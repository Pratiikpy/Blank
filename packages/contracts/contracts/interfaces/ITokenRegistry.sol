// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @notice Vault allowlist. A vault address supplied by a caller is untrusted
///         until isActiveVault returns true for it.
interface ITokenRegistry {
    function isActiveVault(address vault) external view returns (bool);
    function underlyingOf(address vault) external view returns (address);
}
