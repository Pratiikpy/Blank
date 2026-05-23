// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/*
 * GuardianModule
 *
 * Wave 5 Block 3: social-recovery state machine for BlankAccount.
 *
 * Design choices:
 *   - One module instance per chain holds the recovery state for ALL
 *     accounts on that chain (mapping account => GuardianSet). This
 *     avoids needing to upgrade every existing BlankAccount proxy to
 *     embed recovery state.
 *   - Owner of each account configures their own guardian set via
 *     addGuardian / removeGuardian / setThreshold. Account owner is
 *     verified by `msg.sender == account` (the smart-account itself
 *     submits the config tx, signed by its current passkey).
 *   - Recovery request: any guardian calls requestRecovery(account,
 *     newOwner). Other guardians approve. After threshold and
 *     RECOVERY_WINDOW expire, finalizeRecovery is callable by anyone
 *     and emits a RecoveryFinalized event. Wave 5.5 wires
 *     BlankAccount.executeRecovery to listen for this event + rotate
 *     the validator key in-place.
 *   - Veto: any guardian can vetoRecovery during the window
 *     (protects against the lost-passkey + collusion case).
 *   - Hard floor: threshold >= 2 AND guardianCount >= 3.
 *
 * v1 behavior: the on-chain finalize emits the event but does NOT
 * rotate any BlankAccount validator. BlankAccount integration ships
 * in Wave 5.5 once the upgrade-path-storage-safe is reviewed.
 */
contract GuardianModule is UUPSUpgradeable, OwnableUpgradeable {

    struct GuardianSet {
        address[] guardians;
        mapping(address => bool) isGuardian;
        uint8 threshold;
    }

    struct RecoveryRequest {
        address newOwner;
        uint32 requestedAt;
        uint8 approvals;
        mapping(address => bool) hasApproved;
        bool vetoed;
        bool finalized;
    }

    mapping(address => GuardianSet) internal _sets;
    mapping(address => RecoveryRequest) internal _recoveries;

    /// Testnet ships with a short challenge window; mainnet (Wave 6,
    /// if ever) deploys with a 24h window. Immutable per-deploy.
    uint32 public RECOVERY_WINDOW_SECONDS;

    uint8 public constant MIN_GUARDIANS = 3;
    uint8 public constant MIN_THRESHOLD = 2;

    event GuardianAdded(address indexed account, address indexed guardian);
    event GuardianRemoved(address indexed account, address indexed guardian);
    event ThresholdSet(address indexed account, uint8 threshold);
    event RecoveryRequested(address indexed account, address indexed newOwner, address indexed by);
    event RecoveryApproved(address indexed account, address indexed by);
    event RecoveryVetoed(address indexed account, address indexed by);
    event RecoveryCancelled(address indexed account);
    event RecoveryFinalized(address indexed account, address indexed newOwner);
    event RecoveryWindowChanged(uint32 previous, uint32 next);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(uint32 _recoveryWindowSeconds) public initializer {
        __Ownable_init(msg.sender);
        require(_recoveryWindowSeconds >= 60, "GuardianModule: window too short");
        require(_recoveryWindowSeconds <= 30 days, "GuardianModule: window too long");
        RECOVERY_WINDOW_SECONDS = _recoveryWindowSeconds;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setRecoveryWindow(uint32 newWindow) external onlyOwner {
        require(newWindow >= 60 && newWindow <= 30 days, "GuardianModule: window bounds");
        emit RecoveryWindowChanged(RECOVERY_WINDOW_SECONDS, newWindow);
        RECOVERY_WINDOW_SECONDS = newWindow;
    }

    // ─── Account config (called BY the smart account) ───────────────

    function addGuardian(address guardian) external {
        require(guardian != address(0), "GuardianModule: guardian=0");
        require(guardian != msg.sender, "GuardianModule: self-guardian forbidden");
        GuardianSet storage gs = _sets[msg.sender];
        require(!gs.isGuardian[guardian], "GuardianModule: already guardian");
        gs.guardians.push(guardian);
        gs.isGuardian[guardian] = true;
        emit GuardianAdded(msg.sender, guardian);
    }

    function removeGuardian(address guardian) external {
        GuardianSet storage gs = _sets[msg.sender];
        require(gs.isGuardian[guardian], "GuardianModule: not guardian");
        gs.isGuardian[guardian] = false;
        // Swap-and-pop from the array.
        uint256 len = gs.guardians.length;
        for (uint256 i = 0; i < len; i++) {
            if (gs.guardians[i] == guardian) {
                gs.guardians[i] = gs.guardians[len - 1];
                gs.guardians.pop();
                break;
            }
        }
        // If removal drops below the contract floor, also reset threshold
        // so future setThreshold call has to re-establish it explicitly.
        if (gs.guardians.length < MIN_GUARDIANS) {
            gs.threshold = 0;
        }
        emit GuardianRemoved(msg.sender, guardian);
    }

    function setThreshold(uint8 threshold) external {
        GuardianSet storage gs = _sets[msg.sender];
        require(gs.guardians.length >= MIN_GUARDIANS, "GuardianModule: need 3+ guardians");
        require(threshold >= MIN_THRESHOLD, "GuardianModule: threshold floor 2");
        require(threshold <= gs.guardians.length, "GuardianModule: threshold > N");
        gs.threshold = threshold;
        emit ThresholdSet(msg.sender, threshold);
    }

    // ─── Recovery flow (guardian + open) ────────────────────────────

    function requestRecovery(address account, address newOwner) external {
        require(newOwner != address(0), "GuardianModule: newOwner=0");
        GuardianSet storage gs = _sets[account];
        require(gs.threshold >= MIN_THRESHOLD, "GuardianModule: recovery not configured");
        require(gs.isGuardian[msg.sender], "GuardianModule: not guardian");
        RecoveryRequest storage r = _recoveries[account];
        require(!r.finalized, "GuardianModule: already finalized");
        // Reset any prior request.
        delete _recoveries[account];
        RecoveryRequest storage nr = _recoveries[account];
        nr.newOwner = newOwner;
        nr.requestedAt = uint32(block.timestamp);
        nr.approvals = 1;
        nr.hasApproved[msg.sender] = true;
        emit RecoveryRequested(account, newOwner, msg.sender);
    }

    function approveRecovery(address account) external {
        GuardianSet storage gs = _sets[account];
        require(gs.isGuardian[msg.sender], "GuardianModule: not guardian");
        RecoveryRequest storage r = _recoveries[account];
        require(r.requestedAt > 0 && !r.finalized && !r.vetoed, "GuardianModule: no live request");
        require(!r.hasApproved[msg.sender], "GuardianModule: already approved");
        r.hasApproved[msg.sender] = true;
        r.approvals += 1;
        emit RecoveryApproved(account, msg.sender);
    }

    function vetoRecovery(address account) external {
        GuardianSet storage gs = _sets[account];
        require(gs.isGuardian[msg.sender], "GuardianModule: not guardian");
        RecoveryRequest storage r = _recoveries[account];
        require(r.requestedAt > 0 && !r.finalized, "GuardianModule: no live request");
        r.vetoed = true;
        emit RecoveryVetoed(account, msg.sender);
    }

    /// Account can cancel its own recovery (e.g. if the user finds
    /// their old passkey and aborts).
    function cancelRecovery() external {
        RecoveryRequest storage r = _recoveries[msg.sender];
        require(r.requestedAt > 0 && !r.finalized, "GuardianModule: no live request");
        delete _recoveries[msg.sender];
        emit RecoveryCancelled(msg.sender);
    }

    function finalizeRecovery(address account) external {
        GuardianSet storage gs = _sets[account];
        RecoveryRequest storage r = _recoveries[account];
        require(r.requestedAt > 0, "GuardianModule: no request");
        require(!r.finalized, "GuardianModule: already finalized");
        require(!r.vetoed, "GuardianModule: vetoed");
        require(r.approvals >= gs.threshold, "GuardianModule: below threshold");
        require(
            block.timestamp >= r.requestedAt + RECOVERY_WINDOW_SECONDS,
            "GuardianModule: window open"
        );
        r.finalized = true;
        emit RecoveryFinalized(account, r.newOwner);
    }

    // ─── Views ──────────────────────────────────────────────────────

    function guardiansOf(address account) external view returns (address[] memory) {
        return _sets[account].guardians;
    }

    function thresholdOf(address account) external view returns (uint8) {
        return _sets[account].threshold;
    }

    function isGuardian(address account, address who) external view returns (bool) {
        return _sets[account].isGuardian[who];
    }

    function recoveryState(address account) external view returns (
        address newOwner,
        uint32 requestedAt,
        uint8 approvals,
        bool vetoed,
        bool finalized
    ) {
        RecoveryRequest storage r = _recoveries[account];
        return (r.newOwner, r.requestedAt, r.approvals, r.vetoed, r.finalized);
    }

    function hasApproved(address account, address guardian) external view returns (bool) {
        return _recoveries[account].hasApproved[guardian];
    }
}
