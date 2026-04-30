// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Test-only mock of Uniswap v3 SwapRouter02 for Phase 5.6 unit
///         tests. NOT for production deployment — the real SwapRouter02
///         lives at known addresses per chain (lib/uniswap.ts).
///
/// Behaviour: `exactOutputSingle` pulls a configurable fraction of the
/// caller's `amountInMaximum`, transfers `amountOut` of `tokenOut` from
/// this contract to `recipient`, and returns the consumed amount so the
/// caller can refund the unused balance. The `consumedFractionBps` knob
/// (default 9500 = 95%) lets tests exercise the refund path.
contract MockSwapRouter02 {
    using SafeERC20 for IERC20;

    /// @dev Basis points of `amountInMaximum` consumed (10000 = 100% = no refund).
    uint256 public consumedFractionBps = 9500; // 95% by default

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function setConsumedFractionBps(uint256 bps) external {
        require(bps <= 10000, "MockSwapRouter02: bps too high");
        consumedFractionBps = bps;
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        returns (uint256 amountIn)
    {
        amountIn = (params.amountInMaximum * consumedFractionBps) / 10000;
        require(amountIn <= params.amountInMaximum, "MockSwapRouter02: math");

        // Pull the consumed amount from caller (caller must have approved us).
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Send tokenOut to recipient. This contract must hold enough for tests.
        IERC20(params.tokenOut).safeTransfer(params.recipient, params.amountOut);
    }
}
