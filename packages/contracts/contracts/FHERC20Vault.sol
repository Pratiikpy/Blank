// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./utils/ReentrancyGuard.sol";

interface IEventHub {
    function emitActivity(
        address user1,
        address user2,
        string calldata activityType,
        string calldata note,
        uint256 refId
    ) external;
}

/// @title FHERC20Vault — Shield/unshield ERC20 tokens into FHE-encrypted balances
/// @notice One vault per underlying ERC20 token. All financial amounts are encrypted.
///         Social context (who transferred to whom, when) is public via events.
///         Financial details (how much) are encrypted and only visible to the owner.
///
/// @dev Key design decisions from ARCHITECTURE_FIXES.md:
///      - Uses FHE.select() for balance checks (not FHE.req) to avoid leaking balance info
///      - Transfer returns ebool success indicator instead of reverting
///      - Async two-step unshield: requestUnshield → claimUnshield
///      - ReentrancyGuard on all state-changing functions
///      - UUPS upgradeable for bug fixes without losing user funds
///      - Security zone 0 enforced everywhere
contract FHERC20Vault is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State ─────────────────────────────────────────────────────────

    IERC20 public underlyingToken;
    string public name;
    string public symbol;
    uint8 public tokenDecimals;
    IEventHub public eventHub;

    /// @dev All balances are encrypted. PRIVATE — never expose directly.
    mapping(address => euint64) private _balances;

    /// @dev Encrypted allowances: owner → spender → encrypted amount
    mapping(address => mapping(address => euint64)) private _allowances;

    /// @dev Pending unshield requests (address → encrypted amount awaiting decryption)
    mapping(address => euint64) private _pendingUnshields;

    /// @dev Tracks whether an address has ever had a balance (for zero-init)
    mapping(address => bool) private _initialized;

    /// @dev Encrypted zero constant (initialized once, reused)
    euint64 private ZERO;

    // ─── Events (public context, NO amounts) ───────────────────────────

    event Shielded(address indexed user, address indexed token, uint256 timestamp);
    event UnshieldRequested(address indexed user, address indexed token, uint256 timestamp);
    event UnshieldClaimed(address indexed user, address indexed token, uint256 plaintextAmount, uint256 timestamp);
    event EncryptedTransfer(address indexed from, address indexed to, uint256 timestamp);
    event EncryptedApproval(address indexed owner, address indexed spender, uint256 timestamp);

    // ─── Initializer ───────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _underlyingToken,
        string memory _name,
        string memory _symbol,
        uint8 _decimals,
        address _eventHub
    ) public initializer {
        __Ownable_init(msg.sender);
        // UUPSUpgradeable needs no init in OZ v5.6
        // ReentrancyGuard initialized via constructor

        underlyingToken = IERC20(_underlyingToken);
        name = _name;
        symbol = _symbol;
        tokenDecimals = _decimals;
        eventHub = IEventHub(_eventHub);

        // Initialize encrypted zero constant — reused to save gas
        ZERO = FHE.asEuint64(0);
        FHE.allowThis(ZERO);
    }

    // ─── Internal: ensure address has initialized encrypted balance ─────

    function _ensureInitialized(address account) internal {
        if (!_initialized[account]) {
            _balances[account] = FHE.asEuint64(0);
            FHE.allowThis(_balances[account]);
            FHE.allow(_balances[account], account);
            _initialized[account] = true;
        }
    }

    // ─── Shield: Deposit ERC20 → get encrypted balance ──────────────────

    /// @notice Convert plaintext ERC20 tokens into encrypted balance.
    ///         Amount is plaintext here (user is depositing publicly) but
    ///         once shielded, all operations are encrypted.
    /// @param amount Plaintext amount of underlying tokens to deposit
    function shield(uint256 amount) external nonReentrant {
        require(amount > 0, "FHERC20Vault: amount must be > 0");

        // Transfer underlying tokens from user to vault
        underlyingToken.safeTransferFrom(msg.sender, address(this), amount);

        _ensureInitialized(msg.sender);

        // Encrypt the amount and add to user's encrypted balance
        euint64 encAmount = FHE.asEuint64(amount);
        _balances[msg.sender] = FHE.add(_balances[msg.sender], encAmount);

        // Grant permissions
        FHE.allowThis(_balances[msg.sender]);
        FHE.allow(_balances[msg.sender], msg.sender);

        emit Shielded(msg.sender, address(underlyingToken), block.timestamp);

        // Emit to EventHub for activity feed
        try eventHub.emitActivity(msg.sender, address(0), "shield", "", 0) {} catch {}
    }

    // ─── Unshield: Burn encrypted balance → get ERC20 back ──────────────
    // Two-step async process:
    //   1. requestUnshield() — subtracts from encrypted balance, starts decryption
    //   2. claimUnshield() — after decryption resolves, sends ERC20 to user

    /// @notice Request to convert encrypted balance back to plaintext ERC20.
    ///         Uses FHE.select() to avoid leaking whether balance is sufficient.
    /// @param encAmount Encrypted amount to unshield
    /// @return success Encrypted boolean — unseal to check if it worked
    function requestUnshield(InEuint64 memory encAmount) external nonReentrant returns (euint64) {
        _ensureInitialized(msg.sender);

        euint64 amount = FHE.asEuint64(encAmount);

        // Check balance using select (privacy-preserving — no revert on insufficient)
        ebool hasEnough = FHE.gte(_balances[msg.sender], amount);

        // If sufficient: subtract amount. If not: subtract zero (no-op).
        euint64 actualAmount = FHE.select(hasEnough, amount, ZERO);
        _balances[msg.sender] = FHE.sub(_balances[msg.sender], actualAmount);

        // Store pending unshield and request decryption
        _pendingUnshields[msg.sender] = actualAmount;

        // Grant permissions
        FHE.allowThis(_balances[msg.sender]);
        FHE.allow(_balances[msg.sender], msg.sender);
        FHE.allowThis(_pendingUnshields[msg.sender]);
        FHE.allow(_pendingUnshields[msg.sender], msg.sender);

        // v0.1.3 migration: FHE.decrypt removed. Mark publicly decryptable.
        // Caller decrypts off-chain via the cofhe-sdk client client.decryptForTx,
        // then calls claimUnshield(plaintext, signature) below.
        FHE.allowPublic(_pendingUnshields[msg.sender]);

        emit UnshieldRequested(msg.sender, address(underlyingToken), block.timestamp);
        try eventHub.emitActivity(msg.sender, address(0), "unshield", "", 0) {} catch {}

        return _pendingUnshields[msg.sender];
    }

    /// @notice Claim a completed unshield. Caller supplies the off-chain
    ///         decrypted amount along with the Threshold Network signature
    ///         that proves the plaintext is authentic.
    /// @param plaintext The decrypted unshield amount returned by decryptForTx.
    /// @param signature The Threshold Network ECDSA signature over the result.
    function claimUnshield(uint64 plaintext, bytes calldata signature) external nonReentrant {
        euint64 pending = _pendingUnshields[msg.sender];

        // Verify the off-chain decryption by publishing it on-chain. After
        // this call, getDecryptResultSafe(pending) returns (plaintext, true).
        FHE.publishDecryptResult(pending, plaintext, signature);

        (uint64 plainAmount, bool ready) = FHE.getDecryptResultSafe(pending);
        require(ready, "FHERC20Vault: decryption not ready yet");
        require(plainAmount > 0, "FHERC20Vault: nothing to claim");

        // Clear pending (can't delete FHE types, reset to zero)
        _pendingUnshields[msg.sender] = FHE.asEuint64(0);
        FHE.allowThis(_pendingUnshields[msg.sender]);

        // Transfer underlying tokens back to user
        underlyingToken.safeTransfer(msg.sender, plainAmount);

        emit UnshieldClaimed(msg.sender, address(underlyingToken), plainAmount, block.timestamp);
    }

    /// @notice Read the pending unshield ciphertext handle for a user.
    ///         The frontend uses this to fetch the ctHash, then calls
    ///         decryptForTx off-chain to obtain (plaintext, signature)
    ///         for the claimUnshield(plaintext, signature) call above.
    function pendingUnshield(address account) external view returns (euint64) {
        return _pendingUnshields[account];
    }

    // ─── Encrypted Transfer ─────────────────────────────────────────────

    /// @notice Transfer encrypted tokens from sender to recipient.
    ///         Uses FHE.select() — does NOT revert on insufficient balance.
    ///         Returns the encrypted amount that was actually transferred
    ///         (zero if balance was insufficient).
    /// @param to Recipient address
    /// @param encAmount Encrypted amount to transfer
    /// @return transferred The encrypted amount actually transferred (zero if failed)
    function transfer(address to, InEuint64 memory encAmount) external nonReentrant returns (euint64) {
        require(to != address(0), "FHERC20Vault: transfer to zero address");
        require(to != msg.sender, "FHERC20Vault: transfer to self");

        _ensureInitialized(msg.sender);
        _ensureInitialized(to);

        euint64 amount = FHE.asEuint64(encAmount);

        // Privacy-preserving balance check
        ebool hasEnough = FHE.gte(_balances[msg.sender], amount);
        euint64 actualAmount = FHE.select(hasEnough, amount, ZERO);

        // Execute transfer
        _balances[msg.sender] = FHE.sub(_balances[msg.sender], actualAmount);
        _balances[to] = FHE.add(_balances[to], actualAmount);

        // Grant permissions — CRITICAL for both parties
        FHE.allowThis(_balances[msg.sender]);
        FHE.allow(_balances[msg.sender], msg.sender);
        FHE.allowThis(_balances[to]);
        FHE.allow(_balances[to], to);

        // Return handle so caller can check success
        FHE.allowThis(actualAmount);
        FHE.allowSender(actualAmount);

        emit EncryptedTransfer(msg.sender, to, block.timestamp);

        return actualAmount;
    }

    // ─── Encrypted TransferFrom (for approved contracts) ────────────────

    /// @notice Transfer tokens on behalf of `from` using encrypted allowance.
    ///         Used by PaymentHub, GroupManager, etc. after user approves them.
    /// @param from Token owner
    /// @param to Recipient
    /// @param encAmount Encrypted amount
    /// @return transferred The encrypted amount actually transferred
    function transferFrom(
        address from,
        address to,
        InEuint64 memory encAmount
    ) external nonReentrant returns (euint64) {
        require(to != address(0), "FHERC20Vault: transfer to zero address");

        _ensureInitialized(from);
        _ensureInitialized(to);

        euint64 amount = FHE.asEuint64(encAmount);

        return _executeTransferFrom(from, to, amount);
    }

    /// @notice Transfer tokens on behalf of `from` using a pre-verified euint64 handle.
    ///         Used by hub contracts that call FHE.asEuint64() in their own context
    ///         (where msg.sender = the user) to fix the InvalidSigner error that occurs
    ///         when FHE.asEuint64() is called in a cross-contract context (where
    ///         msg.sender = the calling contract, not the original tx signer).
    /// @param from Token owner
    /// @param to Recipient
    /// @param amount Pre-verified euint64 handle (caller must have called FHE.asEuint64)
    /// @return transferred The encrypted amount actually transferred
    function transferFromVerified(
        address from,
        address to,
        euint64 amount
    ) external nonReentrant returns (euint64) {
        require(to != address(0), "FHERC20Vault: transfer to zero address");

        _ensureInitialized(from);
        _ensureInitialized(to);

        return _executeTransferFrom(from, to, amount);
    }

    /// @dev Internal transfer logic shared by transferFrom and transferFromVerified.
    function _executeTransferFrom(
        address from,
        address to,
        euint64 amount
    ) internal returns (euint64) {
        // Check both balance AND allowance
        ebool hasBalance = FHE.gte(_balances[from], amount);
        ebool hasAllowance = FHE.gte(_allowances[from][msg.sender], amount);
        ebool canTransfer = FHE.and(hasBalance, hasAllowance);

        euint64 actualAmount = FHE.select(canTransfer, amount, ZERO);

        // Deduct allowance
        _allowances[from][msg.sender] = FHE.sub(_allowances[from][msg.sender], actualAmount);

        // Execute transfer
        _balances[from] = FHE.sub(_balances[from], actualAmount);
        _balances[to] = FHE.add(_balances[to], actualAmount);

        // Grant permissions
        FHE.allowThis(_balances[from]);
        FHE.allow(_balances[from], from);
        FHE.allowThis(_balances[to]);
        FHE.allow(_balances[to], to);
        FHE.allowThis(_allowances[from][msg.sender]);
        FHE.allow(_allowances[from][msg.sender], from);
        FHE.allowThis(actualAmount);
        FHE.allowTransient(actualAmount, msg.sender);

        emit EncryptedTransfer(from, to, block.timestamp);

        return actualAmount;
    }

    // ─── Approve ────────────────────────────────────────────────────────

    /// @notice Approve a spender to transfer encrypted tokens on your behalf.
    ///         Typically used to approve PaymentHub, GroupManager, etc.
    /// @param spender Address to approve (contract or EOA)
    /// @param encAmount Encrypted allowance amount
    function approve(address spender, InEuint64 memory encAmount) external nonReentrant {
        require(spender != address(0), "FHERC20Vault: approve zero address");

        euint64 amount = FHE.asEuint64(encAmount);
        _allowances[msg.sender][spender] = amount;

        FHE.allowThis(_allowances[msg.sender][spender]);
        FHE.allow(_allowances[msg.sender][spender], msg.sender);
        FHE.allow(_allowances[msg.sender][spender], spender);

        emit EncryptedApproval(msg.sender, spender, block.timestamp);
    }

    /// @notice Approve with a plaintext amount (convenience for infinite approvals).
    ///         Used for lazy approval pattern: approve(contract, type(uint64).max)
    /// @param spender Address to approve
    /// @param amount Plaintext allowance amount
    function approvePlaintext(address spender, uint64 amount) external nonReentrant {
        require(spender != address(0), "FHERC20Vault: approve zero address");

        euint64 encAmount = FHE.asEuint64(amount);
        _allowances[msg.sender][spender] = encAmount;

        FHE.allowThis(_allowances[msg.sender][spender]);
        FHE.allow(_allowances[msg.sender][spender], msg.sender);
        FHE.allow(_allowances[msg.sender][spender], spender);

        emit EncryptedApproval(msg.sender, spender, block.timestamp);
    }

    /// @notice Grant a third-party contract FHE read access to your encrypted
    ///         balance. Required before that contract can perform FHE operations
    ///         on your balance handle (e.g. PaymentReceipts.proveBalanceAbove).
    ///         Only the balance owner can call this — consent-based access.
    /// @param reader The contract address to grant read access to
    function allowBalanceReader(address reader) external {
        require(reader != address(0), "FHERC20Vault: reader zero");
        require(_initialized[msg.sender], "FHERC20Vault: not initialized");
        FHE.allow(_balances[msg.sender], reader);
    }

    // ─── View Functions ─────────────────────────────────────────────────

    /// @notice Get the encrypted balance handle for an account.
    ///         Caller must have a valid permit to unseal the value.
    /// @param account Address to query
    /// @return Encrypted balance handle (decrypt off-chain via the cofhe-sdk client)
    function balanceOf(address account) external view returns (euint64) {
        return _balances[account];
    }

    /// @notice Get the encrypted allowance handle.
    /// @param owner_ Token owner
    /// @param spender Approved spender
    /// @return Encrypted allowance handle
    function allowance(address owner_, address spender) external view returns (euint64) {
        return _allowances[owner_][spender];
    }

    /// @notice Check if an address has been initialized (has interacted with vault)
    function isInitialized(address account) external view returns (bool) {
        return _initialized[account];
    }

    /// @notice Get the total plaintext balance held by this vault (sum of all deposits)
    function totalDeposited() external view returns (uint256) {
        return underlyingToken.balanceOf(address(this));
    }

    // ─── Admin ──────────────────────────────────────────────────────────

    /// @notice Update the EventHub address (in case of upgrade)
    function setEventHub(address _eventHub) external onlyOwner {
        eventHub = IEventHub(_eventHub);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
