// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// Minimal interface to BlankAccount.setOwner, declared inline so this
/// module does not pull in the AA bundle.
interface IBlankAccount {
    function setOwner(uint256 newX, uint256 newY) external;
}

/*
 * GuardianModule
 *
 * Social recovery for BlankAccount. One module per chain holds the guardian
 * sets and recovery requests for every account.
 *
 *   - The account (msg.sender) configures its own guardians and threshold.
 *     Floor: 3 guardians, threshold at least 2 and a strict majority.
 *   - A guardian opens a request and commits the new P-256 key hash. Other
 *     guardians approve that request. Approvals are tracked per request id,
 *     so they never carry over to a later request.
 *   - Only approvals from current guardians count at finalize.
 *   - A veto needs N - threshold + 1 guardian votes (the point where the
 *     threshold can no longer be met). A single guardian cannot block.
 *   - A live request cannot be replaced. It ends by finalize, account
 *     cancel or quorum veto, after which a new request can be opened.
 *   - The challenge window is at least MIN_RECOVERY_WINDOW.
 */
contract GuardianModule is UUPSUpgradeable, OwnableUpgradeable {

    struct GuardianSet {
        address[] guardians;
        mapping(address => bool) isGuardian;
        uint8 threshold;
    }

    struct RecoveryRequest {
        address newOwner;         // legacy, always zero for new requests
        uint32 requestedAt;
        uint8 approvals;          // legacy counter, finalize recounts live approvals
        mapping(address => bool) hasApproved; // legacy, superseded by _ballots
        bool vetoed;
        bool finalized;
    }

    mapping(address => GuardianSet) internal _sets;
    mapping(address => RecoveryRequest) internal _recoveries;

    /// Challenge window. The effective window never drops below
    /// MIN_RECOVERY_WINDOW, even on proxies initialized with a shorter one.
    uint32 public RECOVERY_WINDOW_SECONDS;

    uint8 public constant MIN_GUARDIANS = 3;
    uint8 public constant MIN_THRESHOLD = 2;
    uint8 public constant MAX_GUARDIANS = 10;
    uint32 public constant MIN_RECOVERY_WINDOW = 24 hours;
    uint32 public constant MAX_RECOVERY_WINDOW = 30 days;

    struct Ballot {
        bytes32 newKeyHash;
        mapping(address => bool) approved;
        mapping(address => bool) vetoed;
    }

    /// Per-account request counter. Each request gets a fresh ballot.
    mapping(address => uint256) public recoveryNonce;
    mapping(address => mapping(uint256 => Ballot)) internal _ballots;

    event GuardianAdded(address indexed account, address indexed guardian);
    event GuardianRemoved(address indexed account, address indexed guardian);
    event ThresholdSet(address indexed account, uint8 threshold);
    event RecoveryRequested(address indexed account, address indexed newOwner, address indexed by);
    event RecoveryKeyCommitted(address indexed account, uint256 indexed nonce, bytes32 newKeyHash);
    event RecoveryApproved(address indexed account, address indexed by);
    event RecoveryVetoVote(address indexed account, address indexed by, uint256 vetoes, uint256 quorum);
    event RecoveryVetoed(address indexed account, address indexed by);
    event RecoveryCancelled(address indexed account);
    event RecoveryFinalized(address indexed account, address indexed newOwner);
    event RecoveryRotated(address indexed account, uint256 newOwnerX, uint256 newOwnerY);
    event RecoveryWindowChanged(uint32 previous, uint32 next);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(uint32 _recoveryWindowSeconds) public initializer {
        __Ownable_init(msg.sender);
        require(_recoveryWindowSeconds >= MIN_RECOVERY_WINDOW, "GuardianModule: window too short");
        require(_recoveryWindowSeconds <= MAX_RECOVERY_WINDOW, "GuardianModule: window too long");
        RECOVERY_WINDOW_SECONDS = _recoveryWindowSeconds;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function setRecoveryWindow(uint32 newWindow) external onlyOwner {
        require(
            newWindow >= MIN_RECOVERY_WINDOW && newWindow <= MAX_RECOVERY_WINDOW,
            "GuardianModule: window bounds"
        );
        emit RecoveryWindowChanged(RECOVERY_WINDOW_SECONDS, newWindow);
        RECOVERY_WINDOW_SECONDS = newWindow;
    }

    function effectiveRecoveryWindow() public view returns (uint32) {
        return RECOVERY_WINDOW_SECONDS < MIN_RECOVERY_WINDOW ? MIN_RECOVERY_WINDOW : RECOVERY_WINDOW_SECONDS;
    }

    // ─── Account config (called BY the smart account) ───────────────

    function addGuardian(address guardian) external {
        require(guardian != address(0), "GuardianModule: guardian=0");
        require(guardian != msg.sender, "GuardianModule: self-guardian forbidden");
        GuardianSet storage gs = _sets[msg.sender];
        require(!gs.isGuardian[guardian], "GuardianModule: already guardian");
        require(gs.guardians.length < MAX_GUARDIANS, "GuardianModule: too many guardians");
        gs.guardians.push(guardian);
        gs.isGuardian[guardian] = true;
        emit GuardianAdded(msg.sender, guardian);
    }

    function removeGuardian(address guardian) external {
        GuardianSet storage gs = _sets[msg.sender];
        require(gs.isGuardian[guardian], "GuardianModule: not guardian");
        gs.isGuardian[guardian] = false;
        uint256 len = gs.guardians.length;
        for (uint256 i = 0; i < len; i++) {
            if (gs.guardians[i] == guardian) {
                gs.guardians[i] = gs.guardians[len - 1];
                gs.guardians.pop();
                break;
            }
        }
        uint256 n = gs.guardians.length;
        if (n < MIN_GUARDIANS) {
            // Below the floor, recovery is off until the set is rebuilt.
            if (gs.threshold != 0) {
                gs.threshold = 0;
                emit ThresholdSet(msg.sender, 0);
            }
        } else if (gs.threshold > n) {
            // Keep the threshold reachable.
            gs.threshold = uint8(n);
            emit ThresholdSet(msg.sender, gs.threshold);
        }
        emit GuardianRemoved(msg.sender, guardian);
    }

    function setThreshold(uint8 threshold) external {
        GuardianSet storage gs = _sets[msg.sender];
        uint256 n = gs.guardians.length;
        require(n >= MIN_GUARDIANS, "GuardianModule: need 3+ guardians");
        require(threshold >= MIN_THRESHOLD, "GuardianModule: threshold floor 2");
        require(threshold <= n, "GuardianModule: threshold > N");
        require(threshold >= n / 2 + 1, "GuardianModule: threshold below majority");
        gs.threshold = threshold;
        emit ThresholdSet(msg.sender, threshold);
    }

    // ─── Recovery flow ──────────────────────────────────────────────

    /// Requests opened before the key-commit upgrade (nonce 0) carry no
    /// key and can never finalize, so they do not count as live.
    function _isLive(address account) internal view returns (bool) {
        RecoveryRequest storage r = _recoveries[account];
        return recoveryNonce[account] > 0 && r.requestedAt > 0 && !r.finalized && !r.vetoed;
    }

    function _configured(GuardianSet storage gs) internal view returns (bool) {
        return gs.threshold >= MIN_THRESHOLD && gs.guardians.length >= MIN_GUARDIANS;
    }

    /// Open a recovery that rotates the account to (newOwnerX, newOwnerY).
    /// The caller counts as the first approval.
    function requestRecovery(address account, uint256 newOwnerX, uint256 newOwnerY) external {
        require(newOwnerX != 0 || newOwnerY != 0, "GuardianModule: zero pubkey");
        GuardianSet storage gs = _sets[account];
        require(_configured(gs), "GuardianModule: recovery not configured");
        require(gs.isGuardian[msg.sender], "GuardianModule: not guardian");
        RecoveryRequest storage r = _recoveries[account];
        require(!_isLive(account), "GuardianModule: request already live");

        uint256 nonce = ++recoveryNonce[account];
        Ballot storage b = _ballots[account][nonce];
        b.newKeyHash = keccak256(abi.encode(newOwnerX, newOwnerY));
        b.approved[msg.sender] = true;

        r.newOwner = address(0);
        r.requestedAt = uint32(block.timestamp);
        r.approvals = 1;
        r.vetoed = false;
        r.finalized = false;

        emit RecoveryRequested(account, address(0), msg.sender);
        emit RecoveryKeyCommitted(account, nonce, b.newKeyHash);
    }

    function approveRecovery(address account) external {
        GuardianSet storage gs = _sets[account];
        require(gs.isGuardian[msg.sender], "GuardianModule: not guardian");
        RecoveryRequest storage r = _recoveries[account];
        require(_isLive(account), "GuardianModule: no live request");
        Ballot storage b = _ballots[account][recoveryNonce[account]];
        require(!b.approved[msg.sender], "GuardianModule: already approved");
        require(!b.vetoed[msg.sender], "GuardianModule: already vetoed");
        b.approved[msg.sender] = true;
        r.approvals += 1;
        emit RecoveryApproved(account, msg.sender);
    }

    /// Record a veto vote. The request is vetoed once vetoQuorum(account)
    /// current guardians have voted against it.
    function vetoRecovery(address account) external {
        GuardianSet storage gs = _sets[account];
        require(gs.isGuardian[msg.sender], "GuardianModule: not guardian");
        RecoveryRequest storage r = _recoveries[account];
        require(_isLive(account), "GuardianModule: no live request");
        Ballot storage b = _ballots[account][recoveryNonce[account]];
        require(!b.vetoed[msg.sender], "GuardianModule: already vetoed");
        require(!b.approved[msg.sender], "GuardianModule: already approved");
        b.vetoed[msg.sender] = true;

        uint256 vetoes = _countVetoes(gs, b);
        uint256 quorum = vetoQuorum(account);
        emit RecoveryVetoVote(account, msg.sender, vetoes, quorum);
        if (vetoes >= quorum) {
            r.vetoed = true;
            emit RecoveryVetoed(account, msg.sender);
        }
    }

    /// Account cancels its own live request (e.g. the user found the old
    /// passkey).
    function cancelRecovery() external {
        RecoveryRequest storage r = _recoveries[msg.sender];
        require(_isLive(msg.sender), "GuardianModule: no live request");
        r.requestedAt = 0;
        r.approvals = 0;
        emit RecoveryCancelled(msg.sender);
    }

    /// The event-only finalize could latch `finalized` without rotating and
    /// block the real rotation.
    function finalizeRecovery(address) external pure {
        revert("GuardianModule: retired");
    }

    /// Finalize and rotate the BlankAccount owner key. The key must match
    /// the hash committed at requestRecovery. Caller must be a current
    /// guardian who approved this request.
    ///
    /// Pre-req: BlankAccount.recoveryModule must equal this contract.
    function finalizeRecoveryAndRotate(
        address account,
        uint256 newOwnerX,
        uint256 newOwnerY
    ) external {
        GuardianSet storage gs = _sets[account];
        RecoveryRequest storage r = _recoveries[account];
        require(r.requestedAt > 0, "GuardianModule: no request");
        require(!r.finalized, "GuardianModule: already finalized");
        require(!r.vetoed, "GuardianModule: vetoed");
        require(_configured(gs), "GuardianModule: recovery not configured");
        Ballot storage b = _ballots[account][recoveryNonce[account]];
        require(_countApprovals(gs, b) >= gs.threshold, "GuardianModule: below threshold");
        require(
            block.timestamp >= uint256(r.requestedAt) + effectiveRecoveryWindow(),
            "GuardianModule: window open"
        );
        require(gs.isGuardian[msg.sender] && b.approved[msg.sender], "GuardianModule: caller did not approve");
        require(newOwnerX != 0 || newOwnerY != 0, "GuardianModule: zero pubkey");
        require(keccak256(abi.encode(newOwnerX, newOwnerY)) == b.newKeyHash, "GuardianModule: key mismatch");

        r.finalized = true;
        emit RecoveryFinalized(account, r.newOwner);
        emit RecoveryRotated(account, newOwnerX, newOwnerY);

        // CEI. If setOwner reverts (module not wired), the whole tx reverts
        // and the request stays retryable.
        IBlankAccount(account).setOwner(newOwnerX, newOwnerY);
    }

    function _countApprovals(GuardianSet storage gs, Ballot storage b) internal view returns (uint256 c) {
        uint256 n = gs.guardians.length;
        for (uint256 i = 0; i < n; i++) {
            if (b.approved[gs.guardians[i]]) c++;
        }
    }

    function _countVetoes(GuardianSet storage gs, Ballot storage b) internal view returns (uint256 c) {
        uint256 n = gs.guardians.length;
        for (uint256 i = 0; i < n; i++) {
            if (b.vetoed[gs.guardians[i]]) c++;
        }
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

    /// `approvals` counts approvals from current guardians only.
    function recoveryState(address account) external view returns (
        address newOwner,
        uint32 requestedAt,
        uint8 approvals,
        bool vetoed,
        bool finalized
    ) {
        RecoveryRequest storage r = _recoveries[account];
        uint8 live = r.requestedAt == 0
            ? 0
            : uint8(_countApprovals(_sets[account], _ballots[account][recoveryNonce[account]]));
        return (r.newOwner, r.requestedAt, live, r.vetoed, r.finalized);
    }

    function hasApproved(address account, address guardian) external view returns (bool) {
        if (_recoveries[account].requestedAt == 0) return false;
        return _ballots[account][recoveryNonce[account]].approved[guardian];
    }

    function hasVetoed(address account, address guardian) external view returns (bool) {
        if (_recoveries[account].requestedAt == 0) return false;
        return _ballots[account][recoveryNonce[account]].vetoed[guardian];
    }

    function recoveryKeyHash(address account) external view returns (bytes32) {
        return _ballots[account][recoveryNonce[account]].newKeyHash;
    }

    /// Votes needed to veto: enough that the threshold becomes unreachable.
    function vetoQuorum(address account) public view returns (uint256) {
        GuardianSet storage gs = _sets[account];
        uint256 n = gs.guardians.length;
        if (gs.threshold == 0 || gs.threshold > n) return 1;
        return n - gs.threshold + 1;
    }
}
