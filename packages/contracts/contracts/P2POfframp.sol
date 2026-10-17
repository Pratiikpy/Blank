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
    function transferVerified(address to, sharedEuint64 shared) external returns (sharedEuint64);
}

interface IReclaimAdapter {
    function verifyAndConsume(
        bytes calldata proof,
        uint32 providerId,
        bytes32 expectedReceiver,
        uint64 expectedAmount,
        uint64 fillId,
        address taker
    ) external returns (bytes32 proofHash);
}

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

/// @title P2POfframp — Wave 5 headline build
/// @notice Encrypted P2P offramp: maker posts an encrypted USDC offer
///         against a plaintext fiat price + rail (UPI / Wise / Venmo /
///         PayPal). Taker locks an encrypted fill amount, pays the
///         maker off-chain via the rail, submits a Reclaim Protocol
///         attestation proof, and after a challenge window the USDC
///         releases.
///
/// @dev    Every payout (release, arbiter, expiry, stale dispute) pays the
///         handle the vault actually moved into escrow at takeOffer, never
///         the maker's requested amount. The vault moves 0 when the maker is
///         short, so the taker gets decrypt access to the escrowed handle and
///         must check it before sending fiat. v1 is full-fill only, so
///         encMinFill is stored but not enforced. The fiat price is plaintext
///         so takers can find offers.
///
///         CHALLENGE_WINDOW_SECONDS is constructor immutable so
///         testnet can ship with 5min and mainnet (Wave 6, if any)
///         can ship with 24h without storage drift.
contract P2POfframp is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {

    enum OfferState   { Open, Cancelled, Filled }
    enum FillState    { Locked, ProofSubmitted, Released, Disputed, Resolved, Refunded }

    struct Offer {
        address maker;
        address vault;                   // FHERC20Vault used for settlement
        uint64  fiatAmountMicroUSD;      // plaintext (sortable)
        uint64  fiatRateMicroUSD;        // plaintext (sortable)
        euint64 encUsdcAmount;           // encrypted USDC offered
        euint64 encMinFill;              // encrypted minimum fill
        uint32  fiatRail;                // 1..6 (see ReclaimAdapter)
        bytes32 makerHandleHash;         // maker's rail-side handle digest
        uint32  expiry;
        uint32  createdAt;
        OfferState state;
    }

    struct Fill {
        uint64  offerId;
        address taker;
        euint64 encAmountAtLock;         // snapshot for drift check
        uint64  fiatAmountAtLockMicroUSD;// plaintext, equals offer amount * fillFraction
        uint32  lockedAt;
        uint32  proofSubmittedAt;
        bytes32 reclaimProofHash;
        FillState state;
    }

    // ─── Configuration ─────────────────────────────────────────────

    /// Configurable per-deploy so testnet ships fast iteration and
    /// mainnet (if ever) ships safe windows.
    uint32 public CHALLENGE_WINDOW_SECONDS;

    /// 3-of-5 multisig in Wave 5. Owner sets at init; can be
    /// rotated by setArbiter.
    address public arbiter;

    IReclaimAdapter public reclaimAdapter;
    IEventHub public eventHub;

    // ─── State ─────────────────────────────────────────────────────

    uint64 public nextOfferId;
    uint64 public nextFillId;

    mapping(uint64 => Offer) public offers;
    mapping(uint64 => Fill) public fills;
    mapping(uint64 => uint64) public fillToOffer;       // reverse lookup

    /// Maker reputation. Plaintext counters; absolute fill count is
    /// not sensitive.
    mapping(address => uint32) public makerFillCount;
    mapping(address => uint32) public makerDisputeCount;

    // ─── Events ────────────────────────────────────────────────────

    event OfferCreated(
        uint64 indexed offerId,
        address indexed maker,
        uint64 fiatAmountMicroUSD,
        uint64 fiatRateMicroUSD,
        uint32 fiatRail,
        bytes32 makerHandleHash,
        uint32 expiry
    );
    event OfferCancelled(uint64 indexed offerId);
    event FillLocked(uint64 indexed fillId, uint64 indexed offerId, address indexed taker, uint64 fiatAmountAtLockMicroUSD);
    event ProofSubmitted(uint64 indexed fillId, bytes32 proofHash);
    event FillReleased(uint64 indexed fillId);
    event FillDisputed(uint64 indexed fillId, string reason);
    event FillResolved(uint64 indexed fillId, bool releasedToTaker);
    event FillRefunded(uint64 indexed fillId);
    event ArbiterChanged(address indexed previous, address indexed next);
    event ReclaimAdapterChanged(address indexed previous, address indexed next);
    event ChallengeWindowChanged(uint32 previous, uint32 next);
    event TokenRegistrySet(address indexed registry);
    event FillEscrowed(uint64 indexed fillId, euint64 escrowed);
    event StaleDisputeReleased(uint64 indexed fillId);

    /// Arbiter has this long after a dispute before anyone can apply the
    /// default outcome (release to the taker, whose payment proof already
    /// passed the verifier).
    uint32 public constant DISPUTE_TIMEOUT_SECONDS = 7 days;
    /// Taker has this long after locking to submit a payment proof.
    uint32 public constant PROOF_WINDOW_SECONDS = 24 hours;
    /// Open locks one taker address may hold at once. Caps free offer
    /// griefing: each lock freezes a maker's offer for PROOF_WINDOW_SECONDS.
    /// Known limitation (testnet-only feature): the cap is per address, so
    /// fresh addresses can still lock every open offer for 24h at gas cost
    /// only. A taker lock bond was not added: it needs a plaintext token
    /// path, a slashing rule that must tell a griefer from a taker whose
    /// rail payment failed, and refunds on every exit, which is more new
    /// fund-holding surface than the grief it removes. Mainnet needs a bond
    /// or a maker-side taker allowlist before this ships.
    uint32 public constant MAX_ACTIVE_LOCKS_PER_TAKER = 1;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(
        address _arbiter,
        address _reclaimAdapter,
        address _eventHub,
        uint32  _challengeWindowSeconds
    ) public initializer {
        __Ownable_init(msg.sender);
        require(_challengeWindowSeconds >= 60, "P2POfframp: window too short");
        require(_challengeWindowSeconds <= 7 days, "P2POfframp: window too long");
        require(_arbiter != address(0), "P2POfframp: zero arbiter");
        require(_reclaimAdapter.code.length > 0, "P2POfframp: bad adapter");
        arbiter = _arbiter;
        reclaimAdapter = IReclaimAdapter(_reclaimAdapter);
        eventHub = IEventHub(_eventHub);
        CHALLENGE_WINDOW_SECONDS = _challengeWindowSeconds;
        emit ArbiterChanged(address(0), _arbiter);
    }

    // ─── Admin ─────────────────────────────────────────────────────

    function setArbiter(address newArbiter) external onlyOwner {
        require(newArbiter != address(0), "P2POfframp: zero arbiter");
        emit ArbiterChanged(arbiter, newArbiter);
        arbiter = newArbiter;
    }

    function setReclaimAdapter(address newAdapter) external onlyOwner {
        require(newAdapter.code.length > 0, "P2POfframp: bad adapter");
        emit ReclaimAdapterChanged(address(reclaimAdapter), newAdapter);
        reclaimAdapter = IReclaimAdapter(newAdapter);
    }

    function setChallengeWindow(uint32 newWindow) external onlyOwner {
        require(newWindow >= 60, "P2POfframp: window too short");
        require(newWindow <= 7 days, "P2POfframp: window too long");
        emit ChallengeWindowChanged(CHALLENGE_WINDOW_SECONDS, newWindow);
        CHALLENGE_WINDOW_SECONDS = newWindow;
    }

    function setTokenRegistry(address r) external onlyOwner {
        require(r.code.length > 0, "P2POfframp: bad registry");
        tokenRegistry = ITokenRegistry(r);
        emit TokenRegistrySet(r);
    }

    function _requireAllowedVault(address vault) internal view {
        require(
            address(tokenRegistry) != address(0) && tokenRegistry.isActiveVault(vault),
            "P2POfframp: vault not allowed"
        );
    }

    // ─── Maker side ────────────────────────────────────────────────

    /// Create an offer. Maker's vault USDC stays in maker's account
    /// until takeOffer; we just record intent here. Maker MUST have
    /// pre-approved the vault to this contract's address.
    /// @param proof One batch signature covering `encAmount` then `encMinFill`,
    ///        in that exact order.
    function createOffer(
        address vault,
        externalEuint64 encAmount,
        externalEuint64 encMinFill,
        bytes calldata proof,
        uint32 fiatRail,
        bytes32 makerHandleHash,
        uint64 fiatAmountMicroUSD,
        uint64 fiatRateMicroUSD,
        uint32 expirySeconds
    ) external nonReentrant returns (uint64 offerId) {
        require(vault != address(0), "P2POfframp: vault");
        _requireAllowedVault(vault);
        require(fiatRail >= 1 && fiatRail <= 6, "P2POfframp: rail");
        require(fiatAmountMicroUSD > 0, "P2POfframp: fiat zero");
        require(fiatRateMicroUSD > 0, "P2POfframp: rate zero");
        require(expirySeconds >= 5 minutes, "P2POfframp: expiry too short");
        require(expirySeconds <= 7 days, "P2POfframp: expiry too long");

        offerId = nextOfferId++;

        externalEuint64[] memory packed = new externalEuint64[](2);
        packed[0] = encAmount;
        packed[1] = encMinFill;
        euint64[] memory verified = FHE.asEuint64s(packed, proof);
        euint64 encUsdc = verified[0];
        euint64 encMin  = verified[1];
        FHE.allowThis(encUsdc);
        FHE.allowThis(encMin);
        FHE.allow(encUsdc, msg.sender);
        FHE.allow(encMin, msg.sender);

        offers[offerId] = Offer({
            maker: msg.sender,
            vault: vault,
            fiatAmountMicroUSD: fiatAmountMicroUSD,
            fiatRateMicroUSD: fiatRateMicroUSD,
            encUsdcAmount: encUsdc,
            encMinFill: encMin,
            fiatRail: fiatRail,
            makerHandleHash: makerHandleHash,
            expiry: uint32(block.timestamp + expirySeconds),
            createdAt: uint32(block.timestamp),
            state: OfferState.Open
        });

        emit OfferCreated(offerId, msg.sender, fiatAmountMicroUSD, fiatRateMicroUSD, fiatRail, makerHandleHash, uint32(block.timestamp + expirySeconds));
        try eventHub.emitActivity(msg.sender, address(0), "offramp_offer_created", "", offerId) {} catch {}
    }

    /// Maker cancels an open offer with no active fill.
    function cancelOffer(uint64 offerId) external nonReentrant {
        Offer storage o = offers[offerId];
        require(o.maker == msg.sender, "P2POfframp: not maker");
        require(o.state == OfferState.Open, "P2POfframp: not open");

        o.state = OfferState.Cancelled;
        emit OfferCancelled(offerId);
        try eventHub.emitActivity(msg.sender, address(0), "offramp_offer_cancelled", "", offerId) {} catch {}
    }

    // ─── Taker side ────────────────────────────────────────────────

    /// Lock the offer. v1 is full-fill only: the taker accepts the
    /// entire offer amount. Pulls the maker's encrypted USDC into
    /// this contract so it's escrowed until release or refund.
    /// The vault moves 0 if the maker is short, so the taker must decrypt
    /// getEscrowedAmount(fillId) before sending fiat.
    function takeOffer(
        uint64 offerId
    ) external nonReentrant returns (uint64 fillId) {
        Offer storage o = offers[offerId];
        require(o.state == OfferState.Open, "P2POfframp: offer not open");
        require(block.timestamp < o.expiry, "P2POfframp: offer expired");
        require(msg.sender != o.maker, "P2POfframp: maker cannot self-take");
        _requireAllowedVault(o.vault);
        require(activeLocks[msg.sender] < MAX_ACTIVE_LOCKS_PER_TAKER, "P2POfframp: too many open locks");
        activeLocks[msg.sender] += 1;

        euint64 moved = FHE.receiveEuint64FromCall(
            IFHERC20Vault(o.vault).transferFromVerified(o.maker, address(this), FHE.shareEuint64(o.encUsdcAmount, o.vault)),
            o.vault
        );
        FHE.allowThis(moved);
        FHE.allow(moved, msg.sender);
        FHE.allow(moved, o.maker);

        // Kept for the legacy getter shape; payouts use fillEscrowed.
        euint64 encFill = o.encUsdcAmount;
        FHE.allowThis(encFill);
        FHE.allow(encFill, msg.sender);

        fillId = nextFillId++;
        fillEscrowed[fillId] = moved;
        fills[fillId] = Fill({
            offerId: offerId,
            taker: msg.sender,
            encAmountAtLock: encFill,
            fiatAmountAtLockMicroUSD: o.fiatAmountMicroUSD,
            lockedAt: uint32(block.timestamp),
            proofSubmittedAt: 0,
            reclaimProofHash: bytes32(0),
            state: FillState.Locked
        });
        fillToOffer[fillId] = offerId;

        o.state = OfferState.Filled;

        emit FillLocked(fillId, offerId, msg.sender, o.fiatAmountMicroUSD);
        emit FillEscrowed(fillId, moved);
        try eventHub.emitActivity(msg.sender, o.maker, "offramp_fill_locked", "", fillId) {} catch {}
    }

    /// Taker submits a Reclaim proof attesting they paid via the rail.
    /// Adapter validates + marks the proof used, returns proofHash for
    /// on-chain anti-replay.
    function submitProof(
        uint64 fillId,
        bytes calldata reclaimProof,
        uint32 providerId
    ) external nonReentrant {
        Fill storage f = fills[fillId];
        require(f.taker == msg.sender, "P2POfframp: not taker");
        require(f.state == FillState.Locked, "P2POfframp: bad state");

        Offer storage o = offers[f.offerId];
        require(providerId == o.fiatRail, "P2POfframp: provider/rail mismatch");

        // Adapter checks: provider allowlist, proof validity, amount
        // match (against fill.fiatAmountAtLockMicroUSD, NOT a
        // caller-supplied parameter), fill + taker binding, replay.
        bytes32 proofHash = reclaimAdapter.verifyAndConsume(
            reclaimProof,
            providerId,
            o.makerHandleHash,
            f.fiatAmountAtLockMicroUSD,
            fillId,
            msg.sender
        );
        _releaseLock(msg.sender);

        f.reclaimProofHash = proofHash;
        f.proofSubmittedAt = uint32(block.timestamp);
        f.state = FillState.ProofSubmitted;

        emit ProofSubmitted(fillId, proofHash);
        try eventHub.emitActivity(msg.sender, o.maker, "offramp_proof_submitted", "", fillId) {} catch {}
    }

    /// Release after challenge window expires without dispute. Anyone
    /// can call; releases USDC to the taker.
    function releaseFill(uint64 fillId) external nonReentrant {
        Fill storage f = fills[fillId];
        require(f.state == FillState.ProofSubmitted, "P2POfframp: bad state");
        require(
            block.timestamp >= f.proofSubmittedAt + CHALLENGE_WINDOW_SECONDS,
            "P2POfframp: window open"
        );

        Offer storage o = offers[f.offerId];

        f.state = FillState.Released;
        _payOut(o.vault, f.taker, fillId);
        makerFillCount[o.maker] += 1;

        emit FillReleased(fillId);
        try eventHub.emitActivity(o.maker, f.taker, "offramp_released", "", fillId) {} catch {}
    }

    /// Maker disputes the fill. Must be within the challenge window.
    function disputeFill(uint64 fillId, string calldata reason) external nonReentrant {
        Fill storage f = fills[fillId];
        Offer storage o = offers[f.offerId];
        require(o.maker == msg.sender, "P2POfframp: not maker");
        require(f.state == FillState.ProofSubmitted, "P2POfframp: bad state");
        require(
            block.timestamp < f.proofSubmittedAt + CHALLENGE_WINDOW_SECONDS,
            "P2POfframp: window closed"
        );

        f.state = FillState.Disputed;
        fillDisputedAt[fillId] = uint32(block.timestamp);
        makerDisputeCount[o.maker] += 1;
        emit FillDisputed(fillId, reason);
        try eventHub.emitActivity(msg.sender, f.taker, "offramp_disputed", reason, fillId) {} catch {}
    }

    /// Arbiter resolves a dispute. Either releases to taker (taker
    /// proved payment) or refunds to maker (proof rejected).
    function arbiterResolve(uint64 fillId, bool releaseToTaker) external nonReentrant {
        require(msg.sender == arbiter, "P2POfframp: not arbiter");
        Fill storage f = fills[fillId];
        require(f.state == FillState.Disputed, "P2POfframp: not disputed");

        Offer storage o = offers[f.offerId];

        if (releaseToTaker) {
            f.state = FillState.Resolved;
            makerFillCount[o.maker] += 1;
            _payOut(o.vault, f.taker, fillId);
        } else {
            f.state = FillState.Refunded;
            _payOut(o.vault, o.maker, fillId);
        }

        emit FillResolved(fillId, releaseToTaker);
        try eventHub.emitActivity(o.maker, f.taker, releaseToTaker ? "offramp_resolved_taker" : "offramp_resolved_maker", "", fillId) {} catch {}
    }

    /// Default outcome for a dispute the arbiter left open past
    /// DISPUTE_TIMEOUT_SECONDS. Releases to the taker: their payment proof
    /// already passed the verifier, and a refund default would let a maker
    /// keep the fiat and the USDC by disputing and waiting. Anyone can call.
    function resolveStaleDispute(uint64 fillId) external nonReentrant {
        Fill storage f = fills[fillId];
        require(f.state == FillState.Disputed, "P2POfframp: not disputed");
        uint32 disputedAt = fillDisputedAt[fillId];
        require(disputedAt != 0, "P2POfframp: legacy dispute, arbiter only");
        require(block.timestamp >= uint256(disputedAt) + DISPUTE_TIMEOUT_SECONDS, "P2POfframp: arbiter window open");

        Offer storage o = offers[f.offerId];
        f.state = FillState.Resolved;
        makerFillCount[o.maker] += 1;
        _payOut(o.vault, f.taker, fillId);

        emit FillResolved(fillId, true);
        emit StaleDisputeReleased(fillId);
        try eventHub.emitActivity(o.maker, f.taker, "offramp_resolved_timeout", "", fillId) {} catch {}
    }

    /// Maker reclaims the escrowed USDC if the taker never submitted
    /// a proof within PROOF_WINDOW_SECONDS of locking.
    function expireFill(uint64 fillId) external nonReentrant {
        Fill storage f = fills[fillId];
        Offer storage o = offers[f.offerId];
        require(o.maker == msg.sender, "P2POfframp: not maker");
        require(f.state == FillState.Locked, "P2POfframp: bad state");
        require(block.timestamp >= f.lockedAt + PROOF_WINDOW_SECONDS, "P2POfframp: proof window open");

        _releaseLock(f.taker);
        f.state = FillState.Refunded;
        _payOut(o.vault, o.maker, fillId);
        emit FillRefunded(fillId);
        try eventHub.emitActivity(o.maker, f.taker, "offramp_expired", "", fillId) {} catch {}
    }

    // ─── Views ─────────────────────────────────────────────────────

    function getOffer(uint64 offerId) external view returns (
        address maker,
        address vault,
        uint64 fiatAmountMicroUSD,
        uint64 fiatRateMicroUSD,
        uint32 fiatRail,
        bytes32 makerHandleHash,
        uint32 expiry,
        OfferState state
    ) {
        Offer storage o = offers[offerId];
        return (o.maker, o.vault, o.fiatAmountMicroUSD, o.fiatRateMicroUSD, o.fiatRail, o.makerHandleHash, o.expiry, o.state);
    }

    function getFill(uint64 fillId) external view returns (
        uint64 offerId,
        address taker,
        uint64 fiatAmountAtLockMicroUSD,
        uint32 lockedAt,
        uint32 proofSubmittedAt,
        bytes32 reclaimProofHash,
        FillState state
    ) {
        Fill storage f = fills[fillId];
        return (f.offerId, f.taker, f.fiatAmountAtLockMicroUSD, f.lockedAt, f.proofSubmittedAt, f.reclaimProofHash, f.state);
    }

    function getMakerReputation(address maker) external view returns (uint32 fillCount, uint32 disputeCount) {
        return (makerFillCount[maker], makerDisputeCount[maker]);
    }

    /// @notice Encrypted amount the vault actually moved into escrow for a
    ///         fill. Taker and maker can decrypt it.
    function getEscrowedAmount(uint64 fillId) external view returns (euint64) {
        return _escrowedOf(fillId);
    }

    // ─── Internals ─────────────────────────────────────────────────

    /// Fills locked before this upgrade have no stored moved handle; they
    /// fall back to the lock snapshot so their exits keep working.
    function _escrowedOf(uint64 fillId) internal view returns (euint64) {
        euint64 moved = fillEscrowed[fillId];
        return euint64.unwrap(moved) != 0 ? moved : fills[fillId].encAmountAtLock;
    }

    function _payOut(address vault, address to, uint64 fillId) internal {
        IFHERC20Vault(vault).transferVerified(to, FHE.shareEuint64(_escrowedOf(fillId), vault));
    }

    function _releaseLock(address taker) internal {
        if (activeLocks[taker] > 0) activeLocks[taker] -= 1;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ─── Appended storage (UUPS) ───────────────────────────────────

    ITokenRegistry public tokenRegistry;
    /// fillId => handle the vault actually moved into escrow at takeOffer.
    mapping(uint64 => euint64) public fillEscrowed;
    /// fillId => dispute timestamp, for the stale-dispute default.
    mapping(uint64 => uint32) public fillDisputedAt;
    /// taker => fills currently in Locked state.
    mapping(address => uint32) public activeLocks;

    /// @dev Reserved for future appends.
    uint256[46] private __gap;
}
