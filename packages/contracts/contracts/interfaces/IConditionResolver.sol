// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title IConditionResolver
/// @notice Reineira's open settlement standard for escrow release rules.
///         An escrow registers a condition at creation and asks the resolver
///         whether it may release on each attempt. Adopting this interface
///         keeps Blank's conditional escrow compatible with the Reineira
///         settlement ecosystem (https://reineira.xyz).
/// @dev    Vendored verbatim from references/reineira-code so a resolver
///         written for one speaks for both. Do not change the signatures.
interface IConditionResolver {
    /// @notice Check if the release condition for an escrow is met.
    /// @dev Called on every release attempt. MUST be a view function.
    /// @param escrowId The sequential escrow identifier.
    /// @return True if the escrow should release funds.
    function isConditionMet(uint256 escrowId) external view returns (bool);

    /// @notice Initialize condition configuration for a new escrow.
    /// @dev Called atomically during the escrow's create flow.
    /// @param escrowId The sequential escrow identifier.
    /// @param data ABI-encoded configuration specific to this resolver.
    function onConditionSet(uint256 escrowId, bytes calldata data) external;
}
