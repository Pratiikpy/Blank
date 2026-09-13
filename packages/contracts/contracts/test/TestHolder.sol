// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {FHE, euint64, externalEuint64, sharedEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IFHERC20Vault_Test {
    function transferFromVerified(address from, address to, sharedEuint64 shared)
        external
        returns (sharedEuint64);
    function transferVerified(address to, sharedEuint64 shared) external returns (sharedEuint64);
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
    function pull(address from, externalEuint64 encAmount, bytes calldata proof) external {
        euint64 amount = FHE.asEuint64(encAmount, proof);
        _held = FHE.receiveEuint64FromCall(
            vault.transferFromVerified(from, address(this), FHE.shareEuint64(amount, address(vault))),
            address(vault)
        );
        FHE.allowThis(_held);
    }

    /// @dev Forward the held balance via the new transferVerified path.
    function forward(address to) external returns (euint64) {
        euint64 sent = FHE.receiveEuint64FromCall(
            vault.transferVerified(to, FHE.shareEuint64(_held, address(vault))),
            address(vault)
        );
        FHE.allowThis(sent);
        return sent;
    }
}
