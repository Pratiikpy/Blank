// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {FHE, euint64, InEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IFHERC20Vault_Test {
    function transferFromVerified(address from, address to, euint64 amount) external returns (euint64);
    function transferVerified(address to, euint64 amount) external returns (euint64);
}

/// @notice Minimal mock for exercising vault.transferVerified — holds an
///         encrypted balance via transferFromVerified, then releases it
///         via transferVerified. Mirrors the pattern BusinessHub will use
///         once the escrow flow lands.
contract TestHolder {
    IFHERC20Vault_Test public immutable vault;
    euint64 private _held;

    constructor(address vault_) {
        vault = IFHERC20Vault_Test(vault_);
    }

    /// @dev Pull `encAmount` from `from` (caller must approve this contract
    ///      on the vault first), store the verified handle in this contract.
    function pull(address from, InEuint64 calldata encAmount) external {
        euint64 amount = FHE.asEuint64(encAmount);
        FHE.allowTransient(amount, address(vault));
        _held = vault.transferFromVerified(from, address(this), amount);
        FHE.allowThis(_held);
    }

    /// @dev Forward the held balance via the new transferVerified path.
    function forward(address to) external returns (euint64) {
        FHE.allowTransient(_held, address(vault));
        return vault.transferVerified(to, _held);
    }
}
