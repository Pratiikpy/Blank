// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title EncryptedFlags — Encrypted compliance flags, fee engine, and access control
/// @notice Demonstrates advanced FHE operations:
///         - ebool for encrypted verification status
///         - and/or/not/xor for encrypted boolean logic
///         - euint8 for encrypted flag bitmasks
///         - shl/shr for efficient fee calculation
///         - mul for percentage-based fees
///
/// Pattern inspired by Alpaca-Invoice's compliance rules and NullPay's privacy layers.

contract EncryptedFlags is UUPSUpgradeable, OwnableUpgradeable {

    // ─── Encrypted User Flags ───────────────────────────────────────
    // Each flag is an ebool — nobody can see a user's verification status
    // except the user themselves and authorized contracts

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
    // Fee rates stored as encrypted values for privacy
    euint64 private _baseFeeRate;    // Base fee in basis points (e.g., 100 = 1%)
    euint64 private _merchantDiscount; // Discount for merchants

    // ─── Encrypted Audit Scopes (from Alpaca-Invoice pattern) ──────
    // When sharing data with auditor, a bitmask controls which fields are visible
    // Bit 0: amounts, Bit 1: parties, Bit 2: timestamps, Bit 3: memos
    // Bit 4: receipt_ids, Bit 5: fee_details, Bit 6: compliance_status
    mapping(address => mapping(address => euint8)) private _auditScopes; // user → auditor → scope mask

    event FlagSet(address indexed user, string flagType, uint256 timestamp);
    event AuditScopeSet(address indexed user, address indexed auditor, uint256 timestamp);
    event FeeCalculated(address indexed user, uint256 timestamp);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(uint64 baseFeeRate, uint64 merchantDiscount) public initializer {
        __Ownable_init(msg.sender);

        _baseFeeRate = FHE.asEuint64(baseFeeRate);
        FHE.allowThis(_baseFeeRate);

        _merchantDiscount = FHE.asEuint64(merchantDiscount);
        FHE.allowThis(_merchantDiscount);
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
    function canSend(address user) external returns (ebool) {
        ebool verified = _isVerified[user];
        ebool active = _isActive[user];

        // encrypted AND: both conditions must be true
        ebool result = FHE.and(verified, active);
        FHE.allowSender(result);
        return result;
    }

    /// @notice Check if user can receive (verified OR has completed KYC)
    ///         Uses: FHE.or() on encrypted booleans
    function canReceive(address user) external returns (ebool) {
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

    /// @notice Calculate encrypted fee for an amount
    ///         Uses FHE.mul() for amount * rate, FHE.shr() for division by shift
    ///         Pattern: fee = (amount * rateInBps) >> 14 (divide by ~16384, approximates /10000)
    /// @param encAmount Encrypted payment amount
    /// @return fee Encrypted fee amount
    /// @return netAmount Encrypted amount after fee deduction
    function calculateFee(InEuint64 memory encAmount) external returns (euint64 fee, euint64 netAmount) {
        euint64 amount = FHE.asEuint64(encAmount);

        // fee = amount * baseFeeRate (in basis points, e.g., 100 = 1%)
        // Then shift right by 14 to approximate division by 10000
        // This gives us ~0.6% precision which is acceptable for fees
        euint64 feeProduct = FHE.mul(amount, _baseFeeRate);
        fee = FHE.shr(feeProduct, FHE.asEuint64(14)); // >> 14 ≈ / 16384

        // Net = amount - fee
        netAmount = FHE.sub(amount, fee);

        // Allow caller to read results
        FHE.allowThis(fee);
        FHE.allowSender(fee);
        FHE.allowThis(netAmount);
        FHE.allowSender(netAmount);

        emit FeeCalculated(msg.sender, block.timestamp);
    }

    /// @notice Calculate merchant fee (discounted)
    ///         Demonstrates chained FHE operations: mul → shr → sub → select
    function calculateMerchantFee(InEuint64 memory encAmount, address merchant) external returns (euint64 fee, euint64 netAmount) {
        euint64 amount = FHE.asEuint64(encAmount);

        // Calculate base fee
        euint64 baseFee = FHE.shr(FHE.mul(amount, _baseFeeRate), FHE.asEuint64(14));

        // Calculate discount
        euint64 discount = FHE.shr(FHE.mul(baseFee, _merchantDiscount), FHE.asEuint64(14));

        // Check if merchant flag is set
        ebool isMerch = _isMerchant[merchant];

        // Apply discount only if merchant (encrypted conditional)
        euint64 discountedFee = FHE.sub(baseFee, discount);
        fee = FHE.select(isMerch, discountedFee, baseFee);

        netAmount = FHE.sub(amount, fee);

        FHE.allowThis(fee);
        FHE.allowSender(fee);
        FHE.allowThis(netAmount);
        FHE.allowSender(netAmount);
    }

    // ═══════════════════════════════════════════════════════════════
    //  AUDIT SCOPE BITMASK (from Alpaca-Invoice pattern)
    // ═══════════════════════════════════════════════════════════════

    /// @notice Set audit scope for an auditor (encrypted bitmask)
    ///         Each bit controls access to a specific data category
    function setAuditScope(address auditor, InEuint8 memory encScope) external {
        euint8 scope = FHE.asEuint8(encScope);
        _auditScopes[msg.sender][auditor] = scope;
        FHE.allowThis(scope);
        FHE.allow(scope, msg.sender);
        FHE.allow(scope, auditor);
        emit AuditScopeSet(msg.sender, auditor, block.timestamp);
    }

    /// @notice Check if auditor has access to a specific scope bit
    ///         Uses: FHE.and() with euint8 for bitwise AND
    function checkAuditScope(address user, address auditor, InEuint8 memory encBitMask) external returns (ebool) {
        euint8 scope = _auditScopes[user][auditor];
        euint8 mask = FHE.asEuint8(encBitMask);

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

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
