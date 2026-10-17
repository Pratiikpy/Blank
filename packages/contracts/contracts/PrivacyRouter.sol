// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./utils/ReentrancyGuard.sol";
import "./interfaces/ITokenRegistry.sol";

// ─── Interfaces ──────────────────────────────────────────────────────

interface IFHERC20Vault {
    function transferFrom(address from, address to, externalEuint64 encAmount, bytes calldata proof) external returns (euint64);
    function transferFromVerified(address from, address to, sharedEuint64 shared) external returns (sharedEuint64);
    function transfer(address to, externalEuint64 encAmount, bytes calldata proof) external returns (euint64);
    function balanceOf(address account) external view returns (euint64);
    function underlyingToken() external view returns (address);
    function shield(uint256 amount) external;
    function approvePlaintext(address spender, uint64 amount) external;
    function requestUnshield(externalEuint64 encAmount, bytes calldata proof) external returns (euint64);
    function claimUnshield(uint64 plaintext, bytes calldata signature) external;
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IEventHub {
    function emitActivity(
        address user1,
        address user2,
        string calldata activityType,
        string calldata note,
        uint256 refId
    ) external;
}

/// @title PrivacyRouter: encrypted-input token swap router
/// @notice Two-phase swap whose input arrives as an encrypted vault transfer.
///
///         1. User transfers encrypted vaultIn tokens to the router.
///         2. The moved amount is marked publicly decryptable so a keeper can
///            fetch the Threshold Network result.
///         3. The router swaps that plaintext amount of its own tokenIn
///            reserves on the DEX and pays tokenOut to the user in plaintext.
///
///         Privacy: the input amount is NOT private. It is publicly
///         decryptable from initiation, published on-chain at execution, and
///         the DEX leg and payout are plain ERC20 transfers.
///
/// @dev    - Vaults must be active in the TokenRegistry; tokenIn and tokenOut
///           come from the registry, never from the vault itself.
///         - Every tracked open swap is a liability on tokenIn reserves.
///           withdrawReserves cannot dip below known liabilities and is
///           blocked while an open swap on that token has an unpublished amount.
///         - The encrypted vaultIn balance the router accumulates is turned
///           back into reserves by the owner via requestReserveUnshield and
///           claimReserveUnshield.
///         - SWAP_EXPIRY (10 min) plus a user deadline bound execution time.
contract PrivacyRouter is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Types ──────────────────────────────────────────────────────────

    enum SwapStatus { Pending, Decrypting, Ready, Executed, Cancelled, Expired, Refunded }

    struct PendingSwap {
        uint256 swapId;
        address user;
        address vaultIn;        // FHERC20Vault for input token
        address vaultOut;       // FHERC20Vault for output token
        address tokenIn;        // Underlying ERC20 input
        address tokenOut;       // Underlying ERC20 output
        euint64 encryptedAmountIn;
        uint256 plaintextAmountIn;  // Filled after decrypt resolves
        uint256 minAmountOut;
        uint256 timestamp;
        SwapStatus status;
    }

    // ─── State ──────────────────────────────────────────────────────────

    ISwapRouter public dexRouter;
    IEventHub public eventHub;

    uint256 public nextSwapId;
    mapping(uint256 => PendingSwap) private _swaps;

    /// @dev Reverse lookup: user → their swap IDs
    mapping(address => uint256[]) private _userSwaps;

    /// @dev Swap expiry duration (10 minutes)
    uint256 public constant SWAP_EXPIRY = 10 minutes;

    /// @dev Default DEX fee tier (Uniswap V3 standard: 3000 = 0.3%)
    uint24 public constant DEFAULT_FEE = 3000;

    /// @dev Maximum slippage denominator for safety (used in internal calculations)
    uint256 public constant SLIPPAGE_PRECISION = 10000;

    // ─── Events ─────────────────────────────────────────────────────────

    event SwapInitiated(
        uint256 indexed swapId,
        address indexed user,
        address vaultIn,
        address vaultOut,
        uint256 minAmountOut,
        uint256 timestamp
    );

    event SwapExecuted(
        uint256 indexed swapId,
        address indexed user,
        uint256 amountOut,
        uint256 timestamp
    );

    event SwapCancelled(uint256 indexed swapId, address indexed user, uint256 timestamp);
    event SwapCancelledPendingRefund(uint256 indexed swapId, address indexed user, uint256 timestamp);
    event SwapExpired(uint256 indexed swapId, address indexed user, uint256 timestamp);
    event RouterFunded(address indexed token, uint256 amount, address indexed funder);
    event DexRouterUpdated(address indexed oldRouter, address indexed newRouter);
    event SwapRefunded(uint256 indexed swapId, address indexed user, uint256 amount);
    event TokenRegistrySet(address indexed registry);
    event SwapAmountResolved(uint256 indexed swapId, address indexed tokenIn, uint256 amount);
    event ReservesWithdrawn(address indexed token, uint256 amount, address indexed to);
    event ReserveUnshieldRequested(address indexed vault);
    event ReserveUnshieldClaimed(address indexed vault, uint256 amount);

    // ─── Initializer ────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address _dexRouter, address _eventHub) public initializer {
        __Ownable_init(msg.sender);

        require(_dexRouter != address(0), "PrivacyRouter: zero dex router");
        require(_eventHub != address(0), "PrivacyRouter: zero event hub");

        dexRouter = ISwapRouter(_dexRouter);
        eventHub = IEventHub(_eventHub);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  SWAP LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Step 1: Initiate a swap with an encrypted input amount.
    ///         Moves encrypted vaultIn tokens from the user to the router and
    ///         marks the moved amount publicly decryptable. The amount becomes
    ///         public once anyone publishes the decrypt result.
    ///
    ///         The user MUST have approved this contract on vaultIn before calling.
    ///
    /// @param vaultIn      Registry-active FHERC20Vault for the input token
    /// @param vaultOut     Registry-active FHERC20Vault for the output token
    /// @param encAmount    Encrypted amount of input tokens to swap
    /// @param minAmountOut Minimum acceptable DEX output, must be > 0
    /// @param deadline     Latest timestamp at which executeSwap may run
    /// @return swapId Unique identifier for this pending swap
    function initiateSwap(
        address vaultIn,
        address vaultOut,
        externalEuint64 encAmount, bytes calldata proof,
        uint256 minAmountOut,
        uint256 deadline
    ) external nonReentrant returns (uint256) {
        require(vaultIn != address(0) && vaultOut != address(0), "PrivacyRouter: zero vault");
        require(vaultIn != vaultOut, "PrivacyRouter: same vault");
        require(minAmountOut > 0, "PrivacyRouter: zero minAmountOut");
        require(deadline > block.timestamp, "PrivacyRouter: deadline passed");
        _requireVault(vaultIn);
        _requireVault(vaultOut);

        // Tokens come from the registry so a vault cannot name its own payout token.
        address tokenIn = tokenRegistry.underlyingOf(vaultIn);
        address tokenOut = tokenRegistry.underlyingOf(vaultOut);
        require(tokenIn != address(0) && tokenOut != address(0), "PrivacyRouter: no underlying");
        require(tokenIn != tokenOut, "PrivacyRouter: same underlying");

        euint64 verifiedAmount = FHE.asEuint64(encAmount, proof);

        // Account with the amount actually moved (0 on short balance).
        euint64 transferred = FHE.receiveEuint64FromCall(
            IFHERC20Vault(vaultIn).transferFromVerified(msg.sender, address(this), FHE.shareEuint64(verifiedAmount, vaultIn)),
            vaultIn
        );

        FHE.allowThis(transferred);
        FHE.allowSender(transferred);
        // Public so any keeper can decrypt and publish. This makes the amount public.
        FHE.allowPublic(transferred);

        uint256 swapId = nextSwapId++;
        swapDeadline[swapId] = deadline;
        _liabilityState[swapId] = LIABILITY_UNRESOLVED;
        unresolvedSwapCount[tokenIn] += 1;
        _swaps[swapId] = PendingSwap({
            swapId: swapId,
            user: msg.sender,
            vaultIn: vaultIn,
            vaultOut: vaultOut,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            encryptedAmountIn: transferred,
            plaintextAmountIn: 0,
            minAmountOut: minAmountOut,
            timestamp: block.timestamp,
            status: SwapStatus.Decrypting
        });

        _userSwaps[msg.sender].push(swapId);

        emit SwapInitiated(swapId, msg.sender, vaultIn, vaultOut, minAmountOut, block.timestamp);
        try eventHub.emitActivity(
            msg.sender, address(0), "swap_initiated", "", swapId
        ) {} catch {}

        return swapId;
    }

    /// @notice Step 2: Execute a pending swap after decryption completes.
    ///         Permissionless: the parameters were locked at initiation.
    ///         Spends the router's tokenIn reserves on the DEX and pays the
    ///         tokenOut output to the user in plaintext.
    ///
    /// @param swapId    The swap to execute
    /// @param plaintext The off-chain decrypted amount in (from decryptForTx).
    ///                  Ignored if the result is already published.
    /// @param signature Threshold Network signature over the plaintext.
    ///                  Pass empty bytes if already published.
    function executeSwap(
        uint256 swapId,
        uint64 plaintext,
        bytes calldata signature
    ) external nonReentrant {
        PendingSwap storage swap = _swaps[swapId];
        require(swap.status == SwapStatus.Decrypting, "PrivacyRouter: not decrypting");
        require(block.timestamp <= swap.timestamp + SWAP_EXPIRY, "PrivacyRouter: expired, use claimExpiredSwap");
        uint256 deadline = swapDeadline[swapId];
        // 0 only for swaps created before the deadline parameter existed.
        require(deadline == 0 || block.timestamp <= deadline, "PrivacyRouter: deadline passed");

        _publishIfNeeded(swap.encryptedAmountIn, plaintext, signature);

        (uint64 plainAmount, bool ready) = FHE.getDecryptResultSafe(swap.encryptedAmountIn);
        require(ready, "PrivacyRouter: decryption not ready");
        require(plainAmount > 0, "PrivacyRouter: zero amount (insufficient balance at initiation)");

        uint256 routerBalance = IERC20(swap.tokenIn).balanceOf(address(this));
        require(routerBalance >= plainAmount, "PrivacyRouter: insufficient reserves");

        swap.plaintextAmountIn = plainAmount;
        swap.status = SwapStatus.Executed;
        _closeLiability(swapId, swap.tokenIn, plainAmount);

        IERC20(swap.tokenIn).forceApprove(address(dexRouter), plainAmount);

        uint256 amountOut = dexRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: swap.tokenIn,
                tokenOut: swap.tokenOut,
                fee: DEFAULT_FEE,
                recipient: address(this),
                deadline: deadline == 0 ? block.timestamp : deadline,
                amountIn: plainAmount,
                amountOutMinimum: swap.minAmountOut,
                sqrtPriceLimitX96: 0
            })
        );
        // Do not trust the DEX to enforce the floor.
        require(amountOut >= swap.minAmountOut, "PrivacyRouter: slippage");

        IERC20(swap.tokenIn).forceApprove(address(dexRouter), 0);

        IERC20(swap.tokenOut).safeTransfer(swap.user, amountOut);

        emit SwapExecuted(swapId, swap.user, amountOut, block.timestamp);
        try eventHub.emitActivity(
            swap.user, address(0), "swap_executed", "", swapId
        ) {} catch {}
    }

    /// @notice Cancel a pending swap before execution. Two-phase refund:
    ///         1. If decryption IS ready and router has reserves: immediate refund.
    ///         2. If decryption is NOT ready: status set to Cancelled, user can call
    ///            claimCancelledSwap() later once decryption completes.
    ///
    ///         Only the original user can cancel. This prevents tokens from being stuck
    ///         forever when decryption hasn't resolved at cancellation time.
    ///
    /// @param swapId The swap to cancel
    function cancelSwap(uint256 swapId) external nonReentrant {
        PendingSwap storage swap = _swaps[swapId];
        require(msg.sender == swap.user, "PrivacyRouter: not the user");
        require(
            swap.status == SwapStatus.Decrypting || swap.status == SwapStatus.Ready,
            "PrivacyRouter: cannot cancel"
        );

        (uint64 plainAmount, bool ready) = FHE.getDecryptResultSafe(swap.encryptedAmountIn);
        if (ready && _tryRefund(swapId, swap, plainAmount)) {
            emit SwapCancelled(swapId, swap.user, block.timestamp);
            try eventHub.emitActivity(
                swap.user, address(0), "swap_cancelled_refunded", "", swapId
            ) {} catch {}
            return;
        }

        // Not published yet or reserves short: finish with claimCancelledSwap.
        swap.status = SwapStatus.Cancelled;

        emit SwapCancelled(swapId, swap.user, block.timestamp);
        emit SwapCancelledPendingRefund(swapId, swap.user, block.timestamp);
        try eventHub.emitActivity(
            swap.user, address(0), "swap_cancelled_pending", "", swapId
        ) {} catch {}
    }

    /// @notice Self-service recovery for cancelled swaps where decryption wasn't ready
    ///         at cancellation time. The user calls this after decryption completes to
    ///         reclaim their tokens from the router's plaintext reserves.
    ///
    ///         This prevents the scenario where tokens are permanently stuck because
    ///         decryption hadn't resolved when the user cancelled.
    ///
    /// @param swapId    The cancelled swap to claim refund for
    /// @param plaintext The off-chain decrypted amount (pass 0 if already published)
    /// @param signature Threshold Network signature (pass empty bytes if already published)
    function claimCancelledSwap(
        uint256 swapId,
        uint64 plaintext,
        bytes calldata signature
    ) external nonReentrant {
        PendingSwap storage swap = _swaps[swapId];
        require(swap.status == SwapStatus.Cancelled, "PrivacyRouter: not cancelled");
        require(swap.user == msg.sender, "PrivacyRouter: not your swap");
        require(swap.plaintextAmountIn == 0, "PrivacyRouter: already refunded");

        _publishIfNeeded(swap.encryptedAmountIn, plaintext, signature);

        (uint64 plainAmount, bool ready) = FHE.getDecryptResultSafe(swap.encryptedAmountIn);
        require(ready, "PrivacyRouter: decryption not ready yet");
        require(_tryRefund(swapId, swap, plainAmount), "PrivacyRouter: insufficient reserves, contact owner");

        try eventHub.emitActivity(
            msg.sender, address(0), "swap_refund_claimed", "", swapId
        ) {} catch {}
    }

    /// @notice Refund an expired swap. Anyone can call on the user's behalf.
    ///         Callable again while the swap is Expired and unpaid, so a call
    ///         without a decrypt result or during a reserve shortfall never
    ///         strands the user.
    ///
    /// @param swapId    The expired swap to claim
    /// @param plaintext The off-chain decrypted amount (ignored if already published)
    /// @param signature Threshold Network signature (empty to skip publish)
    function claimExpiredSwap(
        uint256 swapId,
        uint64 plaintext,
        bytes calldata signature
    ) external nonReentrant {
        PendingSwap storage swap = _swaps[swapId];
        bool open = swap.status == SwapStatus.Decrypting || swap.status == SwapStatus.Ready;
        bool unpaidExpired = swap.status == SwapStatus.Expired && swap.plaintextAmountIn == 0;
        require(open || unpaidExpired, "PrivacyRouter: not claimable");
        require(
            block.timestamp > swap.timestamp + SWAP_EXPIRY,
            "PrivacyRouter: not expired yet"
        );

        if (open) {
            swap.status = SwapStatus.Expired;
            emit SwapExpired(swapId, swap.user, block.timestamp);
            try eventHub.emitActivity(
                swap.user, address(0), "swap_expired", "", swapId
            ) {} catch {}
        }

        _publishIfNeeded(swap.encryptedAmountIn, plaintext, signature);

        (uint64 plainAmount, bool ready) = FHE.getDecryptResultSafe(swap.encryptedAmountIn);
        if (ready) {
            _tryRefund(swapId, swap, plainAmount);
        }
    }

    /// @notice Publish a swap's decrypted amount and record it as a known
    ///         liability. Permissionless. Clears the unresolved count that
    ///         blocks withdrawReserves.
    function resolveSwapAmount(uint256 swapId, uint64 plaintext, bytes calldata signature) external nonReentrant {
        PendingSwap storage swap = _swaps[swapId];
        require(_liabilityState[swapId] == LIABILITY_UNRESOLVED, "PrivacyRouter: not unresolved");
        _publishIfNeeded(swap.encryptedAmountIn, plaintext, signature);
        (uint64 plainAmount, bool ready) = FHE.getDecryptResultSafe(swap.encryptedAmountIn);
        require(ready, "PrivacyRouter: decryption not ready");
        _resolveLiability(swapId, swap.tokenIn, plainAmount);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  VIEW FUNCTIONS
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Get full swap details by ID
    function getSwap(uint256 swapId) external view returns (
        address user,
        address vaultIn,
        address vaultOut,
        address tokenIn,
        address tokenOut,
        uint256 plaintextAmountIn,
        uint256 minAmountOut,
        uint256 timestamp,
        SwapStatus status
    ) {
        PendingSwap storage s = _swaps[swapId];
        return (
            s.user, s.vaultIn, s.vaultOut, s.tokenIn, s.tokenOut,
            s.plaintextAmountIn, s.minAmountOut, s.timestamp, s.status
        );
    }

    /// @notice Get all swap IDs for a user
    function getUserSwaps(address user) external view returns (uint256[] memory) {
        return _userSwaps[user];
    }

    /// @notice Expose the encrypted amount-in handle so keepers (and the user)
    ///         can decrypt it off-chain via the Threshold Network and pass
    ///         (plaintext, signature) to executeSwap/cancelSwap/claim*Swap.
    /// @dev Without this getter there is no way to retrieve the ctHash from
    ///      events or other view functions, which would leave the entire
    ///      async-decrypt path inaccessible to keepers.
    function getEncryptedAmountIn(uint256 swapId) external view returns (euint64) {
        return _swaps[swapId].encryptedAmountIn;
    }

    /// @notice Check if a swap's decryption is ready
    function isDecryptionReady(uint256 swapId) external view returns (bool) {
        PendingSwap storage s = _swaps[swapId];
        if (s.status != SwapStatus.Decrypting) return false;
        (, bool ready) = FHE.getDecryptResultSafe(s.encryptedAmountIn);
        return ready;
    }

    /// @notice Check if a swap has expired
    function isExpired(uint256 swapId) external view returns (bool) {
        PendingSwap storage s = _swaps[swapId];
        return block.timestamp > s.timestamp + SWAP_EXPIRY;
    }

    /// @notice Get router's plaintext reserves for a specific token
    function reserves(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @notice Get active (non-terminal) swaps for a user with pagination
    function getActiveSwaps(address user, uint256 offset, uint256 limit)
        external view returns (PendingSwap[] memory)
    {
        uint256[] storage ids = _userSwaps[user];
        uint256 count = 0;

        // Count active swaps
        for (uint256 i = offset; i < ids.length && count < limit; i++) {
            SwapStatus s = _swaps[ids[i]].status;
            if (s == SwapStatus.Decrypting || s == SwapStatus.Ready) {
                count++;
            }
        }

        PendingSwap[] memory result = new PendingSwap[](count);
        uint256 j = 0;
        for (uint256 i = offset; i < ids.length && j < count; i++) {
            SwapStatus s = _swaps[ids[i]].status;
            if (s == SwapStatus.Decrypting || s == SwapStatus.Ready) {
                result[j++] = _swaps[ids[i]];
            }
        }
        return result;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  ADMIN
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Fund the router with plaintext ERC20 reserves.
    ///         The router needs plaintext tokens to execute DEX swaps.
    ///         Anyone can fund (useful for liquidity providers or the owner).
    /// @param token ERC20 token to deposit
    /// @param amount Amount to deposit
    function fundReserves(address token, uint256 amount) external {
        require(amount > 0, "PrivacyRouter: zero amount");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit RouterFunded(token, amount, msg.sender);
    }

    /// @notice Withdraw plaintext ERC20 reserves (owner only). Cannot dip
    ///         below the published liabilities of open swaps, and is blocked
    ///         for a token while any open swap on it has an unpublished amount
    ///         (publish it with resolveSwapAmount first).
    /// @param token Token to withdraw
    /// @param amount Amount to withdraw
    /// @param to Recipient address
    function withdrawReserves(address token, uint256 amount, address to) external onlyOwner {
        require(to != address(0), "PrivacyRouter: zero address");
        require(unresolvedSwapCount[token] == 0, "PrivacyRouter: unresolved swaps");
        _requireFree(token, amount);
        IERC20(token).safeTransfer(to, amount);
        emit ReservesWithdrawn(token, amount, to);
    }

    /// @notice Owner-triggered refund for a Cancelled or unpaid Expired swap,
    ///         at the published amount, from reserves.
    /// @param swapId The swap to refund
    function manualRefund(uint256 swapId) external onlyOwner nonReentrant {
        PendingSwap storage swap = _swaps[swapId];
        require(
            swap.status == SwapStatus.Cancelled || swap.status == SwapStatus.Expired,
            "PrivacyRouter: not refundable"
        );
        require(swap.plaintextAmountIn == 0, "PrivacyRouter: already refunded");

        (uint64 plainAmount, bool ready) = FHE.getDecryptResultSafe(swap.encryptedAmountIn);
        require(ready, "PrivacyRouter: decryption not ready");
        require(_tryRefund(swapId, swap, plainAmount), "PrivacyRouter: insufficient reserves");
    }

    /// @notice One-shot owner refund for a Cancelled or unpaid Expired swap
    ///         whose amount cannot be published. Pays the swap's tokenIn only.
    ///         If the amount is published it must match exactly. Cannot spend
    ///         reserves owed to other swaps.
    /// @param swapId The swap to refund
    /// @param token Must equal the swap's tokenIn
    /// @param amount Amount to refund
    function emergencyRefund(uint256 swapId, address token, uint256 amount) external onlyOwner nonReentrant {
        PendingSwap storage swap = _swaps[swapId];
        require(
            swap.status == SwapStatus.Cancelled || swap.status == SwapStatus.Expired,
            "PrivacyRouter: not refundable"
        );
        require(swap.plaintextAmountIn == 0, "PrivacyRouter: already refunded");
        require(token == swap.tokenIn, "PrivacyRouter: wrong token");
        require(amount > 0, "PrivacyRouter: zero amount");

        (uint64 plainAmount, bool ready) = FHE.getDecryptResultSafe(swap.encryptedAmountIn);
        require(!ready || amount == plainAmount, "PrivacyRouter: amount mismatch");

        swap.status = SwapStatus.Refunded;
        swap.plaintextAmountIn = amount;
        _closeLiability(swapId, token, plainAmount);
        _requireFree(token, amount);

        IERC20(token).safeTransfer(swap.user, amount);
        emit SwapRefunded(swapId, swap.user, amount);
    }

    /// @notice Start turning the router's encrypted balance in `vault` back
    ///         into plaintext reserves. `encAmount` must be encrypted with
    ///         this router as the account (cofhe sdk setAccount(router)) and
    ///         the vault as the consuming contract.
    function requestReserveUnshield(address vault, externalEuint64 encAmount, bytes calldata proof)
        external onlyOwner nonReentrant returns (euint64)
    {
        _requireVault(vault);
        euint64 pending = IFHERC20Vault(vault).requestUnshield(encAmount, proof);
        emit ReserveUnshieldRequested(vault);
        return pending;
    }

    /// @notice Finish a reserve unshield. The underlying lands in this
    ///         router's reserves.
    function claimReserveUnshield(address vault, uint64 plaintext, bytes calldata signature)
        external onlyOwner nonReentrant
    {
        _requireVault(vault);
        IERC20 token = IERC20(tokenRegistry.underlyingOf(vault));
        uint256 before = token.balanceOf(address(this));
        IFHERC20Vault(vault).claimUnshield(plaintext, signature);
        emit ReserveUnshieldClaimed(vault, token.balanceOf(address(this)) - before);
    }

    /// @notice Set the vault allowlist. Swaps cannot be initiated until set.
    function setTokenRegistry(address r) external onlyOwner {
        require(r.code.length > 0, "PrivacyRouter: bad registry");
        tokenRegistry = ITokenRegistry(r);
        emit TokenRegistrySet(r);
    }

    /// @notice Update the DEX router address
    /// @param _dexRouter New DEX router address
    function setDexRouter(address _dexRouter) external onlyOwner {
        require(_dexRouter != address(0), "PrivacyRouter: zero address");
        address old = address(dexRouter);
        dexRouter = ISwapRouter(_dexRouter);
        emit DexRouterUpdated(old, _dexRouter);
    }

    /// @notice Update the EventHub address
    /// @param _eventHub New EventHub address
    function setEventHub(address _eventHub) external onlyOwner {
        eventHub = IEventHub(_eventHub);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  INTERNALS
    // ═══════════════════════════════════════════════════════════════════

    uint8 private constant LIABILITY_UNRESOLVED = 1;
    uint8 private constant LIABILITY_RESOLVED = 2;
    uint8 private constant LIABILITY_CLOSED = 3;

    function _requireVault(address vault) internal view {
        require(address(tokenRegistry) != address(0) && tokenRegistry.isActiveVault(vault), "PrivacyRouter: vault not allowed");
    }

    function _requireFree(address token, uint256 amount) internal view {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance >= amount && balance - amount >= outstandingLiability[token], "PrivacyRouter: reserves owed to swaps");
    }

    /// @dev Publishing an already published handle is skipped, so a late
    ///      caller with a stale signature cannot make the call revert.
    function _publishIfNeeded(euint64 handle, uint64 plaintext, bytes calldata signature) internal {
        if (signature.length == 0) return;
        (, bool ready) = FHE.getDecryptResultSafe(handle);
        if (!ready) FHE.publishDecryptResult(handle, plaintext, signature);
    }

    /// @dev Pays the published amount back in tokenIn and marks the swap
    ///      Refunded. A zero amount (short balance at initiation) closes the
    ///      swap with no transfer. Returns false, recording the amount as a
    ///      liability, when reserves cannot cover it.
    function _tryRefund(uint256 swapId, PendingSwap storage swap, uint64 plainAmount) internal returns (bool) {
        if (plainAmount > 0 && IERC20(swap.tokenIn).balanceOf(address(this)) < plainAmount) {
            _resolveLiability(swapId, swap.tokenIn, plainAmount);
            return false;
        }
        swap.status = SwapStatus.Refunded;
        swap.plaintextAmountIn = plainAmount;
        _closeLiability(swapId, swap.tokenIn, plainAmount);
        if (plainAmount > 0) {
            IERC20(swap.tokenIn).safeTransfer(swap.user, plainAmount);
        }
        emit SwapRefunded(swapId, swap.user, plainAmount);
        return true;
    }

    function _resolveLiability(uint256 swapId, address tokenIn, uint256 amount) internal {
        if (_liabilityState[swapId] != LIABILITY_UNRESOLVED) return;
        _liabilityState[swapId] = LIABILITY_RESOLVED;
        unresolvedSwapCount[tokenIn] -= 1;
        outstandingLiability[tokenIn] += amount;
        emit SwapAmountResolved(swapId, tokenIn, amount);
    }

    /// @dev `amount` must be the published amount whenever the swap is
    ///      resolved. Swaps from before liability tracking (state 0) are skipped.
    function _closeLiability(uint256 swapId, address tokenIn, uint256 amount) internal {
        uint8 st = _liabilityState[swapId];
        if (st == LIABILITY_UNRESOLVED) {
            unresolvedSwapCount[tokenIn] -= 1;
        } else if (st == LIABILITY_RESOLVED) {
            outstandingLiability[tokenIn] -= amount;
        } else {
            return;
        }
        _liabilityState[swapId] = LIABILITY_CLOSED;
    }

    // ─── Appended storage (UUPS append-only) ────────────────────────────

    ITokenRegistry public tokenRegistry;
    /// @dev tokenIn => sum of published amounts owed to open swaps.
    mapping(address => uint256) public outstandingLiability;
    /// @dev tokenIn => open swaps whose amount is not yet published.
    mapping(address => uint256) public unresolvedSwapCount;
    /// @dev swapId => 0 untracked (pre-upgrade), 1 unresolved, 2 resolved, 3 closed.
    mapping(uint256 => uint8) private _liabilityState;
    /// @dev swapId => user deadline for executeSwap (0 for pre-upgrade swaps).
    mapping(uint256 => uint256) public swapDeadline;

    /// @dev Reserved storage. Decrement when appending state.
    uint256[45] private __gap;

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
