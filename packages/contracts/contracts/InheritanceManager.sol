// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "./utils/ReentrancyGuard.sol";

interface IFHERC20Vault {
    function transferFrom(address from, address to, InEuint64 memory encAmount) external returns (euint64);
    function transferFromVerified(address from, address to, euint64 amount) external returns (euint64);
}

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
        address[] vaults;           // FHERC20Vaults to transfer on claim
    }

    uint256 public constant CHALLENGE_PERIOD = 7 days;
    uint256 public constant MIN_INACTIVITY = 30 days;

    IEventHub public eventHub;

    mapping(address => InheritancePlan) public plans;

    /// @dev Issue #185 — finalizeClaim mutex keyed by principal (plan owner).
    ///      Prevents a second heir (or replay of the same heir) from
    ///      finalizing an already-finalized plan. Even though `finalizeClaim`
    ///      flips `plan.active = false` before transferring, that flag is a
    ///      general plan-active toggle (also used by `removeHeir`) and gives a
    ///      generic "no plan" error on re-entry. This dedicated flag yields a
    ///      specific, auditable "claim already finalized" revert and makes the
    ///      finalize-once invariant explicit.
    ///
    ///      APPEND-ONLY state (UUPS-safe) — added in v0.1.5.
    mapping(address => bool) public claimFinalized;

    event HeirSet(address indexed owner, address indexed heir, uint256 inactivityPeriod, uint256 timestamp);
    event HeirRemoved(address indexed owner, uint256 timestamp);
    event Heartbeat(address indexed owner, uint256 timestamp);
    event ClaimStarted(address indexed owner, address indexed heir, uint256 timestamp);
    event ClaimCancelled(address indexed owner, uint256 timestamp);
    event ClaimFinalized(address indexed owner, address indexed heir, uint256 timestamp);
    event VaultsUpdated(address indexed owner, address[] vaults, uint256 timestamp);

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

        InheritancePlan storage plan = plans[msg.sender];
        plan.heir = heir;
        plan.inactivityPeriod = inactivityPeriod;
        plan.lastHeartbeat = block.timestamp;
        plan.claimStartedAt = 0;
        plan.active = true;
        // plan.vaults is preserved from any previous setVaults call

        emit HeirSet(msg.sender, heir, inactivityPeriod, block.timestamp);
        try eventHub.emitActivity(msg.sender, heir, "heir_set", "", 0) {} catch {}
    }

    /// @notice Remove your inheritance plan
    function removeHeir() external nonReentrant {
        require(plans[msg.sender].active, "InheritanceManager: no plan");
        plans[msg.sender].active = false;
        emit HeirRemoved(msg.sender, block.timestamp);
    }

    /// @notice Set or update the vaults protected by this inheritance plan.
    ///         Owner MUST approve this contract (InheritanceManager) on each vault
    ///         via vault.approvePlaintext(inheritanceManager, type(uint64).max)
    ///         so that finalizeClaim can transfer balances to the heir.
    /// @param _vaults Array of FHERC20Vault addresses to protect
    function setVaults(address[] calldata _vaults) external nonReentrant {
        InheritancePlan storage plan = plans[msg.sender];
        require(plan.active, "InheritanceManager: no plan");
        // Audit P2.14: cap the vaults array to prevent finalizeClaim's
        // unbounded loop from exceeding the block gas limit. 20 vaults is
        // generous (Blank only ships 2 today, but USDT + ETH + WBTC + etc.
        // is the realistic upper bound for any user). Without this cap an
        // owner could push hundreds of vaults and permanently lock the
        // claim by making finalizeClaim revert with out-of-gas every time.
        require(_vaults.length <= 20, "InheritanceManager: too many vaults");
        plan.vaults = _vaults;
        emit VaultsUpdated(msg.sender, _vaults, block.timestamp);
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
    ///         Transfers all vault balances from the owner to the heir.
    ///
    ///         The heir provides encrypted amounts for each vault — one per vault in the plan.
    ///         To drain the full balance, encrypt type(uint64).max for each vault.
    ///         The vault's transferFrom uses FHE.select (no revert on insufficient balance),
    ///         so over-requesting is safe — it transfers up to the available balance.
    ///
    ///         PREREQUISITE: The owner MUST have approved this contract on each vault
    ///         via vault.approvePlaintext(inheritanceManager, type(uint64).max).
    ///
    /// @param owner_ The address of the plan owner whose funds are being claimed
    /// @param encAmounts Encrypted amounts to transfer from each vault (one per vault in plan.vaults)
    function finalizeClaim(address owner_, InEuint64[] memory encAmounts) external nonReentrant {
        // #185 mutex: first heir wins cleanly; any subsequent call (including a
        // racing second heir or a replay of the original) gets this specific
        // revert instead of a generic "no plan" error or a silent no-op.
        require(!claimFinalized[owner_], "InheritanceManager: claim already finalized");

        InheritancePlan storage plan = plans[owner_];
        require(plan.active, "InheritanceManager: no plan");
        require(msg.sender == plan.heir, "InheritanceManager: not heir");
        require(plan.claimStartedAt > 0, "InheritanceManager: no pending claim");
        require(
            block.timestamp > plan.claimStartedAt + CHALLENGE_PERIOD,
            "InheritanceManager: challenge period active"
        );
        require(
            encAmounts.length == plan.vaults.length,
            "InheritanceManager: amounts/vaults length mismatch"
        );

        // Audit Top-28 #13 (CEI): set BOTH state flags before any external
        // call. plan.active = false already double-served as a mutex via the
        // require(plan.active) check above, but claimFinalized was being set
        // AFTER the transfer loop, leaving it unset during the cross-contract
        // calls. If any future change weakens the plan.active mutex (or a
        // bespoke vault implementation bypasses nonReentrant), a reentrant
        // call could pass the !claimFinalized check at the top and re-enter.
        // Setting both flags first hardens the mutex independently of the
        // nonReentrant modifier — strict first-attempt-wins semantics.
        plan.active = false;
        claimFinalized[owner_] = true;

        // Transfer all vault balances from owner to heir
        for (uint256 i = 0; i < plan.vaults.length; i++) {
            // Verify encrypted input here (msg.sender = heir) before cross-contract call
            euint64 verifiedAmount = FHE.asEuint64(encAmounts[i]);
            FHE.allowTransient(verifiedAmount, plan.vaults[i]);

            IFHERC20Vault vault = IFHERC20Vault(plan.vaults[i]);
            // vault.transferFromVerified checks both balance AND allowance via FHE.select
            // Returns the actual encrypted amount transferred (zero if insufficient)
            euint64 transferred = vault.transferFromVerified(owner_, plan.heir, verifiedAmount);
            // Grant the heir permission to read the transferred amount handle
            FHE.allowTransient(transferred, plan.heir);
        }

        emit ClaimFinalized(owner_, plan.heir, block.timestamp);
        try eventHub.emitActivity(msg.sender, owner_, "claim_finalized", "", 0) {} catch {}
    }

    // ─── View Functions ─────────────────────────────────────────────────

    function getPlan(address owner_) external view returns (
        address heir, uint256 inactivityPeriod, uint256 lastHeartbeat,
        uint256 claimStartedAt, bool active, address[] memory vaults
    ) {
        InheritancePlan storage p = plans[owner_];
        return (p.heir, p.inactivityPeriod, p.lastHeartbeat, p.claimStartedAt, p.active, p.vaults);
    }

    function isClaimable(address owner_) external view returns (bool) {
        InheritancePlan storage p = plans[owner_];
        return p.active && block.timestamp > p.lastHeartbeat + p.inactivityPeriod;
    }

    function setEventHub(address _eventHub) external onlyOwner { eventHub = IEventHub(_eventHub); }
    /// @dev Reserved storage to avoid collisions on future upgrades.
    ///      Append-only: when adding a new state variable in a later upgrade,
    ///      decrement the gap size so total storage is unchanged.
    /// @dev Used: 4. Gap: 50.
    uint256[50] private __gap;

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
