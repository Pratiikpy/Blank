// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// @title BurnerRegistry: durable encrypted backup of burner-wallet metadata
/// @notice Per-account store of opaque encrypted blobs, each under an opaque
///         32-byte tag. The contract never sees a burner address.
///
/// @dev    Privacy model. v1 keyed records by (owner, burner) and emitted both
///         as indexed topics, publishing the main-to-burner link to anyone
///         and defeating the point of a burner. v2 keys records by
///         (owner, tag). The client derives `tag` from secret material only
///         it holds (for example HMAC(backupKey, burnerId)), and the burner
///         address lives only inside the encrypted blob. Observers learn that
///         `owner` keeps N backups and when they change, not which burners
///         they belong to.
///
///         What stays public: the writer address. Writes come from the main
///         account (that is how recovery finds them), so "this account has
///         backups" is visible. This is inherent to an on-chain backup keyed
///         by the account.
///
///         Recovery: filter BackupSet / BackupCleared by `owner`, keep the
///         latest event per tag, decrypt each blob.
///
/// @dev    NOT upgradeable. Redeploy to change; v1 deployments still hold
///         their old (linkable) events and should be retired.
contract BurnerRegistry {
    error ZeroTag();
    error EmptyBlob();
    error NoMetadata();
    error BlobTooLarge();

    /// @dev Cap keeps per-write gas predictable.
    uint256 public constant MAX_BLOB_BYTES = 1024;

    mapping(address owner => mapping(bytes32 tag => bytes)) private metadata;

    /// @notice Emitted on every write. The blob is in the event so a fresh
    ///         device can recover from logs alone.
    event BackupSet(address indexed owner, bytes32 indexed tag, bytes encryptedBlob, uint256 timestamp);

    event BackupCleared(address indexed owner, bytes32 indexed tag, uint256 timestamp);

    /// @notice Publish (or overwrite) the blob for `(msg.sender, tag)`.
    function setMetadata(bytes32 tag, bytes calldata encryptedBlob) external {
        if (tag == bytes32(0)) revert ZeroTag();
        if (encryptedBlob.length == 0) revert EmptyBlob();
        if (encryptedBlob.length > MAX_BLOB_BYTES) revert BlobTooLarge();

        metadata[msg.sender][tag] = encryptedBlob;

        emit BackupSet(msg.sender, tag, encryptedBlob, block.timestamp);
    }

    /// @notice Delete the blob for `(msg.sender, tag)`.
    function clearMetadata(bytes32 tag) external {
        if (tag == bytes32(0)) revert ZeroTag();
        if (metadata[msg.sender][tag].length == 0) revert NoMetadata();

        delete metadata[msg.sender][tag];

        emit BackupCleared(msg.sender, tag, block.timestamp);
    }

    function getMetadata(address owner, bytes32 tag) external view returns (bytes memory) {
        return metadata[owner][tag];
    }

    function hasMetadata(address owner, bytes32 tag) external view returns (bool) {
        return metadata[owner][tag].length > 0;
    }
}
