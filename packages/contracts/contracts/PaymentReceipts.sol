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

    // Encrypted global stats — anyone can decrypt via FHE.allowGlobal.
    // Used for the landing-page "$X moved encrypted through Blank" counter.
    // Aggregates are safe to expose because no individual transaction can
    // be inferred from them (anonymity set = all platform users).
    euint64 private _globalVolume;
    euint64 private _globalTxCount;
    bool private _globalStatsInitialized;

    // ─── Qualification Proofs (v0.1.3, append-only storage) ──────────────
    // Encrypted "≥ threshold" claims about a user's total received income or
    // balance. The proof's ebool is stored on-chain and FHE.allowPublic'd so
    // anyone can later finalize it via publishProof(). Verifier flow: read
    // getProofHandle(id) → off-chain decryptForTx → publishProof → read
    // getProof(id) for the public verdict. Threshold is plaintext (public
    // by design) — the actual income/balance never is.
    struct QualificationProof {
        address prover;
        uint64 threshold;
        uint256 blockNumber;
        uint256 timestamp;
        ebool result;
        string kind;       // "income" | "balance"
        bool exists;
    }

    uint256 public proofCount;
    mapping(uint256 => QualificationProof) private _proofs;
    mapping(address => uint256[]) private _userProofs;

    event ReceiptIssued(
        bytes32 indexed receiptHash,
        address indexed payer,
        address indexed payee,
        uint256 timestamp
    );

    event ProofCreated(
        uint256 indexed proofId,
        address indexed prover,
        uint64 threshold,
        string kind,
        uint256 timestamp
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize() public initializer {
        __Ownable_init(msg.sender);
        _globalVolume = FHE.asEuint64(0);
        FHE.allowThis(_globalVolume);
        FHE.allowGlobal(_globalVolume);
        _globalTxCount = FHE.asEuint64(0);
        FHE.allowThis(_globalTxCount);
        FHE.allowGlobal(_globalTxCount);
        _globalStatsInitialized = true;
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

        // Update global aggregates — public via FHE.allowGlobal so the
        // landing page (and anyone else) can decrypt and display them.
        _ensureGlobalStatsInit();
        _globalVolume = FHE.add(_globalVolume, amount);
        FHE.allowThis(_globalVolume);
        FHE.allowGlobal(_globalVolume);
        _globalTxCount = FHE.add(_globalTxCount, FHE.asEuint64(1));
        FHE.allowThis(_globalTxCount);
        FHE.allowGlobal(_globalTxCount);

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

    // ─── Qualification proofs (v0.1.3) ──────────────────────────────────

    /// @notice Prove your encrypted total received income is >= threshold,
    ///         WITHOUT revealing the actual income. Returns a proof id that
    ///         can be shared as a verification link. Anyone can finalize the
    ///         proof on-chain via publishProof() — only the prover ever
    ///         learns the underlying income amount.
    /// @param thresholdPlaintext Public threshold to prove against (e.g. $50,000)
    function proveIncomeAbove(uint64 thresholdPlaintext) external returns (uint256 proofId) {
        _initUserStats(msg.sender);

        euint64 income = _totalReceived[msg.sender];
        euint64 threshold = FHE.asEuint64(thresholdPlaintext);
        ebool result = FHE.gte(income, threshold);
        FHE.allowThis(result);
        FHE.allowSender(result);
        FHE.allowPublic(result);

        proofId = proofCount++;
        _proofs[proofId] = QualificationProof({
            prover: msg.sender,
            threshold: thresholdPlaintext,
            blockNumber: block.number,
            timestamp: block.timestamp,
            result: result,
            kind: "income",
            exists: true
        });
        _userProofs[msg.sender].push(proofId);

        emit ProofCreated(proofId, msg.sender, thresholdPlaintext, "income", block.timestamp);
    }

    /// @notice Publish the off-chain decryption of a proof's ebool so it can
    ///         be read on-chain via getProof(). Anyone can call this — the
    ///         signature must be a valid Threshold Network signature over
    ///         (proof.result, plaintext).
    function publishProof(uint256 proofId, bool plaintext, bytes calldata signature) external {
        QualificationProof storage p = _proofs[proofId];
        require(p.exists, "PaymentReceipts: proof not found");
        FHE.publishDecryptResult(p.result, plaintext, signature);
    }

    /// @notice Read a proof's metadata + verification result. `isReady` is
    ///         false until publishProof() has been called for this proof id.
    function getProof(uint256 proofId) external view returns (
        address prover,
        uint64 threshold,
        uint256 blockNumber,
        uint256 timestamp,
        string memory kind,
        bool isTrue,
        bool isReady
    ) {
        QualificationProof storage p = _proofs[proofId];
        require(p.exists, "PaymentReceipts: proof not found");
        (bool result, bool ready) = FHE.getDecryptResultSafe(p.result);
        return (p.prover, p.threshold, p.blockNumber, p.timestamp, p.kind, result, ready);
    }

    /// @notice Read the encrypted ebool handle for off-chain decryption via
    ///         the cofhe-sdk client. Caller passes this to decryptForTx then
    ///         submits the result to publishProof.
    function getProofHandle(uint256 proofId) external view returns (ebool) {
        return _proofs[proofId].result;
    }

    /// @notice List a user's proof ids (in creation order).
    function getProofsByUser(address user) external view returns (uint256[] memory) {
        return _userProofs[user];
    }

    // ─── Public encrypted aggregates ────────────────────────────────────

    /// @notice Encrypted handle for total volume across all receipts. Anyone
    ///         can decrypt via cofhe-sdk's decryptForView (no permit needed
    ///         because the contract calls FHE.allowGlobal). Used by the
    ///         landing-page counter.
    function getGlobalVolumeHandle() external view returns (euint64) {
        return _globalVolume;
    }

    /// @notice Encrypted handle for total transaction count. Same global
    ///         decrypt semantics as getGlobalVolumeHandle.
    function getGlobalTxCountHandle() external view returns (euint64) {
        return _globalTxCount;
    }

    function _ensureGlobalStatsInit() internal {
        if (!_globalStatsInitialized) {
            _globalStatsInitialized = true;
            // _globalVolume already initialized to euint64(0) in initialize();
            // _globalTxCount needs explicit init since it was added later.
            _globalTxCount = FHE.asEuint64(0);
            FHE.allowThis(_globalTxCount);
            FHE.allowGlobal(_globalTxCount);
            // Also re-mark _globalVolume as global (idempotent — was previously
            // only allowThis'd in the v1 initializer).
            FHE.allowGlobal(_globalVolume);
        }
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
