// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ISwapRouter — Minimal Uniswap V3 SwapRouter interface
/// @notice Only the exactInputSingle function is needed for our use case.
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

/// @title MockDEX — Fixed-rate DEX for encrypted swap testing
/// @notice Implements the Uniswap ISwapRouter interface with configurable fixed
///         exchange rates. Used by PrivacyRouter to execute the plaintext leg of
///         encrypted token swaps.
///
/// @dev Production would use a real DEX (Uniswap, Aerodrome). This mock lets us
///      test the full encrypted swap flow without external liquidity.
///      Exchange rates are scaled by 1e6 for precision.
///      Example: 1 USDC → 0.0004 WETH → rate = 400 (400 / 1e6 = 0.0004)
contract MockDEX is ISwapRouter {
    using SafeERC20 for IERC20;

    // ─── State ─────────────────────────────────────────────────────────

    /// @dev Exchange rates: tokenIn → tokenOut → rate (scaled by 1e6)
    mapping(address => mapping(address => uint256)) public exchangeRates;

    address public owner;

    // ─── Events ────────────────────────────────────────────────────────

    event RateSet(address indexed tokenIn, address indexed tokenOut, uint256 rate);
    event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address indexed recipient);
    event Funded(address indexed token, uint256 amount, address indexed funder);

    // ─── Constructor ───────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    // ─── Admin ─────────────────────────────────────────────────────────

    /// @notice Set the exchange rate for a token pair.
    ///         Rate is scaled by 1e6: amountOut = (amountIn * rate) / 1e6.
    ///         Example: rate = 400 means 1 input token → 0.0004 output tokens.
    /// @param tokenIn Input token address
    /// @param tokenOut Output token address
    /// @param rate Exchange rate scaled by 1e6
    function setRate(address tokenIn, address tokenOut, uint256 rate) external {
        require(msg.sender == owner, "MockDEX: not owner");
        require(tokenIn != address(0) && tokenOut != address(0), "MockDEX: zero address");
        require(tokenIn != tokenOut, "MockDEX: same token");
        require(rate > 0, "MockDEX: zero rate");

        exchangeRates[tokenIn][tokenOut] = rate;

        emit RateSet(tokenIn, tokenOut, rate);
    }

    /// @notice Set bidirectional exchange rates (convenience).
    ///         If 1 A = 0.5 B (forwardRate = 500000), then 1 B = 2 A (reverseRate = 2000000).
    /// @param tokenA First token
    /// @param tokenB Second token
    /// @param forwardRate A → B rate (scaled by 1e6)
    /// @param reverseRate B → A rate (scaled by 1e6)
    function setRateBidirectional(
        address tokenA,
        address tokenB,
        uint256 forwardRate,
        uint256 reverseRate
    ) external {
        require(msg.sender == owner, "MockDEX: not owner");
        require(tokenA != address(0) && tokenB != address(0), "MockDEX: zero address");
        require(tokenA != tokenB, "MockDEX: same token");
        require(forwardRate > 0 && reverseRate > 0, "MockDEX: zero rate");

        exchangeRates[tokenA][tokenB] = forwardRate;
        exchangeRates[tokenB][tokenA] = reverseRate;

        emit RateSet(tokenA, tokenB, forwardRate);
        emit RateSet(tokenB, tokenA, reverseRate);
    }

    // ─── Swap ──────────────────────────────────────────────────────────

    /// @notice Execute a fixed-rate swap. Implements ISwapRouter.exactInputSingle.
    /// @param params Standard Uniswap ExactInputSingleParams
    /// @return amountOut The amount of output tokens transferred to recipient
    function exactInputSingle(ExactInputSingleParams calldata params) external payable override returns (uint256 amountOut) {
        require(params.deadline >= block.timestamp, "MockDEX: deadline expired");

        uint256 rate = exchangeRates[params.tokenIn][params.tokenOut];
        require(rate > 0, "MockDEX: no rate set");

        // Transfer input tokens from sender to this contract
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);

        // Calculate output: amountOut = (amountIn * rate) / 1e6
        amountOut = (params.amountIn * rate) / 1e6;
        require(amountOut >= params.amountOutMinimum, "MockDEX: insufficient output amount");

        // Verify DEX has enough output tokens
        uint256 balance = IERC20(params.tokenOut).balanceOf(address(this));
        require(balance >= amountOut, "MockDEX: insufficient liquidity");

        // Transfer output tokens to recipient
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);

        emit Swapped(params.tokenIn, params.tokenOut, params.amountIn, amountOut, params.recipient);

        return amountOut;
    }

    // ─── Liquidity ─────────────────────────────────────────────────────

    /// @notice Fund the DEX with tokens so it can fulfill swaps.
    ///         Anyone can fund (useful for testing).
    /// @param token Token address to deposit
    /// @param amount Amount to deposit
    function fund(address token, uint256 amount) external {
        require(amount > 0, "MockDEX: zero amount");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(token, amount, msg.sender);
    }

    // ─── View ──────────────────────────────────────────────────────────

    /// @notice Get the DEX's balance of a specific token (available liquidity)
    /// @param token Token address to query
    /// @return Available liquidity
    function liquidity(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    /// @notice Preview swap output without executing
    /// @param tokenIn Input token
    /// @param tokenOut Output token
    /// @param amountIn Amount of input tokens
    /// @return amountOut Expected output amount (0 if no rate set)
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut) {
        uint256 rate = exchangeRates[tokenIn][tokenOut];
        if (rate == 0) return 0;
        return (amountIn * rate) / 1e6;
    }

    /// @notice Transfer ownership
    /// @param newOwner New owner address
    function transferOwnership(address newOwner) external {
        require(msg.sender == owner, "MockDEX: not owner");
        require(newOwner != address(0), "MockDEX: zero address");
        owner = newOwner;
    }

    /// @notice Withdraw tokens from the DEX (owner only, for fund recovery)
    /// @param token Token to withdraw
    /// @param amount Amount to withdraw
    /// @param to Recipient address
    function withdraw(address token, uint256 amount, address to) external {
        require(msg.sender == owner, "MockDEX: not owner");
        require(to != address(0), "MockDEX: zero address");
        IERC20(token).safeTransfer(to, amount);
    }
}
