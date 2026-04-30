// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.25;

/// @title Mock1271 — minimal ERC-1271 contract for testing.
/// @notice Returns a configurable bytes4 from `isValidSignature`. Used by
///         ERC6538Registry tests to exercise the ERC-1271 fallback path
///         that real passkey-AAs (BlankAccount) will hit in production.
contract Mock1271 {
    bytes4 public returnValue;

    function setReturnValue(bytes4 v) external {
        returnValue = v;
    }

    function isValidSignature(bytes32 /*hash*/, bytes memory /*signature*/)
        external
        view
        returns (bytes4 magicValue)
    {
        return returnValue;
    }
}
