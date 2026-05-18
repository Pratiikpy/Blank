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
/// @dev Phase 4.1 — minimal validator interface BlankAccount dispatches to
///      when userOp.signature carries the non-legacy format. The validator
///      verifies its own signature scheme + scope and returns packed
///      validationData (per ERC-4337 v0.8 BaseAccount semantics).
interface IBlankValidator {
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) external returns (uint256);
}

contract BlankAccount is BaseAccount, Initializable, UUPSUpgradeable {
    IEntryPoint private immutable _entryPoint;

    // ─── Storage layout (DO NOT REORDER) ──────────────────────────────────
    // slot 0: ownerX
    // slot 1: ownerY
    // slot 2: recoveryModule
    // slot 3: enabledValidators                       ← Phase 4.1 append
    //
    // Append-only storage layout per UUPS upgrade rules. The
    // `check-storage-layout` hardhat task verifies this on every CI run.
    // Existing user proxies preserve slots 0-2 verbatim through the
    // upgradeToAndCall(newImpl) flow; slot 3 starts as default-zero
    // (no validators enabled) which is the correct fresh state.

    /// @notice P-256 public key X coordinate (one half of the WebAuthn pubkey)
    uint256 public ownerX;
    /// @notice P-256 public key Y coordinate
    uint256 public ownerY;

    /// @notice Recovery module address (zero = no recovery configured)
    address public recoveryModule;

    /// @notice Phase 4.1 — set of authorized IValidator modules. The
    ///         session-key dispatch in `_validateSignature` calls one of
    ///         these when userOp.signature uses the validator format
    ///         (anything non-64-byte). Toggled via `enableValidator` /
    ///         `disableValidator`, both `onlySelfOrEntryPoint` so only the
    ///         account itself can authorize validators (no external EOA
    ///         can sneak in a malicious one).
    mapping(address validator => bool enabled) public enabledValidators;

    event Initialized(uint256 ownerX, uint256 ownerY, address recoveryModule);
    event OwnerChanged(uint256 newX, uint256 newY);
    event Executed(address indexed target, uint256 value, bytes data);
    event ValidatorEnabled(address indexed validator);
    event ValidatorDisabled(address indexed validator);

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
    /// @dev Phase 4.1 — length-discriminated dispatch:
    ///        • 64 bytes  → legacy P-256 path: `abi.encode(r, s)` from the
    ///                      WebAuthn flow. Backwards-compatible with every
    ///                      pre-upgrade client.
    ///        • else      → validator dispatch: `abi.encode(address validator,
    ///                      bytes innerSig)`. The account checks the validator
    ///                      is enabled, then forwards the userOp (with sig
    ///                      replaced by `innerSig`) to the validator's
    ///                      `validateUserOp`. The validator returns packed
    ///                      validationData that the EntryPoint enforces
    ///                      natively (validUntil / validAfter for frequency
    ///                      caps, etc).
    ///
    /// @dev `abi.encode(r, s)` is exactly 64 bytes (two uint256 values), and
    ///      `abi.encode(address, bytes)` is at minimum 96 bytes (32 address
    ///      + 32 offset + 32 length, plus the bytes payload). The two
    ///      formats are unambiguously discriminated by length.
    function _validateSignature(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) internal virtual override returns (uint256 validationData) {
        if (userOp.signature.length == 64) {
            // Legacy P-256 path — unchanged behavior, preserves
            // backwards compat with pre-upgrade client signatures.
            (uint256 r, uint256 s) = abi.decode(userOp.signature, (uint256, uint256));
            return P256.verify(userOpHash, r, s, ownerX, ownerY) ? 0 : 1;
        }

        // Validator-dispatch path. We decode the outer wrapper and forward
        // the inner-sig-bearing userOp to the validator. Decode reverts on
        // malformed input — that lands in BaseAccount.validateUserOp's outer
        // try/catch as SIG_VALIDATION_FAILED, which is the right behavior:
        // a malformed sig should never authorize anything.
        (address validator, bytes memory innerSig) = abi.decode(
            userOp.signature,
            (address, bytes)
        );
        if (validator == address(0) || !enabledValidators[validator]) {
            return 1; // SIG_VALIDATION_FAILED — validator not authorized
        }

        // Build a shim userOp with sig replaced by innerSig so the
        // validator decodes its own format from `userOp.signature`. We
        // copy each field — bytes calldata fields auto-convert to bytes
        // memory at the assignment boundary. Cost is bounded by userOp
        // size (typical ~500 bytes).
        PackedUserOperation memory shim = PackedUserOperation({
            sender: userOp.sender,
            nonce: userOp.nonce,
            initCode: userOp.initCode,
            callData: userOp.callData,
            accountGasLimits: userOp.accountGasLimits,
            preVerificationGas: userOp.preVerificationGas,
            gasFees: userOp.gasFees,
            paymasterAndData: userOp.paymasterAndData,
            signature: innerSig
        });
        return IBlankValidator(validator).validateUserOp(shim, userOpHash);
    }

    /// @notice Phase 4.1 — authorize a validator module. The session-key
    ///         dispatch in `_validateSignature` consults this map.
    ///         `onlySelfOrEntryPoint` means the user must sign a UserOp
    ///         (with their P-256 passkey) calling this — no external EOA
    ///         can install a validator.
    function enableValidator(address validator) external onlySelfOrEntryPoint {
        require(validator != address(0), "BlankAccount: zero validator");
        enabledValidators[validator] = true;
        emit ValidatorEnabled(validator);
    }

    /// @notice Phase 4.1 — revoke a previously-authorized validator. After
    ///         this, any UserOp using the validator-dispatch format with
    ///         this validator address fails with SIG_VALIDATION_FAILED.
    function disableValidator(address validator) external onlySelfOrEntryPoint {
        enabledValidators[validator] = false;
        emit ValidatorDisabled(validator);
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
            // Mirror single-call execute() which emits Executed at line 211.
            // Without this, off-chain indexers tracking Executed miss every
            // call bundled via executeBatch — the relayer's approve+send
            // bundle path is exactly that.
            emit Executed(targets[i], values[i], datas[i]);
        }
    }

    /// @notice ERC-1271 signature verification hook.
    ///         The cofhe Threshold Network uses this to verify decrypt requests
    ///         when a smart account is the signer (instead of an EOA).
    /// @return magicValue 0x1626ba7e if valid, 0xffffffff otherwise.
    ///         Never reverts — ERC-1271 requires consumers to be able to
    ///         distinguish "invalid" from "errored" by inspecting the
    ///         return value, so we fail closed (return 0xffffffff) on
    ///         every malformed-input case rather than letting abi.decode
    ///         bubble a revert.
    function isValidSignature(
        bytes32 hash,
        bytes calldata signature
    ) external view returns (bytes4 magicValue) {
        // P-256 (r, s) is two uint256 fields packed via abi.encode = exactly
        // 64 bytes. Any other length is malformed.
        if (signature.length != 64) return 0xffffffff;
        // bytes-level read is safe at this length; sidesteps abi.decode's
        // own implicit revert on truncated/oversized input.
        uint256 r;
        uint256 s;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
        }
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

    /// @notice Auto-deposit incoming ETH to the EntryPoint as gas credit for
    ///         this account. Allows users to fund their own gas by sending
    ///         ETH to this address from ANYWHERE (a CEX withdrawal, a
    ///         primary EOA, a hardware wallet, a friend). Without this hook
    ///         a plain ETH transfer would land as idle balance that the
    ///         EntryPoint can't see — the user would then need a separate
    ///         "convert to gas" UserOp.
    /// @dev Skip the deposit when the EntryPoint is the sender: canonical
    ///      v0.8 EntryPoint refunds excess prefund via its internal deposit
    ///      map (no plain transfer), but a non-canonical or future-version
    ///      EntryPoint might refund via plain transfer and would loop
    ///      otherwise. Cost: one CALLER + EQ check (~22 gas).
    /// @dev The depositTo call is allowed to revert (e.g., EntryPoint OOG):
    ///      the ETH then sits as idle balance and can be deposited later
    ///      via `topUpGas`. This guarantees that incoming ETH is never
    ///      lost just because the auto-deposit failed.
    receive() external payable {
        if (msg.value > 0 && msg.sender != address(_entryPoint)) {
            try _entryPoint.depositTo{value: msg.value}(address(this)) {
                // Auto-deposit succeeded — emitted by EntryPoint itself.
            } catch {
                // Auto-deposit failed — ETH stays as idle balance.
                // User can call topUpGas to retry without losing the ETH.
            }
        }
    }

    /// @notice Manual fallback: deposit any idle ETH on this account into
    ///         the EntryPoint as gas credit. Used when the auto-deposit in
    ///         `receive()` couldn't run (e.g., ETH arrived via SELFDESTRUCT
    ///         or a contract `call`-with-value path that bypasses receive),
    ///         or when the auto-deposit reverted. Permissionless: anyone can
    ///         credit gas to this account, no auth gate. The deposited
    ///         amount is always tracked against this account's address, so
    ///         a third party calling this only ever benefits the owner.
    function topUpGas() external {
        uint256 idle = address(this).balance;
        if (idle > 0) {
            _entryPoint.depositTo{value: idle}(address(this));
        }
    }

    /// @notice Withdraw EntryPoint gas-deposit balance to an arbitrary address.
    ///         Gated to self-or-EntryPoint so only the account owner (via a
    ///         passkey-signed UserOp) can pull their own gas funds out.
    /// @param  to     Recipient address. Anywhere — back to the owner's EOA,
    ///                a CEX deposit address, another wallet.
    /// @param  amount Wei to withdraw. Capped by EntryPoint at the account's
    ///                current deposit balance.
    function withdrawGasDepositTo(
        address payable to,
        uint256 amount
    ) external onlySelfOrEntryPoint {
        _entryPoint.withdrawTo(to, amount);
    }
}
