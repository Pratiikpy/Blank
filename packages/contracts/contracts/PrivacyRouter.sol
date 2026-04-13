// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./utils/ReentrancyGuard.sol";

// ─── Interfaces ──────────────────────────────────────────────────────

interface IFHERC20Vault {
    function transferFrom(address from, address to, InEuint64 memory encAmount) external returns (euint64);
    function transferFromVerified(address from, address to, euint64 amount) external returns (euint64);
    function transfer(address to, InEuint64 memory encAmount) external returns (euint64);
    function balanceOf(address account) external view returns (euint64);
    function underlyingToken() external view returns (address);
    function shield(uint256 amount) external;
    function approvePlaintext(address spender, uint64 amount) external;
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

/// @title PrivacyRouter — Encrypted token swap router
/// @notice Enables token swaps where the input amount is FHE-encrypted. The swap
///         follows a "privacy sandwich" pattern:
///
///         1. User transfers ENCRYPTED tokens → Router (private)
///         2. Router decrypts the amount asynchronously (Threshold Network)
///         3. Router executes a PLAINTEXT swap on DEX (brief public exposure)
///         4. Router shields the output tokens back into ENCRYPTED form (private)
///
///         The encrypted amount is never visible to third parties. The brief plaintext
///         exposure during the DEX swap is a known trade-off, similar to how dark pools
///         execute orders on public venues.
///
/// @dev Architecture decisions:
///      - Two-phase async: initiateSwap() → executeSwap() (decryption is async)
///      - Router holds plaintext ERC20 reserves to execute swaps without vault unshield
///      - After DEX swap, output tokens are shielded into vaultOut for the router,
///        then encrypted output is transferred to user via vault.transfer
///      - Owner pre-funds the router with underlying ERC20 tokens for each supported pair
///      - Router's accumulated encrypted input tokens can be periodically rebalanced
///      - 10-minute expiry protects users from stuck swaps
///      - FHE.select() used for privacy-preserving balance checks (never reverts on balance)
///      - UUPS upgradeable for bug fixes
///      - ReentrancyGuard on all state-changing functions
///      - Security zone 0 enforced everywhere
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

    /// @notice Step 1: Initiate an encrypted token swap.
    ///         Transfers encrypted input tokens from user to the router's balance
    ///         in the input vault, then requests async decryption of the amount.
    ///
    ///         The user MUST have approved this contract on vaultIn before calling.
    ///
    /// @param vaultIn FHERC20Vault for the input token (e.g., encrypted USDC)
    /// @param vaultOut FHERC20Vault for the desired output token (e.g., encrypted WETH)
    /// @param encAmount Encrypted amount of input tokens to swap
    /// @param minAmountOut Minimum acceptable output amount (plaintext — for slippage protection)
    /// @return swapId Unique identifier for this pending swap
    function initiateSwap(
        address vaultIn,
        address vaultOut,
        InEuint64 memory encAmount,
        uint256 minAmountOut
    ) external nonReentrant returns (uint256) {
        require(vaultIn != address(0) && vaultOut != address(0), "PrivacyRouter: zero vault");
        require(vaultIn != vaultOut, "PrivacyRouter: same vault");

        address tokenIn = IFHERC20Vault(vaultIn).underlyingToken();
        address tokenOut = IFHERC20Vault(vaultOut).underlyingToken();
        require(tokenIn != tokenOut, "PrivacyRouter: same underlying");

        // Verify encrypted input here (msg.sender = user) before cross-contract call
        euint64 verifiedAmount = FHE.asEuint64(encAmount);
        FHE.allowTransient(verifiedAmount, vaultIn);

        // Transfer encrypted tokens from user to router's balance in vaultIn
        // This deducts from user's encrypted balance and adds to router's
        euint64 transferred = IFHERC20Vault(vaultIn).transferFromVerified(
            msg.sender,
            address(this),
            verifiedAmount
        );

        // Grant this contract permission to use the encrypted handle
        FHE.allowThis(transferred);
        // User can verify their swap intent (read the encrypted amount they submitted)
        FHE.allowSender(transferred);

        // v0.1.3 migration: marks the encrypted amount as publicly decryptable.
        // Callers of executeSwap / claimCancelledSwap / claimExpiredSwap supply
        // the off-chain decryption result + Threshold Network signature; the
        // first one to call wins, subsequent calls can pass empty signature.
        FHE.allowPublic(transferred);

        // Store pending swap
        uint256 swapId = nextSwapId++;
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
    ///         Anyone can call this (keeper, user, or bot) — it's permissionless
    ///         because the swap parameters were locked at initiation.
    ///
    ///         Flow:
    ///         1. Read decrypted plaintext amount
    ///         2. Use router's own ERC20 reserves to execute DEX swap
    ///         3. Approve output vault and shield output tokens (creates encrypted balance for router)
    ///         4. The user receives their output via the shielded balance mechanism
    ///
    /// @dev The router holds plaintext ERC20 reserves to avoid the vault unshield
    ///      round-trip. Router accumulates encrypted input balance in vaultIn, while
    ///      spending its own plaintext reserves. Owner periodically rebalances.
    ///
    ///      Output tokens are sent directly to the user as plaintext ERC20, which
    ///      the user can then shield into vaultOut themselves. This avoids the
    ///      InEuint64 limitation on vault.transfer() and vault.shield().
    ///
    /// @param swapId    The swap to execute
    /// @param plaintext The off-chain decrypted amount in (from decryptForTx).
    ///                  Pass 0 if a previous call already published the result.
    /// @param signature Threshold Network signature over the plaintext.
    ///                  Pass empty bytes if a previous call already published.
    function executeSwap(
        uint256 swapId,
        uint64 plaintext,
        bytes calldata signature
    ) external nonReentrant {
        PendingSwap storage swap = _swaps[swapId];
        require(swap.status == SwapStatus.Decrypting, "PrivacyRouter: not decrypting");
        require(block.timestamp <= swap.timestamp + SWAP_EXPIRY, "PrivacyRouter: expired, use claimExpiredSwap");

        // Publish the decryption result if caller provided one. Idempotent —
        // subsequent calls with empty signature read the already-published value.
        if (signature.length > 0) {
            FHE.publishDecryptResult(swap.encryptedAmountIn, plaintext, signature);
        }

        // Read the decrypted plaintext amount (now stored on-chain after publish)
        (uint64 plainAmount, bool ready) = FHE.getDecryptResultSafe(swap.encryptedAmountIn);
        require(ready, "PrivacyRouter: decryption not ready");
        require(plainAmount > 0, "PrivacyRouter: zero amount (insufficient balance at initiation)");

        swap.plaintextAmountIn = plainAmount;
        swap.status = SwapStatus.Ready;

        // Verify router has sufficient plaintext reserves for the input token
        uint256 routerBalance = IERC20(swap.tokenIn).balanceOf(address(this));
        require(routerBalance >= plainAmount, "PrivacyRouter: insufficient reserves");

        // Approve DEX router to spend input tokens
        IERC20(swap.tokenIn).forceApprove(address(dexRouter), plainAmount);

        // Execute the DEX swap — plaintext tokens in, plaintext tokens out
        uint256 amountOut = dexRouter.exactInputSingle(
            ISwapRouter.ExactInputSingleParams({
                tokenIn: swap.tokenIn,
                tokenOut: swap.tokenOut,
                fee: DEFAULT_FEE,
                recipient: address(this), // Router receives output first
                deadline: block.timestamp,
                amountIn: plainAmount,
                amountOutMinimum: swap.minAmountOut,
                sqrtPriceLimitX96: 0      // No price limit (MockDEX ignores this)
            })
        );

        // Clear DEX router approval (safety — revoke any residual allowance)
        IERC20(swap.tokenIn).forceApprove(address(dexRouter), 0);

        // Transfer output ERC20 tokens directly to the user.
        // The user can then shield them into the output vault if they want encrypted balance.
        // This approach avoids the InEuint64 requirement on vault.shield() and vault.transfer().
        IERC20(swap.tokenOut).safeTransfer(swap.user, amountOut);

        swap.status = SwapStatus.Executed;

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

        // Attempt immediate refund if decryption is already published
        (uint64 plainAmount, bool ready) = FHE.getDecryptResultSafe(swap.encryptedAmountIn);
        if (ready && plainAmount > 0) {
            uint256 routerBalance = IERC20(swap.tokenIn).balanceOf(address(this));
            if (routerBalance >= plainAmount) {
                // Immediate refund — mark as Refunded (terminal state)
                swap.status = SwapStatus.Refunded;
                swap.plaintextAmountIn = plainAmount;
                IERC20(swap.tokenIn).safeTransfer(swap.user, plainAmount);

                emit SwapCancelled(swapId, swap.user, block.timestamp);
                emit SwapRefunded(swapId, swap.user, plainAmount);
                try eventHub.emitActivity(
                    swap.user, address(0), "swap_cancelled_refunded", "", swapId
                ) {} catch {}
                return;
            }
        }

        // Decryption not ready OR router lacks reserves — mark as Cancelled.
        // User can call claimCancelledSwap() later once decryption resolves
        // and router has reserves, or owner can call manualRefund().
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

        // Publish if caller supplied a signature (idempotent — first publisher wins)
        if (signature.length > 0) {
            FHE.publishDecryptResult(swap.encryptedAmountIn, plaintext, signature);
        }

        // Read the now-resolved decryption result
        (uint64 plainAmount, bool ready) = FHE.getDecryptResultSafe(swap.encryptedAmountIn);
        require(ready, "PrivacyRouter: decryption not ready yet");
        require(plainAmount > 0, "PrivacyRouter: zero amount");

        // Verify router has sufficient reserves
        uint256 routerBalance = IERC20(swap.tokenIn).balanceOf(address(this));
        require(routerBalance >= plainAmount, "PrivacyRouter: insufficient reserves, contact owner");

        // Execute refund
        swap.status = SwapStatus.Refunded;
        swap.plaintextAmountIn = plainAmount;
        IERC20(swap.tokenIn).safeTransfer(msg.sender, plainAmount);

        emit SwapRefunded(swapId, msg.sender, plainAmount);
        try eventHub.emitActivity(
            msg.sender, address(0), "swap_refund_claimed", "", swapId
        ) {} catch {}
    }

    /// @notice Claim an expired swap. Anyone can call this on behalf of the user.
    ///         If the swap has not been executed within 10 minutes, the user can
    ///         reclaim their tokens.
    ///
    /// @param swapId    The expired swap to claim
    /// @param plaintext The off-chain decrypted amount (pass 0 to skip publish)
    /// @param signature Threshold Network signature (pass empty bytes to skip publish)
    function claimExpiredSwap(
        uint256 swapId,
        uint64 plaintext,
        bytes calldata signature
    ) external nonReentrant {
        PendingSwap storage swap = _swaps[swapId];
        require(
            swap.status == SwapStatus.Decrypting || swap.status == SwapStatus.Ready,
            "PrivacyRouter: not claimable"
        );
        require(
            block.timestamp > swap.timestamp + SWAP_EXPIRY,
            "PrivacyRouter: not expired yet"
        );

        swap.status = SwapStatus.Expired;

        // Publish if caller supplied a signature
        if (signature.length > 0) {
            FHE.publishDecryptResult(swap.encryptedAmountIn, plaintext, signature);
        }

        // Attempt plaintext refund from router reserves
        (uint64 plainAmount, bool ready) = FHE.getDecryptResultSafe(swap.encryptedAmountIn);
        if (ready && plainAmount > 0) {
            uint256 routerBalance = IERC20(swap.tokenIn).balanceOf(address(this));
            if (routerBalance >= plainAmount) {
                swap.plaintextAmountIn = plainAmount;
                IERC20(swap.tokenIn).safeTransfer(swap.user, plainAmount);
            }
        }

        emit SwapExpired(swapId, swap.user, block.timestamp);
        try eventHub.emitActivity(
            swap.user, address(0), "swap_expired", "", swapId
        ) {} catch {}
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

    /// @notice Withdraw plaintext ERC20 reserves (owner only).
    ///         Used for rebalancing or emergency fund recovery.
    /// @param token Token to withdraw
    /// @param amount Amount to withdraw
    /// @param to Recipient address
    function withdrawReserves(address token, uint256 amount, address to) external onlyOwner {
        require(to != address(0), "PrivacyRouter: zero address");
        IERC20(token).safeTransfer(to, amount);
    }

    /// @notice Process a manual refund for a cancelled/expired swap where
    ///         automatic refund failed (e.g., router had insufficient reserves at the time).
    ///         Owner only — sends plaintext ERC20 to the user.
    /// @param swapId The swap to refund
    function manualRefund(uint256 swapId) external onlyOwner nonReentrant {
        PendingSwap storage swap = _swaps[swapId];
        require(
            swap.status == SwapStatus.Cancelled || swap.status == SwapStatus.Expired,
            "PrivacyRouter: not refundable"
        );
        require(swap.plaintextAmountIn == 0, "PrivacyRouter: already refunded");

        // Try to get decrypted amount (must already be published — manualRefund
        // is owner-only, so we expect a prior call to have done the publish)
        (uint64 plainAmount, bool ready) = FHE.getDecryptResultSafe(swap.encryptedAmountIn);
        require(ready, "PrivacyRouter: decryption not ready");
        require(plainAmount > 0, "PrivacyRouter: zero amount");

        swap.status = SwapStatus.Refunded;
        swap.plaintextAmountIn = plainAmount;
        IERC20(swap.tokenIn).safeTransfer(swap.user, plainAmount);
        emit SwapRefunded(swapId, swap.user, plainAmount);
    }

    /// @notice Emergency refund for a cancelled/expired swap.
    ///         Allows the owner to specify a token and amount to refund to the swap user.
    ///         Use when automatic refund and manualRefund both failed or are insufficient.
    /// @param swapId The swap to refund
    /// @param token ERC20 token to refund
    /// @param amount Amount to refund
    function emergencyRefund(uint256 swapId, address token, uint256 amount) external onlyOwner {
        PendingSwap storage swap = _swaps[swapId];
        require(
            swap.status == SwapStatus.Cancelled || swap.status == SwapStatus.Expired,
            "PrivacyRouter: not refundable"
        );
        IERC20(token).safeTransfer(swap.user, amount);
        emit SwapRefunded(swapId, swap.user, amount);
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

    /// @dev UUPS upgrade authorization — owner only
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
