// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./utils/ReentrancyGuard.sol";
import "./interfaces/ITokenRegistry.sol";

interface IFHERC20Vault {
    function transferFromVerified(address from, address to, sharedEuint64 shared) external returns (sharedEuint64);
    function transferVerified(address to, sharedEuint64 shared) external returns (sharedEuint64);
}

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

interface IPaymentReceipts {
    function bumpUserReceived(address user, sharedEuint64 shared) external;
    function bumpGlobal(sharedEuint64 shared) external;
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
///
///      Funding gate: the vault moves 0 (no revert) when a buyer is short,
///      so a sale must not read as made until funds are proven. buyFixed and
///      payPWYW record a Pending purchase with a public ebool "the vault
///      moved the full amount"; confirmFunding publishes its decryption and
///      only then marks the purchase Sold, bumps receipts and emits the
///      sale events. A zero payment becomes Void. Auctions get the same
///      guarantee at close: a winner must hold a non-zero bid that met the
///      minimum, otherwise the auction closes with no winner and every bid
///      is refundable.
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

    enum PurchaseKind { Fixed, PWYW }
    enum PurchaseStatus { None, Pending, Sold, Void }

    /// @dev A FixedPrice or PWYW payment awaiting confirmFunding.
    struct Purchase {
        uint256 listingId;
        address buyer;
        PurchaseKind kind;
        PurchaseStatus status;
        ebool funded;
        euint64 paid;
        bytes32 deliveryNoteHash;
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

    /// @dev Plaintext winning-bid index, set by revealWinner() when the
    /// encrypted winnerIdxHandle is decrypted. Needed because a winner who
    /// placed MULTIPLE bids needs precise identification of WHICH of their
    /// bids was the winning one — otherwise claimAuctionWin's loop would
    /// arbitrarily mark the first unrefunded bid as "settled" while leaving
    /// the actual winning bid refundable, letting the winner double-claim.
    /// 0 is the default for "not yet revealed"; valid indices are 0..N-1
    /// but only meaningful after revealWinner sets it. Append-only addition;
    /// __gap reduced by 1 slot below.
    mapping(uint256 => uint256) private _winningBidIdx;

    /// @dev Auction config: minimum auction window (1 hour) + maximum (30 days).
    uint256 public constant MIN_AUCTION_SECONDS = 1 hours;
    uint256 public constant MAX_AUCTION_SECONDS = 30 days;
    /// @dev §1.14 A7 — cap auction bid count to prevent DoS-by-spam.
    ///      closeAuction iterates bids with FHE.select per bid; without
    ///      a cap an attacker could exceed block gas limit and lock the
    ///      auction permanently. 200 keeps closeAuction comfortably
    ///      below 30M gas at EntryPoint v0.8 pricing.
    uint256 public constant MAX_BIDS = 200;
    /// @dev Winner index revealed when no bid is eligible. Above MAX_BIDS, so
    ///      it never collides with a real index.
    uint8 public constant NO_WINNER = type(uint8).max;

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
    event PaymentReceiptsSet(address indexed previous, address indexed current);
    event TokenRegistrySet(address indexed registry);
    /// @notice Encrypted amount actually paid on a FixedPrice buy: the price
    ///         on a match with enough balance, otherwise 0. Buyer and seller
    ///         can decrypt it; the seller should check it before delivering.
    event FixedPricePaid(uint256 indexed listingId, address indexed buyer, euint64 paid);
    /// @notice A payment is waiting for confirmFunding. Decrypt `funded`
    ///         (public) off-chain and pass the result and signature to
    ///         confirmFunding. FixedPriceBuy / PWYWPayment fire only then.
    event PurchasePending(uint256 indexed purchaseId, uint256 indexed listingId, address indexed buyer, ebool funded);
    /// @notice Nothing (or not the full price) moved; the purchase is void
    ///         and the seller owes no delivery.
    event PurchaseVoided(uint256 indexed purchaseId, uint256 indexed listingId, address indexed buyer);
    /// @notice The auction closed without an eligible bid. Every bid is
    ///         refundable through refundLoserBid.
    event AuctionNoWinner(uint256 indexed listingId, uint256 totalBids);

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
        externalEuint64 encPrice, bytes calldata proof,
        uint256 auctionSeconds,
        string calldata title,
        bytes32 descriptionCidHash,
        string calldata deliveryChannel
    ) external nonReentrant returns (uint256 listingId) {
        require(vault != address(0), "Storefront: zero vault");
        _requireAllowedVault(vault);
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
            verifiedPrice = FHE.asEuint64(encPrice, proof);
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
    ///         The purchase is Pending until confirmFunding proves the full
    ///         price moved; the seller delivers only against a Sold purchase.
    ///         A listing priced at 0 can never confirm, use PayWhatYouWant
    ///         for free items.
    ///
    /// @param listingId        On-chain listing id.
    /// @param encAmount        Buyer's encrypted offer (must equal encPrice).
    /// @param deliveryNoteHash Optional buyer-side note (e.g. shipping addr
    ///                         encrypted with seller's pubkey, IPFS CID
    ///                         hash). Plaintext bytes32 stored on-chain.
    /// @return purchaseId      Id to pass to confirmFunding.
    function buyFixed(
        uint256 listingId,
        externalEuint64 encAmount, bytes calldata proof,
        bytes32 deliveryNoteHash
    ) external nonReentrant returns (uint256 purchaseId) {
        Listing storage l = _listings[listingId];
        require(l.active, "Storefront: not active");
        require(!l.closed, "Storefront: closed");
        require(l.mode == SaleMode.FixedPrice, "Storefront: not FixedPrice");
        require(msg.sender != l.seller, "Storefront: seller cannot buy self-listing");
        _requireAllowedVault(l.vault);

        // Verify input under buyer's signer.
        euint64 verifiedAmount = FHE.asEuint64(encAmount, proof);
        FHE.allowThis(verifiedAmount);

        // Match check: buyer's offer must equal seller's price.
        ebool matches = FHE.eq(verifiedAmount, l.encPrice);
        euint64 actualPay = FHE.select(matches, verifiedAmount, FHE.asEuint64(0));
        FHE.allowThis(actualPay);

        // Pull buyer → seller. transferFromVerified deducts allowance + balance.
        // If actualPay is 0 (mismatch), the vault still runs but moves nothing.
        IFHERC20Vault vault = IFHERC20Vault(l.vault);
        euint64 transferred = FHE.receiveEuint64FromCall(
            vault.transferFromVerified(msg.sender, l.seller, FHE.shareEuint64(actualPay, l.vault)),
            l.vault
        );
        FHE.allowThis(transferred);
        FHE.allowSender(transferred);
        FHE.allow(transferred, l.seller);

        // A listing can be bought many times (digital goods). Keep the
        // buyer's running paid total so the seller can verify payment.
        // Adding a zero payment changes nothing, so this is not gated.
        euint64 total = FHE.add(_paidByBuyer[listingId][msg.sender], transferred);
        _paidByBuyer[listingId][msg.sender] = total;
        FHE.allowThis(total);
        FHE.allowSender(total);
        FHE.allow(total, l.seller);

        ebool funded = FHE.and(
            FHE.gt(transferred, FHE.asEuint64(0)),
            FHE.eq(transferred, l.encPrice)
        );
        purchaseId = _openPurchase(listingId, PurchaseKind.Fixed, transferred, funded, deliveryNoteHash);
    }

    /// @notice Settle a pending FixedPrice or PWYW purchase (step 2 of 2).
    ///         Anyone may call with the Threshold Network decryption of
    ///         getPurchaseFundedHandle(purchaseId).
    ///         true: the purchase is Sold, receipts are bumped and the sale
    ///         events fire. false: the purchase is Void, nothing is owed.
    function confirmFunding(uint256 purchaseId, bool fundedPlaintext, bytes calldata signature) external nonReentrant {
        Purchase storage p = _purchases[purchaseId];
        require(p.status == PurchaseStatus.Pending, "Storefront: purchase not pending");

        // Publish only if nobody has yet, so a second publish cannot revert.
        (bool funded, bool ready) = FHE.getDecryptResultSafe(p.funded);
        if (!ready) {
            FHE.publishDecryptResult(p.funded, fundedPlaintext, signature);
            (funded, ready) = FHE.getDecryptResultSafe(p.funded);
        }
        require(ready, "Storefront: decryption not ready");

        uint256 listingId = p.listingId;
        address buyer = p.buyer;
        Listing storage l = _listings[listingId];

        if (!funded) {
            p.status = PurchaseStatus.Void;
            emit PurchaseVoided(purchaseId, listingId, buyer);
            return;
        }

        p.status = PurchaseStatus.Sold;
        // Receipts count settled sales only; a zero payment would still
        // bump the public transaction counter.
        _bumpReceiptsAndGlobal(l.seller, p.paid);

        if (p.kind == PurchaseKind.Fixed) {
            emit FixedPriceBuy(listingId, buyer, l.seller, p.deliveryNoteHash);
            emit FixedPricePaid(listingId, buyer, p.paid);
            try eventHub.emitActivity(buyer, l.seller, "storefront_buy", l.title, listingId) {} catch {}
        } else {
            emit PWYWPayment(listingId, buyer, l.seller, p.deliveryNoteHash);
            try eventHub.emitActivity(buyer, l.seller, "storefront_pwyw", l.title, listingId) {} catch {}
        }
    }

    /// @notice The public ebool "the vault moved the full amount" for a purchase.
    function getPurchaseFundedHandle(uint256 purchaseId) external view returns (ebool) {
        return _purchases[purchaseId].funded;
    }

    /// @notice Public state of a purchase (no amounts).
    function getPurchase(uint256 purchaseId) external view returns (
        uint256 listingId,
        address buyer,
        PurchaseKind kind,
        PurchaseStatus status
    ) {
        Purchase storage p = _purchases[purchaseId];
        return (p.listingId, p.buyer, p.kind, p.status);
    }

    function _openPurchase(
        uint256 listingId,
        PurchaseKind kind,
        euint64 paid,
        ebool funded,
        bytes32 deliveryNoteHash
    ) internal returns (uint256 purchaseId) {
        FHE.allowThis(funded);
        FHE.allowPublic(funded);

        purchaseId = nextPurchaseId++;
        Purchase storage p = _purchases[purchaseId];
        p.listingId = listingId;
        p.buyer = msg.sender;
        p.kind = kind;
        p.status = PurchaseStatus.Pending;
        p.funded = funded;
        p.paid = paid;
        p.deliveryNoteHash = deliveryNoteHash;

        emit PurchasePending(purchaseId, listingId, msg.sender, funded);
    }

    // ─── Auction: Place Bid ───────────────────────────────────────────

    /// @notice Place an encrypted bid. Funds move from bidder's vault into
    ///         this contract's vault balance immediately (escrow). When the
    ///         auction closes, the winner's bid is forwarded to the seller
    ///         and losers can call `refundLoserBid` to reclaim their funds.
    ///
    ///         One bid per address per listing, so MAX_BIDS slots cannot be
    ///         filled by one account.
    ///
    ///         A bid below the minimum, or one the vault could not fund,
    ///         locks 0 and is recorded as a 0 bid. It still takes a slot
    ///         (rejecting it would reveal the comparison) but closeAuction
    ///         never lets a 0 bid win, so it cannot take the item.
    function placeBid(uint256 listingId, externalEuint64 encAmount, bytes calldata proof) external nonReentrant {
        Listing storage l = _listings[listingId];
        require(l.active && !l.closed, "Storefront: listing not active");
        require(l.mode == SaleMode.Auction, "Storefront: not Auction");
        require(block.timestamp < l.closesAt, "Storefront: auction closed");
        require(msg.sender != l.seller, "Storefront: seller cannot bid own auction");
        // §1.14 A7: cap bid count to prevent DoS-by-spam. closeAuction
        // walks the bid array with FHE.select per bid; without a cap an
        // attacker could spam thousands of small bids and exceed the
        // block gas limit, locking the auction forever. MAX_BIDS = 200
        // keeps closeAuction well under typical block gas at v0.8
        // EntryPoint pricing.
        require(_bids[listingId].length < MAX_BIDS, "Storefront: bid cap reached");
        require(!_hasBid[listingId][msg.sender], "Storefront: already bid");
        _hasBid[listingId][msg.sender] = true;
        _requireAllowedVault(l.vault);

        // Verify input under bidder.
        euint64 verifiedAmount = FHE.asEuint64(encAmount, proof);

        // §1.14 A8: gate the locked amount via FHE.select(verifiedAmount
        // >= l.encPrice). l.encPrice is the seller-set minimum bid for
        // auctions (see Listing struct comment). Without this gate, a
        // bidder could place 1 wei and still take an unclaimed auction.
        // Bids below the min lock zero; the bidder spends gas but no
        // tokens move, and the entry in _bids[] has amount=0 so the
        // FHE-tournament selection won't pick it as winner.
        ebool meetsMin = FHE.gte(verifiedAmount, l.encPrice);
        euint64 effectiveAmount = FHE.select(meetsMin, verifiedAmount, FHE.asEuint64(0));

        // Move funds bidder → this contract.
        euint64 locked = FHE.receiveEuint64FromCall(
            IFHERC20Vault(l.vault).transferFromVerified(msg.sender, address(this), FHE.shareEuint64(effectiveAmount, l.vault)),
            l.vault
        );
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

        // The top bid wins only if it is funded and met the minimum. Bids
        // hold what the vault actually locked: 0 when unfunded or below the
        // minimum. Without this, all-zero bids would hand index 0 the item
        // for nothing. The decision is data, not a branch: an ineligible
        // auction reveals NO_WINNER instead of an index.
        ebool eligible = FHE.and(
            FHE.gt(currentMax, FHE.asEuint64(0)),
            FHE.gte(currentMax, l.encPrice)
        );
        euint8 revealIdx = FHE.select(eligible, winnerIdx, FHE.asEuint8(NO_WINNER));
        FHE.allowThis(revealIdx);
        FHE.allowPublic(revealIdx);
        FHE.allowThis(currentMax);
        FHE.allow(currentMax, l.seller);

        _winnerIdxHandle[listingId] = revealIdx;
        l.closed = true;
        l.winningBid = currentMax;
        // l.winner stays 0x0 until revealWinner() decrypts and sets it.

        emit AuctionClosed(listingId, address(0), bids.length);
        try eventHub.emitActivity(l.seller, address(0), "storefront_auction_closed", l.title, listingId) {} catch {}
    }

    /// @notice §1.4 phase B: publish the decrypted winner index. Threshold
    /// Network signs the result; this contract verifies via FHE.publishDecryptResult
    /// and resolves the encrypted index to a concrete bidder address.
    /// Anyone can call (the verification is the gate). `NO_WINNER` means no bid
    /// was funded and above the minimum: the auction ends with no winner and
    /// every bid is refundable.
    function revealWinner(uint256 listingId, uint8 plaintextIdx, bytes calldata signature) external {
        Listing storage l = _listings[listingId];
        require(l.closed, "Storefront: not closed");
        require(l.mode == SaleMode.Auction, "Storefront: not Auction");
        require(l.winner == address(0) && !_noWinner[listingId], "Storefront: winner already revealed");

        Bid[] storage bids = _bids[listingId];
        require(plaintextIdx < bids.length || plaintextIdx == NO_WINNER, "Storefront: bad winner index");

        // Verify the off-chain decryption matches the on-chain encrypted handle.
        // Reverts if signature/value don't match.
        FHE.publishDecryptResult(_winnerIdxHandle[listingId], plaintextIdx, signature);

        if (plaintextIdx == NO_WINNER) {
            _noWinner[listingId] = true;
            emit AuctionNoWinner(listingId, bids.length);
            try eventHub.emitActivity(l.seller, address(0), "storefront_auction_no_winner", l.title, listingId) {} catch {}
            return;
        }

        l.winner = bids[plaintextIdx].bidder;
        // Pin the winning index so claimAuctionWin can mark precisely
        // bids[plaintextIdx] as settled instead of walking the array
        // and arbitrarily marking the first-by-bidder match. Without
        // this, a winner who placed multiple bids could double-claim
        // (settle bid 0 via claim + refund the actual winning bid).
        _winningBidIdx[listingId] = uint256(plaintextIdx);

        emit AuctionClosed(listingId, l.winner, bids.length);
        try eventHub.emitActivity(l.seller, l.winner, "storefront_auction_revealed", l.title, listingId) {} catch {}
    }

    /// @notice Encrypted winner-index handle accessor for off-chain decrypt.
    function getWinnerIdxHandle(uint256 listingId) external view returns (euint8) {
        return _winnerIdxHandle[listingId];
    }

    // ─── Auction: Winner Claim ────────────────────────────────────────

    /// @notice Settle a revealed auction: the winning bid transfers from
    ///         this contract to the seller. Anyone can call, so the seller is
    ///         paid even if the winner walks away. Only the winner's
    ///         delivery note hash is recorded.
    function claimAuctionWin(uint256 listingId, bytes32 deliveryNoteHash) external nonReentrant {
        Listing storage l = _listings[listingId];
        require(l.closed, "Storefront: not closed");
        require(l.mode == SaleMode.Auction, "Storefront: not Auction");
        require(l.winner != address(0), "Storefront: winner not revealed");
        if (msg.sender != l.winner) deliveryNoteHash = bytes32(0);

        // Mark the EXACT winning bid as settled. _winningBidIdx is the
        // decrypted plaintext index posted by revealWinner. Using the
        // precise index (rather than the previous loop) closes the
        // double-claim bug where a winner with multiple bids could
        // settle bid 0 here + then refundLoserBid the actual winning
        // bid (still flagged refunded=false). Sanity: winner can't be
        // 0x0 after revealWinner, so an index of 0 with non-zero
        // winner is correct (it identifies bids[0] which IS the winner
        // in single-bid auctions).
        Bid[] storage bids = _bids[listingId];
        uint256 wIdx = _winningBidIdx[listingId];
        require(wIdx < bids.length, "Storefront: invalid winning index");
        Bid storage winningBid = bids[wIdx];
        require(winningBid.bidder == l.winner, "Storefront: winning bid mismatch");
        require(!winningBid.refunded, "Storefront: already settled");
        winningBid.refunded = true;

        // Pay seller the winning bid amount.
        euint64 paid = FHE.receiveEuint64FromCall(
            IFHERC20Vault(l.vault).transferVerified(l.seller, FHE.shareEuint64(l.winningBid, l.vault)),
            l.vault
        );
        FHE.allowThis(paid);
        FHE.allow(paid, l.seller);

        _bumpReceiptsAndGlobal(l.seller, paid);

        emit AuctionWinnerClaimed(listingId, l.winner, deliveryNoteHash);
        try eventHub.emitActivity(l.winner, l.seller, "storefront_auction_won", l.title, listingId) {} catch {}
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
        // Refunds open only after the winner is revealed. Before that the
        // winning bid is unknown, and refunding it would leave the seller
        // unpaid. When no bid was eligible there is no winning bid to protect.
        require(l.winner != address(0) || _noWinner[listingId], "Storefront: winner not revealed");
        require(
            l.winner == address(0) || bidIndex != _winningBidIdx[listingId],
            "Storefront: winning bid, use claimAuctionWin"
        );

        // Refund: contract → bidder.
        IFHERC20Vault(l.vault).transferVerified(msg.sender, FHE.shareEuint64(bid.amount, l.vault));

        bid.refunded = true;
        emit BidRefunded(listingId, msg.sender, bidIndex);
    }

    // ─── PayWhatYouWant ────────────────────────────────────────────────

    /// @notice Pay any amount. Useful for tip-jar / open-source funding /
    ///         "name your price" digital products. The payment is Pending
    ///         until confirmFunding proves the vault moved something; a zero
    ///         payment is voided and never counts as a sale.
    /// @return purchaseId Id to pass to confirmFunding.
    function payPWYW(
        uint256 listingId,
        externalEuint64 encAmount, bytes calldata proof,
        bytes32 deliveryNoteHash
    ) external nonReentrant returns (uint256 purchaseId) {
        Listing storage l = _listings[listingId];
        require(l.active && !l.closed, "Storefront: not active");
        require(l.mode == SaleMode.PayWhatYouWant, "Storefront: not PWYW");
        require(msg.sender != l.seller, "Storefront: seller cannot pay self");
        _requireAllowedVault(l.vault);

        euint64 verifiedAmount = FHE.asEuint64(encAmount, proof);

        euint64 transferred = FHE.receiveEuint64FromCall(
            IFHERC20Vault(l.vault).transferFromVerified(msg.sender, l.seller, FHE.shareEuint64(verifiedAmount, l.vault)),
            l.vault
        );
        FHE.allowThis(transferred);
        FHE.allowSender(transferred);
        FHE.allow(transferred, l.seller);

        ebool funded = FHE.gt(transferred, FHE.asEuint64(0));
        purchaseId = _openPurchase(listingId, PurchaseKind.PWYW, transferred, funded, deliveryNoteHash);
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
        require(_eventHub.code.length > 0, "Storefront: bad event hub");
        eventHub = IEventHub(_eventHub);
    }

    function setTokenRegistry(address r) external onlyOwner {
        require(r.code.length > 0, "Storefront: bad registry");
        tokenRegistry = ITokenRegistry(r);
        emit TokenRegistrySet(r);
    }

    /// @notice Buyer's encrypted running total paid on a FixedPrice listing.
    function getPaidByBuyer(uint256 listingId, address buyer) external view returns (euint64) {
        return _paidByBuyer[listingId][buyer];
    }

    function hasBid(uint256 listingId, address bidder) external view returns (bool) {
        return _hasBid[listingId][bidder];
    }

    function _requireAllowedVault(address vault) internal view {
        require(
            address(tokenRegistry) != address(0) && tokenRegistry.isActiveVault(vault),
            "Storefront: vault not allowed"
        );
    }

    /// @dev Zero switches receipt bumps off.
    function setPaymentReceipts(address _paymentReceipts) external onlyOwner {
        require(
            _paymentReceipts == address(0) || _paymentReceipts.code.length > 0,
            "Storefront: bad receipts"
        );
        address previous = paymentReceipts;
        paymentReceipts = _paymentReceipts;
        emit PaymentReceiptsSet(previous, _paymentReceipts);
    }

    // ─── Internals ─────────────────────────────────────────────────────

    function _bumpReceiptsAndGlobal(address recipient, euint64 amount) internal {
        if (paymentReceipts == address(0)) return;
        // §2.6 of BEST_VERSION_FULL_PLAN: surface receipt-bump failures.
        try IPaymentReceipts(paymentReceipts).bumpUserReceived(recipient, FHE.shareEuint64(amount, paymentReceipts)) {} catch (bytes memory reason) {
            emit ReceiptsBumpFailed("user", reason);
        }
        try IPaymentReceipts(paymentReceipts).bumpGlobal(FHE.shareEuint64(amount, paymentReceipts)) {} catch (bytes memory reason) {
            emit ReceiptsBumpFailed("global", reason);
        }
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev listingId => bidder => has placed a bid. Appended.
    mapping(uint256 => mapping(address => bool)) private _hasBid;
    /// @dev listingId => buyer => encrypted running total paid (FixedPrice). Appended.
    mapping(uint256 => mapping(address => euint64)) private _paidByBuyer;
    /// @dev Vault allowlist. Appended.
    ITokenRegistry public tokenRegistry;
    /// @dev Next id for FixedPrice / PWYW purchases. Appended.
    uint256 public nextPurchaseId;
    /// @dev purchaseId => payment awaiting or past confirmFunding. Appended.
    mapping(uint256 => Purchase) private _purchases;
    /// @dev listingId => the auction was revealed with no eligible bid. Appended.
    mapping(uint256 => bool) private _noWinner;

    /// @dev Append-only storage. The gap started at 50 and shrinks by 1 for
    /// each appended slot (_winnerIdxHandle, _winningBidIdx, _hasBid,
    /// _paidByBuyer, tokenRegistry, nextPurchaseId, _purchases, _noWinner),
    /// so used + gap stays constant.
    uint256[42] private __gap;

    /// @notice True once revealWinner showed that no bid was eligible.
    function auctionHasNoWinner(uint256 listingId) external view returns (bool) {
        return _noWinner[listingId];
    }
}
