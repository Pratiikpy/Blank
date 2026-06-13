// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./utils/ReentrancyGuard.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IConditionResolver} from "./interfaces/IConditionResolver.sol";

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

/// @title EncryptedEscrow — fully-encrypted 2-of-2 escrow with optional arbiter.
/// @notice Wave 4 #249. The original BusinessHub escrow stored funds in
///         plaintext underlying ERC-20 (so amounts were observable on-chain).
///         This contract holds funds as encrypted vault balance instead —
///         the amount is never visible to anyone except the parties.
///
/// @dev Lifecycle:
///        Active → (markDelivered + approveRelease) → Released
///        Active → disputeEscrow → Disputed → arbiterDecide → Released
///        Active → claimExpiredEscrow (after deadline) → Refunded
///
///      Same actor model as BusinessHub.Escrow (depositor, beneficiary,
///      optional arbiter) but the amount is FHE-encrypted end-to-end.
contract EncryptedEscrow is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {

    enum EscrowStatus { Active, Disputed, Released, Refunded }

    struct Escrow {
        address depositor;
        address beneficiary;
        address arbiter;        // 0x0 if no arbiter configured
        address vault;
        euint64 encAmount;      // The ONLY amount stored. No plaintext copy.
        uint256 deadline;       // After this, depositor can claim refund
        bool depositorApproved;
        bool beneficiaryMarkedDelivered;
        EscrowStatus status;
        string description;
        uint256 createdAt;
    }

    IEventHub public eventHub;
    address public paymentReceipts;

    uint256 public nextEscrowId;
    mapping(uint256 => Escrow) private _escrows;
    mapping(address => uint256[]) private _userEscrows;

    /// @dev Optional per-escrow release-rule resolver (Reineira's
    ///      IConditionResolver standard). address(0) for the original 2-of-2,
    ///      arbiter, and expiry escrows. Appended after _userEscrows; __gap
    ///      was reduced from 50 to 49 to keep total slots constant.
    mapping(uint256 => address) private _escrowResolver;

    // ─── Events ───────────────────────────────────────────────────────

    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed depositor,
        address indexed beneficiary,
        address arbiter,
        uint256 deadline
    );
    event EscrowDelivered(uint256 indexed escrowId, address indexed beneficiary);
    event EscrowApproved(uint256 indexed escrowId, address indexed depositor);
    event EscrowReleased(uint256 indexed escrowId, address indexed to);
    event EscrowDisputed(uint256 indexed escrowId, address indexed by);
    event EscrowArbiterDecided(uint256 indexed escrowId, address indexed arbiter, bool toBeneficiary);
    event EscrowExpiryClaimed(uint256 indexed escrowId, address indexed depositor);
    /// @notice A conditional escrow registered a release-rule resolver.
    event EscrowResolverSet(uint256 indexed escrowId, address indexed resolver);

    /// @notice §2.6 of BEST_VERSION_FULL_PLAN: emitted when paymentReceipts
    /// bump call reverts. kind is "user" or "global". Indexer detects + replays.
    event ReceiptsBumpFailed(string kind, bytes reason);
    event PaymentReceiptsSet(address indexed previous, address indexed current);

    // ─── Initializer ──────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _eventHub) public initializer {
        __Ownable_init(msg.sender);
        eventHub = IEventHub(_eventHub);
    }

    // ─── Create ───────────────────────────────────────────────────────

    /// @notice Open a new encrypted escrow. The amount is pulled from the
    ///         depositor's encrypted vault balance into this contract.
    function createEscrow(
        address beneficiary,
        address vault,
        InEuint64 calldata encAmount,
        string calldata description,
        address arbiter,
        uint256 deadline
    ) external nonReentrant returns (uint256 escrowId) {
        require(beneficiary != address(0) && beneficiary != msg.sender, "EncryptedEscrow: bad beneficiary");
        require(vault != address(0), "EncryptedEscrow: zero vault");
        require(deadline >= block.timestamp + 1 days, "EncryptedEscrow: deadline < 1 day out");
        require(bytes(description).length <= 512, "EncryptedEscrow: description too long");
        // Arbiter conflict-of-interest gate. Both shapes are real bugs:
        //   arbiter == msg.sender (depositor):
        //     Depositor can disputeEscrow → arbiterDecide(false), pulling
        //     funds back instantly. Bypasses the 1-day deadline gate.
        //   arbiter == beneficiary:
        //     Arbiter has direct self-interest to rule in their own favor.
        // address(0) is still accepted as "no arbiter configured" (the
        // claimExpiredEscrow path handles that case).
        require(arbiter != msg.sender, "EncryptedEscrow: arbiter == depositor");
        require(arbiter != beneficiary, "EncryptedEscrow: arbiter == beneficiary");

        // Verify the encrypted input under depositor's signer.
        euint64 verified = FHE.asEuint64(encAmount);
        FHE.allowTransient(verified, vault);

        // Pull funds: depositor → this contract.
        euint64 locked = IFHERC20Vault(vault).transferFromVerified(msg.sender, address(this), verified);
        FHE.allowThis(locked);
        FHE.allowSender(locked);
        FHE.allow(locked, beneficiary);
        // §2.4 of BEST_VERSION_FULL_PLAN: arbiter decrypt-rights deferred to
        // disputeEscrow time. Pre-dispute the arbiter has no business reading
        // the encrypted amount; granting at create leaks ongoing visibility
        // into a contract the arbiter is not yet involved in. Half-baked A12.

        escrowId = nextEscrowId++;
        _escrows[escrowId] = Escrow({
            depositor: msg.sender,
            beneficiary: beneficiary,
            arbiter: arbiter,
            vault: vault,
            encAmount: locked,
            deadline: deadline,
            depositorApproved: false,
            beneficiaryMarkedDelivered: false,
            status: EscrowStatus.Active,
            description: description,
            createdAt: block.timestamp
        });
        _userEscrows[msg.sender].push(escrowId);
        _userEscrows[beneficiary].push(escrowId);
        if (arbiter != address(0)) _userEscrows[arbiter].push(escrowId);

        emit EscrowCreated(escrowId, msg.sender, beneficiary, arbiter, deadline);
        try eventHub.emitActivity(msg.sender, beneficiary, "escrow_created", description, escrowId) {} catch {}
    }

    // ─── Conditional create (Reineira IConditionResolver standard) ─────

    /// @notice Open an encrypted escrow whose release is gated by a pluggable
    ///         rule instead of the 2-of-2 / arbiter flow. The amount is pulled
    ///         from the depositor's encrypted vault balance, same as
    ///         createEscrow. The resolver is registered atomically and bound to
    ///         this contract.
    /// @param resolver     Release-rule contract; must support IConditionResolver.
    /// @param resolverData ABI-encoded config the resolver understands.
    /// @param deadline     Stored on the escrow for display; the operative
    ///                     timeout lives inside resolverData. Refund-on-expiry
    ///                     is disabled for resolver-gated escrows (release is
    ///                     resolver-exclusive), so there is no refund race.
    function createConditionalEscrow(
        address beneficiary,
        address vault,
        InEuint64 calldata encAmount,
        string calldata description,
        address resolver,
        bytes calldata resolverData,
        uint256 deadline
    ) external nonReentrant returns (uint256 escrowId) {
        require(beneficiary != address(0) && beneficiary != msg.sender, "EncryptedEscrow: bad beneficiary");
        require(vault != address(0), "EncryptedEscrow: zero vault");
        require(resolver != address(0), "EncryptedEscrow: zero resolver");
        require(
            IERC165(resolver).supportsInterface(type(IConditionResolver).interfaceId),
            "EncryptedEscrow: resolver !IConditionResolver"
        );
        require(deadline >= block.timestamp + 1 days, "EncryptedEscrow: deadline < 1 day out");
        require(bytes(description).length <= 512, "EncryptedEscrow: description too long");

        // Verify the encrypted input under depositor's signer, then pull funds.
        euint64 verified = FHE.asEuint64(encAmount);
        FHE.allowTransient(verified, vault);
        euint64 locked = IFHERC20Vault(vault).transferFromVerified(msg.sender, address(this), verified);
        FHE.allowThis(locked);
        FHE.allowSender(locked);
        FHE.allow(locked, beneficiary);

        escrowId = nextEscrowId++;
        _escrows[escrowId] = Escrow({
            depositor: msg.sender,
            beneficiary: beneficiary,
            arbiter: address(0),
            vault: vault,
            encAmount: locked,
            deadline: deadline,
            depositorApproved: false,
            beneficiaryMarkedDelivered: false,
            status: EscrowStatus.Active,
            description: description,
            createdAt: block.timestamp
        });
        _userEscrows[msg.sender].push(escrowId);
        _userEscrows[beneficiary].push(escrowId);
        _escrowResolver[escrowId] = resolver;

        // Effects done; now register the condition. nonReentrant blocks
        // re-entry, and a reverting resolver only fails its own create.
        IConditionResolver(resolver).onConditionSet(escrowId, resolverData);

        emit EscrowCreated(escrowId, msg.sender, beneficiary, address(0), deadline);
        emit EscrowResolverSet(escrowId, resolver);
        try eventHub.emitActivity(msg.sender, beneficiary, "escrow_created", description, escrowId) {} catch {}
    }

    // ─── Markers ──────────────────────────────────────────────────────

    function markDelivered(uint256 escrowId) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Active, "EncryptedEscrow: not active");
        require(msg.sender == e.beneficiary, "EncryptedEscrow: not beneficiary");
        // §2.5 A17 of BEST_VERSION_FULL_PLAN: idempotency guard prevents
        // duplicate EscrowDelivered events polluting the indexer between
        // markDelivered and depositor approval.
        require(!e.beneficiaryMarkedDelivered, "EncryptedEscrow: already delivered");
        e.beneficiaryMarkedDelivered = true;
        emit EscrowDelivered(escrowId, msg.sender);
        try eventHub.emitActivity(msg.sender, e.depositor, "escrow_delivered", "", escrowId) {} catch {}
        if (e.depositorApproved) _release(escrowId);
    }

    function approveRelease(uint256 escrowId) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Active, "EncryptedEscrow: not active");
        require(msg.sender == e.depositor, "EncryptedEscrow: not depositor");
        // §2.5 A17: same idempotency guard for approval-side.
        require(!e.depositorApproved, "EncryptedEscrow: already approved");
        e.depositorApproved = true;
        emit EscrowApproved(escrowId, msg.sender);
        if (e.beneficiaryMarkedDelivered) _release(escrowId);
    }

    // ─── Conditional release trigger ──────────────────────────────────

    /// @notice Release a resolver-gated escrow once its rule says so.
    ///         Permissionless: the resolver does the gating, so anyone may
    ///         poke it (the vendor after the auto-release deadline, or right
    ///         after the buyer approves). Reverts for non-conditional escrows.
    function releaseIfConditionMet(uint256 escrowId) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Active, "EncryptedEscrow: not active");
        address resolver = _escrowResolver[escrowId];
        require(resolver != address(0), "EncryptedEscrow: no resolver");
        require(
            IConditionResolver(resolver).isConditionMet(escrowId),
            "EncryptedEscrow: condition not met"
        );
        _release(escrowId);
    }

    // ─── Disputes ─────────────────────────────────────────────────────

    function disputeEscrow(uint256 escrowId) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Active, "EncryptedEscrow: not active");
        require(msg.sender == e.depositor || msg.sender == e.beneficiary, "EncryptedEscrow: not a party");
        require(e.arbiter != address(0), "EncryptedEscrow: no arbiter, use claimExpiredEscrow at deadline");
        e.status = EscrowStatus.Disputed;
        // §2.4: grant arbiter decrypt rights only when dispute opens.
        // arbiterDecide will need the encrypted amount to make an informed
        // call. Pre-dispute, the grant was unnecessary leakage.
        FHE.allow(e.encAmount, e.arbiter);
        emit EscrowDisputed(escrowId, msg.sender);
        try eventHub.emitActivity(msg.sender, address(0), "escrow_disputed", e.description, escrowId) {} catch {}
    }

    function arbiterDecide(uint256 escrowId, bool releaseToBeneficiary) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Disputed, "EncryptedEscrow: not disputed");
        require(e.arbiter != address(0) && msg.sender == e.arbiter, "EncryptedEscrow: not arbiter");

        address recipient = releaseToBeneficiary ? e.beneficiary : e.depositor;
        e.status = EscrowStatus.Released;

        FHE.allowTransient(e.encAmount, e.vault);
        euint64 paid = IFHERC20Vault(e.vault).transferVerified(recipient, e.encAmount);
        FHE.allowThis(paid);
        FHE.allow(paid, recipient);

        if (releaseToBeneficiary) _bumpReceiptsAndGlobal(e.beneficiary, paid);

        emit EscrowArbiterDecided(escrowId, msg.sender, releaseToBeneficiary);
        emit EscrowReleased(escrowId, recipient);
        try eventHub.emitActivity(msg.sender, recipient, "escrow_arbiter_decided", e.description, escrowId) {} catch {}
    }

    // ─── Expiry refund ────────────────────────────────────────────────

    /// @notice After deadline, depositor can pull funds back. Active state only.
    function claimExpiredEscrow(uint256 escrowId) external nonReentrant {
        Escrow storage e = _escrows[escrowId];
        require(e.status == EscrowStatus.Active, "EncryptedEscrow: not active");
        require(msg.sender == e.depositor, "EncryptedEscrow: not depositor");
        require(block.timestamp >= e.deadline, "EncryptedEscrow: not yet expired");
        // Resolver-gated escrows release exclusively through
        // releaseIfConditionMet, so the depositor cannot race a refund here.
        require(_escrowResolver[escrowId] == address(0), "EncryptedEscrow: resolver-gated escrow");

        e.status = EscrowStatus.Refunded;

        FHE.allowTransient(e.encAmount, e.vault);
        IFHERC20Vault(e.vault).transferVerified(msg.sender, e.encAmount);

        emit EscrowExpiryClaimed(escrowId, msg.sender);
        try eventHub.emitActivity(msg.sender, address(0), "escrow_expired_claimed", e.description, escrowId) {} catch {}
    }

    // ─── Internal release path ────────────────────────────────────────

    function _release(uint256 escrowId) internal {
        Escrow storage e = _escrows[escrowId];
        e.status = EscrowStatus.Released;

        FHE.allowTransient(e.encAmount, e.vault);
        euint64 paid = IFHERC20Vault(e.vault).transferVerified(e.beneficiary, e.encAmount);
        FHE.allowThis(paid);
        FHE.allow(paid, e.beneficiary);

        _bumpReceiptsAndGlobal(e.beneficiary, paid);

        emit EscrowReleased(escrowId, e.beneficiary);
        try eventHub.emitActivity(e.depositor, e.beneficiary, "escrow_released", e.description, escrowId) {} catch {}
    }

    // ─── Views ────────────────────────────────────────────────────────

    function getEscrow(uint256 escrowId) external view returns (
        address depositor,
        address beneficiary,
        address arbiter,
        address vault,
        uint256 deadline,
        bool depositorApproved,
        bool beneficiaryMarkedDelivered,
        EscrowStatus status,
        string memory description,
        uint256 createdAt
    ) {
        Escrow storage e = _escrows[escrowId];
        return (
            e.depositor, e.beneficiary, e.arbiter, e.vault,
            e.deadline, e.depositorApproved, e.beneficiaryMarkedDelivered,
            e.status, e.description, e.createdAt
        );
    }

    function getEncryptedAmount(uint256 escrowId) external view returns (euint64) {
        return _escrows[escrowId].encAmount;
    }

    function getUserEscrows(address user) external view returns (uint256[] memory) {
        return _userEscrows[user];
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

    /// @dev Append-only storage. Used: 7 (added _escrowResolver in this rev).
    /// Gap: 49. Decrement gap by 1 when adding a new state variable; total
    /// slots (used + gap) must stay constant across UUPS upgrades.
    uint256[49] private __gap;
}
