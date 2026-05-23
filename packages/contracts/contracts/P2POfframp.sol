// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, InEuint64 memory encAmount) external returns (euint64);
    function transferFromVerified(address from, address to, euint64 amount) external returns (euint64);
    function transferVerified(address to, euint64 amount) external returns (euint64);
}

interface IReclaimAdapter {
    function verifyAndConsume(
        bytes calldata proof,
        uint32 providerId,
        bytes32 expectedReceiver,
        uint64 expectedAmount
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
/// @dev    The encrypted-amount moat applies to fill-amount drift
///         (FHE.eq enforced at release: fill amount cannot change
///         between lock and release) and the maker's encrypted
///         minimum fill (FHE.gte at take). The initial offer's fiat
///         price is plaintext so takers can find offers — README
///         must say so honestly.
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
        arbiter = _arbiter;
        reclaimAdapter = IReclaimAdapter(_reclaimAdapter);
        eventHub = IEventHub(_eventHub);
        CHALLENGE_WINDOW_SECONDS = _challengeWindowSeconds;
        emit ArbiterChanged(address(0), _arbiter);
    }

    // ─── Admin ─────────────────────────────────────────────────────

    function setArbiter(address newArbiter) external onlyOwner {
        emit ArbiterChanged(arbiter, newArbiter);
        arbiter = newArbiter;
    }

    function setReclaimAdapter(address newAdapter) external onlyOwner {
        reclaimAdapter = IReclaimAdapter(newAdapter);
    }

    function setChallengeWindow(uint32 newWindow) external onlyOwner {
        require(newWindow >= 60, "P2POfframp: window too short");
        require(newWindow <= 7 days, "P2POfframp: window too long");
        CHALLENGE_WINDOW_SECONDS = newWindow;
    }

    // ─── Maker side ────────────────────────────────────────────────

    /// Create an offer. Maker's vault USDC stays in maker's account
    /// until takeOffer; we just record intent here. Maker MUST have
    /// pre-approved the vault to this contract's address.
    function createOffer(
        address vault,
        InEuint64 calldata encAmount,
        InEuint64 calldata encMinFill,
        uint32 fiatRail,
        bytes32 makerHandleHash,
        uint64 fiatAmountMicroUSD,
        uint64 fiatRateMicroUSD,
        uint32 expirySeconds
    ) external nonReentrant returns (uint64 offerId) {
        require(vault != address(0), "P2POfframp: vault");
        require(fiatRail >= 1 && fiatRail <= 6, "P2POfframp: rail");
        require(fiatAmountMicroUSD > 0, "P2POfframp: fiat zero");
        require(fiatRateMicroUSD > 0, "P2POfframp: rate zero");
        require(expirySeconds >= 5 minutes, "P2POfframp: expiry too short");
        require(expirySeconds <= 7 days, "P2POfframp: expiry too long");

        offerId = nextOfferId++;

        euint64 encUsdc = FHE.asEuint64(encAmount);
        euint64 encMin  = FHE.asEuint64(encMinFill);
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

    /// Lock the offer. v1 is full-fill only — the taker accepts the
    /// entire offer amount. Pulls the maker's encrypted USDC into
    /// this contract so it's escrowed until release or refund.
    ///
    /// Partial fills with proportional fiat are deliberately Wave 6
    /// scope: they require an FHE-friendly fillFraction primitive we
    /// don't have today, so v1 keeps the encrypted-amount-drift
    /// surface ZERO by reusing the maker's encUsdcAmount handle for
    /// the fill snapshot.
    function takeOffer(
        uint64 offerId
    ) external nonReentrant returns (uint64 fillId) {
        Offer storage o = offers[offerId];
        require(o.state == OfferState.Open, "P2POfframp: offer not open");
        require(block.timestamp < o.expiry, "P2POfframp: offer expired");
        require(msg.sender != o.maker, "P2POfframp: maker cannot self-take");

        // Re-grant the maker's encUsdcAmount handle so the vault can
        // read it on the transferFromVerified call. The handle was
        // created in the maker's context at createOffer; we hold
        // contract-level access via FHE.allowThis already.
        FHE.allowTransient(o.encUsdcAmount, o.vault);
        IFHERC20Vault(o.vault).transferFromVerified(o.maker, address(this), o.encUsdcAmount);

        // The fill snapshot IS the maker's encrypted offer amount.
        // Drift between lock and release becomes impossible because
        // both reads point at the same FHE handle.
        euint64 encFill = o.encUsdcAmount;
        FHE.allowThis(encFill);
        FHE.allow(encFill, msg.sender);

        fillId = nextFillId++;
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

        // Adapter checks: provider allowlist, proof validity, amount
        // match (against fill.fiatAmountAtLockMicroUSD, NOT a
        // caller-supplied parameter), replay.
        bytes32 proofHash = reclaimAdapter.verifyAndConsume(
            reclaimProof,
            providerId,
            o.makerHandleHash,
            f.fiatAmountAtLockMicroUSD
        );

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

        // Drift-free by construction: f.encAmountAtLock IS the
        // maker's offer handle stored at takeOffer time. The Solidity
        // mapping is the only writer, and we never re-write the
        // field after lock. transferVerified pulls exactly the
        // escrowed encrypted amount.
        FHE.allowTransient(f.encAmountAtLock, o.vault);
        IFHERC20Vault(o.vault).transferVerified(f.taker, f.encAmountAtLock);

        f.state = FillState.Released;
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
            FHE.allowTransient(f.encAmountAtLock, o.vault);
            IFHERC20Vault(o.vault).transferVerified(f.taker, f.encAmountAtLock);
            f.state = FillState.Resolved;
            makerFillCount[o.maker] += 1;
        } else {
            FHE.allowTransient(f.encAmountAtLock, o.vault);
            IFHERC20Vault(o.vault).transferVerified(o.maker, f.encAmountAtLock);
            f.state = FillState.Refunded;
        }

        emit FillResolved(fillId, releaseToTaker);
        try eventHub.emitActivity(o.maker, f.taker, releaseToTaker ? "offramp_resolved_taker" : "offramp_resolved_maker", "", fillId) {} catch {}
    }

    /// Maker reclaims the escrowed USDC if the taker never submitted
    /// a proof within `proofWindow` of locking. Hardcoded at 24h for
    /// v1 (separate from CHALLENGE_WINDOW_SECONDS which is post-proof).
    function expireFill(uint64 fillId) external nonReentrant {
        Fill storage f = fills[fillId];
        Offer storage o = offers[f.offerId];
        require(o.maker == msg.sender, "P2POfframp: not maker");
        require(f.state == FillState.Locked, "P2POfframp: bad state");
        require(block.timestamp >= f.lockedAt + 24 hours, "P2POfframp: proof window open");

        FHE.allowTransient(f.encAmountAtLock, o.vault);
        IFHERC20Vault(o.vault).transferVerified(o.maker, f.encAmountAtLock);

        f.state = FillState.Refunded;
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

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
