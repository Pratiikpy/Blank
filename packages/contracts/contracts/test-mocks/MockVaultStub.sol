// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only: a vault-shaped contract that only reports its underlying.
contract MockVaultStub {
    address public underlyingToken;

    constructor(address _underlying) {
        underlyingToken = _underlying;
    }
}

/// @dev Test-only: ERC20 with configurable decimals.
contract MockERC20Decimals is ERC20 {
    uint8 private immutable _dec;

    constructor(uint8 dec) ERC20("Mock", "MCK") {
        _dec = dec;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
