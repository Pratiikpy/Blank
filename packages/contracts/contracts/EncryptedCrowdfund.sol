// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./utils/ReentrancyGuard.sol";

interface IFHERC20Vault {
    function transferFromVerified(address from, address to, euint64 amount) external returns (euint64);
    function transferVerified(address to, euint64 amount) external returns (euint64);
}

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

interface IPaymentReceipts {
    function bumpUserReceived(address user, euint64 amount) external;
    function bumpGlobal(euint64 amount) external;
}

/// @title EncryptedCrowdfund — private campaigns with encrypted goal + contributions
/// @notice Campaign creator posts a fundraising target. Contributors send
///         encrypted amounts. The chain runs `raised >= goal` via FHE.gte
///         after the deadline; only the verdict (true/false) is decrypted
///         publicly. On success the creator pulls; on failure contributors
///         get refunded.
///
/// @dev Keeps individual contribution amounts private throughout. The
///      total goal is also private — observers cannot game the campaign by
///      knowing how close it is to closing.
contract EncryptedCrowdfund is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {

    enum CampaignStatus { Open, Closed, Released, Refunding }

    struct Campaign {
        address creator;
        address vault;
        euint64 encGoal;
        euint64 encRaised;
        uint256 deadline;
        CampaignStatus status;
        bool goalMet;          // set after closeCampaign + publishCloseResult
        ebool goalCheck;       // ebool handle for async-decrypt
        bool resultPublished;
        string title;
        bytes32 descriptionCidHash;
        uint256 createdAt;
    }

    struct Contribution {
        address contributor;
        euint64 amount;
        bool refunded;
    }

    IEventHub public eventHub;
    address public paymentReceipts;

    uint256 public nextCampaignId;
    mapping(uint256 => Campaign) private _campaigns;
    mapping(uint256 => Contribution[]) private _contributions;
    mapping(address => uint256[]) private _creatorCampaigns;

    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 90 days;

    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed creator,
        address vault,
        uint256 deadline,
        string title
    );

    event Contributed(
        uint256 indexed campaignId,
        address indexed contributor,
        uint256 contributionIndex,
        uint256 timestamp
    );

    event CampaignClosed(uint256 indexed campaignId, uint256 totalContributions);

    event CloseResultPublished(uint256 indexed campaignId, bool goalMet);

    event CampaignReleased(uint256 indexed campaignId, address indexed creator);

    event ContributionRefunded(
        uint256 indexed campaignId,
        address indexed contributor,
        uint256 contributionIndex
    );

    /// @notice §2.6 of BEST_VERSION_FULL_PLAN: emitted when paymentReceipts
    /// bump call reverts. kind is "user" or "global". Indexer detects + replays.
    event ReceiptsBumpFailed(string kind, bytes reason);
    event PaymentReceiptsSet(address indexed previous, address indexed current);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _eventHub) public initializer {
        __Ownable_init(msg.sender);
        eventHub = IEventHub(_eventHub);
    }

    // ─── Create Campaign ──────────────────────────────────────────────

    function createCampaign(
        address vault,
        InEuint64 calldata encGoal,
        uint256 durationSeconds,
        string calldata title,
        bytes32 descriptionCidHash
    ) external nonReentrant returns (uint256 campaignId) {
        require(vault != address(0), "Crowdfund: zero vault");
        require(durationSeconds >= MIN_DURATION && durationSeconds <= MAX_DURATION, "Crowdfund: bad duration");
        require(bytes(title).length > 0 && bytes(title).length <= 200, "Crowdfund: bad title");

        euint64 verifiedGoal = FHE.asEuint64(encGoal);
        FHE.allowThis(verifiedGoal);
        FHE.allowSender(verifiedGoal);

        // Initialize raised total to 0.
        euint64 zero = FHE.asEuint64(0);
        FHE.allowThis(zero);

        campaignId = nextCampaignId++;
        _campaigns[campaignId] = Campaign({
            creator: msg.sender,
            vault: vault,
            encGoal: verifiedGoal,
            encRaised: zero,
            deadline: block.timestamp + durationSeconds,
            status: CampaignStatus.Open,
            goalMet: false,
            goalCheck: ebool.wrap(0),
            resultPublished: false,
            title: title,
            descriptionCidHash: descriptionCidHash,
            createdAt: block.timestamp
        });
        _creatorCampaigns[msg.sender].push(campaignId);

        emit CampaignCreated(campaignId, msg.sender, vault, block.timestamp + durationSeconds, title);
        try eventHub.emitActivity(msg.sender, address(0), "crowdfund_created", title, campaignId) {} catch {}
    }

    // ─── Contribute ───────────────────────────────────────────────────

    function contribute(uint256 campaignId, InEuint64 calldata encAmount) external nonReentrant {
        Campaign storage c = _campaigns[campaignId];
        require(c.status == CampaignStatus.Open, "Crowdfund: not open");
        require(block.timestamp < c.deadline, "Crowdfund: past deadline");
        require(msg.sender != c.creator, "Crowdfund: creator cannot contribute");

        euint64 verifiedAmount = FHE.asEuint64(encAmount);
        FHE.allowTransient(verifiedAmount, c.vault);

        // Move contributor's funds into this contract's vault balance.
        euint64 locked = IFHERC20Vault(c.vault).transferFromVerified(msg.sender, address(this), verifiedAmount);
        FHE.allowThis(locked);
        FHE.allowSender(locked);

        // Bump the encrypted running total.
        c.encRaised = FHE.add(c.encRaised, locked);
        FHE.allowThis(c.encRaised);
        FHE.allow(c.encRaised, c.creator);
        FHE.allowSender(c.encRaised);

        _contributions[campaignId].push(Contribution({
            contributor: msg.sender,
            amount: locked,
            refunded: false
        }));

        emit Contributed(campaignId, msg.sender, _contributions[campaignId].length - 1, block.timestamp);
        try eventHub.emitActivity(msg.sender, c.creator, "crowdfund_contributed", c.title, campaignId) {} catch {}
    }

    // ─── Close Campaign ───────────────────────────────────────────────

    /// @notice Any address can close after deadline. Computes goal-met
    ///         predicate via FHE.gte(raised, goal) and marks the campaign
    ///         closed. The result must be published separately via
    ///         publishCloseResult before claimRelease / claimRefund.
    function closeCampaign(uint256 campaignId) external nonReentrant {
        Campaign storage c = _campaigns[campaignId];
        require(c.status == CampaignStatus.Open, "Crowdfund: already closed");
        require(block.timestamp >= c.deadline, "Crowdfund: not yet ended");
        // §2.2 of BEST_VERSION_FULL_PLAN: reject zero-contributions close.
        // FHE.gte(0, 0) is true, so without this guard a campaign with no
        // contributors would emit a fake "successful campaign" event and the
        // indexer would record a non-existent fundraise. The encrypted goal
        // value stays private; only "had at least one contribution" is public.
        require(_contributions[campaignId].length > 0, "Crowdfund: no contributions to close against");

        // §1.14 A4: prevent zero-goal grief. Creator could set encGoal=0
        // at create time so FHE.gte(raised, 0) is always true; victim
        // contributes, creator claimRelease pulls funds. Fix is to AND
        // a "goal is positive" check into the verdict. Both are encrypted
        // booleans — neither leaks the actual goal amount. When goal is
        // zero, reached is forced false and the campaign routes to refunds.
        ebool reached = FHE.gte(c.encRaised, c.encGoal);
        ebool goalIsPositive = FHE.gt(c.encGoal, FHE.asEuint64(0));
        reached = FHE.and(reached, goalIsPositive);
        FHE.allowThis(reached);
        FHE.allowSender(reached);
        FHE.allowPublic(reached);

        c.goalCheck = reached;
        c.status = CampaignStatus.Closed;

        emit CampaignClosed(campaignId, _contributions[campaignId].length);
        try eventHub.emitActivity(c.creator, address(0), "crowdfund_closed", c.title, campaignId) {} catch {}
    }

    /// @notice Publish the off-chain decryption of the goal-check ebool.
    ///         Threshold Network signs the result; this contract verifies
    ///         and stores the boolean verdict. Anyone can call.
    function publishCloseResult(uint256 campaignId, bool plaintext, bytes calldata signature) external nonReentrant {
        Campaign storage c = _campaigns[campaignId];
        require(c.status == CampaignStatus.Closed || c.status == CampaignStatus.Released || c.status == CampaignStatus.Refunding, "Crowdfund: not closed");
        require(!c.resultPublished, "Crowdfund: already published");
        FHE.publishDecryptResult(c.goalCheck, plaintext, signature);
        c.goalMet = plaintext;
        c.resultPublished = true;
        // Set status hint so the UI knows whether to show "Release" or "Refund" CTA.
        c.status = plaintext ? CampaignStatus.Released : CampaignStatus.Refunding;
        emit CloseResultPublished(campaignId, plaintext);
    }

    // ─── Release (success) ────────────────────────────────────────────

    /// @notice Creator pulls the entire raised amount when goal was met.
    ///         Contributors get their delivery (off-chain) — campaign
    ///         success is the contract's handshake with reality.
    function claimRelease(uint256 campaignId) external nonReentrant {
        Campaign storage c = _campaigns[campaignId];
        require(c.resultPublished, "Crowdfund: result not published");
        require(c.goalMet, "Crowdfund: goal not met");
        require(msg.sender == c.creator, "Crowdfund: not creator");
        require(c.status != CampaignStatus.Open, "Crowdfund: open");

        // Single sweep: contract -> creator.
        FHE.allowTransient(c.encRaised, c.vault);
        euint64 paid = IFHERC20Vault(c.vault).transferVerified(c.creator, c.encRaised);
        FHE.allowThis(paid);
        FHE.allow(paid, c.creator);

        _bumpReceiptsAndGlobal(c.creator, paid);

        // Mark all contributions as "refunded" (i.e. settled — they paid the creator).
        Contribution[] storage cs = _contributions[campaignId];
        for (uint256 i = 0; i < cs.length; i++) {
            cs[i].refunded = true;
        }

        emit CampaignReleased(campaignId, c.creator);
        try eventHub.emitActivity(c.creator, address(0), "crowdfund_released", c.title, campaignId) {} catch {}
    }

    // ─── Refund (failure) ─────────────────────────────────────────────

    /// @notice On failed campaign, each contributor pulls their own
    ///         contribution back. Idempotent per contribution index.
    function claimRefund(uint256 campaignId, uint256 contributionIndex) external nonReentrant {
        Campaign storage c = _campaigns[campaignId];
        require(c.resultPublished, "Crowdfund: result not published");
        require(!c.goalMet, "Crowdfund: goal was met (no refunds)");

        Contribution[] storage cs = _contributions[campaignId];
        require(contributionIndex < cs.length, "Crowdfund: bad index");
        Contribution storage contrib = cs[contributionIndex];
        require(contrib.contributor == msg.sender, "Crowdfund: not your contribution");
        require(!contrib.refunded, "Crowdfund: already refunded");

        FHE.allowTransient(contrib.amount, c.vault);
        IFHERC20Vault(c.vault).transferVerified(msg.sender, contrib.amount);

        contrib.refunded = true;
        emit ContributionRefunded(campaignId, msg.sender, contributionIndex);
    }

    // ─── Views ────────────────────────────────────────────────────────

    function getCampaign(uint256 campaignId) external view returns (
        address creator,
        address vault,
        uint256 deadline,
        CampaignStatus status,
        bool goalMet,
        bool resultPublished,
        string memory title,
        bytes32 descriptionCidHash,
        uint256 createdAt
    ) {
        Campaign storage c = _campaigns[campaignId];
        return (c.creator, c.vault, c.deadline, c.status, c.goalMet, c.resultPublished, c.title, c.descriptionCidHash, c.createdAt);
    }

    function getEncryptedGoal(uint256 campaignId) external view returns (euint64) {
        return _campaigns[campaignId].encGoal;
    }

    function getEncryptedRaised(uint256 campaignId) external view returns (euint64) {
        return _campaigns[campaignId].encRaised;
    }

    function getGoalCheckHandle(uint256 campaignId) external view returns (ebool) {
        return _campaigns[campaignId].goalCheck;
    }

    function getContributionCount(uint256 campaignId) external view returns (uint256) {
        return _contributions[campaignId].length;
    }

    function getContribution(uint256 campaignId, uint256 contributionIndex) external view returns (
        address contributor,
        bool refunded
    ) {
        Contribution storage c = _contributions[campaignId][contributionIndex];
        return (c.contributor, c.refunded);
    }

    function getCreatorCampaigns(address creator) external view returns (uint256[] memory) {
        return _creatorCampaigns[creator];
    }

    // ─── Admin ────────────────────────────────────────────────────────

    function setEventHub(address _eventHub) external onlyOwner {
        eventHub = IEventHub(_eventHub);
    }

    function setPaymentReceipts(address _paymentReceipts) external onlyOwner {
        address previous = paymentReceipts;
        paymentReceipts = _paymentReceipts;
        emit PaymentReceiptsSet(previous, _paymentReceipts);
    }

    function _bumpReceiptsAndGlobal(address recipient, euint64 amount) internal {
        if (paymentReceipts == address(0)) return;
        FHE.allowTransient(amount, paymentReceipts);
        // §2.6 of BEST_VERSION_FULL_PLAN: surface receipt-bump failures.
        try IPaymentReceipts(paymentReceipts).bumpUserReceived(recipient, amount) {} catch (bytes memory reason) {
            emit ReceiptsBumpFailed("user", reason);
        }
        FHE.allowTransient(amount, paymentReceipts);
        try IPaymentReceipts(paymentReceipts).bumpGlobal(amount) {} catch (bytes memory reason) {
            emit ReceiptsBumpFailed("global", reason);
        }
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Append-only storage. Used: 7. Gap: 50.
    /// Decrement gap by 1 when adding a new state variable; total slots
    /// (used + gap) must stay constant across UUPS upgrades.
    uint256[50] private __gap;
}
