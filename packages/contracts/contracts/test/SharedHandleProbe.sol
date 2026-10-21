// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {FHE, euint64, externalEuint64, sharedEuint64} from "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IFHERC20Vault_Probe {
    function transfer(address to, externalEuint64 encAmount, bytes calldata proof) external returns (sharedEuint64);
    function transferFrom(address from, address to, externalEuint64 encAmount, bytes calldata proof)
        external
        returns (sharedEuint64);
    function requestUnshield(externalEuint64 encAmount, bytes calldata proof) external returns (sharedEuint64);
}

/// @notice Test-only contract caller for the vault's encrypted-input entry
///         points. It consumes each result the way a real integrator must:
///         as a share handed over by the vault. A vault that returns a raw
///         handle makes every call here revert with NotShared.
contract SharedHandleProbe {
    euint64 private _last;

    function callTransfer(address vault, address to, externalEuint64 enc, bytes calldata proof) external {
        _last = FHE.receiveEuint64FromCall(IFHERC20Vault_Probe(vault).transfer(to, enc, proof), vault);
        FHE.allowThis(_last);
    }

    function callTransferFrom(address vault, address from, address to, externalEuint64 enc, bytes calldata proof)
        external
    {
        _last = FHE.receiveEuint64FromCall(IFHERC20Vault_Probe(vault).transferFrom(from, to, enc, proof), vault);
        FHE.allowThis(_last);
    }

    function callRequestUnshield(address vault, externalEuint64 enc, bytes calldata proof) external {
        _last = FHE.receiveEuint64FromCall(IFHERC20Vault_Probe(vault).requestUnshield(enc, proof), vault);
        FHE.allowThis(_last);
    }

    function last() external view returns (euint64) {
        return _last;
    }
}
