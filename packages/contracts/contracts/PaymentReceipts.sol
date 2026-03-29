// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title PaymentReceipts — Cryptographic encrypted receipts for every payment
/// @notice After each payment, a receipt is generated with:
///         - Encrypted random payment ID (FHE.randomEuint64)
///         - Encrypted amount stored in the receipt
///         - Both payer and payee can unseal their receipt
///         - Anyone can verify a receipt hash exists (without seeing amounts)
///
/// Inspired by NullPay's receipt system, adapted for FHE.
/// Uses: randomEuint64, eq, ne, sealOutput, min, max

contract PaymentReceipts is UUPSUpgradeable, OwnableUpgradeable {

    // ─── Access Control ────────────────────────────────────────────────
    mapping(address => bool) public authorizedCallers;

    modifier onlyAuthorized() {
        require(authorizedCallers[msg.sender] || msg.sender == owner(), "PaymentReceipts: unauthorized");
        _;
    }

    struct Receipt {
        euint64 paymentId;      // Encrypted random ID — prevents correlation
        euint64 amount;         // Encrypted amount — only parties can unseal
        address payer;
        address payee;
        address token;          // Which FHERC20Vault
        bytes32 receiptHash;    // keccak256(payer, payee, salt) — public anchor
        uint256 timestamp;
        bool exists;
    }

    uint256 public receiptCount;
    mapping(bytes32 => Receipt) private _receipts;       // receiptHash → Receipt
    mapping(address => bytes32[]) private _userReceipts;  // address → receipt hashes (both payer+payee)

    // Encrypted statistics per user
    mapping(address => euint64) private _totalSent;      // Encrypted total sent
    mapping(address => euint64) private _totalReceived;   // Encrypted total received
    mapping(address => euint64) private _transactionCount; // Encrypted tx count
    mapping(address => bool) private _statsInitialized;   // Whether user stats have been initialized

    // Encrypted global stats
    euint64 private _globalVolume;                        // Encrypted total volume

    event ReceiptIssued(
        bytes32 indexed receiptHash,
        address indexed payer,
        address indexed payee,
        uint256 timestamp
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize() public initializer {
        __Ownable_init(msg.sender);
        _globalVolume = FHE.asEuint64(0);
        FHE.allowThis(_globalVolume);
    }

    /// @notice Set or remove an authorized caller for issuing receipts
    /// @param caller Address to authorize or deauthorize
    /// @param authorized Whether the caller is authorized
    function setAuthorizedCaller(address caller, bool authorized) external onlyOwner {
        authorizedCallers[caller] = authorized;
    }

    /// @notice Issue a receipt after a payment. Called by authorized contracts only.
    /// @param payer Who sent the payment
    /// @param payee Who received the payment
    /// @param encAmount Encrypted payment amount
    /// @param token FHERC20Vault address
    /// @return receiptHash The public receipt anchor
    function issueReceipt(
        address payer,
        address payee,
        InEuint64 memory encAmount,
        address token
    ) external onlyAuthorized returns (bytes32) {
        require(payer != address(0) && payee != address(0), "Invalid addresses");

        // Generate encrypted random payment ID — nobody can predict or correlate
        euint64 paymentId = FHE.randomEuint64();
        FHE.allowThis(paymentId);
        FHE.allow(paymentId, payer);
        FHE.allow(paymentId, payee);

        euint64 amount = FHE.asEuint64(encAmount);

        // Create public receipt hash (anchor for verification)
        bytes32 salt = keccak256(abi.encodePacked(block.timestamp, payer, payee, receiptCount));
        bytes32 receiptHash = keccak256(abi.encodePacked(payer, payee, salt));

        // Ensure no duplicate (using ne would be on encrypted data, but hash is plaintext)
        require(!_receipts[receiptHash].exists, "Duplicate receipt");

        // Store receipt
        _receipts[receiptHash] = Receipt({
            paymentId: paymentId,
            amount: amount,
            payer: payer,
            payee: payee,
            token: token,
            receiptHash: receiptHash,
            timestamp: block.timestamp,
            exists: true
        });

        // Grant access to both parties
        FHE.allowThis(amount);
        FHE.allow(amount, payer);
        FHE.allow(amount, payee);

        // Update encrypted user stats
        _initUserStats(payer);
        _initUserStats(payee);

        _totalSent[payer] = FHE.add(_totalSent[payer], amount);
        FHE.allowThis(_totalSent[payer]);
        FHE.allow(_totalSent[payer], payer);

        _totalReceived[payee] = FHE.add(_totalReceived[payee], amount);
        FHE.allowThis(_totalReceived[payee]);
        FHE.allow(_totalReceived[payee], payee);

        // Increment encrypted transaction count using add(count, 1)
        euint64 one = FHE.asEuint64(1);
        _transactionCount[payer] = FHE.add(_transactionCount[payer], one);
        _transactionCount[payee] = FHE.add(_transactionCount[payee], one);
        FHE.allowThis(_transactionCount[payer]);
        FHE.allow(_transactionCount[payer], payer);
        FHE.allowThis(_transactionCount[payee]);
        FHE.allow(_transactionCount[payee], payee);

        // Update global volume
        _globalVolume = FHE.add(_globalVolume, amount);
        FHE.allowThis(_globalVolume);

        // Track receipts per user
        _userReceipts[payer].push(receiptHash);
        _userReceipts[payee].push(receiptHash);
        receiptCount++;

        emit ReceiptIssued(receiptHash, payer, payee, block.timestamp);
        return receiptHash;
    }

    /// @notice Verify a receipt exists (public — anyone can check)
    function verifyReceipt(bytes32 receiptHash) external view returns (
        bool exists,
        address payer,
        address payee,
        address token,
        uint256 timestamp
    ) {
        Receipt storage r = _receipts[receiptHash];
        return (r.exists, r.payer, r.payee, r.token, r.timestamp);
    }

    /// @notice Get the encrypted amount from a receipt (only parties can unseal)
    function getReceiptAmount(bytes32 receiptHash) external view returns (euint64) {
        require(_receipts[receiptHash].exists, "Receipt not found");
        return _receipts[receiptHash].amount;
    }

    /// @notice Get the encrypted random payment ID (only parties can unseal)
    function getReceiptPaymentId(bytes32 receiptHash) external view returns (euint64) {
        require(_receipts[receiptHash].exists, "Receipt not found");
        return _receipts[receiptHash].paymentId;
    }

    /// @notice Get your encrypted total sent (only you can unseal)
    function getMyTotalSent() external view returns (euint64) {
        return _totalSent[msg.sender];
    }

    /// @notice Get your encrypted total received
    function getMyTotalReceived() external view returns (euint64) {
        return _totalReceived[msg.sender];
    }

    /// @notice Get your encrypted transaction count
    function getMyTransactionCount() external view returns (euint64) {
        return _transactionCount[msg.sender];
    }

    /// @notice Compare two receipt amounts (encrypted comparison)
    /// @dev Uses eq() — returns ebool that only the caller can unseal
    function compareReceiptAmounts(bytes32 hash1, bytes32 hash2) external returns (ebool) {
        require(_receipts[hash1].exists && _receipts[hash2].exists, "Receipt not found");
        Receipt storage r1 = _receipts[hash1];
        Receipt storage r2 = _receipts[hash2];
        require(
            msg.sender == r1.payer || msg.sender == r1.payee || msg.sender == r2.payer || msg.sender == r2.payee,
            "PaymentReceipts: not a party"
        );
        ebool areEqual = FHE.eq(r1.amount, r2.amount);
        FHE.allowSender(areEqual);
        return areEqual;
    }

    /// @notice Find the larger of two receipt amounts
    /// @dev Uses max() — returns encrypted max that caller can unseal
    function maxReceiptAmount(bytes32 hash1, bytes32 hash2) external returns (euint64) {
        require(_receipts[hash1].exists && _receipts[hash2].exists, "Receipt not found");
        Receipt storage r1 = _receipts[hash1];
        Receipt storage r2 = _receipts[hash2];
        require(
            msg.sender == r1.payer || msg.sender == r1.payee || msg.sender == r2.payer || msg.sender == r2.payee,
            "PaymentReceipts: not a party"
        );
        euint64 result = FHE.max(r1.amount, r2.amount);
        FHE.allowSender(result);
        return result;
    }

    /// @notice Find the smaller of two receipt amounts
    function minReceiptAmount(bytes32 hash1, bytes32 hash2) external returns (euint64) {
        require(_receipts[hash1].exists && _receipts[hash2].exists, "Receipt not found");
        Receipt storage r1 = _receipts[hash1];
        Receipt storage r2 = _receipts[hash2];
        require(
            msg.sender == r1.payer || msg.sender == r1.payee || msg.sender == r2.payer || msg.sender == r2.payee,
            "PaymentReceipts: not a party"
        );
        euint64 result = FHE.min(r1.amount, r2.amount);
        FHE.allowSender(result);
        return result;
    }

    /// @notice Get all receipt hashes for a user
    function getUserReceipts(address user) external view returns (bytes32[] memory) {
        return _userReceipts[user];
    }

    function _initUserStats(address user) internal {
        if (!_statsInitialized[user]) {
            _statsInitialized[user] = true;
            _totalSent[user] = FHE.asEuint64(0);
            FHE.allowThis(_totalSent[user]);
            FHE.allow(_totalSent[user], user);
            _totalReceived[user] = FHE.asEuint64(0);
            FHE.allowThis(_totalReceived[user]);
            FHE.allow(_totalReceived[user], user);
            _transactionCount[user] = FHE.asEuint64(0);
            FHE.allowThis(_transactionCount[user]);
            FHE.allow(_transactionCount[user], user);
        }
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
