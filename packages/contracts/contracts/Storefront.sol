// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./utils/ReentrancyGuard.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, InEuint64 memory encAmount) external returns (euint64);
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

/// @title Storefront — one-product page with three private sale modes
/// @notice A creator or seller posts ONE thing they want to sell. Buyers
///         pay privately via:
///           - FixedPrice  : single encrypted price, anyone can buy.
///           - Auction     : sealed-bid, FHE.max picks winner at close.
///           - PayWhatYouWant : any encrypted amount; total stays private.
///
/// @dev Bundles the claim-link experience (one URL = one private sale)
///      with FHE-only auction mechanics. Seller's revenue, buyer's bids,
///      and PWYW contributions all stay encrypted. Plaintext fields are
///      strictly social: title, description CID hash, delivery channel.
///
///      Storage layout:
///        - One canonical `Listing` struct per listingId.
///        - Per-listing bidder list + encrypted bid amounts.
///        - Funds custody: contract holds vault tokens for the duration
///          of an auction (so loser-refund paths can release).
contract Storefront is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {

    // ─── Types ────────────────────────────────────────────────────────

    enum SaleMode { FixedPrice, Auction, PayWhatYouWant }

    struct Listing {
        address seller;
        address vault;
        SaleMode mode;
        // FixedPrice: encrypted price the buyer must match (FHE.eq).
        // Auction:    encrypted minimum bid (also reused as base for FHE.max init).
        // PWYW:       unused.
        euint64 encPrice;
        // Auction-only: when bids close (unix timestamp). 0 for fixed/PWYW.
        uint256 closesAt;
        // Auction-only: winning bidder address; 0x0 until closed.
        address winner;
        // Auction-only: handle to the maximum bid amount, set during close.
        // FixedPrice/PWYW: zero — buyer transfer is direct, not held.
        euint64 winningBid;
        bool active;
        bool closed;
        // Marketplace metadata (plaintext — not the privacy-sensitive part).
        string title;
        bytes32 descriptionCidHash;  // IPFS CID hash of full description + image gallery.
        string deliveryChannel;      // "DM creator on telegram" / "support@store.com"
        uint256 createdAt;
    }

    struct Bid {
        address bidder;
        euint64 amount;
        bool refunded;
    }

    // ─── State ────────────────────────────────────────────────────────

    IEventHub public eventHub;
    address public paymentReceipts;

    uint256 public nextListingId;
    mapping(uint256 => Listing) private _listings;

    /// @dev Per-auction bid list (in submission order).
    mapping(uint256 => Bid[]) private _bids;

    /// @dev Reverse lookups.
    mapping(address => uint256[]) private _sellerListings;

    /// @dev §1.4 phase B (BEST_VERSION_FULL_PLAN): encrypted winner-index per
    /// auction listingId. Set in closeAuction via FHE-tournament selection.
    /// Decrypted off-chain and posted via revealWinner() with EIP-712 signature.
    /// Append-only addition; __gap reduced by 1 slot below.
    mapping(uint256 => euint8) private _winnerIdxHandle;

    /// @dev Auction config: minimum auction window (1 hour) + maximum (30 days).
    uint256 public constant MIN_AUCTION_SECONDS = 1 hours;
    uint256 public constant MAX_AUCTION_SECONDS = 30 days;

    // ─── Events ───────────────────────────────────────────────────────

    event ListingCreated(
        uint256 indexed listingId,
        address indexed seller,
        SaleMode mode,
        address vault,
        uint256 closesAt,
        string title
    );

    event ListingDeactivated(uint256 indexed listingId, address indexed seller);

    event FixedPriceBuy(
        uint256 indexed listingId,
        address indexed buyer,
        address indexed seller,
        bytes32 deliveryNoteHash
    );

    event BidPlaced(
        uint256 indexed listingId,
        address indexed bidder,
        uint256 bidIndex,
        uint256 timestamp
    );

    event AuctionClosed(
        uint256 indexed listingId,
        address indexed winner,
        uint256 totalBids
    );

    event AuctionWinnerClaimed(
        uint256 indexed listingId,
        address indexed winner,
        bytes32 deliveryNoteHash
    );

    event BidRefunded(uint256 indexed listingId, address indexed bidder, uint256 bidIndex);

    event PWYWPayment(
        uint256 indexed listingId,
        address indexed payer,
        address indexed seller,
        bytes32 deliveryNoteHash
    );

    /// @notice §2.6 of BEST_VERSION_FULL_PLAN: emitted when paymentReceipts
    /// bump call reverts. kind is "user" or "global". Indexer detects + replays.
    event ReceiptsBumpFailed(string kind, bytes reason);

    // ─── Initializer ──────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _eventHub) public initializer {
        __Ownable_init(msg.sender);
        eventHub = IEventHub(_eventHub);
    }

    // ─── Create Listing ───────────────────────────────────────────────

    /// @notice Post a new product page. Returns the listingId. The shareable
    ///         URL is constructed off-chain as `/shop/<chain>/<listingId>`.
    ///
    /// @param mode             FixedPrice / Auction / PayWhatYouWant.
    /// @param vault            FHERC20Vault address for the token to settle in.
    /// @param encPrice         FixedPrice: exact match required.
    ///                         Auction: minimum bid (use 0-encrypted for "any").
    ///                         PWYW: ignored — pass 0-encrypted, contract drops it.
    /// @param auctionSeconds   For Auction only: seconds-from-now to close.
    ///                         Must be in [MIN_AUCTION_SECONDS, MAX_AUCTION_SECONDS].
    ///                         Pass 0 for FixedPrice / PWYW.
    /// @param title            Plaintext product title (public).
    /// @param descriptionCidHash IPFS CID hash for description + images.
    /// @param deliveryChannel  Plaintext channel for off-chain delivery (e.g.
    ///                         "DM creator on telegram"). Public.
    function createListing(
        SaleMode mode,
        address vault,
        InEuint64 calldata encPrice,
        uint256 auctionSeconds,
        string calldata title,
        bytes32 descriptionCidHash,
        string calldata deliveryChannel
    ) external nonReentrant returns (uint256 listingId) {
        require(vault != address(0), "Storefront: zero vault");
        require(bytes(title).length > 0 && bytes(title).length <= 200, "Storefront: bad title length");

        uint256 closesAt = 0;
        if (mode == SaleMode.Auction) {
            require(
                auctionSeconds >= MIN_AUCTION_SECONDS && auctionSeconds <= MAX_AUCTION_SECONDS,
                "Storefront: auction window out of range"
            );
            closesAt = block.timestamp + auctionSeconds;
        } else {
            require(auctionSeconds == 0, "Storefront: auctionSeconds only for Auction");
        }

        // Verify the encrypted price for FixedPrice / Auction. PWYW ignores it.
        euint64 verifiedPrice;
        if (mode != SaleMode.PayWhatYouWant) {
            verifiedPrice = FHE.asEuint64(encPrice);
            FHE.allowThis(verifiedPrice);
            FHE.allowSender(verifiedPrice);
        }

        listingId = nextListingId++;
        _listings[listingId] = Listing({
            seller: msg.sender,
            vault: vault,
            mode: mode,
            encPrice: verifiedPrice,
            closesAt: closesAt,
            winner: address(0),
            winningBid: euint64.wrap(0),
            active: true,
            closed: false,
            title: title,
            descriptionCidHash: descriptionCidHash,
            deliveryChannel: deliveryChannel,
            createdAt: block.timestamp
        });
        _sellerListings[msg.sender].push(listingId);

        emit ListingCreated(listingId, msg.sender, mode, vault, closesAt, title);
        try eventHub.emitActivity(msg.sender, address(0), "storefront_listed", title, listingId) {} catch {}
    }

    // ─── Fixed Price Buy ──────────────────────────────────────────────

    /// @notice Buy a FixedPrice listing. Buyer's payment is verified against
    ///         the seller's price via FHE.eq — if the encrypted amounts
    ///         match, the transfer succeeds; if not, the contract refunds
    ///         (FHE.select pattern: transfers 0 instead of reverting).
    ///
    /// @param listingId        On-chain listing id.
    /// @param encAmount        Buyer's encrypted offer (must equal encPrice).
    /// @param deliveryNoteHash Optional buyer-side note (e.g. shipping addr
    ///                         encrypted with seller's pubkey, IPFS CID
    ///                         hash). Plaintext bytes32 stored on-chain.
    function buyFixed(
        uint256 listingId,
        InEuint64 calldata encAmount,
        bytes32 deliveryNoteHash
    ) external nonReentrant {
        Listing storage l = _listings[listingId];
        require(l.active, "Storefront: not active");
        require(!l.closed, "Storefront: closed");
        require(l.mode == SaleMode.FixedPrice, "Storefront: not FixedPrice");
        require(msg.sender != l.seller, "Storefront: seller cannot buy self-listing");

        // Verify input under buyer's signer.
        euint64 verifiedAmount = FHE.asEuint64(encAmount);
        FHE.allowThis(verifiedAmount);

        // Match check: buyer's offer must equal seller's price.
        ebool matches = FHE.eq(verifiedAmount, l.encPrice);
        euint64 actualPay = FHE.select(matches, verifiedAmount, FHE.asEuint64(0));
        FHE.allowThis(actualPay);
        FHE.allowTransient(actualPay, l.vault);

        // Pull buyer → seller. transferFromVerified deducts allowance + balance.
        // If actualPay is 0 (mismatch), the vault still runs but moves nothing.
        IFHERC20Vault vault = IFHERC20Vault(l.vault);
        euint64 transferred = vault.transferFromVerified(msg.sender, l.seller, actualPay);
        FHE.allowThis(transferred);
        FHE.allowSender(transferred);
        FHE.allow(transferred, l.seller);

        _bumpReceiptsAndGlobal(l.seller, transferred);

        emit FixedPriceBuy(listingId, msg.sender, l.seller, deliveryNoteHash);
        try eventHub.emitActivity(msg.sender, l.seller, "storefront_buy", l.title, listingId) {} catch {}
    }

    // ─── Auction: Place Bid ───────────────────────────────────────────

    /// @notice Place an encrypted bid. Funds move from bidder's vault into
    ///         this contract's vault balance immediately (escrow). When the
    ///         auction closes, the winner's bid is forwarded to the seller
    ///         and losers can call `refundLoserBid` to reclaim their funds.
    ///
    ///         Multiple bids per address are allowed — track each.
    function placeBid(uint256 listingId, InEuint64 calldata encAmount) external nonReentrant {
        Listing storage l = _listings[listingId];
        require(l.active && !l.closed, "Storefront: listing not active");
        require(l.mode == SaleMode.Auction, "Storefront: not Auction");
        require(block.timestamp < l.closesAt, "Storefront: auction closed");
        require(msg.sender != l.seller, "Storefront: seller cannot bid own auction");

        // Verify input under bidder.
        euint64 verifiedAmount = FHE.asEuint64(encAmount);
        FHE.allowTransient(verifiedAmount, l.vault);

        // Move funds bidder → this contract.
        euint64 locked = IFHERC20Vault(l.vault).transferFromVerified(msg.sender, address(this), verifiedAmount);
        FHE.allowThis(locked);
        FHE.allowSender(locked);

        _bids[listingId].push(Bid({ bidder: msg.sender, amount: locked, refunded: false }));
        emit BidPlaced(listingId, msg.sender, _bids[listingId].length - 1, block.timestamp);
        try eventHub.emitActivity(msg.sender, l.seller, "storefront_bid", l.title, listingId) {} catch {}
    }

    // ─── Auction: Close ───────────────────────────────────────────────

    /// @notice Close an auction after its deadline. Computes the max bid
    ///         via FHE.max across all bids and stores the winner. Anyone
    ///         can call this — running it is a public service.
    ///
    /// @dev Winner identification: we walk the bids and use FHE.gt to
    ///      compare each bid against the current max, then FHE.select to
    ///      track the running winner address. Cost grows with bid count.
    /// @notice §1.4 phase B (BEST_VERSION_FULL_PLAN): close auction via
    /// FHE-tournament selection. Computes encrypted winner index by comparing
    /// each bid against the running max, using FHE.select to pick the higher
    /// one. Stores the encrypted index in _winnerIdxHandle. Listing is not
    /// fully settled here; revealWinner() must be called next to decrypt the
    /// index and set l.winner. Mirrors EncryptedCrowdfund close + publish
    /// pattern.
    function closeAuction(uint256 listingId) external nonReentrant {
        Listing storage l = _listings[listingId];
        require(l.active && !l.closed, "Storefront: not closeable");
        require(l.mode == SaleMode.Auction, "Storefront: not Auction");
        require(block.timestamp >= l.closesAt, "Storefront: not yet ended");

        Bid[] storage bids = _bids[listingId];
        require(bids.length > 0, "Storefront: no bids");

        // FHE-tournament: walk bids, track max + winner index simultaneously
        // via FHE.select. Winner index is encrypted; off-chain decryption +
        // revealWinner() resolves it to a bidder address.
        euint8 winnerIdx = FHE.asEuint8(0);
        euint64 currentMax = bids[0].amount;
        for (uint256 i = 1; i < bids.length; i++) {
            ebool isHigher = FHE.gt(bids[i].amount, currentMax);
            winnerIdx = FHE.select(isHigher, FHE.asEuint8(uint8(i)), winnerIdx);
            currentMax = FHE.select(isHigher, bids[i].amount, currentMax);
        }
        FHE.allowThis(winnerIdx);
        FHE.allowPublic(winnerIdx);
        FHE.allowThis(currentMax);
        FHE.allow(currentMax, l.seller);

        _winnerIdxHandle[listingId] = winnerIdx;
        l.closed = true;
        l.winningBid = currentMax;
        // l.winner stays 0x0 until revealWinner() decrypts and sets it.

        emit AuctionClosed(listingId, address(0), bids.length);
        try eventHub.emitActivity(l.seller, address(0), "storefront_auction_closed", l.title, listingId) {} catch {}
    }

    /// @notice §1.4 phase B: publish the decrypted winner index. Threshold
    /// Network signs the result; this contract verifies via FHE.publishDecryptResult
    /// and resolves the encrypted index to a concrete bidder address.
    /// Anyone can call (the verification is the gate).
    function revealWinner(uint256 listingId, uint8 plaintextIdx, bytes calldata signature) external {
        Listing storage l = _listings[listingId];
        require(l.closed, "Storefront: not closed");
        require(l.mode == SaleMode.Auction, "Storefront: not Auction");
        require(l.winner == address(0), "Storefront: winner already revealed");

        Bid[] storage bids = _bids[listingId];
        require(plaintextIdx < bids.length, "Storefront: bad winner index");

        // Verify the off-chain decryption matches the on-chain encrypted handle.
        // Reverts if signature/value don't match.
        FHE.publishDecryptResult(_winnerIdxHandle[listingId], plaintextIdx, signature);

        l.winner = bids[plaintextIdx].bidder;

        emit AuctionClosed(listingId, l.winner, bids.length);
        try eventHub.emitActivity(l.seller, l.winner, "storefront_auction_revealed", l.title, listingId) {} catch {}
    }

    /// @notice Encrypted winner-index handle accessor for off-chain decrypt.
    function getWinnerIdxHandle(uint256 listingId) external view returns (euint8) {
        return _winnerIdxHandle[listingId];
    }

    // ─── Auction: Winner Claim ────────────────────────────────────────

    /// @notice Winner triggers settlement: their bid amount transfers from
    ///         this contract to the seller. Winner attaches an optional
    ///         delivery note hash for the seller (shipping address, etc.).
    function claimAuctionWin(uint256 listingId, bytes32 deliveryNoteHash) external nonReentrant {
        Listing storage l = _listings[listingId];
        require(l.closed, "Storefront: not closed");
        require(l.mode == SaleMode.Auction, "Storefront: not Auction");
        require(l.winner != address(0), "Storefront: winner not revealed");
        require(msg.sender == l.winner, "Storefront: not winner");

        // Pay seller the winning bid amount.
        FHE.allowTransient(l.winningBid, l.vault);
        euint64 paid = IFHERC20Vault(l.vault).transferVerified(l.seller, l.winningBid);
        FHE.allowThis(paid);
        FHE.allow(paid, l.seller);

        _bumpReceiptsAndGlobal(l.seller, paid);

        // Mark winner's bid as effectively settled (so they can't double-refund).
        Bid[] storage bids = _bids[listingId];
        for (uint256 i = 0; i < bids.length; i++) {
            if (bids[i].bidder == msg.sender && !bids[i].refunded) {
                bids[i].refunded = true;
                break; // settle just one bid (the winning one)
            }
        }

        emit AuctionWinnerClaimed(listingId, msg.sender, deliveryNoteHash);
        try eventHub.emitActivity(msg.sender, l.seller, "storefront_auction_won", l.title, listingId) {} catch {}
    }

    // ─── Auction: Refund Loser ────────────────────────────────────────

    /// @notice After auction closes, a non-winning bidder can pull their
    ///         locked bid back. Idempotent + per-bid (each Bid struct has
    ///         its own `refunded` flag).
    function refundLoserBid(uint256 listingId, uint256 bidIndex) external nonReentrant {
        Listing storage l = _listings[listingId];
        require(l.closed, "Storefront: not closed");
        require(l.mode == SaleMode.Auction, "Storefront: not Auction");

        Bid[] storage bids = _bids[listingId];
        require(bidIndex < bids.length, "Storefront: bad bidIndex");
        Bid storage bid = bids[bidIndex];
        require(bid.bidder == msg.sender, "Storefront: not your bid");
        require(!bid.refunded, "Storefront: already refunded");

        // Refund: contract → bidder.
        FHE.allowTransient(bid.amount, l.vault);
        IFHERC20Vault(l.vault).transferVerified(msg.sender, bid.amount);

        bid.refunded = true;
        emit BidRefunded(listingId, msg.sender, bidIndex);
    }

    // ─── PayWhatYouWant ────────────────────────────────────────────────

    /// @notice Pay any amount. Useful for tip-jar / open-source funding /
    ///         "name your price" digital products.
    function payPWYW(
        uint256 listingId,
        InEuint64 calldata encAmount,
        bytes32 deliveryNoteHash
    ) external nonReentrant {
        Listing storage l = _listings[listingId];
        require(l.active && !l.closed, "Storefront: not active");
        require(l.mode == SaleMode.PayWhatYouWant, "Storefront: not PWYW");
        require(msg.sender != l.seller, "Storefront: seller cannot pay self");

        euint64 verifiedAmount = FHE.asEuint64(encAmount);
        FHE.allowTransient(verifiedAmount, l.vault);

        euint64 transferred = IFHERC20Vault(l.vault).transferFromVerified(msg.sender, l.seller, verifiedAmount);
        FHE.allowThis(transferred);
        FHE.allowSender(transferred);
        FHE.allow(transferred, l.seller);

        _bumpReceiptsAndGlobal(l.seller, transferred);

        emit PWYWPayment(listingId, msg.sender, l.seller, deliveryNoteHash);
        try eventHub.emitActivity(msg.sender, l.seller, "storefront_pwyw", l.title, listingId) {} catch {}
    }

    // ─── Listing admin ─────────────────────────────────────────────────

    /// @notice Seller deactivates a listing. For FixedPrice/PWYW this just
    ///         hides it; no funds are moved. For Auction, this is allowed
    ///         only BEFORE any bid is placed.
    function deactivateListing(uint256 listingId) external nonReentrant {
        Listing storage l = _listings[listingId];
        require(msg.sender == l.seller, "Storefront: not seller");
        require(l.active, "Storefront: already inactive");

        if (l.mode == SaleMode.Auction) {
            require(_bids[listingId].length == 0, "Storefront: cannot deactivate live auction");
        }

        l.active = false;
        emit ListingDeactivated(listingId, msg.sender);
        try eventHub.emitActivity(msg.sender, address(0), "storefront_deactivated", l.title, listingId) {} catch {}
    }

    // ─── Views ─────────────────────────────────────────────────────────

    function getListing(uint256 listingId) external view returns (
        address seller,
        address vault,
        SaleMode mode,
        uint256 closesAt,
        address winner,
        bool active,
        bool closed,
        string memory title,
        bytes32 descriptionCidHash,
        string memory deliveryChannel,
        uint256 createdAt
    ) {
        Listing storage l = _listings[listingId];
        return (
            l.seller,
            l.vault,
            l.mode,
            l.closesAt,
            l.winner,
            l.active,
            l.closed,
            l.title,
            l.descriptionCidHash,
            l.deliveryChannel,
            l.createdAt
        );
    }

    function getEncryptedPrice(uint256 listingId) external view returns (euint64) {
        return _listings[listingId].encPrice;
    }

    function getWinningBid(uint256 listingId) external view returns (euint64) {
        return _listings[listingId].winningBid;
    }

    function getBidCount(uint256 listingId) external view returns (uint256) {
        return _bids[listingId].length;
    }

    function getBid(uint256 listingId, uint256 bidIndex) external view returns (
        address bidder,
        bool refunded
    ) {
        Bid storage b = _bids[listingId][bidIndex];
        return (b.bidder, b.refunded);
    }

    function getEncryptedBidAmount(uint256 listingId, uint256 bidIndex) external view returns (euint64) {
        return _bids[listingId][bidIndex].amount;
    }

    function getSellerListings(address seller) external view returns (uint256[] memory) {
        return _sellerListings[seller];
    }

    // ─── Admin ─────────────────────────────────────────────────────────

    function setEventHub(address _eventHub) external onlyOwner {
        eventHub = IEventHub(_eventHub);
    }

    function setPaymentReceipts(address _paymentReceipts) external onlyOwner {
        paymentReceipts = _paymentReceipts;
    }

    // ─── Internals ─────────────────────────────────────────────────────

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

    /// @dev Append-only storage. Used: 8. Gap: 49.
    /// 50 -> 49 after §1.4 phase B added _winnerIdxHandle (BEST_VERSION_FULL_PLAN).
    /// Decrement gap by 1 when adding a new state variable; total slots
    /// (used + gap) must stay constant across UUPS upgrades.
    uint256[49] private __gap;
}
