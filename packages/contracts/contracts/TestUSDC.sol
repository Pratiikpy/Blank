// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSDC — Mintable test stablecoin for Blank
/// @notice Anyone can mint. Testnet only. 6 decimals like real USDC.
contract TestUSDC is ERC20 {
    uint8 private constant _DECIMALS = 6;

    constructor() ERC20("Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return _DECIMALS;
    }

    /// @notice Mint test tokens to any address. No access control — testnet only.
    /// @param to Recipient address
    /// @param amount Amount in smallest unit (6 decimals: 1 USDC = 1_000_000)
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Convenience: mint 10,000 USDC to the caller
    function faucet() external {
        _mint(msg.sender, 10_000 * 10 ** _DECIMALS);
    }
}
