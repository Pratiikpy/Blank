// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title EncryptedFlags — Encrypted compliance flags, fee engine, and access control
/// @notice Flags and fee rates are stored as ciphertexts, but the owner sets
///         them with PLAINTEXT arguments (setVerified(user, true), the fee
///         rates), so anyone reading those transactions learns the values.
///         The combined results (canSend, canReceive, merchant fees) may only
///         be computed by the user or an owner-authorized contract.

contract EncryptedFlags is UUPSUpgradeable, OwnableUpgradeable {

    // ─── Encrypted User Flags ───────────────────────────────────────
    // Each flag is an ebool. The value is visible in the owner's setter
    // calldata; on-chain reads are limited to the user and this contract.

    mapping(address => ebool) private _isVerified;       // KYC/identity verified
    mapping(address => ebool) private _isActive;         // Account active (not suspended)
    mapping(address => ebool) private _hasCompletedKYC;  // Completed KYC flow
    mapping(address => ebool) private _isMerchant;       // Merchant account flag

    // ─── Encrypted Bitmask Flags ────────────────────────────────────
    // Uses euint8 as a bitmask for multiple flags in a single encrypted value
    // Bit 0: verified, Bit 1: active, Bit 2: kyc, Bit 3: merchant
    // Bit 4: can_send, Bit 5: can_receive, Bit 6: can_create_invoice, Bit 7: reserved
    mapping(address => euint8) private _flagBitmask;

    // ─── Fee Configuration ──────────────────────────────────────────
    // Fee rates in basis points of 10000. Encrypted at rest, but set from
    // plaintext, so the rates themselves are public.
    euint64 private _baseFeeRate;    // e.g. 100 = 1%
    euint64 private _merchantDiscount; // share of the base fee waived, e.g. 2000 = 20%

    // ─── Encrypted Audit Scopes (from Alpaca-Invoice pattern) ──────
    // When sharing data with auditor, a bitmask controls which fields are visible
    // Bit 0: amounts, Bit 1: parties, Bit 2: timestamps, Bit 3: memos
    // Bit 4: receipt_ids, Bit 5: fee_details, Bit 6: compliance_status
    mapping(address => mapping(address => euint8)) private _auditScopes; // user → auditor → scope mask

    event FlagSet(address indexed user, string flagType, uint256 timestamp);
    event AuditScopeSet(address indexed user, address indexed auditor, uint256 timestamp);
    event FeeCalculated(address indexed user, uint256 timestamp);
    event AuthorizedCallerSet(address indexed caller, bool authorized);
    event FeeRatesSet(uint64 baseFeeRate, uint64 merchantDiscount);

    uint64 public constant BPS = 10_000;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(uint64 baseFeeRate, uint64 merchantDiscount) public initializer {
        __Ownable_init(msg.sender);
        _setFeeRates(baseFeeRate, merchantDiscount);
    }

    /// @notice Replace the fee rates. Both are basis points, capped at 10000.
    function setFeeRates(uint64 baseFeeRate, uint64 merchantDiscount) external onlyOwner {
        _setFeeRates(baseFeeRate, merchantDiscount);
    }

    /// @notice Allow a contract to query canSend / canReceive / merchant fees
    ///         for users other than itself.
    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
        emit AuthorizedCallerSet(caller, authorized);
    }

    function _setFeeRates(uint64 baseFeeRate, uint64 merchantDiscount) internal {
        require(baseFeeRate <= BPS && merchantDiscount <= BPS, "EncryptedFlags: rate above 10000");
        _baseFeeRate = FHE.asEuint64(baseFeeRate);
        FHE.allowThis(_baseFeeRate);
        _merchantDiscount = FHE.asEuint64(merchantDiscount);
        FHE.allowThis(_merchantDiscount);
        emit FeeRatesSet(baseFeeRate, merchantDiscount);
    }

    /// @dev Without this, any caller could read any user's flags through
    ///      the combined result, which is an oracle on the user's status.
    modifier onlyUserOrAuthorized(address user) {
        require(msg.sender == user || authorizedCallers[msg.sender], "EncryptedFlags: not authorized");
        _;
    }

    // ═══════════════════════════════════════════════════════════════
    //  ENCRYPTED BOOLEAN FLAGS (ebool + and/or/not)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Set a user's verification status (admin only)
    function setVerified(address user, bool verified) external onlyOwner {
        _isVerified[user] = FHE.asEbool(verified);
        FHE.allowThis(_isVerified[user]);
        FHE.allow(_isVerified[user], user);
        emit FlagSet(user, "verified", block.timestamp);
    }

    /// @notice Set account active status
    function setActive(address user, bool active) external onlyOwner {
        _isActive[user] = FHE.asEbool(active);
        FHE.allowThis(_isActive[user]);
        FHE.allow(_isActive[user], user);
        emit FlagSet(user, "active", block.timestamp);
    }

    /// @notice Set KYC completion
    function setKYCCompleted(address user) external onlyOwner {
        _hasCompletedKYC[user] = FHE.asEbool(true);
        FHE.allowThis(_hasCompletedKYC[user]);
        FHE.allow(_hasCompletedKYC[user], user);
        emit FlagSet(user, "kyc", block.timestamp);
    }

    /// @notice Set merchant flag
    function setMerchant(address user, bool isMerchant) external onlyOwner {
        _isMerchant[user] = FHE.asEbool(isMerchant);
        FHE.allowThis(_isMerchant[user]);
        FHE.allow(_isMerchant[user], user);
        emit FlagSet(user, "merchant", block.timestamp);
    }

    /// @notice Check if a user can send payments
    ///         Must be: verified AND active AND NOT frozen
    ///         Uses: FHE.and(), FHE.not() on encrypted booleans
    function canSend(address user) external onlyUserOrAuthorized(user) returns (ebool) {
        ebool verified = _isVerified[user];
        ebool active = _isActive[user];

        // encrypted AND: both conditions must be true
        ebool result = FHE.and(verified, active);
        FHE.allowSender(result);
        return result;
    }

    /// @notice Check if user can receive (verified OR has completed KYC)
    ///         Uses: FHE.or() on encrypted booleans
    function canReceive(address user) external onlyUserOrAuthorized(user) returns (ebool) {
        ebool verified = _isVerified[user];
        ebool kycDone = _hasCompletedKYC[user];

        // encrypted OR: either condition is sufficient
        ebool result = FHE.or(verified, kycDone);
        FHE.allowSender(result);
        return result;
    }

    /// @notice Toggle a user's active status (encrypted XOR with true = flip)
    ///         Uses: FHE.xor() — encrypted toggle without revealing current state
    function toggleActive(address user) external onlyOwner {
        ebool current = _isActive[user];
        ebool flipper = FHE.asEbool(true);

        // XOR with true flips the boolean: true→false, false→true
        _isActive[user] = FHE.xor(current, flipper);
        FHE.allowThis(_isActive[user]);
        FHE.allow(_isActive[user], user);
        emit FlagSet(user, "active_toggled", block.timestamp);
    }

    /// @notice Invert verification (for testing/admin)
    ///         Uses: FHE.not() on encrypted boolean
    function invertVerification(address user) external onlyOwner {
        _isVerified[user] = FHE.not(_isVerified[user]);
        FHE.allowThis(_isVerified[user]);
        FHE.allow(_isVerified[user], user);
    }

    // ═══════════════════════════════════════════════════════════════
    //  FEE ENGINE (mul + shr for percentage calculation)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Calculate encrypted fee for an amount: fee = amount * rate / 10000.
    /// @param encAmount Encrypted payment amount
    /// @return fee Encrypted fee amount
    /// @return netAmount Encrypted amount after fee deduction
    function calculateFee(externalEuint64 encAmount, bytes calldata proof) external returns (euint64 fee, euint64 netAmount) {
        euint64 amount = FHE.asEuint64(encAmount, proof);
        fee = _applyBps(amount, _baseFeeRate);
        netAmount = FHE.sub(amount, fee);

        FHE.allowThis(fee);
        FHE.allowSender(fee);
        FHE.allowThis(netAmount);
        FHE.allowSender(netAmount);

        emit FeeCalculated(msg.sender, block.timestamp);
    }

    /// @notice Calculate merchant fee: the base fee minus the merchant
    ///         discount share when `merchant` holds the merchant flag.
    /// @dev    Restricted to the merchant or an authorized contract. Open
    ///         access would let anyone learn merchant status by comparing
    ///         this fee against calculateFee.
    function calculateMerchantFee(externalEuint64 encAmount, bytes calldata proof, address merchant)
        external
        onlyUserOrAuthorized(merchant)
        returns (euint64 fee, euint64 netAmount)
    {
        euint64 amount = FHE.asEuint64(encAmount, proof);

        euint64 baseFee = _applyBps(amount, _baseFeeRate);
        euint64 discount = _applyBps(baseFee, _merchantDiscount);
        fee = FHE.select(_isMerchant[merchant], FHE.sub(baseFee, discount), baseFee);
        netAmount = FHE.sub(amount, fee);

        FHE.allowThis(fee);
        FHE.allowSender(fee);
        FHE.allowThis(netAmount);
        FHE.allowSender(netAmount);
    }

    /// @dev x * rateBps / 10000, split as (x / BPS) * rate + (x % BPS) * rate / BPS
    ///      so the product never overflows uint64 for rate <= BPS. Clamped to
    ///      x so a rate stored before the cap cannot make the caller's sub wrap.
    function _applyBps(euint64 x, euint64 rateBps) internal returns (euint64) {
        euint64 bps = FHE.asEuint64(BPS);
        euint64 whole = FHE.mul(FHE.div(x, bps), rateBps);
        euint64 part = FHE.div(FHE.mul(FHE.rem(x, bps), rateBps), bps);
        return FHE.min(FHE.add(whole, part), x);
    }

    // ═══════════════════════════════════════════════════════════════
    //  AUDIT SCOPE BITMASK (from Alpaca-Invoice pattern)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Set audit scope for an auditor (encrypted bitmask)
    ///         Each bit controls access to a specific data category
    function setAuditScope(address auditor, externalEuint8 encScope, bytes calldata proof) external {
        euint8 scope = FHE.asEuint8(encScope, proof);
        _auditScopes[msg.sender][auditor] = scope;
        FHE.allowThis(scope);
        FHE.allowSender(scope);
        FHE.allow(scope, auditor);
        emit AuditScopeSet(msg.sender, auditor, block.timestamp);
    }

    /// @notice Check if auditor has access to a specific scope bit
    ///         Uses: FHE.and() with euint8 for bitwise AND
    function checkAuditScope(address user, address auditor, externalEuint8 encBitMask, bytes calldata proof) external returns (ebool) {
        require(msg.sender == user || msg.sender == auditor, "EncryptedFlags: not user or auditor");
        euint8 scope = _auditScopes[user][auditor];
        euint8 mask = FHE.asEuint8(encBitMask, proof);

        // Bitwise AND to check if the specific bit is set
        euint8 result = FHE.and(scope, mask);

        // Check if result is non-zero (bit was set)
        euint8 zero = FHE.asEuint8(0);
        ebool hasAccess = FHE.ne(result, zero);

        FHE.allowSender(hasAccess);
        return hasAccess;
    }

    // ═══════════════════════════════════════════════════════════════
    //  VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════

    function getMyVerifiedStatus() external view returns (ebool) { return _isVerified[msg.sender]; }
    function getMyActiveStatus() external view returns (ebool) { return _isActive[msg.sender]; }
    function getMyKYCStatus() external view returns (ebool) { return _hasCompletedKYC[msg.sender]; }
    function getMyMerchantStatus() external view returns (ebool) { return _isMerchant[msg.sender]; }
    function getAuditScope(address auditor) external view returns (euint8) { return _auditScopes[msg.sender][auditor]; }

    /// @dev Reserved storage to avoid collisions on future upgrades.
    ///      Append-only: when adding a new state variable in a later upgrade,
    ///      decrement the gap size so total storage is unchanged.
    /// @dev Contracts allowed to query flags and merchant fees for other users.
    mapping(address => bool) public authorizedCallers;

    /// @dev Used: 9. Gap: 49.
    uint256[49] private __gap;

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
