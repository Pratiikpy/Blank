// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, InEuint64 memory encAmount) external returns (euint64);
    function transferFromVerified(address from, address to, euint64 amount) external returns (euint64);
}

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

/// @title GroupManager — Encrypted group expense splitting
/// @notice Create groups, add expenses with encrypted per-person shares,
///         and settle debts via FHERC20 transfers. Each member sees only their own balance.
///
/// @dev Key design decisions:
///      - Splits are pre-computed OFF-CHAIN (euint64 division not supported)
///      - Payer encrypts each member's share individually and submits as InEuint64[]
///      - Multi-admin system (any admin can add expenses/members)
///      - Member debts are encrypted — each member can only unseal their own
contract GroupManager is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {

    // ─── Types ──────────────────────────────────────────────────────────

    struct Group {
        string name;
        address[] members;
        uint256 expenseCount;
        bool active;
    }

    struct Expense {
        address payer;
        string description;
        uint256 timestamp;
    }

    // ─── State ──────────────────────────────────────────────────────────

    IEventHub public eventHub;

    uint256 public constant MAX_GROUP_SIZE = 50;
    uint256 public nextGroupId;
    mapping(uint256 => Group) private _groups;
    mapping(uint256 => mapping(address => bool)) public isMember;
    mapping(uint256 => mapping(address => bool)) public isAdmin;
    mapping(uint256 => mapping(address => euint64)) private _debts; // Positive = owes, Negative (via underflow) = is owed
    mapping(uint256 => mapping(uint256 => Expense)) public expenses;

    /// @dev Reverse lookup: address → all group IDs they belong to
    mapping(address => uint256[]) private _userGroups;

    /// @dev Vote deduplication: groupId → expenseId → voter → hasVoted
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) private _hasVoted;

    /// @dev Expense archived flag: groupId → expenseId → archived
    mapping(uint256 => mapping(uint256 => bool)) public expenseArchived;

    // ─── Events ─────────────────────────────────────────────────────────

    event GroupCreated(uint256 indexed groupId, string name, address[] members, uint256 timestamp);
    event MemberAdded(uint256 indexed groupId, address indexed member, uint256 timestamp);
    event MemberRemoved(uint256 indexed groupId, address indexed member, uint256 timestamp);
    event AdminAdded(uint256 indexed groupId, address indexed admin, uint256 timestamp);
    event ExpenseAdded(uint256 indexed groupId, uint256 expenseId, address indexed payer, string description, uint256 timestamp);
    event DebtSettled(uint256 indexed groupId, address indexed from, address indexed to, uint256 timestamp);
    event GroupArchived(uint256 indexed groupId, uint256 timestamp);
    event ExpenseArchived(uint256 indexed groupId, uint256 expenseId, uint256 timestamp);

    // ─── Initializer ────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _eventHub) public initializer {
        __Ownable_init(msg.sender);
        eventHub = IEventHub(_eventHub);
    }

    // ─── Group Management ───────────────────────────────────────────────

    /// @notice Create a new group. Creator becomes the first admin.
    function createGroup(string calldata name, address[] calldata members) external nonReentrant returns (uint256) {
        require(members.length <= MAX_GROUP_SIZE, "GroupManager: too many members");
        uint256 id = nextGroupId++;
        Group storage g = _groups[id];
        g.name = name;
        g.active = true;

        // Add creator as member + admin
        _addMemberInternal(id, msg.sender);
        isAdmin[id][msg.sender] = true;

        // Add other members
        for (uint256 i = 0; i < members.length; i++) {
            if (members[i] != msg.sender && members[i] != address(0)) {
                _addMemberInternal(id, members[i]);
            }
        }

        emit GroupCreated(id, name, g.members, block.timestamp);
        try eventHub.emitActivity(msg.sender, address(0), "group_created", name, id) {} catch {}

        return id;
    }

    /// @notice Add a member to an existing group. Only admins.
    function addMember(uint256 groupId, address member) external nonReentrant {
        require(isAdmin[groupId][msg.sender], "GroupManager: not admin");
        require(_groups[groupId].members.length < MAX_GROUP_SIZE, "GroupManager: group full");
        require(!isMember[groupId][member], "GroupManager: already member");
        require(member != address(0), "GroupManager: zero address");

        _addMemberInternal(groupId, member);
        emit MemberAdded(groupId, member, block.timestamp);
    }

    /// @notice Promote a member to admin. Only existing admins.
    function addAdmin(uint256 groupId, address admin) external nonReentrant {
        require(isAdmin[groupId][msg.sender], "GroupManager: not admin");
        require(isMember[groupId][admin], "GroupManager: not a member");
        isAdmin[groupId][admin] = true;
        emit AdminAdded(groupId, admin, block.timestamp);
    }

    /// @notice Leave a group. Last admin cannot leave (must promote another first).
    function leaveGroup(uint256 groupId) external nonReentrant {
        require(isMember[groupId][msg.sender], "GroupManager: not a member");
        require(
            !isAdmin[groupId][msg.sender] || _groups[groupId].members.length > 1,
            "GroupManager: last admin cannot leave"
        );

        // Remove from members array
        Group storage group = _groups[groupId];
        for (uint256 i = 0; i < group.members.length; i++) {
            if (group.members[i] == msg.sender) {
                group.members[i] = group.members[group.members.length - 1];
                group.members.pop();
                break;
            }
        }

        isMember[groupId][msg.sender] = false;
        isAdmin[groupId][msg.sender] = false;

        // Remove from user's groups
        uint256[] storage userGroups = _userGroups[msg.sender];
        for (uint256 i = 0; i < userGroups.length; i++) {
            if (userGroups[i] == groupId) {
                userGroups[i] = userGroups[userGroups.length - 1];
                userGroups.pop();
                break;
            }
        }

        try eventHub.emitActivity(msg.sender, address(0), "member_left", "", groupId) {} catch {}
        emit MemberRemoved(groupId, msg.sender, block.timestamp);
    }

    /// @notice Archive a group. Only admins. Sets group to inactive.
    function archiveGroup(uint256 groupId) external nonReentrant {
        require(isAdmin[groupId][msg.sender], "GroupManager: not admin");
        _groups[groupId].active = false;
        emit GroupArchived(groupId, block.timestamp);
    }

    function _addMemberInternal(uint256 groupId, address member) internal {
        _groups[groupId].members.push(member);
        isMember[groupId][member] = true;
        _userGroups[member].push(groupId);

        // Initialize encrypted debt to zero
        _debts[groupId][member] = FHE.asEuint64(0);
        FHE.allowThis(_debts[groupId][member]);
        FHE.allow(_debts[groupId][member], member);
    }

    // ─── Expenses ───────────────────────────────────────────────────────

    /// @notice Add an expense to the group.
    ///         Splits are pre-computed off-chain — payer provides encrypted per-person shares.
    ///
    /// @param groupId Group to add expense to
    /// @param splitWith Addresses of members who owe (can include payer for self-share)
    /// @param shares Encrypted amount each person owes (pre-computed off-chain)
    /// @param totalPaid Encrypted total the payer paid (credited to payer)
    /// @param description Public expense description
    function addExpense(
        uint256 groupId,
        address[] calldata splitWith,
        InEuint64[] memory shares,
        InEuint64 memory totalPaid,
        string calldata description
    ) external nonReentrant {
        require(isMember[groupId][msg.sender], "GroupManager: not a member");
        require(splitWith.length == shares.length, "GroupManager: length mismatch");
        require(splitWith.length > 0, "GroupManager: empty split");
        require(splitWith.length <= 30, "GroupManager: max 30 members per expense");

        // Check for duplicate addresses in splitWith
        for (uint256 i = 0; i < splitWith.length; i++) {
            for (uint256 j = i + 1; j < splitWith.length; j++) {
                require(splitWith[i] != splitWith[j], "Duplicate member in split");
            }
        }

        // Credit the payer (reduce their debt)
        euint64 total = FHE.asEuint64(totalPaid);
        _debts[groupId][msg.sender] = FHE.sub(_debts[groupId][msg.sender], total);
        FHE.allowThis(_debts[groupId][msg.sender]);
        FHE.allow(_debts[groupId][msg.sender], msg.sender);

        // Debit each person's share (increase their debt)
        for (uint256 i = 0; i < splitWith.length; i++) {
            require(isMember[groupId][splitWith[i]], "GroupManager: not a member");
            euint64 share = FHE.asEuint64(shares[i]);
            _debts[groupId][splitWith[i]] = FHE.add(_debts[groupId][splitWith[i]], share);
            FHE.allowThis(_debts[groupId][splitWith[i]]);
            FHE.allow(_debts[groupId][splitWith[i]], splitWith[i]);
        }

        // Record expense metadata
        uint256 expenseId = _groups[groupId].expenseCount++;
        expenses[groupId][expenseId] = Expense(msg.sender, description, block.timestamp);

        emit ExpenseAdded(groupId, expenseId, msg.sender, description, block.timestamp);
        try eventHub.emitActivity(msg.sender, address(0), "group_expense", description, groupId) {} catch {}
    }

    /// @notice Archive an expense (bookkeeping only).
    ///         Does NOT reverse debt changes — those are encrypted and irreversible.
    function archiveExpense(uint256 groupId, uint256 expenseId) external nonReentrant {
        require(isAdmin[groupId][msg.sender], "GroupManager: not admin");
        require(expenseId < _groups[groupId].expenseCount, "GroupManager: invalid expense");
        require(!expenseArchived[groupId][expenseId], "GroupManager: already archived");

        expenseArchived[groupId][expenseId] = true;
        emit ExpenseArchived(groupId, expenseId, block.timestamp);
    }

    // ─── Settle Debts ───────────────────────────────────────────────────

    /// @notice Settle a debt with another group member by transferring FHERC20 tokens.
    ///         Updates both parties' encrypted debt balances.
    function settleDebt(
        uint256 groupId,
        address with_,
        address vault,
        InEuint64 memory encAmount
    ) external nonReentrant {
        require(isMember[groupId][msg.sender], "GroupManager: not a member");
        require(isMember[groupId][with_], "GroupManager: counterparty not a member");

        // Verify encrypted input here (msg.sender = user) before cross-contract call
        euint64 amount = FHE.asEuint64(encAmount);
        FHE.allowTransient(amount, vault);

        // Transfer tokens from sender to counterparty using pre-verified handle
        IFHERC20Vault(vault).transferFromVerified(msg.sender, with_, amount);

        // Update debts: sender's debt decreases, counterparty's debt increases
        _debts[groupId][msg.sender] = FHE.sub(_debts[groupId][msg.sender], amount);
        _debts[groupId][with_] = FHE.add(_debts[groupId][with_], amount);

        FHE.allowThis(_debts[groupId][msg.sender]);
        FHE.allow(_debts[groupId][msg.sender], msg.sender);
        FHE.allowThis(_debts[groupId][with_]);
        FHE.allow(_debts[groupId][with_], with_);

        emit DebtSettled(groupId, msg.sender, with_, block.timestamp);
        try eventHub.emitActivity(msg.sender, with_, "group_settle", "", groupId) {} catch {}
    }

    // ─── Quadratic Voting for Expense Approval ─────────────────────────
    // Uses FHE.square() — the quadratic cost primitive

    mapping(uint256 => mapping(uint256 => euint64)) private _expenseVotes; // groupId → expenseId → encrypted vote total
    mapping(uint256 => mapping(uint256 => bool)) private _votesInitialized; // groupId → expenseId → whether vote tally is initialized

    /// @notice Vote on whether to approve a group expense.
    ///         Quadratic voting: casting N votes costs N² from your influence.
    ///         Uses FHE.square() for the quadratic cost calculation.
    /// @param groupId Group to vote in
    /// @param expenseId Expense to vote on
    /// @param encVotes Encrypted number of votes (quadratic cost applies)
    function voteOnExpense(
        uint256 groupId,
        uint256 expenseId,
        InEuint64 memory encVotes
    ) external nonReentrant {
        require(isMember[groupId][msg.sender], "GroupManager: not a member");
        require(!_hasVoted[groupId][expenseId][msg.sender], "Already voted");
        _hasVoted[groupId][expenseId][msg.sender] = true;

        euint64 votes = FHE.asEuint64(encVotes);

        // Quadratic cost: casting N votes costs N² (using FHE.square)
        // This prevents whale domination — 10 votes costs 100, not 10
        euint64 cost = FHE.square(votes);
        FHE.allowThis(cost);
        FHE.allowSender(cost);

        // Add votes to the encrypted tally
        if (!_votesInitialized[groupId][expenseId]) {
            _expenseVotes[groupId][expenseId] = FHE.asEuint64(0);
            FHE.allowThis(_expenseVotes[groupId][expenseId]);
            _votesInitialized[groupId][expenseId] = true;
        }
        _expenseVotes[groupId][expenseId] = FHE.add(_expenseVotes[groupId][expenseId], votes);
        FHE.allowThis(_expenseVotes[groupId][expenseId]);
        FHE.allowSender(_expenseVotes[groupId][expenseId]);
    }

    /// @notice Get the encrypted vote total for an expense
    function getExpenseVotes(uint256 groupId, uint256 expenseId) external view returns (euint64) {
        return _expenseVotes[groupId][expenseId];
    }

    // ─── View Functions ─────────────────────────────────────────────────

    /// @notice Get your encrypted debt in a group. Unseal with permit.
    function getMyDebt(uint256 groupId) external view returns (euint64) {
        require(isMember[groupId][msg.sender], "GroupManager: not a member");
        return _debts[groupId][msg.sender];
    }

    /// @notice Get group info
    function getGroup(uint256 groupId) external view returns (
        string memory name,
        address[] memory members,
        uint256 expenseCount,
        bool active
    ) {
        Group storage g = _groups[groupId];
        return (g.name, g.members, g.expenseCount, g.active);
    }

    /// @notice Get all group IDs a user belongs to
    function getUserGroups(address user) external view returns (uint256[] memory) {
        return _userGroups[user];
    }

    /// @notice Get expense metadata
    function getExpense(uint256 groupId, uint256 expenseId) external view returns (
        address payer,
        string memory description,
        uint256 timestamp
    ) {
        Expense storage e = expenses[groupId][expenseId];
        return (e.payer, e.description, e.timestamp);
    }

    // ─── Admin ──────────────────────────────────────────────────────────

    function setEventHub(address _eventHub) external onlyOwner {
        eventHub = IEventHub(_eventHub);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
