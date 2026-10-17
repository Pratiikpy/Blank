// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "./utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, externalEuint64 encAmount, bytes calldata proof) external returns (euint64);
    function transferFromVerified(address from, address to, sharedEuint64 shared) external returns (sharedEuint64);
}

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

/// @title P2PExchange (retired)
/// @notice Was: atomic swaps with public order sizes and encrypted settlement.
///         Retired before mainnet. Storage and views stay for history; makers
///         can still cancel offers that were open at retirement.
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

    /// @notice Retired. The exchange no longer takes new offers or fills.
    ///         Open offers can still be cancelled by their maker; the
    ///         contract never custodies funds, so there is nothing to withdraw.
    function createOffer(address, address, uint256, uint256, uint256) external pure returns (uint256) {
        revert("P2PExchange: retired");
    }

    /// @notice Retired. See createOffer.
    function fillOffer(uint256, externalEuint64, externalEuint64, bytes calldata) external pure {
        revert("P2PExchange: retired");
    }

    /// @notice Publish the off-chain decryption of a filled offer's validation
    ///         flag. Anyone can call this once they've fetched the plaintext
    ///         and signature from the Threshold Network — usually either
    ///         party verifying the trade. After publish, getTradeValidation()
    ///         returns (isValid, true).
    /// @param offerId       The filled offer
    /// @param validPlaintext The decrypted ebool (true if amounts matched)
    /// @param signature     Threshold Network signature over the plaintext
    function publishTradeValidation(
        uint256 offerId,
        bool validPlaintext,
        bytes calldata signature
    ) external {
        ebool validation = _offerValidation[offerId];
        FHE.publishDecryptResult(validation, validPlaintext, signature);
    }

    /// @notice Check whether a filled offer's trade was valid (amounts matched the offer).
    ///         Returns (isValid, isReady). If isReady is false, no one has called
    ///         publishTradeValidation yet — both parties can verify off-chain
    ///         via the cofhe-sdk client and either one can publish to make it on-chain readable.
    /// @param offerId The offer to check
    /// @return isValid Whether the trade amounts matched the offer
    /// @return isReady Whether the decryption result has been published
    function getTradeValidation(uint256 offerId) external view returns (bool isValid, bool isReady) {
        ebool validation = _offerValidation[offerId];
        (bool result, bool ready) = FHE.getDecryptResultSafe(validation);
        return (result, ready);
    }

    /// @notice Read the encrypted validation handle for an offer.
    ///         Frontend uses this to fetch the ctHash, then decrypts off-chain
    ///         to obtain (validPlaintext, signature) for publishTradeValidation.
    function getValidationHandle(uint256 offerId) external view returns (ebool) {
        return _offerValidation[offerId];
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
    /// @dev Reserved storage to avoid collisions on future upgrades.
    ///      Append-only: when adding a new state variable in a later upgrade,
    ///      decrement the gap size so total storage is unchanged.
    /// @dev Used: 6. Gap: 50.
    uint256[50] private __gap;

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
