// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title EncryptedFlags — Encrypted compliance flags, fee engine, and access control
/// @notice Flags and fee rates are stored as ciphertexts. The combined
///         results (canSend, canReceive, merchant fees) may only be computed
///         by the user or an owner-authorized contract, and are returned as
///         shared handles so a calling contract can consume them.
///
/// @dev    Two ways to set a flag or the fee rates:
///         - the *Encrypted setters take an encrypted input, so the value is
///           never in calldata. Use these when the value is confidential.
///         - the plaintext setters (setVerified, setActive, setMerchant,
///           setKYCCompleted, setFeeRates, initialize) are DEPRECATED. They
///           stay because a Safe owner cannot yet be shown to produce an
///           encrypted input (NOT VERIFIED). The value is visible in their
///           transaction calldata; events no longer repeat it.

contract EncryptedFlags is UUPSUpgradeable, OwnableUpgradeable {

    // ─── Encrypted User Flags ───────────────────────────────────────
    // Each flag is an ebool. On-chain reads are limited to the user and this
    // contract; the plaintext setters leak the value through calldata.

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
    // Fee rates in basis points of 10000. Encrypted at rest. Public if set
    // through the plaintext setters, hidden if set through setFeeRatesEncrypted.
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
    /// @dev Carries no rate: the rates stay encrypted at rest.
    event FeeRatesSet(uint256 timestamp);

    uint64 public constant BPS = 10_000;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(uint64 baseFeeRate, uint64 merchantDiscount) public initializer {
        __Ownable_init(msg.sender);
        _setFeeRates(baseFeeRate, merchantDiscount);
    }

    /// @notice Replace the fee rates. Both are basis points, capped at 10000.
    /// @dev Deprecated: the rates are readable in this call's calldata. Use
    ///      setFeeRatesEncrypted for confidential rates.
    function setFeeRates(uint64 baseFeeRate, uint64 merchantDiscount) external onlyOwner {
        _setFeeRates(baseFeeRate, merchantDiscount);
    }

    /// @notice Replace the fee rates from encrypted inputs. Rates above 10000
    ///         bps are clamped to 10000 under FHE, since an encrypted value
    ///         cannot be rejected.
    /// @param proof One batch signature covering `encBaseFeeRate` then
    ///        `encMerchantDiscount`, in that order.
    function setFeeRatesEncrypted(
        externalEuint64 encBaseFeeRate,
        externalEuint64 encMerchantDiscount,
        bytes calldata proof
    ) external onlyOwner {
        externalEuint64[] memory packed = new externalEuint64[](2);
        packed[0] = encBaseFeeRate;
        packed[1] = encMerchantDiscount;
        euint64[] memory verified = FHE.asEuint64s(packed, proof);
        euint64 cap = FHE.asEuint64(BPS);
        _baseFeeRate = FHE.min(verified[0], cap);
        FHE.allowThis(_baseFeeRate);
        _merchantDiscount = FHE.min(verified[1], cap);
        FHE.allowThis(_merchantDiscount);
        emit FeeRatesSet(block.timestamp);
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
        emit FeeRatesSet(block.timestamp);
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

    /// @notice Set a user's verification status (admin only).
    /// @dev Deprecated: the value is readable in the calldata. Use setVerifiedEncrypted.
    function setVerified(address user, bool verified) external onlyOwner {
        _storeVerified(user, FHE.asEbool(verified));
    }

    /// @notice Set a user's verification status from an encrypted input.
    function setVerifiedEncrypted(address user, externalEbool encVerified, bytes calldata proof) external onlyOwner {
        _storeVerified(user, FHE.asEbool(encVerified, proof));
    }

    /// @notice Set account active status.
    /// @dev Deprecated: the value is readable in the calldata. Use setActiveEncrypted.
    function setActive(address user, bool active) external onlyOwner {
        _storeActive(user, FHE.asEbool(active));
    }

    /// @notice Set account active status from an encrypted input.
    function setActiveEncrypted(address user, externalEbool encActive, bytes calldata proof) external onlyOwner {
        _storeActive(user, FHE.asEbool(encActive, proof));
    }

    /// @notice Set KYC completion.
    /// @dev Deprecated: calling it at all announces that KYC completed. Use
    ///      setKYCCompletedEncrypted.
    function setKYCCompleted(address user) external onlyOwner {
        _storeKYC(user, FHE.asEbool(true));
    }

    /// @notice Set KYC completion from an encrypted input.
    function setKYCCompletedEncrypted(address user, externalEbool encKyc, bytes calldata proof) external onlyOwner {
        _storeKYC(user, FHE.asEbool(encKyc, proof));
    }

    /// @notice Set merchant flag.
    /// @dev Deprecated: the value is readable in the calldata. Use setMerchantEncrypted.
    function setMerchant(address user, bool isMerchant) external onlyOwner {
        _storeMerchant(user, FHE.asEbool(isMerchant));
    }

    /// @notice Set merchant flag from an encrypted input.
    function setMerchantEncrypted(address user, externalEbool encMerchant, bytes calldata proof) external onlyOwner {
        _storeMerchant(user, FHE.asEbool(encMerchant, proof));
    }

    function _storeVerified(address user, ebool value) internal {
        _isVerified[user] = value;
        FHE.allowThis(value);
        FHE.allow(value, user);
        emit FlagSet(user, "verified", block.timestamp);
    }

    function _storeActive(address user, ebool value) internal {
        _isActive[user] = value;
        FHE.allowThis(value);
        FHE.allow(value, user);
        emit FlagSet(user, "active", block.timestamp);
    }

    function _storeKYC(address user, ebool value) internal {
        _hasCompletedKYC[user] = value;
        FHE.allowThis(value);
        FHE.allow(value, user);
        emit FlagSet(user, "kyc", block.timestamp);
    }

    function _storeMerchant(address user, ebool value) internal {
        _isMerchant[user] = value;
        FHE.allowThis(value);
        FHE.allow(value, user);
        emit FlagSet(user, "merchant", block.timestamp);
    }

    /// @notice Check if a user can send payments
    ///         Must be: verified AND active. There is no separate frozen
    ///         flag: suspending an account means setActive(user, false).
    ///         Uses: FHE.and() on encrypted booleans
    ///         Returns a shared handle: a calling contract takes it with
    ///         FHE.receiveEboolFromCall(shared, flags). An EOA reads the same
    ///         handle through its allowSender permit.
    function canSend(address user) external onlyUserOrAuthorized(user) returns (sharedEbool) {
        ebool verified = _isVerified[user];
        ebool active = _isActive[user];

        // encrypted AND: both conditions must be true
        ebool result = FHE.and(verified, active);
        FHE.allowThis(result);
        FHE.allowSender(result);
        return FHE.shareEbool(result, msg.sender);
    }

    /// @notice Check if user can receive (verified OR has completed KYC)
    ///         Uses: FHE.or() on encrypted booleans
    ///         Returns a shared handle, like canSend.
    function canReceive(address user) external onlyUserOrAuthorized(user) returns (sharedEbool) {
        ebool verified = _isVerified[user];
        ebool kycDone = _hasCompletedKYC[user];

        // encrypted OR: either condition is sufficient
        ebool result = FHE.or(verified, kycDone);
        FHE.allowThis(result);
        FHE.allowSender(result);
        return FHE.shareEbool(result, msg.sender);
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
    ///         Both results are shared handles, taken by a calling contract
    ///         with FHE.receiveEuint64FromCall. A contract that holds the
    ///         amount as a handle rather than a user input should use
    ///         calculateFeeVerified.
    /// @param encAmount Encrypted payment amount
    /// @return fee Encrypted fee amount
    /// @return netAmount Encrypted amount after fee deduction
    function calculateFee(externalEuint64 encAmount, bytes calldata proof)
        external
        returns (sharedEuint64 fee, sharedEuint64 netAmount)
    {
        return _feeFor(FHE.asEuint64(encAmount, proof));
    }

    /// @notice calculateFee for an amount the caller shares as a handle.
    function calculateFeeVerified(sharedEuint64 sharedAmount)
        external
        returns (sharedEuint64 fee, sharedEuint64 netAmount)
    {
        return _feeFor(FHE.receiveEuint64Param(sharedAmount));
    }

    /// @notice Calculate merchant fee: the base fee minus the merchant
    ///         discount share when `merchant` holds the merchant flag.
    /// @dev    Restricted to the merchant or an authorized contract. Open
    ///         access would let anyone learn merchant status by comparing
    ///         this fee against calculateFee.
    function calculateMerchantFee(externalEuint64 encAmount, bytes calldata proof, address merchant)
        external
        onlyUserOrAuthorized(merchant)
        returns (sharedEuint64 fee, sharedEuint64 netAmount)
    {
        return _merchantFeeFor(FHE.asEuint64(encAmount, proof), merchant);
    }

    /// @notice calculateMerchantFee for an amount the caller shares as a handle.
    function calculateMerchantFeeVerified(sharedEuint64 sharedAmount, address merchant)
        external
        onlyUserOrAuthorized(merchant)
        returns (sharedEuint64 fee, sharedEuint64 netAmount)
    {
        return _merchantFeeFor(FHE.receiveEuint64Param(sharedAmount), merchant);
    }

    function _feeFor(euint64 amount) internal returns (sharedEuint64, sharedEuint64) {
        euint64 fee = _applyBps(amount, _baseFeeRate);
        euint64 netAmount = FHE.sub(amount, fee);
        emit FeeCalculated(msg.sender, block.timestamp);
        return _handBack(fee, netAmount);
    }

    function _merchantFeeFor(euint64 amount, address merchant) internal returns (sharedEuint64, sharedEuint64) {
        euint64 baseFee = _applyBps(amount, _baseFeeRate);
        euint64 discount = _applyBps(baseFee, _merchantDiscount);
        euint64 fee = FHE.select(_isMerchant[merchant], FHE.sub(baseFee, discount), baseFee);
        euint64 netAmount = FHE.sub(amount, fee);
        return _handBack(fee, netAmount);
    }

    /// @dev Keeps this contract and the caller on both results and shares
    ///      them with the caller.
    function _handBack(euint64 fee, euint64 netAmount) internal returns (sharedEuint64, sharedEuint64) {
        FHE.allowThis(fee);
        FHE.allowSender(fee);
        FHE.allowThis(netAmount);
        FHE.allowSender(netAmount);
        return (FHE.shareEuint64(fee, msg.sender), FHE.shareEuint64(netAmount, msg.sender));
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
