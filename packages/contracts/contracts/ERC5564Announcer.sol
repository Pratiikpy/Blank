// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.25;

/// @title ERC5564Announcer — Phase 9 stealth meta-address announcer
/// @notice Verbatim port of the canonical ERC-5564 reference contract
///         (https://github.com/ethereum/ERCs/blob/master/assets/erc-5564/contracts/ERC5564Announcer.sol).
///         Emits `Announcement` events that recipients scan with their
///         viewing key to discover incoming stealth payments.
///
/// @dev    The contract holds NO STATE. It's a public bulletin board:
///         anyone can publish that they sent funds to a stealth
///         address; only the recipient (with the viewing key matching
///         the stealth meta-address) can detect and sweep them.
///
/// @dev    Scheme IDs:
///           1 = secp256k1 with view tag (the only scheme defined in
///               the EIP today; matches the lib in `packages/app/src/
///               lib/stealth.ts`).
///         New schemes can be added without touching this contract —
///         scheme registry lives off-chain in EIP-5564 itself.
///
/// @dev    Singleton: deployed at the deterministic CREATE2 address
///         `0x55649E01B5Df198D18D95b5cc5051630cfD45564` on every chain
///         that has run the Arachnid CREATE2 deployer with the canonical
///         salt `0xd0103a290d760f027c9ca72675f5121d725397fb2f618f05b6c44958b25b4447`.
///         If that address has no code on the active testnet, the
///         deploy task in `tasks/deploy-erc5564-announcer.ts` falls
///         back to a regular non-deterministic deploy and writes the
///         resulting address to `deployments/<network>.json`.
///
/// @dev    The `caller` field is `msg.sender`, indexed so recipients
///         can filter by sender (e.g. "all stealth payments from my
///         employer"). NOT a privacy leak — the EIP design intentionally
///         leaves the sender visible since hiding both ends defeats
///         basic auditability needs (tax reports, etc.).
///
/// @dev    `metadata` layout per EIP-5564 §"Announcement metadata":
///           byte 0     = view tag (first byte of keccak256(shared_secret))
///           bytes 1-4  = function selector (or 0xeeeeeeee for native ETH)
///           bytes 5-24 = token address (20 bytes)
///           bytes 25-56 = amount or tokenId (32 bytes)
///         Caller-supplied; this contract doesn't validate.
contract ERC5564Announcer {
    /// @notice Announce that a stealth payment landed at `stealthAddress`.
    /// @param  schemeId        Identifier of the stealth-address scheme (1 = secp256k1+viewtag).
    /// @param  stealthAddress  The one-time-use Ethereum address derived
    ///                         from the recipient's meta-address + the
    ///                         caller's ephemeral key.
    /// @param  ephemeralPubKey Caller's ephemeral pubkey (compressed
    ///                         secp256k1, 33 bytes for scheme 1). Recipient
    ///                         needs this to compute their side of the ECDH.
    /// @param  metadata        Per scheme. For scheme 1 the first byte is
    ///                         the view tag — recipient checks that byte
    ///                         before doing the (more expensive) full
    ///                         ECDH + point-add to determine if it's theirs.
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    /// @notice Publish an Announcement. Anyone can call.
    function announce(
        uint256 schemeId,
        address stealthAddress,
        bytes calldata ephemeralPubKey,
        bytes calldata metadata
    ) external {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}
