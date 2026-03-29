// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./utils/ReentrancyGuard.sol";

interface IEventHub {
    function emitActivity(address user1, address user2, string calldata activityType, string calldata note, uint256 refId) external;
}

/// @title InheritanceManager — Dead man's switch for encrypted wallets
/// @notice If an owner is inactive for a set period, their designated heir can claim funds.
///         Includes a 7-day challenge period where the owner can cancel the claim.
///
/// @dev Flow: setHeir() → owner pings heartbeat() periodically →
///      if inactive too long → heir calls startClaim() →
///      7-day challenge window → heir calls finalizeClaim() →
///      heir receives funds from specified vaults
contract InheritanceManager is UUPSUpgradeable, OwnableUpgradeable, ReentrancyGuard {

    struct InheritancePlan {
        address heir;
        uint256 inactivityPeriod;   // Seconds of inactivity before claim is possible
        uint256 lastHeartbeat;      // Last time owner proved they're active
        uint256 claimStartedAt;     // When heir started claim (0 if no active claim)
        bool active;
    }

    uint256 public constant CHALLENGE_PERIOD = 7 days;
    uint256 public constant MIN_INACTIVITY = 30 days;

    IEventHub public eventHub;

    mapping(address => InheritancePlan) public plans;

    event HeirSet(address indexed owner, address indexed heir, uint256 inactivityPeriod, uint256 timestamp);
    event HeirRemoved(address indexed owner, uint256 timestamp);
    event Heartbeat(address indexed owner, uint256 timestamp);
    event ClaimStarted(address indexed owner, address indexed heir, uint256 timestamp);
    event ClaimCancelled(address indexed owner, uint256 timestamp);
    event ClaimFinalized(address indexed owner, address indexed heir, uint256 timestamp);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address _eventHub) public initializer {
        __Ownable_init(msg.sender);
        eventHub = IEventHub(_eventHub);
    }

    /// @notice Set or update your heir and inactivity period
    function setHeir(address heir, uint256 inactivityPeriod) external nonReentrant {
        require(heir != address(0) && heir != msg.sender, "InheritanceManager: invalid heir");
        require(inactivityPeriod >= MIN_INACTIVITY, "InheritanceManager: min 30 days");

        plans[msg.sender] = InheritancePlan({
            heir: heir,
            inactivityPeriod: inactivityPeriod,
            lastHeartbeat: block.timestamp,
            claimStartedAt: 0,
            active: true
        });

        emit HeirSet(msg.sender, heir, inactivityPeriod, block.timestamp);
        try eventHub.emitActivity(msg.sender, heir, "heir_set", "", 0) {} catch {}
    }

    /// @notice Remove your inheritance plan
    function removeHeir() external nonReentrant {
        require(plans[msg.sender].active, "InheritanceManager: no plan");
        plans[msg.sender].active = false;
        emit HeirRemoved(msg.sender, block.timestamp);
    }

    /// @notice Prove you're still active. Also cancels any pending claims.
    function heartbeat() external nonReentrant {
        InheritancePlan storage plan = plans[msg.sender];
        require(plan.active, "InheritanceManager: no plan");

        plan.lastHeartbeat = block.timestamp;

        // Cancel any pending claim
        if (plan.claimStartedAt > 0) {
            plan.claimStartedAt = 0;
            emit ClaimCancelled(msg.sender, block.timestamp);
        }

        emit Heartbeat(msg.sender, block.timestamp);
    }

    /// @notice Heir starts the claim process. Owner has 7 days to respond.
    function startClaim(address owner_) external nonReentrant {
        InheritancePlan storage plan = plans[owner_];
        require(plan.active, "InheritanceManager: no plan");
        require(msg.sender == plan.heir, "InheritanceManager: not heir");
        require(plan.claimStartedAt == 0, "InheritanceManager: claim already pending");
        require(
            block.timestamp > plan.lastHeartbeat + plan.inactivityPeriod,
            "InheritanceManager: owner still active"
        );

        plan.claimStartedAt = block.timestamp;

        emit ClaimStarted(owner_, msg.sender, block.timestamp);
        try eventHub.emitActivity(msg.sender, owner_, "claim_started", "", 0) {} catch {}
    }

    /// @notice Heir finalizes the claim after the 7-day challenge period.
    ///         Frontend handles the actual FHERC20Vault transfers — this contract
    ///         just validates the timing and marks the plan as claimed.
    function finalizeClaim(address owner_) external nonReentrant {
        InheritancePlan storage plan = plans[owner_];
        require(plan.active, "InheritanceManager: no plan");
        require(msg.sender == plan.heir, "InheritanceManager: not heir");
        require(plan.claimStartedAt > 0, "InheritanceManager: no pending claim");
        require(
            block.timestamp > plan.claimStartedAt + CHALLENGE_PERIOD,
            "InheritanceManager: challenge period active"
        );

        plan.active = false;

        emit ClaimFinalized(owner_, msg.sender, block.timestamp);
        try eventHub.emitActivity(msg.sender, owner_, "claim_finalized", "", 0) {} catch {}
    }

    // ─── View Functions ─────────────────────────────────────────────────

    function getPlan(address owner_) external view returns (
        address heir, uint256 inactivityPeriod, uint256 lastHeartbeat,
        uint256 claimStartedAt, bool active
    ) {
        InheritancePlan storage p = plans[owner_];
        return (p.heir, p.inactivityPeriod, p.lastHeartbeat, p.claimStartedAt, p.active);
    }

    function isClaimable(address owner_) external view returns (bool) {
        InheritancePlan storage p = plans[owner_];
        return p.active && block.timestamp > p.lastHeartbeat + p.inactivityPeriod;
    }

    function setEventHub(address _eventHub) external onlyOwner { eventHub = IEventHub(_eventHub); }
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
