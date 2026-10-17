// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IConditionResolver} from "./interfaces/IConditionResolver.sol";

/// @title  InvoiceApprovalResolver
/// @notice Release rule for a conditional invoice. The escrow releases to the
///         vendor when the buyer approves, or when an auto-release deadline
///         passes so the vendor is not stranded by a silent buyer.
/// @dev    Implements Reineira's IConditionResolver standard, so the same rule
///         plugs into any escrow that speaks that interface. Conditions are
///         keyed by (escrow contract, escrowId): the escrow that calls
///         onConditionSet owns that key, so nobody can pre-register a
///         condition for another escrow's upcoming sequential id.
///         Condition config and approval are public (see getCondition); this
///         contract keeps no secrets. Stateless and non-upgradeable by design.
contract InvoiceApprovalResolver is IConditionResolver, ERC165 {
    struct Condition {
        address buyer; // who may approve early release
        uint64 autoReleaseDeadline; // after this, release is allowed regardless
        bool set; // guards uninitialised reads and one-time config
    }

    /// @dev escrow contract => escrowId => stored condition config.
    mapping(address => mapping(uint256 => Condition)) private _conditions;
    /// @dev escrow contract => escrowId => whether the buyer approved early release.
    mapping(address => mapping(uint256 => bool)) public approved;

    error AlreadyConfigured(uint256 escrowId);
    error NotConfigured(uint256 escrowId);
    error InvalidBuyer();
    error InvalidDeadline();
    error NotBuyer(uint256 escrowId);

    event ConditionSet(address indexed escrow, uint256 indexed escrowId, address indexed buyer, uint64 autoReleaseDeadline);
    event Approved(address indexed escrow, uint256 indexed escrowId, address indexed buyer);

    /// @inheritdoc IConditionResolver
    /// @dev data = abi.encode(address buyer, uint64 autoReleaseDeadline).
    ///      Called once by the escrow during creation; msg.sender is the escrow.
    function onConditionSet(uint256 escrowId, bytes calldata data) external override {
        Condition storage c = _conditions[msg.sender][escrowId];
        if (c.set) revert AlreadyConfigured(escrowId);

        (address buyer, uint64 autoReleaseDeadline) = abi.decode(data, (address, uint64));
        if (buyer == address(0)) revert InvalidBuyer();
        if (autoReleaseDeadline <= block.timestamp) revert InvalidDeadline();

        _conditions[msg.sender][escrowId] =
            Condition({buyer: buyer, autoReleaseDeadline: autoReleaseDeadline, set: true});

        emit ConditionSet(msg.sender, escrowId, buyer, autoReleaseDeadline);
    }

    /// @notice Buyer approves early release of `escrowId` on `escrow`.
    /// @dev Only the buyer recorded at config time. Idempotent.
    function approve(address escrow, uint256 escrowId) external {
        Condition memory c = _conditions[escrow][escrowId];
        if (!c.set) revert NotConfigured(escrowId);
        if (msg.sender != c.buyer) revert NotBuyer(escrowId);
        approved[escrow][escrowId] = true;
        emit Approved(escrow, escrowId, msg.sender);
    }

    /// @inheritdoc IConditionResolver
    /// @dev Reads the calling escrow's own condition. Met when the buyer
    ///      approved, or the auto-release deadline passed.
    function isConditionMet(uint256 escrowId) external view override returns (bool) {
        Condition memory c = _conditions[msg.sender][escrowId];
        if (!c.set) return false;
        return approved[msg.sender][escrowId] || block.timestamp >= c.autoReleaseDeadline;
    }

    /// @notice Condition config and live status, for UIs.
    function getCondition(address escrow, uint256 escrowId)
        external
        view
        returns (address buyer, uint64 autoReleaseDeadline, bool isApproved, bool deadlinePassed, bool set)
    {
        Condition memory c = _conditions[escrow][escrowId];
        return (
            c.buyer,
            c.autoReleaseDeadline,
            approved[escrow][escrowId],
            c.set && block.timestamp >= c.autoReleaseDeadline,
            c.set
        );
    }

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165) returns (bool) {
        return interfaceId == type(IConditionResolver).interfaceId || super.supportsInterface(interfaceId);
    }
}
