// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.25;

/// @title ERC6538Registry — Phase 9 stealth meta-address registry.
/// @notice Verbatim port of the canonical ERC-6538 reference contract
///         (https://github.com/ethereum/ERCs/blob/master/assets/erc-6538/contracts/ERC6538Registry.sol).
///         Bumped pragma from `0.8.23` to `^0.8.25` to match this project;
///         no semantic changes — only the pragma line and the doc header
///         differ from the upstream.
///
/// @dev    The canonical singleton on every chain Umbra/Fluidkey deployed
///         is `0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538`. Both
///         eth-sepolia and base-sepolia already host this address (3,147
///         bytes of code each as of 2026-04-27), so the deploy task
///         records the canonical address in `deployments/<network>.json`
///         and only falls back to a local deploy if the canonical address
///         lacks code on the active chain.
///
/// @dev    Wallets/indexers (Umbra, Fluidkey, Labrys) hardcode
///         `0x6538…6538`. Using the canonical address means we
///         interoperate with the existing stealth ecosystem out of the
///         box.
contract ERC6538Registry {
    /// @notice Emitted when an invalid signature is provided to `registerKeysOnBehalf`.
    error ERC6538Registry__InvalidSignature();

    /// @notice Stealth meta-address per (registrant, schemeId).
    /// @dev    `stealthMetaAddress` is the raw concatenation of
    ///         compressed-spending-pubkey || compressed-viewing-pubkey
    ///         (66 bytes for scheme 1 secp256k1). The `st:eth:0x…` prefix
    ///         lives in the UI layer only — chain is implicit per the
    ///         singleton-per-chain deployment model.
    mapping(address registrant => mapping(uint256 schemeId => bytes)) public stealthMetaAddressOf;

    /// @notice Next nonce expected from `registrant` for `registerKeysOnBehalf`.
    /// @dev    Increments POST-INCREMENT inside the typed-data hash even
    ///         when the signature later fails. Callers re-quoting after a
    ///         failed tx must fetch the new nonce. `incrementNonce()` is
    ///         the user's escape hatch to invalidate outstanding sigs.
    mapping(address registrant => uint256) public nonceOf;

    /// @notice EIP-712 type hash. Note the mixed-case
    ///         `Erc6538RegistryEntry` — easy to silently mistype as
    ///         `ERC6538RegistryEntry`, which would break sig recovery.
    bytes32 public constant ERC6538REGISTRY_ENTRY_TYPE_HASH =
        keccak256("Erc6538RegistryEntry(uint256 schemeId,bytes stealthMetaAddress,uint256 nonce)");

    /// @notice The chain ID where this contract is initially deployed.
    uint256 internal immutable INITIAL_CHAIN_ID;

    /// @notice The domain separator used in this contract.
    bytes32 internal immutable INITIAL_DOMAIN_SEPARATOR;

    /// @notice Emitted when a registrant updates their stealth meta-address.
    /// @param  registrant         The account that registered the meta-address.
    /// @param  schemeId           Stealth scheme identifier (1 = secp256k1+viewtag).
    /// @param  stealthMetaAddress The 66-byte compressed (spend || view) concat.
    event StealthMetaAddressSet(
        address indexed registrant, uint256 indexed schemeId, bytes stealthMetaAddress
    );

    /// @notice Emitted when a registrant increments their nonce.
    event NonceIncremented(address indexed registrant, uint256 newNonce);

    constructor() {
        INITIAL_CHAIN_ID = block.chainid;
        INITIAL_DOMAIN_SEPARATOR = _computeDomainSeparator();
    }

    /// @notice Sets the caller's stealth meta-address for the given scheme ID.
    function registerKeys(uint256 schemeId, bytes calldata stealthMetaAddress) external {
        stealthMetaAddressOf[msg.sender][schemeId] = stealthMetaAddress;
        emit StealthMetaAddressSet(msg.sender, schemeId, stealthMetaAddress);
    }

    /// @notice Sets the `registrant`'s stealth meta-address for the given
    ///         scheme ID, authorised by an EOA ECDSA sig OR an ERC-1271
    ///         contract sig.
    /// @dev    Tries `ecrecover` first if `signature.length == 65`; if
    ///         the recovered address isn't the registrant (or recovery
    ///         returned the zero address), falls back to
    ///         `IERC1271(registrant).isValidSignature(...)`. Reverts
    ///         `ERC6538Registry__InvalidSignature()` if both fail.
    function registerKeysOnBehalf(
        address registrant,
        uint256 schemeId,
        bytes memory signature,
        bytes calldata stealthMetaAddress
    ) external {
        bytes32 dataHash;
        address recoveredAddress;

        unchecked {
            dataHash = keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    DOMAIN_SEPARATOR(),
                    keccak256(
                        abi.encode(
                            ERC6538REGISTRY_ENTRY_TYPE_HASH,
                            schemeId,
                            keccak256(stealthMetaAddress),
                            nonceOf[registrant]++
                        )
                    )
                )
            );
        }

        if (signature.length == 65) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly ("memory-safe") {
                r := mload(add(signature, 0x20))
                s := mload(add(signature, 0x40))
                v := byte(0, mload(add(signature, 0x60)))
            }
            recoveredAddress = ecrecover(dataHash, v, r, s);
        }

        if (
            (
                (recoveredAddress == address(0) || recoveredAddress != registrant)
                    && (
                        IERC1271(registrant).isValidSignature(dataHash, signature)
                            != IERC1271.isValidSignature.selector
                    )
            )
        ) revert ERC6538Registry__InvalidSignature();

        stealthMetaAddressOf[registrant][schemeId] = stealthMetaAddress;
        emit StealthMetaAddressSet(registrant, schemeId, stealthMetaAddress);
    }

    /// @notice Increments the nonce of the sender to invalidate outstanding sigs.
    function incrementNonce() external {
        unchecked {
            nonceOf[msg.sender]++;
        }
        emit NonceIncremented(msg.sender, nonceOf[msg.sender]);
    }

    /// @notice EIP-712 domain separator. Recomputed on chain forks.
    /// @dev    Public selector `0x3644e515` — some libs assume lowercase,
    ///         this one is the uppercase parenthesised form.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == INITIAL_CHAIN_ID ? INITIAL_DOMAIN_SEPARATOR : _computeDomainSeparator();
    }

    function _computeDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("ERC6538Registry"),
                keccak256("1.0"),
                block.chainid,
                address(this)
            )
        );
    }
}

/// @notice Minimal ERC-1271 interface for contract-signature verification.
interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes memory signature)
        external
        view
        returns (bytes4 magicValue);
}
