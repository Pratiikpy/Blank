// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title EventHub — Unified event emission for all Blank contracts
/// @notice All contracts emit activity events through this hub so the frontend
///         can query a single contract address for the full activity feed.
contract EventHub is UUPSUpgradeable, OwnableUpgradeable {
    /// @notice Emitted for every user-visible action across the system
    /// @param user1 Primary user (sender/creator/payer)
    /// @param user2 Secondary user (receiver/payee) — address(0) if N/A
    /// @param activityType Type string: "payment", "request", "request_fulfilled",
    ///        "group_expense", "group_settle", "tip", "invoice_created", "invoice_paid",
    ///        "payroll", "escrow_created", "escrow_released", "escrow_disputed",
    ///        "exchange_created", "exchange_filled", "shield", "unshield"
    /// @param sourceContract The contract that triggered this event
    /// @param note Optional plaintext note/emoji (empty string if none)
    /// @param refId Optional reference ID (requestId, groupId, invoiceId, etc.)
    event Activity(
        address indexed user1,
        address indexed user2,
        string activityType,
        address sourceContract,
        string note,
        uint256 refId,
        uint256 timestamp
    );

    /// @notice Tracks which contracts are allowed to emit events
    mapping(address => bool) public whitelisted;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize() public initializer {
        __Ownable_init(msg.sender);
        // UUPSUpgradeable needs no init in OZ v5.6
    }

    /// @notice Whitelist a contract to emit events
    function whitelist(address contractAddr) external onlyOwner {
        whitelisted[contractAddr] = true;
    }

    /// @notice Remove a contract from the whitelist
    function removeWhitelist(address contractAddr) external onlyOwner {
        whitelisted[contractAddr] = false;
    }

    /// @notice Batch whitelist multiple contracts
    function batchWhitelist(address[] calldata contracts) external onlyOwner {
        for (uint256 i = 0; i < contracts.length; i++) {
            whitelisted[contracts[i]] = true;
        }
    }

    /// @notice Emit an activity event. Only whitelisted contracts can call this.
    function emitActivity(
        address user1,
        address user2,
        string calldata activityType,
        string calldata note,
        uint256 refId
    ) external {
        require(whitelisted[msg.sender], "EventHub: caller not whitelisted");
        emit Activity(user1, user2, activityType, msg.sender, note, refId, block.timestamp);
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
