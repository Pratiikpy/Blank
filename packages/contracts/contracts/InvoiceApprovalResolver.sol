// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IConditionResolver} from "./interfaces/IConditionResolver.sol";

/// @title  InvoiceApprovalResolver
/// @notice Release rule for a conditional invoice. The escrow releases to the
///         vendor when the buyer approves, or when an auto-release deadline
///         passes so the vendor is not stranded by a silent buyer.
/// @dev    Implements Reineira's IConditionResolver standard, so the same rule
///         plugs into any escrow that speaks that interface. Each escrowId is
///         bound 1:1 to the escrow contract that registered it; only that
///         escrow may read isConditionMet, which keeps release timing private
///         from outside observers. Stateless and non-upgradeable by design.
contract InvoiceApprovalResolver is IConditionResolver, ERC165 {
    struct Condition {
        address buyer; // who may approve early release
        uint64 autoReleaseDeadline; // after this, release is allowed regardless
        bool set; // guards uninitialised reads and one-time config
    }

    /// @dev escrowId => the escrow contract authorised to query this condition.
    mapping(uint256 => address) private _boundEscrow;
    /// @dev escrowId => stored condition config.
    mapping(uint256 => Condition) private _conditions;
    /// @dev escrowId => whether the buyer has approved early release.
    mapping(uint256 => bool) public approved;

    error AlreadyConfigured(uint256 escrowId);
    error NotConfigured(uint256 escrowId);
    error UnauthorizedCaller(uint256 escrowId);
    error InvalidBuyer();
    error InvalidDeadline();
    error NotBuyer(uint256 escrowId);

    event ConditionSet(uint256 indexed escrowId, address indexed buyer, uint64 autoReleaseDeadline);
    event Approved(uint256 indexed escrowId, address indexed buyer);

    /// @dev Gates reads to the escrow that registered this escrowId.
    modifier onlyBoundEscrow(uint256 escrowId) {
        if (msg.sender != _boundEscrow[escrowId]) revert UnauthorizedCaller(escrowId);
        _;
    }

    /// @inheritdoc IConditionResolver
    /// @dev data = abi.encode(address buyer, uint64 autoReleaseDeadline).
    ///      Called once by the escrow during creation. Binds msg.sender (the
    ///      escrow) as the only address allowed to read this condition.
    function onConditionSet(uint256 escrowId, bytes calldata data) external override {
        if (_conditions[escrowId].set) revert AlreadyConfigured(escrowId);

        (address buyer, uint64 autoReleaseDeadline) = abi.decode(data, (address, uint64));
        if (buyer == address(0)) revert InvalidBuyer();
        if (autoReleaseDeadline <= block.timestamp) revert InvalidDeadline();

        _boundEscrow[escrowId] = msg.sender;
        _conditions[escrowId] =
            Condition({buyer: buyer, autoReleaseDeadline: autoReleaseDeadline, set: true});

        emit ConditionSet(escrowId, buyer, autoReleaseDeadline);
    }

    /// @notice Buyer approves early release of this escrow to the vendor.
    /// @dev Only the buyer recorded at config time. Idempotent.
    function approve(uint256 escrowId) external {
        Condition memory c = _conditions[escrowId];
        if (!c.set) revert NotConfigured(escrowId);
        if (msg.sender != c.buyer) revert NotBuyer(escrowId);
        approved[escrowId] = true;
        emit Approved(escrowId, msg.sender);
    }

    /// @inheritdoc IConditionResolver
    /// @dev Met when the buyer approved, or the auto-release deadline passed.
    function isConditionMet(uint256 escrowId)
        external
        view
        override
        onlyBoundEscrow(escrowId)
        returns (bool)
    {
        Condition memory c = _conditions[escrowId];
        if (!c.set) return false;
        return approved[escrowId] || block.timestamp >= c.autoReleaseDeadline;
    }

    /// @notice Public view for UIs: the condition config and live status. Not
    ///         gated, so a front end can show "funded / approved / releasable"
    ///         without the escrow binding. Only the boolean from isConditionMet
    ///         stays escrow-private.
    function getCondition(uint256 escrowId)
        external
        view
        returns (address buyer, uint64 autoReleaseDeadline, bool isApproved, bool deadlinePassed, bool set)
    {
        Condition memory c = _conditions[escrowId];
        return (c.buyer, c.autoReleaseDeadline, approved[escrowId], c.set && block.timestamp >= c.autoReleaseDeadline, c.set);
    }

    /// @notice The escrow contract bound to an escrowId (address(0) if unset).
    function boundEscrow(uint256 escrowId) external view returns (address) {
        return _boundEscrow[escrowId];
    }

    /// @inheritdoc ERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override(ERC165) returns (bool) {
        return interfaceId == type(IConditionResolver).interfaceId || super.supportsInterface(interfaceId);
    }
}
