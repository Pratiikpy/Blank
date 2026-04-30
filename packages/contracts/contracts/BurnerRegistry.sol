// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title BurnerRegistry — Phase 6.2 durable backup for burner-wallet metadata
/// @notice Per-MAIN-account registry mapping `(owner, burner)` to an opaque
///         encrypted blob. The contract is dumb storage — it does NOT inspect
///         or validate blob contents. Encryption is a client-side concern:
///         the frontend derives a symmetric key from the user's passkey
///         (Phase 6.2 frontend follow-up), AES-encrypts a JSON of
///         `{ label, salt, notes, createdAt }`, and writes the ciphertext
///         here. Anyone can read the ciphertext but only the key holder
///         can decrypt.
///
/// @dev    Storage shape: `mapping(owner => mapping(burner => bytes))`.
///         The outer key is the MAIN account address (msg.sender on writes);
///         the inner key is the burner's deterministic AA address. This way
///         the registry can be queried by anyone for ANY owner — useful for
///         multi-device recovery: a user signing in on a new device with
///         their passkey can re-derive their main address, then iterate the
///         registry's events to recover their burner list.
///
/// @dev    Auth model:
///           • Anyone can READ via `getMetadata(owner, burner)`.
///           • Only the owner can WRITE their own slot (`msg.sender == owner`).
///           • A `clearMetadata(burner)` is provided so a user can purge
///             their own entries (e.g. compromised key, reorg of plans).
///
/// @dev    Gas + storage notes:
///           • Each `setMetadata` write costs ~`SSTORE_GAS * ceil(blob/32)`.
///             Typical burner blob is ~80-120 bytes encrypted (AES-GCM with
///             a 12-byte nonce + ~64 bytes plaintext + 16-byte tag), so
///             ~3-4 storage slots written = ~60k gas. Acceptable for a
///             one-off backup operation.
///           • There's no on-chain enumeration of burners — clients must
///             watch `MetadataSet`/`MetadataCleared` events to reconstruct
///             a list. This avoids unbounded array storage and matches the
///             event-sourced UX Phase 6.1's localStorage-only MVP shipped.
///
/// @dev    NOT upgradeable. The contract is intentionally minimal so a
///         migration would just deploy a v2 and re-publish entries from
///         events. Upgradeability would add storage gaps + admin keys
///         that aren't worth the complexity for ~60 lines of logic.
contract BurnerRegistry {
    // ─── Errors ───────────────────────────────────────────────────────────

    /// @notice Caller tried to write metadata for a burner address of `0`.
    error ZeroBurner();
    /// @notice Caller tried to write an empty blob (use `clearMetadata` instead).
    error EmptyBlob();
    /// @notice Caller tried to clear a slot that was never written.
    error NoMetadata();
    /// @notice Blob exceeds the upper bound. Caps abuse + makes the per-write
    ///         gas cost predictable.
    error BlobTooLarge();

    // ─── Constants ────────────────────────────────────────────────────────

    /// @dev Hard cap on encrypted blob size. AES-GCM of typical metadata
    ///      ({ label, salt, notes, createdAt }) is ~120-200 bytes; this cap
    ///      gives generous headroom for future additions without unbounded
    ///      gas costs. ~32k gas SSTORE per 32-byte slot, so 1024 bytes is
    ///      ~32 slots = ~1M gas worst-case write. Reasonable per-call cost.
    uint256 public constant MAX_BLOB_BYTES = 1024;

    // ─── Storage ──────────────────────────────────────────────────────────

    /// @dev `metadata[owner][burner] = encrypted JSON blob`.
    mapping(address owner => mapping(address burner => bytes)) private metadata;

    // ─── Events ───────────────────────────────────────────────────────────

    /// @notice Emitted whenever an owner writes metadata for a burner.
    /// @dev    Watching this event is how clients enumerate an owner's
    ///         burner set — there's no on-chain array. The blob itself is
    ///         in the event so a fresh device can recover without ever
    ///         reading storage.
    event MetadataSet(
        address indexed owner,
        address indexed burner,
        bytes encryptedBlob,
        uint256 timestamp
    );

    /// @notice Emitted when an owner deletes a burner's metadata slot.
    event MetadataCleared(
        address indexed owner,
        address indexed burner,
        uint256 timestamp
    );

    // ─── Writes ───────────────────────────────────────────────────────────

    /// @notice Publish (or overwrite) the encrypted metadata blob for
    ///         `(msg.sender, burner)`. Caller is treated as the owner.
    /// @dev    The blob is opaque to the contract — encrypt client-side
    ///         with a key derived from the passkey.
    function setMetadata(address burner, bytes calldata encryptedBlob) external {
        if (burner == address(0)) revert ZeroBurner();
        if (encryptedBlob.length == 0) revert EmptyBlob();
        if (encryptedBlob.length > MAX_BLOB_BYTES) revert BlobTooLarge();

        metadata[msg.sender][burner] = encryptedBlob;

        emit MetadataSet(msg.sender, burner, encryptedBlob, block.timestamp);
    }

    /// @notice Delete the metadata slot for `(msg.sender, burner)`.
    /// @dev    Reverts if no metadata is currently set — defensive against
    ///         spurious clears that could waste gas + emit confusing events.
    function clearMetadata(address burner) external {
        if (burner == address(0)) revert ZeroBurner();
        if (metadata[msg.sender][burner].length == 0) revert NoMetadata();

        delete metadata[msg.sender][burner];

        emit MetadataCleared(msg.sender, burner, block.timestamp);
    }

    // ─── Reads ────────────────────────────────────────────────────────────

    /// @notice Read the latest encrypted blob for `(owner, burner)`.
    ///         Returns empty bytes if nothing was ever written or the slot
    ///         was cleared.
    function getMetadata(address owner, address burner)
        external
        view
        returns (bytes memory)
    {
        return metadata[owner][burner];
    }

    /// @notice Convenience view: did `owner` ever publish metadata for
    ///         this burner that hasn't been cleared?
    function hasMetadata(address owner, address burner)
        external
        view
        returns (bool)
    {
        return metadata[owner][burner].length > 0;
    }
}
