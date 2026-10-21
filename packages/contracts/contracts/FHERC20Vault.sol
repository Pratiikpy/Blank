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
    event TrustedBalanceReaderSet(address indexed reader, bool trusted);
    event BalanceReaderConsent(address indexed user, address indexed reader, bool allowed);

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
            // Also init the pending-unshield slot so requestUnshield's
            // "no outstanding pending" gate can compare against a real
            // encrypted-zero handle (FHE.eq on an uninitialized raw-zero
            // storage slot is unsafe). Without this init the gate would
            // need a plaintext flag → storage-layout change.
            _pendingUnshields[account] = FHE.asEuint64(0);
            FHE.allowThis(_pendingUnshields[account]);
            FHE.allow(_pendingUnshields[account], account);
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
        // The encrypted balance is euint64 — values above 2^64-1 would
        // truncate at FHE.asEuint64 below but the safeTransferFrom takes
        // the FULL uint256, locking the upper bits' worth of underlying
        // tokens in the vault with no claim path. For USDC (6 decimals)
        // the practical cap is ~18 trillion USDC — well above any real
        // shield — but for a 0-decimal token or a future 18-decimal
        // stablecoin, the cap is ~18 tokens. Reject explicitly so the
        // bound is honest at the source.
        require(amount <= type(uint64).max, "FHERC20Vault: amount exceeds uint64");

        // Credit what actually arrived, so a fee-on-transfer token cannot
        // mint encrypted balance the vault does not hold.
        uint256 balanceBefore = underlyingToken.balanceOf(address(this));
        underlyingToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balanceAfter = underlyingToken.balanceOf(address(this));
        uint256 received = balanceAfter - balanceBefore;
        require(received > 0, "FHERC20Vault: nothing received");

        // Overflow bound. Every encrypted balance and pending unshield is
        // backed 1:1 by underlying held here, so their sum never exceeds this
        // contract's token balance. Capping that balance at uint64 max means
        // no single encrypted balance can reach the wrap point, so the FHE.add
        // below cannot wrap. Checking here (in plaintext, before crediting)
        // reverts the whole shield instead of stranding pulled tokens.
        require(balanceAfter <= type(uint64).max, "FHERC20Vault: vault supply cap");

        _ensureInitialized(msg.sender);

        // Encrypt the amount and add to user's encrypted balance
        euint64 encAmount = FHE.asEuint64(received);
        _balances[msg.sender] = FHE.add(_balances[msg.sender], encAmount);

        // Grant permissions
        FHE.allowThis(_balances[msg.sender]);
        FHE.allowSender(_balances[msg.sender]);

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
    /// @param encAmount Encrypted amount handle to unshield
    /// @param proof Batch signature authenticating `encAmount`
    /// @return pending The caller's pending unshield handle, shared to the
    ///         caller. A contract caller consumes it with
    ///         FHE.receiveEuint64FromCall(result, vault); an EOA ignores it
    ///         and reads pendingUnshield(account) instead.
    function requestUnshield(
        externalEuint64 encAmount,
        bytes calldata proof
    ) external nonReentrant returns (sharedEuint64) {
        _ensureInitialized(msg.sender);

        euint64 amount = FHE.asEuint64(encAmount, proof);

        // CRITICAL anti-overwrite guard: pre-fix this function overwrote
        // _pendingUnshields on every call. A user with an outstanding
        // (un-claimed) pending could call again and lose the first
        // pending value — its balance was already deducted but never
        // claimable. Now the request is a no-op when there's an
        // outstanding pending: balance untouched, pending preserved.
        ebool noOutstanding = FHE.eq(_pendingUnshields[msg.sender], ZERO);
        ebool hasEnough = FHE.gte(_balances[msg.sender], amount);
        ebool canRequest = FHE.and(noOutstanding, hasEnough);

        // If allowed: subtract amount. If not: subtract zero (no-op).
        euint64 actualAmount = FHE.select(canRequest, amount, ZERO);
        _balances[msg.sender] = FHE.sub(_balances[msg.sender], actualAmount);

        // Store pending — keep existing pending when canRequest is false
        // so a duplicate-request can't silently zero out a real pending.
        _pendingUnshields[msg.sender] = FHE.select(canRequest, actualAmount, _pendingUnshields[msg.sender]);

        // Grant permissions
        FHE.allowThis(_balances[msg.sender]);
        FHE.allowSender(_balances[msg.sender]);
        FHE.allowThis(_pendingUnshields[msg.sender]);
        FHE.allowSender(_pendingUnshields[msg.sender]);

        // v0.1.3 migration: FHE.decrypt removed. Mark publicly decryptable.
        // Caller decrypts off-chain via the cofhe-sdk client client.decryptForTx,
        // then calls claimUnshield(plaintext, signature) below.
        FHE.allowPublic(_pendingUnshields[msg.sender]);

        emit UnshieldRequested(msg.sender, address(underlyingToken), block.timestamp);
        try eventHub.emitActivity(msg.sender, address(0), "unshield", "", 0) {} catch {}

        return FHE.shareEuint64(_pendingUnshields[msg.sender], msg.sender);
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
        // The user reads this handle to know the claim cleared.
        FHE.allowSender(_pendingUnshields[msg.sender]);

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
    /// @param encAmount Encrypted amount handle to transfer
    /// @param proof Batch signature authenticating `encAmount`
    /// @return transferred The encrypted amount actually transferred (zero if
    ///         failed), shared to the caller. An EOA ignores the return and
    ///         unseals the same handle through its persistent allow.
    function transfer(
        address to,
        externalEuint64 encAmount,
        bytes calldata proof
    ) external nonReentrant returns (sharedEuint64) {
        require(to != address(0), "FHERC20Vault: transfer to zero address");
        require(to != msg.sender, "FHERC20Vault: transfer to self");

        _ensureInitialized(msg.sender);
        _ensureInitialized(to);

        euint64 amount = FHE.asEuint64(encAmount, proof);

        // Privacy-preserving balance check
        ebool hasEnough = FHE.gte(_balances[msg.sender], amount);
        euint64 actualAmount = _move(msg.sender, to, FHE.select(hasEnough, amount, ZERO));

        // Grant permissions — CRITICAL for both parties
        FHE.allowThis(_balances[msg.sender]);
        FHE.allowSender(_balances[msg.sender]);
        FHE.allowThis(_balances[to]);
        FHE.allow(_balances[to], to);

        // Persistent allow lets an EOA caller unseal the result; the share
        // is what a contract caller consumes.
        FHE.allowThis(actualAmount);
        FHE.allowSender(actualAmount);

        emit EncryptedTransfer(msg.sender, to, block.timestamp);

        return FHE.shareEuint64(actualAmount, msg.sender);
    }

    // ─── Encrypted TransferFrom (for approved contracts) ────────────────

    /// @notice Transfer tokens FROM `msg.sender` TO `to` using a pre-verified
    ///         encrypted handle. Mirrors `transferFromVerified` but for the
    ///         common case where the caller already holds the funds (e.g.
    ///         BusinessHub releasing escrowed payments to the vendor or
    ///         refunding the client).
    ///
    ///         Pre-verified means the handle was previously produced by an
    ///         `FHE.asEuint64` call in `msg.sender`'s context — typically
    ///         carried over from an earlier `transferFromVerified` whose
    ///         result was stored in the caller's state. Skipping a fresh
    ///         `InEuint64` argument both saves gas (no ZK input verify) and
    ///         is the only way for a contract to move encrypted funds it
    ///         already holds — the caller doesn't have a fresh ciphertext
    ///         to encrypt; it has a handle.
    /// @param to Recipient
    /// @param shared Amount shared to this vault by the calling contract
    /// @return transferred The encrypted amount actually transferred, shared back
    ///         to the caller (zero if balance insufficient)
    function transferVerified(
        address to,
        sharedEuint64 shared
    ) external nonReentrant returns (sharedEuint64) {
        require(to != address(0), "FHERC20Vault: transfer to zero address");
        require(to != msg.sender, "FHERC20Vault: transfer to self");

        _ensureInitialized(msg.sender);
        _ensureInitialized(to);

        // The share slot records who directed this handle at us, so a caller
        // cannot name a ciphertext the vault merely happens to be allowed on.
        euint64 amount = FHE.receiveEuint64Param(shared);

        // Privacy-preserving balance check
        ebool hasEnough = FHE.gte(_balances[msg.sender], amount);
        euint64 actualAmount = _move(msg.sender, to, FHE.select(hasEnough, amount, ZERO));

        // Grant permissions — both parties + this contract
        FHE.allowThis(_balances[msg.sender]);
        FHE.allowSender(_balances[msg.sender]);
        FHE.allowThis(_balances[to]);
        FHE.allow(_balances[to], to);

        // Return handle so caller can check actual amount transferred. The
        // share is directed at the caller instead of a bare allowTransient,
        // so the caller can prove where the value came from.
        FHE.allowThis(actualAmount);

        emit EncryptedTransfer(msg.sender, to, block.timestamp);

        return FHE.shareEuint64(actualAmount, msg.sender);
    }

    /// @notice Transfer tokens on behalf of `from` using encrypted allowance.
    ///         Used by PaymentHub, GroupManager, etc. after user approves them.
    /// @param from Token owner
    /// @param to Recipient
    /// @param encAmount Encrypted amount
    /// @return transferred The encrypted amount actually transferred, shared
    ///         to the caller
    function transferFrom(
        address from,
        address to,
        externalEuint64 encAmount,
        bytes calldata proof
    ) external nonReentrant returns (sharedEuint64) {
        require(to != address(0), "FHERC20Vault: transfer to zero address");
        // Defense-in-depth: reject from == to. transferVerified already
        // rejects to == msg.sender; transferFrom (used by hubs that
        // pre-verified the encrypted input) needs an analogous guard.
        // Without it, a hub that forgets its own self-transfer check
        // (or an adversary calling the vault directly) can burn
        // allowance with no net balance change AND, more dangerously,
        // trigger any caller-side bookkeeping (income counter bumps,
        // event emissions) on a fake self-transfer. Same shape as the
        // BusinessHub.runPayroll + ClaimLinks self-claim fixes.
        require(from != to, "FHERC20Vault: from and to are the same");

        _ensureInitialized(from);
        _ensureInitialized(to);

        euint64 amount = FHE.asEuint64(encAmount, proof);

        return FHE.shareEuint64(_executeTransferFrom(from, to, amount), msg.sender);
    }

    /// @notice Transfer tokens on behalf of `from` using a pre-verified euint64 handle.
    ///         Used by hub contracts that call FHE.asEuint64() in their own context
    ///         (where msg.sender = the user) to fix the InvalidSigner error that occurs
    ///         when FHE.asEuint64() is called in a cross-contract context (where
    ///         msg.sender = the calling contract, not the original tx signer).
    /// @param from Token owner
    /// @param to Recipient
    /// @param shared Amount shared to this vault by the calling contract
    /// @return transferred The encrypted amount actually transferred, shared back
    ///         to the caller
    function transferFromVerified(
        address from,
        address to,
        sharedEuint64 shared
    ) external nonReentrant returns (sharedEuint64) {
        require(to != address(0), "FHERC20Vault: transfer to zero address");
        // See transferFrom for rationale — same defense-in-depth guard.
        require(from != to, "FHERC20Vault: from and to are the same");

        _ensureInitialized(from);
        _ensureInitialized(to);

        // Sharer must be our caller, so a handle the vault merely holds
        // permission on cannot be passed in by an unrelated party.
        euint64 amount = FHE.receiveEuint64Param(shared);

        return FHE.shareEuint64(_executeTransferFrom(from, to, amount), msg.sender);
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

        euint64 actualAmount = _move(from, to, FHE.select(canTransfer, amount, ZERO));

        // Deduct allowance by what actually moved
        _allowances[from][msg.sender] = FHE.sub(_allowances[from][msg.sender], actualAmount);

        // Grant permissions
        FHE.allowThis(_balances[from]);
        FHE.allow(_balances[from], from);
        FHE.allowThis(_balances[to]);
        FHE.allow(_balances[to], to);
        FHE.allowThis(_allowances[from][msg.sender]);
        FHE.allow(_allowances[from][msg.sender], from);
        FHE.allowThis(actualAmount);

        emit EncryptedTransfer(from, to, block.timestamp);

        return actualAmount;
    }

    /// @dev Moves an already balance-checked amount. If crediting `to` would
    ///      wrap euint64, nothing moves: the debit uses the same guarded
    ///      amount, so total supply stays consistent. The shield supply cap
    ///      makes the wrap unreachable today; this keeps it unreachable if
    ///      that bound is ever relaxed. Returns the amount actually moved.
    function _move(address from, address to, euint64 amount) internal returns (euint64 moved) {
        euint64 sum = FHE.add(_balances[to], amount);
        ebool noWrap = FHE.gte(sum, _balances[to]);
        moved = FHE.select(noWrap, amount, ZERO);
        _balances[from] = FHE.sub(_balances[from], moved);
        _balances[to] = FHE.select(noWrap, sum, _balances[to]);
    }

    // ─── Approve ────────────────────────────────────────────────────────

    /// @notice Approve a spender to transfer encrypted tokens on your behalf.
    ///         Typically used to approve PaymentHub, GroupManager, etc.
    /// @param spender Address to approve (contract or EOA)
    /// @param encAmount Encrypted allowance amount handle
    /// @param proof Batch signature authenticating `encAmount`
    function approve(
        address spender,
        externalEuint64 encAmount,
        bytes calldata proof
    ) external nonReentrant {
        require(spender != address(0), "FHERC20Vault: approve zero address");

        euint64 amount = FHE.asEuint64(encAmount, proof);
        _allowances[msg.sender][spender] = amount;

        FHE.allowThis(_allowances[msg.sender][spender]);
        FHE.allowSender(_allowances[msg.sender][spender]);
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
        FHE.allowSender(_allowances[msg.sender][spender]);
        FHE.allow(_allowances[msg.sender][spender], spender);

        emit EncryptedApproval(msg.sender, spender, block.timestamp);
    }

    /// @notice Consent to a trusted reader contract (e.g. PaymentReceipts)
    ///         receiving your CURRENT encrypted balance as a same-transaction
    ///         share, via shareBalanceWithReader. Nothing is granted on the
    ///         balance handle itself: that handle is replaced by every
    ///         balance write, so a persistent grant on it would go stale.
    ///         The consent is durable until revokeBalanceReader. Only readers
    ///         the vault owner trusts can be consented to, so a phished
    ///         signature cannot hand your balance to an arbitrary contract.
    /// @param reader The trusted contract address to consent to
    function allowBalanceReader(address reader) external {
        require(reader != address(0), "FHERC20Vault: reader zero");
        require(trustedBalanceReaders[reader], "FHERC20Vault: reader not trusted");
        require(_initialized[msg.sender], "FHERC20Vault: not initialized");
        _balanceReaderConsent[msg.sender][reader] = true;
        emit BalanceReaderConsent(msg.sender, reader, true);
    }

    /// @notice Withdraw consent given through allowBalanceReader.
    function revokeBalanceReader(address reader) external {
        _balanceReaderConsent[msg.sender][reader] = false;
        emit BalanceReaderConsent(msg.sender, reader, false);
    }

    /// @notice Hand `user`'s current encrypted balance to the calling reader
    ///         for the rest of this transaction. The caller must be a reader
    ///         the owner trusts AND `user` must have consented to it. The
    ///         reader consumes the result with
    ///         FHE.receiveEuint64FromCall(result, vault). A reader is
    ///         expected to pass only its own msg.sender as `user`.
    /// @param user Balance owner who consented through allowBalanceReader
    function shareBalanceWithReader(address user) external nonReentrant returns (sharedEuint64) {
        require(
            trustedBalanceReaders[msg.sender] && _balanceReaderConsent[user][msg.sender],
            "FHERC20Vault: reader not allowed"
        );
        return FHE.shareEuint64(_balances[user], msg.sender);
    }

    /// @notice Whether `reader` is trusted AND `user` has consented to it.
    function isBalanceReader(address user, address reader) external view returns (bool) {
        return trustedBalanceReaders[reader] && _balanceReaderConsent[user][reader];
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
        // A codeless hub makes every emitActivity call revert outside the
        // try/catch (extcodesize check), which would brick shield/unshield.
        require(_eventHub.code.length > 0, "FHERC20Vault: bad event hub");
        eventHub = IEventHub(_eventHub);
    }

    /// @notice Owner-managed set of contracts that may be consented to for
    ///         balance reads (PaymentReceipts). Appended after the original
    ///         layout.
    function setTrustedBalanceReader(address reader, bool trusted) external onlyOwner {
        require(!trusted || reader.code.length > 0, "FHERC20Vault: bad reader");
        trustedBalanceReaders[reader] = trusted;
        emit TrustedBalanceReaderSet(reader, trusted);
    }

    /// @notice Reader contracts the owner trusts with a shared balance handle.
    mapping(address => bool) public trustedBalanceReaders;

    /// @dev user => reader => consent given through allowBalanceReader.
    mapping(address => mapping(address => bool)) private _balanceReaderConsent;

    /// @dev Reserved storage to avoid collisions on future upgrades.
    ///      Append-only: when adding a new state variable in a later upgrade,
    ///      decrement the gap size so total storage is unchanged.
    /// @dev Used: 12. Gap: 48.
    uint256[48] private __gap;

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
