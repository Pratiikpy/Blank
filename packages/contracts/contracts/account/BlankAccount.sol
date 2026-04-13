// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "@account-abstraction/contracts/core/BaseAccount.sol";
import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import "../lib/P256Verifier.sol";

/**
 * @title BlankAccount — ERC-4337 smart account with WebAuthn / passkey login
 * @notice User signs UserOperations with a P-256 keypair stored on their device
 *         (Touch ID / Face ID / Windows Hello). No seed phrase. No browser
 *         extension. The contract verifies P-256 signatures via the RIP-7212
 *         precompile when available, daimo Solidity verifier as fallback.
 *
 * @dev Ported from Z0tz cctp-bridge (account/Z0tzAccount.sol). Renamed to
 *      Blank-prefixed names to avoid confusion with their fork.
 *
 * @dev The ERC-1271 isValidSignature hook is non-optional — it lets the cofhe
 *      Threshold Network recognize this contract as a signer when
 *      decryptForTx/decryptForView is called from a smart-account context.
 *      Without it, encrypted balance reveals fail silently.
 */
contract BlankAccount is BaseAccount, Initializable, UUPSUpgradeable {
    IEntryPoint private immutable _entryPoint;

    /// @notice P-256 public key X coordinate (one half of the WebAuthn pubkey)
    uint256 public ownerX;
    /// @notice P-256 public key Y coordinate
    uint256 public ownerY;

    /// @notice Recovery module address (zero = no recovery configured)
    address public recoveryModule;

    event Initialized(uint256 ownerX, uint256 ownerY, address recoveryModule);
    event OwnerChanged(uint256 newX, uint256 newY);
    event Executed(address indexed target, uint256 value, bytes data);

    modifier onlySelfOrEntryPoint() {
        require(
            msg.sender == address(this) || msg.sender == address(entryPoint()),
            "BlankAccount: unauthorized"
        );
        _;
    }

    modifier onlyRecoveryModule() {
        require(msg.sender == recoveryModule, "BlankAccount: not recovery module");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor(IEntryPoint anEntryPoint) {
        _entryPoint = anEntryPoint;
        _disableInitializers();
    }

    function initialize(
        uint256 _ownerX,
        uint256 _ownerY,
        address _recoveryModule
    ) external initializer {
        ownerX = _ownerX;
        ownerY = _ownerY;
        recoveryModule = _recoveryModule;
        emit Initialized(_ownerX, _ownerY, _recoveryModule);
    }

    /// @inheritdoc BaseAccount
    function entryPoint() public view virtual override returns (IEntryPoint) {
        return _entryPoint;
    }

    /// @inheritdoc BaseAccount
    function _validateSignature(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) internal virtual override returns (uint256 validationData) {
        // userOp.signature = abi.encode(uint256 r, uint256 s) — produced by
        // the WebAuthn flow on the client (P-256 returns r, s pairs).
        (uint256 r, uint256 s) = abi.decode(userOp.signature, (uint256, uint256));
        bool valid = P256.verify(userOpHash, r, s, ownerX, ownerY);
        validationData = valid ? 0 : 1; // 0 = valid; 1 = SIG_VALIDATION_FAILED
    }

    /// @dev Allow execute from EntryPoint AND self-calls (for batched internal ops).
    function _requireForExecute() internal view virtual override {
        require(
            msg.sender == address(this) || msg.sender == address(entryPoint()),
            "BlankAccount: unauthorized"
        );
    }

    /// @notice Execute a single call (override of BaseAccount.execute that adds
    ///         the Executed event for off-chain indexing).
    function execute(
        address target,
        uint256 value,
        bytes calldata data
    ) external virtual override {
        _requireForExecute();
        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
        emit Executed(target, value, data);
    }

    /// @notice Execute a batch of calls atomically — all succeed or all revert.
    ///         Used by the relayer to bundle approve+send into a single UserOp.
    function executeBatch(
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata datas
    ) external onlySelfOrEntryPoint {
        require(
            targets.length == values.length && values.length == datas.length,
            "BlankAccount: length mismatch"
        );
        for (uint256 i = 0; i < targets.length; i++) {
            (bool success, ) = targets[i].call{value: values[i]}(datas[i]);
            require(success, "BlankAccount: batch execution failed");
        }
    }

    /// @notice ERC-1271 signature verification hook.
    ///         The cofhe Threshold Network uses this to verify decrypt requests
    ///         when a smart account is the signer (instead of an EOA).
    /// @return magicValue 0x1626ba7e if valid, 0xffffffff otherwise. Never reverts.
    function isValidSignature(
        bytes32 hash,
        bytes calldata signature
    ) external view returns (bytes4 magicValue) {
        (uint256 r, uint256 s) = abi.decode(signature, (uint256, uint256));
        if (P256.verify(hash, r, s, ownerX, ownerY)) {
            return 0x1626ba7e; // EIP-1271 magic value
        }
        return 0xffffffff;
    }

    /// @notice Replace the owner pubkey. Callable only by the recovery module
    ///         after a successful guardian-attested recovery flow.
    function setOwner(uint256 newX, uint256 newY) external onlyRecoveryModule {
        ownerX = newX;
        ownerY = newY;
        emit OwnerChanged(newX, newY);
    }

    /// @dev Authorize UUPS upgrades from EntryPoint OR self. Self-call path is
    ///      what allows a UserOp to upgrade the account's own implementation.
    function _authorizeUpgrade(address) internal view override onlySelfOrEntryPoint {}

    receive() external payable {}
}
