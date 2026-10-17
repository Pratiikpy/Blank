// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./interfaces/ITokenRegistry.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, externalEuint64 encAmount, bytes calldata proof) external returns (euint64);
    function transferFromVerified(address from, address to, sharedEuint64 shared) external returns (sharedEuint64);
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
///      - The caller is always the payer. Shares must sum exactly to the
///        total (checked under FHE); a mismatched expense applies no change.
///      - Debts are modular euint64 (credit is a wrapped negative), so they
///        carry no wrap guard by design.
///      - A member's debt survives leave + rejoin.
///      - Each group settles in one allowlisted vault, pinned on first settle.
///      - Archived groups take no new expenses or settlements.
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
    /// @notice Encrypted actual-transferred amount for a settlement.
    ///         The vault may have transferred less than requested if balance/allowance
    ///         was insufficient (FHE.select clamps silently). Frontend decrypts
    ///         `encryptedActual` off-chain (payer + payee both have ACL) to detect
    ///         partial settlement and warn the user.
    /// @dev ABI-additive event, emitted alongside DebtSettled for every settleDebt call.
    event DebtSettledEncrypted(
        uint256 indexed groupId,
        address indexed payer,
        address indexed payee,
        euint64 encryptedActual,
        uint256 timestamp
    );
    event GroupArchived(uint256 indexed groupId, uint256 timestamp);
    event ExpenseArchived(uint256 indexed groupId, uint256 expenseId, uint256 timestamp);
    event TokenRegistrySet(address indexed registry);
    event GroupVaultPinned(uint256 indexed groupId, address indexed vault);
    /// @notice Encrypted flag: true if the expense's shares summed to the
    ///         total and were applied. Payer can decrypt.
    event ExpenseApplied(uint256 indexed groupId, uint256 expenseId, ebool applied);

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
        // Pre-fix: this checked total member count > 1, which let a solo
        // admin leave a 5-member group, bricking it (no admin remains so
        // no one can add members or promote admins). The correct invariant
        // is: at least one OTHER admin must exist after I leave. Scan is
        // bounded by MAX_GROUP_SIZE = 50.
        require(
            !isAdmin[groupId][msg.sender] || _hasOtherAdmin(groupId, msg.sender),
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

        // First join: start at zero. Rejoin: keep the old debt, so leaving
        // cannot wipe what a member owes.
        if (!FHE.isInitialized(_debts[groupId][member])) {
            _debts[groupId][member] = FHE.asEuint64(0);
            FHE.allowThis(_debts[groupId][member]);
        }
        FHE.allow(_debts[groupId][member], member);
    }

    /// @notice Does the group have at least one admin OTHER than `exclude`?
    /// Used by leaveGroup to enforce "last admin can't leave" — pre-fix
    /// that check counted total members instead of admins. Scan bounded
    /// by MAX_GROUP_SIZE = 50, ~3k gas worst case (50× SLOAD per mapping
    /// lookup).
    function _hasOtherAdmin(uint256 groupId, address exclude) internal view returns (bool) {
        address[] storage members = _groups[groupId].members;
        uint256 n = members.length;
        for (uint256 i = 0; i < n; i++) {
            address m = members[i];
            if (m != exclude && isAdmin[groupId][m]) return true;
        }
        return false;
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
    /// @param proof One batch signature covering `shares` then `totalPaid`, in
    ///        that exact order. The client must encrypt them as a single batch
    ///        laid out the same way, or verification fails.
    function addExpense(
        uint256 groupId,
        address[] calldata splitWith,
        externalEuint64[] calldata shares,
        externalEuint64 totalPaid,
        bytes calldata proof,
        string calldata description
    ) external nonReentrant {
        require(isMember[groupId][msg.sender], "GroupManager: not a member");
        require(_groups[groupId].active, "GroupManager: group archived");
        require(splitWith.length == shares.length, "GroupManager: length mismatch");
        require(splitWith.length > 0, "GroupManager: empty split");
        require(splitWith.length <= 30, "GroupManager: max 30 members per expense");

        // Check for duplicate addresses in splitWith
        for (uint256 i = 0; i < splitWith.length; i++) {
            for (uint256 j = i + 1; j < splitWith.length; j++) {
                require(splitWith[i] != splitWith[j], "Duplicate member in split");
            }
        }

        // One signature covers the whole batch, so every share and the total
        // are verified together, in declaration order.
        externalEuint64[] memory packed = new externalEuint64[](shares.length + 1);
        for (uint256 i = 0; i < shares.length; i++) {
            packed[i] = shares[i];
        }
        packed[shares.length] = totalPaid;
        euint64[] memory verified = FHE.asEuint64s(packed, proof);

        // Shares must sum exactly to the total, with no wrap on the way.
        // Otherwise the expense applies nothing, so a member cannot be
        // charged more than the payer claims to have paid.
        euint64 total = verified[shares.length];
        euint64 sum = FHE.asEuint64(0);
        ebool noWrap = FHE.asEbool(true);
        for (uint256 i = 0; i < splitWith.length; i++) {
            require(isMember[groupId][splitWith[i]], "GroupManager: not a member");
            euint64 next = FHE.add(sum, verified[i]);
            noWrap = FHE.and(noWrap, FHE.gte(next, sum));
            sum = next;
        }
        ebool applied = FHE.and(noWrap, FHE.eq(sum, total));
        euint64 zero = FHE.asEuint64(0);

        // Credit the payer (reduce their debt)
        _debts[groupId][msg.sender] = FHE.sub(_debts[groupId][msg.sender], FHE.select(applied, total, zero));
        FHE.allowThis(_debts[groupId][msg.sender]);
        FHE.allowSender(_debts[groupId][msg.sender]);

        // Debit each person's share (increase their debt)
        for (uint256 i = 0; i < splitWith.length; i++) {
            euint64 share = FHE.select(applied, verified[i], zero);
            _debts[groupId][splitWith[i]] = FHE.add(_debts[groupId][splitWith[i]], share);
            FHE.allowThis(_debts[groupId][splitWith[i]]);
            FHE.allow(_debts[groupId][splitWith[i]], splitWith[i]);
        }
        FHE.allowThis(applied);
        FHE.allowSender(applied);

        // Record expense metadata
        uint256 expenseId = _groups[groupId].expenseCount++;
        expenses[groupId][expenseId] = Expense(msg.sender, description, block.timestamp);

        emit ExpenseAdded(groupId, expenseId, msg.sender, description, block.timestamp);
        emit ExpenseApplied(groupId, expenseId, applied);
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
    ///         Updates both parties' encrypted debt balances using the ACTUAL
    ///         transferred amount (not the requested amount) — the vault's
    ///         FHE.select may silently transfer 0 or less than requested when
    ///         balance/allowance is insufficient.
    /// @dev Fix for flow-blocker #87: previously subtracted `requested` which
    ///      silently corrupted debt accounting when the vault transferred less.
    function settleDebt(
        uint256 groupId,
        address with_,
        address vault,
        externalEuint64 encAmount, bytes calldata proof
    ) external nonReentrant {
        require(isMember[groupId][msg.sender], "GroupManager: not a member");
        require(isMember[groupId][with_], "GroupManager: counterparty not a member");
        require(_groups[groupId].active, "GroupManager: group archived");
        _requireAllowedVault(vault);
        address pinned = groupVault[groupId];
        if (pinned == address(0)) {
            groupVault[groupId] = vault;
            emit GroupVaultPinned(groupId, vault);
        } else {
            require(vault == pinned, "GroupManager: wrong vault for group");
        }
        // Reject self-settle. A self → self transfer is a no-op for
        // the vault (FHE.select clamps to balance) but the debt math
        // below still mutates _debts[msg.sender] twice in sequence:
        //   1. subtract min(actual, debt[self]) — possibly to 0
        //   2. add actual — sets debt[self] to `actual`
        // For a member with zero pre-existing debt, this LETS THEM
        // INVENT a debt of `actual` USDC against themselves — no
        // counterparty credit, no off-setting entry, just corruption
        // of the group's debt-sum-to-zero invariant.
        require(with_ != msg.sender, "GroupManager: cannot settle with yourself");

        // #187 per-edge mutex: prevent two callers from settling the SAME
        // (groupId, payer, payee) edge in the SAME block. Without this, the
        // second call rides stale encrypted-state assumptions and either (a)
        // double-decrements the debt or (b) reverts cryptically from the
        // vault's "insufficient balance" clamp after the first drained funds.
        // Next-block settles are allowed — this is a race guard, not a lock.
        require(
            lastSettleBlock[groupId][msg.sender][with_] < block.number,
            "GroupManager: already settling this debt this block"
        );
        lastSettleBlock[groupId][msg.sender][with_] = block.number;

        // Verify encrypted input here (msg.sender = user) before cross-contract call
        euint64 amount = FHE.asEuint64(encAmount, proof);

        // Transfer tokens from sender to counterparty using pre-verified handle.
        // `actual` == min(balance, allowance, requested) — FHE.select in the vault
        // clamps silently. We MUST update debts using `actual`, not `amount`.
        euint64 actual = FHE.receiveEuint64FromCall(
            IFHERC20Vault(vault).transferFromVerified(msg.sender, with_, FHE.shareEuint64(amount, vault)),
            vault
        );

        // Retain ACL for this contract — needed for the debt-update math and
        // because `transferFromVerified` only granted transient allowance.
        FHE.allowThis(actual);

        // Clamp payer's debt subtraction at zero: if payer owed less than
        // `actual` (possible if over-paying), don't underflow their debt.
        // debtDelta = min(actual, _debts[payer])
        ebool owesAtLeastActual = FHE.gte(_debts[groupId][msg.sender], actual);
        euint64 payerDebtDelta = FHE.select(owesAtLeastActual, actual, _debts[groupId][msg.sender]);
        _debts[groupId][msg.sender] = FHE.sub(_debts[groupId][msg.sender], payerDebtDelta);

        // Counterparty's debt increases by the same clamped amount the payer
        // was credited, so an overpay cannot inflate the payee's debt beyond
        // what settled (debt is "owed by": creditors are wrapped negatives).
        _debts[groupId][with_] = FHE.add(_debts[groupId][with_], payerDebtDelta);

        FHE.allowThis(_debts[groupId][msg.sender]);
        FHE.allowSender(_debts[groupId][msg.sender]);
        FHE.allowThis(_debts[groupId][with_]);
        FHE.allow(_debts[groupId][with_], with_);

        // Grant payer + payee off-chain decrypt access on the actual amount
        // so the frontend can compare against the requested amount and warn
        // the payer about partial settlement (the "silent failure" fix).
        FHE.allowSender(actual);
        FHE.allow(actual, with_);

        emit DebtSettled(groupId, msg.sender, with_, block.timestamp);
        emit DebtSettledEncrypted(groupId, msg.sender, with_, actual, block.timestamp);
        try eventHub.emitActivity(msg.sender, with_, "group_settle", "", groupId) {} catch {}
    }

    // ─── Quadratic Voting for Expense Approval ─────────────────────────
    // Uses FHE.square() — the quadratic cost primitive

    mapping(uint256 => mapping(uint256 => euint64)) private _expenseVotes; // groupId → expenseId → encrypted vote total
    mapping(uint256 => mapping(uint256 => bool)) private _votesInitialized; // groupId → expenseId → whether vote tally is initialized

    /// @dev Issue #187 — per-edge same-block settlement mutex.
    ///      groupId → payer → payee → block number of last settleDebt attempt.
    ///      Blocks two callers (or the same caller racing themselves) from
    ///      settling the same debt-edge twice in one block. Two SEQUENTIAL
    ///      settles in different blocks still work — this is an anti-race
    ///      guard, not a permanent lock. Cheaper than a forever-locked edge
    ///      flag and self-expiring (each new block clears the effective lock).
    ///
    ///      APPEND-ONLY state (UUPS-safe) — added in v0.1.5 at the end of the
    ///      declared storage to preserve all prior slot indices.
    mapping(uint256 => mapping(address => mapping(address => uint256))) public lastSettleBlock;

    /// @notice Retired. Quadratic expense voting was cut; past tallies stay
    ///         readable through getExpenseVotes.
    function voteOnExpense(uint256, uint256, externalEuint64, bytes calldata) external pure {
        revert("GroupManager: retired");
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

    function setTokenRegistry(address r) external onlyOwner {
        require(r.code.length > 0, "GroupManager: bad registry");
        tokenRegistry = ITokenRegistry(r);
        emit TokenRegistrySet(r);
    }

    function _requireAllowedVault(address vault) internal view {
        require(
            address(tokenRegistry) != address(0) && tokenRegistry.isActiveVault(vault),
            "GroupManager: vault not allowed"
        );
    }

    /// @dev groupId => vault the group settles in, pinned on first settle. Appended.
    mapping(uint256 => address) public groupVault;
    /// @dev Vault allowlist. Appended.
    ITokenRegistry public tokenRegistry;

    /// @dev Reserved storage. Shrink by 1 for each slot appended above.
    uint256[48] private __gap;

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
