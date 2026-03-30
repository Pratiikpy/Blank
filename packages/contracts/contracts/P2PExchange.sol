// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, InEuint64 memory encAmount) external returns (euint64);
}

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

/// @title P2PExchange — Trustless atomic token swaps
/// @notice Users post offers with PUBLIC order sizes (for discovery) and ENCRYPTED settlement.
///         Taker accepts, both sides transfer atomically. No liquidity pool needed.
contract P2PExchange is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {

    struct Offer {
        address maker;
        address tokenGive;      // FHERC20Vault address
        address tokenWant;      // FHERC20Vault address
        uint256 amountGive;     // PUBLIC — for order discovery
        uint256 amountWant;     // PUBLIC — for order discovery
        uint256 expiry;
        bool active;
        bool filled;
    }

    IEventHub public eventHub;
    uint256 public nextOfferId;
    mapping(uint256 => Offer) public offers;
    mapping(address => uint256[]) private _userOffers;

    /// @dev Trade validation results: offerId → encrypted boolean (true if amounts matched)
    mapping(uint256 => ebool) private _offerValidation;

    event OfferCreated(uint256 indexed id, address indexed maker, address tokenGive, address tokenWant, uint256 amountGive, uint256 amountWant, uint256 expiry, uint256 timestamp);
    event OfferFilled(uint256 indexed id, address indexed taker, uint256 timestamp);
    event OfferCancelled(uint256 indexed id, uint256 timestamp);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address _eventHub) public initializer {
        __Ownable_init(msg.sender);
        eventHub = IEventHub(_eventHub);
    }

    /// @notice Create a swap offer. Amounts are PUBLIC for discoverability.
    function createOffer(
        address tokenGive,
        address tokenWant,
        uint256 amountGive,
        uint256 amountWant,
        uint256 expiry
    ) external nonReentrant returns (uint256) {
        require(tokenGive != tokenWant, "P2PExchange: same token");
        require(amountGive > 0 && amountWant > 0, "P2PExchange: zero amount");
        require(expiry > block.timestamp, "P2PExchange: expired");

        uint256 id = nextOfferId++;
        offers[id] = Offer({
            maker: msg.sender,
            tokenGive: tokenGive,
            tokenWant: tokenWant,
            amountGive: amountGive,
            amountWant: amountWant,
            expiry: expiry,
            active: true,
            filled: false
        });
        _userOffers[msg.sender].push(id);

        emit OfferCreated(id, msg.sender, tokenGive, tokenWant, amountGive, amountWant, expiry, block.timestamp);
        try eventHub.emitActivity(msg.sender, address(0), "exchange_created", "", id) {} catch {}

        return id;
    }

    /// @notice Fill an offer. Taker sends tokenWant to maker, maker sends tokenGive to taker.
    ///         Both transfers use encrypted amounts for privacy during settlement.
    ///
    ///         Amount verification: After both encrypted transfers, the contract verifies
    ///         that the taker paid at least amountWant and the maker sent no more than
    ///         amountGive using FHE.gte()/FHE.lte() against the public offer prices.
    ///         Since offer amounts are already public, these checks leak no private data.
    ///         If validation fails, the trade is marked invalid and both parties can
    ///         detect this via the decrypted tradeValid boolean.
    ///
    /// @param offerId The offer to fill
    /// @param encTakerPayment Encrypted amount taker sends (must be >= offer.amountWant)
    /// @param encMakerPayment Encrypted amount to transfer from maker (must be <= offer.amountGive)
    function fillOffer(
        uint256 offerId,
        InEuint64 memory encTakerPayment,
        InEuint64 memory encMakerPayment
    ) external nonReentrant {
        Offer storage o = offers[offerId];
        require(o.active && !o.filled, "P2PExchange: not available");
        require(block.timestamp <= o.expiry, "P2PExchange: expired");
        require(msg.sender != o.maker, "P2PExchange: self-fill");

        // Taker sends tokenWant to maker
        euint64 actualGive = IFHERC20Vault(o.tokenWant).transferFrom(msg.sender, o.maker, encTakerPayment);
        FHE.allowSender(actualGive);
        FHE.allow(actualGive, o.maker);

        // Maker sends tokenGive to taker (maker must have pre-approved this contract)
        euint64 actualReceive = IFHERC20Vault(o.tokenGive).transferFrom(o.maker, msg.sender, encMakerPayment);
        FHE.allowSender(actualReceive);
        FHE.allow(actualReceive, msg.sender);

        // ── Amount Verification ──────────────────────────────────────────
        // Verify taker paid at least amountWant and maker sent at most amountGive.
        // Offer amounts are PUBLIC (stored as plaintext for discovery), so these
        // FHE comparisons leak no additional private information.
        //
        // We cannot prevent invalid transfers on-chain (vault.transferFrom takes
        // InEuint64 which cannot be constructed from euint64), but we CAN detect
        // and flag invalid trades for both parties to verify.
        euint64 expectedTakerAmount = FHE.asEuint64(o.amountWant);
        euint64 expectedMakerAmount = FHE.asEuint64(o.amountGive);

        ebool takerPaidEnough = FHE.gte(actualGive, expectedTakerAmount);
        ebool makerPayoutValid = FHE.lte(actualReceive, expectedMakerAmount);
        ebool tradeValid = FHE.and(takerPaidEnough, makerPayoutValid);

        // Store validation result — both parties can verify off-chain
        FHE.allowSender(tradeValid);
        FHE.allow(tradeValid, o.maker);
        FHE.allowThis(tradeValid);

        // Store the validation handle for the offer so it can be queried
        _offerValidation[offerId] = tradeValid;

        // Decryption is now client-side (v0.1.3) — client calls publishDecryptResult()
        // after decrypting off-chain, then getTradeValidation() reads via getDecryptResultSafe().

        o.filled = true;
        o.active = false;

        emit OfferFilled(offerId, msg.sender, block.timestamp);
        try eventHub.emitActivity(msg.sender, o.maker, "exchange_filled", "", offerId) {} catch {}
    }

    /// @notice Check whether a filled offer's trade was valid (amounts matched the offer).
    ///         Returns (isValid, isReady). If isReady is false, decryption hasn't completed yet.
    /// @param offerId The offer to check
    /// @return isValid Whether the trade amounts matched the offer (taker paid enough, maker sent correct amount)
    /// @return isReady Whether the decryption result is available
    function getTradeValidation(uint256 offerId) external view returns (bool isValid, bool isReady) {
        ebool validation = _offerValidation[offerId];
        (uint256 result, bool ready) = FHE.getDecryptResultSafe(ebool.unwrap(validation));
        return (result != 0, ready);
    }

    /// @notice Cancel an active offer. Only the maker can cancel.
    function cancelOffer(uint256 offerId) external nonReentrant {
        Offer storage o = offers[offerId];
        require(msg.sender == o.maker, "P2PExchange: not maker");
        require(o.active && !o.filled, "P2PExchange: not available");
        o.active = false;
        emit OfferCancelled(offerId, block.timestamp);
    }

    // ─── View Functions ─────────────────────────────────────────────────

    function getActiveOffers(uint256 offset, uint256 limit) external view returns (Offer[] memory) {
        uint256 count = 0;
        for (uint256 i = offset; i < nextOfferId && count < limit; i++) {
            if (offers[i].active && !offers[i].filled && block.timestamp <= offers[i].expiry) count++;
        }

        Offer[] memory result = new Offer[](count);
        uint256 j = 0;
        for (uint256 i = offset; i < nextOfferId && j < count; i++) {
            if (offers[i].active && !offers[i].filled && block.timestamp <= offers[i].expiry) {
                result[j++] = offers[i];
            }
        }
        return result;
    }

    function getUserOffers(address user) external view returns (uint256[] memory) { return _userOffers[user]; }

    function setEventHub(address _eventHub) external onlyOwner { eventHub = IEventHub(_eventHub); }
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
