// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/*
 * BlankHandles
 *
 * Wave 5 Block 2: per-chain `@handle` registry. Maps human-readable
 * handles ("alice") to a smart-account address plus optional email
 * digest and optional ENS fallback.
 *
 * v1 design choices:
 *   - Per-chain namespace (Eth Sepolia "alice" and Base Sepolia
 *     "alice" are independent). UI shows chain suffix.
 *   - 3-24 character handles. Case-insensitive uniqueness.
 *   - Reserved-words list for short / brand-protected names. Short
 *     handles (3-4 chars) are admin-only at v1; community auction
 *     is Wave 6 scope.
 *   - Soulbound-by-default, BUT transferable through the
 *     recoveryHook so Block 3 guardian recovery can rebind the
 *     handle when a smart-account address rotates.
 *
 * Anti-phishing carry-over from Wave 4 #349: if the handle has an
 * emailDigest, the resolver returns it so the sender flow can
 * verify the encrypted recipient email matches before sending.
 */
contract BlankHandles is UUPSUpgradeable, OwnableUpgradeable {

    struct Handle {
        bytes32 handleHash;       // keccak256(lowercase)
        address owner;            // smart-account address
        bytes32 emailDigest;      // optional FHE-friendly digest
        bytes32 ensRecord;        // optional ENS fallback
        uint64 createdAt;
        uint64 lastActivityAt;    // for the 30-day inactivity reclaim path
    }

    // ─── State ─────────────────────────────────────────────────────

    mapping(bytes32 => Handle) public handles;
    mapping(address => bytes32) public ownerToHandle;
    mapping(bytes32 => bool) public reservedHandles;

    /// Hook contract authorized to rebind handles during recovery.
    /// Set by owner (typically the BlankAccount factory or the
    /// GuardianModule deployed in Block 3).
    address public recoveryHook;

    uint32 public constant MIN_HANDLE_LEN = 3;
    uint32 public constant MAX_HANDLE_LEN = 24;
    uint32 public constant SHORT_HANDLE_THRESHOLD = 4; // <= this length is admin-only at v1
    uint32 public constant INACTIVITY_RECLAIM_SECONDS = 30 days;

    // ─── Events ────────────────────────────────────────────────────

    event HandleReserved(string handle, address indexed owner, bytes32 indexed handleHash);
    event HandleEmailDigestSet(bytes32 indexed handleHash, bytes32 emailDigest);
    event HandleEnsSet(bytes32 indexed handleHash, bytes32 ensRecord);
    event HandleOwnerTransferred(bytes32 indexed handleHash, address indexed previous, address indexed next);
    event HandleActivityPing(bytes32 indexed handleHash);
    event ReservedListSet(bytes32 indexed handleHash, bool reserved);
    event RecoveryHookChanged(address indexed previous, address indexed next);

    // ─── Init ──────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize() public initializer {
        __Ownable_init(msg.sender);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ─── Admin ─────────────────────────────────────────────────────

    function setRecoveryHook(address hook) external onlyOwner {
        emit RecoveryHookChanged(recoveryHook, hook);
        recoveryHook = hook;
    }

    function setReservedList(bytes32[] calldata handleHashes, bool reserved) external onlyOwner {
        for (uint256 i = 0; i < handleHashes.length; i++) {
            reservedHandles[handleHashes[i]] = reserved;
            emit ReservedListSet(handleHashes[i], reserved);
        }
    }

    /// Admin override for the short-handle (3-4 char) lockout.
    /// Owner can mint a short handle to a chosen address.
    function adminMintShort(string calldata handle, address to) external onlyOwner {
        require(to != address(0), "BlankHandles: to=0");
        uint32 len = uint32(bytes(handle).length);
        require(len >= MIN_HANDLE_LEN && len <= SHORT_HANDLE_THRESHOLD, "BlankHandles: not short");
        bytes32 h = _normalizeAndHash(handle);
        require(handles[h].owner == address(0), "BlankHandles: taken");
        _writeHandle(h, to, handle);
    }

    // ─── Public reserve ───────────────────────────────────────────

    /// Reserve a handle for the caller. Reverts on:
    ///   - bad length (< MIN_HANDLE_LEN or > MAX_HANDLE_LEN)
    ///   - non-alphanumeric / dot / dash / underscore character
    ///   - taken (case-insensitive)
    ///   - reserved word
    ///   - short handle without admin path (caller is not owner)
    ///   - caller already has a handle on this chain
    function reserve(string calldata handle, bytes32 emailDigest) external {
        uint32 len = uint32(bytes(handle).length);
        require(len >= MIN_HANDLE_LEN, "BlankHandles: too short");
        require(len <= MAX_HANDLE_LEN, "BlankHandles: too long");
        if (len <= SHORT_HANDLE_THRESHOLD) {
            revert("BlankHandles: short handles admin-only at v1");
        }
        require(_isValidChars(handle), "BlankHandles: bad chars");
        bytes32 h = _normalizeAndHash(handle);
        require(!reservedHandles[h], "BlankHandles: reserved");
        require(handles[h].owner == address(0), "BlankHandles: taken");
        require(ownerToHandle[msg.sender] == bytes32(0), "BlankHandles: already have handle");

        _writeHandle(h, msg.sender, handle);
        if (emailDigest != bytes32(0)) {
            handles[h].emailDigest = emailDigest;
            emit HandleEmailDigestSet(h, emailDigest);
        }
    }

    function setEmailDigest(string calldata handle, bytes32 emailDigest) external {
        bytes32 h = _normalizeAndHash(handle);
        require(handles[h].owner == msg.sender, "BlankHandles: not owner");
        handles[h].emailDigest = emailDigest;
        emit HandleEmailDigestSet(h, emailDigest);
    }

    function setEnsFallback(string calldata handle, bytes32 ensRecord) external {
        bytes32 h = _normalizeAndHash(handle);
        require(handles[h].owner == msg.sender, "BlankHandles: not owner");
        handles[h].ensRecord = ensRecord;
        emit HandleEnsSet(h, ensRecord);
    }

    /// Anyone can call to record activity. The handle's lastActivityAt
    /// drives the 30-day inactivity reclaim. Usually emitted from
    /// integrations on send/receive so handles stay live without the
    /// owner manually pinging.
    function pingActivity(string calldata handle) external {
        bytes32 h = _normalizeAndHash(handle);
        require(handles[h].owner != address(0), "BlankHandles: unknown");
        handles[h].lastActivityAt = uint64(block.timestamp);
        emit HandleActivityPing(h);
    }

    /// Reclaim a handle whose owner has been inactive for
    /// INACTIVITY_RECLAIM_SECONDS. Anyone can trigger; the handle is
    /// freed for a new reserve.
    function reclaimInactive(string calldata handle) external {
        bytes32 h = _normalizeAndHash(handle);
        Handle storage e = handles[h];
        require(e.owner != address(0), "BlankHandles: unknown");
        require(
            block.timestamp >= e.lastActivityAt + INACTIVITY_RECLAIM_SECONDS,
            "BlankHandles: not inactive"
        );
        address prev = e.owner;
        delete ownerToHandle[prev];
        delete handles[h];
        emit HandleOwnerTransferred(h, prev, address(0));
    }

    // ─── Recovery-hook rebind ─────────────────────────────────────

    /// Called by the GuardianModule (Block 3) when a smart-account
    /// recovery completes. Transfers the handle from prev to next.
    /// recoveryHook is set by owner once Block 3 deploys.
    function transferOwner(bytes32 handleHash, address newOwner) external {
        require(msg.sender == recoveryHook, "BlankHandles: not recovery hook");
        require(newOwner != address(0), "BlankHandles: to=0");
        Handle storage e = handles[handleHash];
        require(e.owner != address(0), "BlankHandles: unknown");
        address prev = e.owner;
        delete ownerToHandle[prev];
        e.owner = newOwner;
        e.lastActivityAt = uint64(block.timestamp);
        ownerToHandle[newOwner] = handleHash;
        emit HandleOwnerTransferred(handleHash, prev, newOwner);
    }

    // ─── Views ────────────────────────────────────────────────────

    function lookup(string calldata handle) external view returns (Handle memory) {
        return handles[_normalizeAndHash(handle)];
    }

    function reverseLookup(address owner) external view returns (bytes32 handleHash) {
        return ownerToHandle[owner];
    }

    function isAvailable(string calldata handle) external view returns (bool ok, string memory reason) {
        uint32 len = uint32(bytes(handle).length);
        if (len < MIN_HANDLE_LEN) return (false, "too short");
        if (len > MAX_HANDLE_LEN) return (false, "too long");
        if (!_isValidChars(handle)) return (false, "bad chars");
        bytes32 h = _normalizeAndHash(handle);
        if (reservedHandles[h]) return (false, "reserved");
        if (handles[h].owner != address(0)) return (false, "taken");
        if (len <= SHORT_HANDLE_THRESHOLD) return (false, "short admin-only at v1");
        return (true, "");
    }

    // ─── Internal ─────────────────────────────────────────────────

    function _writeHandle(bytes32 h, address owner, string memory raw) internal {
        handles[h] = Handle({
            handleHash: h,
            owner: owner,
            emailDigest: bytes32(0),
            ensRecord: bytes32(0),
            createdAt: uint64(block.timestamp),
            lastActivityAt: uint64(block.timestamp)
        });
        ownerToHandle[owner] = h;
        emit HandleReserved(raw, owner, h);
    }

    /// Case-insensitive uniqueness: lowercase + hash.
    function _normalizeAndHash(string memory handle) internal pure returns (bytes32) {
        bytes memory b = bytes(handle);
        bytes memory out = new bytes(b.length);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            // ASCII A-Z (0x41-0x5A) -> a-z by +0x20.
            if (c >= 0x41 && c <= 0x5A) {
                out[i] = bytes1(uint8(c) + 32);
            } else {
                out[i] = c;
            }
        }
        return keccak256(out);
    }

    /// Only allow a-z A-Z 0-9 plus . - _
    function _isValidChars(string memory handle) internal pure returns (bool) {
        bytes memory b = bytes(handle);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool isAlpha = (c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A);
            bool isDigit = c >= 0x30 && c <= 0x39;
            bool isAllowedPunct = c == 0x2E /* . */ || c == 0x2D /* - */ || c == 0x5F /* _ */;
            if (!isAlpha && !isDigit && !isAllowedPunct) return false;
        }
        return true;
    }
}
