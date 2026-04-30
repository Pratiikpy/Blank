// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {_packValidationData, SIG_VALIDATION_FAILED} from "@account-abstraction/contracts/core/Helpers.sol";

/// @title SessionKeyValidator — Phase 4.1 core
/// @notice Authorizes a separate ECDSA "session key" to sign UserOps from a
///         BlankAccount, but ONLY within a tight scope: a fixed recipient,
///         a max amount per call, a minimum interval between fires, and a
///         hard expiry. Use cases: rent autopay, monthly payroll, scheduled
///         gifts. The session key is held by a server (Vercel cron) so
///         transfers can fire on schedule without the user being online.
///
/// @dev Integration is a TWO-STEP process:
///
///   1. **BlankAccount UUPS upgrade** (separate piece of work) introduces a
///      1-byte signature mode prefix:
///        • 0x00 → legacy P-256 path (existing behaviour)
///        • 0x01 → session-key path: signature decodes to
///                 `abi.encodePacked(uint8(1), address validator, bytes innerSig)`,
///                 and BlankAccount delegates to
///                 `IValidator(validator).validateUserOp(userOp, userOpHash)`.
///   2. **This validator** is then `setScope`'d once by the user (a P-256-signed
///      UserOp) per (sessionKey, recipient) pair. The session key can fire
///      transfers thereafter, gated by this contract's scope checks.
///
/// @dev DESIGN NOTES — please read before changing:
///
///   • **Account-associated storage.** ERC-7562 forbids state writes during
///     `validateUserOp` UNLESS the storage slot is keyed by `msg.sender` (the
///     account). Our `scopes` mapping is `mapping(account → mapping(sessionKey
///     → Scope))`, keyed first by the account, so writes are bundler-legal.
///
///   • **No `block.timestamp` in `validateUserOp`.** Same ERC-7562 rule. We
///     pack `validAfter = lastFiredAt + periodSeconds` into the validation
///     return value; the EntryPoint enforces it pre-execution natively. We
///     never read `block.timestamp` ourselves.
///
///   • **State writes during validation are "burn the period on revert".**
///     We update `lastFiredAt` inside `validateUserOp`. If the execution
///     phase later reverts (e.g. insufficient USDC), the bump persists and
///     the session key is locked out until next period. This matches
///     ZeroDev's WeightedECDSAValidator pattern. Future work could move the
///     bump into a post-execute hook for waste-free retries; flagged in the
///     follow-up task list.
///
///   • **Selector whitelist.** Session keys may ONLY invoke
///     `BlankAccount.execute(address,uint256,bytes)`. `executeBatch` is
///     forbidden (could fan out to N transfers, breaking per-call cap).
///     Self-calls back into the AA (e.g. `setOwner`, `_authorizeUpgrade`,
///     enabling another validator) are forbidden by the explicit
///     `target != msg.sender` check.
///
///   • **ERC-20 surface.** Inner data MUST be `IERC20.transfer(address,uint256)`.
///     `transferFrom` and `approve` are rejected — both can leak funds
///     beyond the scope. Plain ETH transfers are also supported (zero
///     `spendToken`, target == recipient, empty inner data).
///
///   • **FHE encrypted transfers OUT OF SCOPE for this MVP.** The validator
///     can't decrypt amounts to enforce $-denominated caps. Plaintext-only.
contract SessionKeyValidator {
    using ECDSA for bytes32;

    // ─── Constants ────────────────────────────────────────────────────────

    /// @dev BlankAccount.execute(address,uint256,bytes)
    bytes4 private constant SELECTOR_EXECUTE = 0xb61d27f6;

    /// @dev IERC20.transfer(address,uint256)
    bytes4 private constant SELECTOR_ERC20_TRANSFER = 0xa9059cbb;

    // ─── Types ────────────────────────────────────────────────────────────

    struct Scope {
        /// @dev Hardcoded recipient. The session key can ONLY fire transfers
        ///      to this address. address(0) marks the slot unset (lookup miss).
        address recipient;
        /// @dev address(0) for native-ETH transfers. Else the ERC-20 token
        ///      address whose `transfer(recipient, amount)` is allowed.
        address spendToken;
        /// @dev Hard ceiling on a single call's transferred amount, in the
        ///      token's smallest unit (wei for ETH, 6-dec base for USDC).
        ///      uint128 fits up to ~3.4 × 10^20 USDC ($3 × 10^14) — plenty.
        uint128 maxAmountPerCall;
        /// @dev Minimum seconds between successful fires. EntryPoint enforces
        ///      via `validAfter` so the next call REVERTS at the EntryPoint
        ///      before reaching this contract.
        uint48 periodSeconds;
        /// @dev Hard expiry of the entire authorization (uint48 — Unix
        ///      seconds, fits well past year 8919245). Returned as
        ///      `validUntil` in the validation data.
        uint48 validUntil;
        /// @dev Last successful fire timestamp. Updated during validation
        ///      phase (account-associated storage, ERC-7562-legal).
        uint48 lastFiredAt;
    }

    // ─── Storage ──────────────────────────────────────────────────────────

    /// @dev `scopes[account][sessionKey]`. Keyed first by `account` so writes
    ///      from `validateUserOp` are bundler-legal account-associated storage
    ///      (ERC-7562 §STO-021). DO NOT reorder this mapping's keys.
    mapping(address account => mapping(address sessionKey => Scope)) private scopes;

    // ─── Events ───────────────────────────────────────────────────────────

    event ScopeSet(
        address indexed account,
        address indexed sessionKey,
        address indexed recipient,
        address spendToken,
        uint128 maxAmountPerCall,
        uint48 periodSeconds,
        uint48 validUntil
    );

    event ScopeRevoked(address indexed account, address indexed sessionKey);

    event SessionFired(
        address indexed account,
        address indexed sessionKey,
        address indexed recipient,
        address spendToken,
        uint256 amount,
        uint48 firedAt
    );

    // ─── Errors ───────────────────────────────────────────────────────────

    error ZeroSessionKey();
    error ZeroRecipient();
    error ZeroPeriod();
    error ZeroMaxAmount();
    error InvalidValidUntil();
    error ScopeNotFound();
    error AlreadyExpired();
    error InvalidSignatureLength();
    error BadSelector();
    error TargetNotRecipient();
    error TargetIsAccount();
    error AmountOverCap();
    error UnsupportedInnerSelector();
    error InvalidInnerCalldata();
    error InvalidEthCalldata();

    // ─── Scope management ────────────────────────────────────────────────

    /// @notice Authorize a session key with a specific scope. MUST be called
    ///         BY the account itself (i.e. via a P-256-signed UserOp from the
    ///         user's BlankAccount). `msg.sender` is treated as the account.
    /// @dev    Overwrites any existing scope for the same `(account, sessionKey)`
    ///         pair, including `lastFiredAt`. Re-authorizing the same session
    ///         key thus resets the frequency counter — explicit user choice.
    function setScope(address sessionKey, Scope calldata scope) external {
        if (sessionKey == address(0)) revert ZeroSessionKey();
        if (scope.recipient == address(0)) revert ZeroRecipient();
        if (scope.periodSeconds == 0) revert ZeroPeriod();
        if (scope.maxAmountPerCall == 0) revert ZeroMaxAmount();
        if (scope.validUntil == 0) revert InvalidValidUntil();
        // Note: we deliberately don't check `validUntil > block.timestamp` here
        // because `setScope` is NOT in the bundler-rules-restricted validation
        // phase (it's a regular tx call), but we keep the check off anyway so
        // a UserOp can pre-load a future-dated scope.

        // Anchor `lastFiredAt` to `block.timestamp - periodSeconds` so the
        // FIRST fire's `validAfter == block.timestamp` (allowed immediately)
        // and every subsequent fire's `validAfter` advances by exactly one
        // period from a real wall-clock anchor. Without this, using `0` as
        // sentinel meant the second fire's `validAfter = 1 + period` which
        // is a 1970 timestamp, so the EntryPoint's `block.timestamp >=
        // validAfter` check trivially passed and the period cap was bypassed
        // until cumulative N×period caught up to wall clock — found in audit
        // 2026-04-27.  setScope runs in a regular tx (NOT in bundler-rules-
        // restricted validation), so reading `block.timestamp` here is fine.
        uint48 nowTs = uint48(block.timestamp);
        uint48 anchor = nowTs >= scope.periodSeconds ? nowTs - scope.periodSeconds : 0;
        scopes[msg.sender][sessionKey] = Scope({
            recipient: scope.recipient,
            spendToken: scope.spendToken,
            maxAmountPerCall: scope.maxAmountPerCall,
            periodSeconds: scope.periodSeconds,
            validUntil: scope.validUntil,
            lastFiredAt: anchor
        });

        emit ScopeSet(
            msg.sender,
            sessionKey,
            scope.recipient,
            scope.spendToken,
            scope.maxAmountPerCall,
            scope.periodSeconds,
            scope.validUntil
        );
    }

    /// @notice Revoke a session key's authorization. Called by the account.
    function revokeScope(address sessionKey) external {
        Scope storage s = scopes[msg.sender][sessionKey];
        if (s.recipient == address(0)) revert ScopeNotFound();
        delete scopes[msg.sender][sessionKey];
        emit ScopeRevoked(msg.sender, sessionKey);
    }

    /// @notice Public read for off-chain UIs (ScheduledSends screen).
    function getScope(address account, address sessionKey)
        external
        view
        returns (Scope memory)
    {
        return scopes[account][sessionKey];
    }

    /// @notice Convenience: did this account install ANY scope for this key?
    function isInitialized(address account, address sessionKey) external view returns (bool) {
        return scopes[account][sessionKey].recipient != address(0);
    }

    // ─── ERC-4337 validation surface ──────────────────────────────────────

    /// @notice IValidator-style entrypoint. Called by the BlankAccount's
    ///         `_validateSignature` after it routes session-mode signatures
    ///         to this validator.
    /// @dev    `msg.sender` MUST be the account whose scope is being checked.
    ///         The integrating BlankAccount upgrade enforces this by calling
    ///         this function only from inside its own `_validateSignature`,
    ///         which itself runs only when invoked by the EntryPoint.
    /// @return validationData Packed (sigFailed, validUntil, validAfter)
    ///         per `_packValidationData`. The EntryPoint uses `validAfter`
    ///         to enforce frequency natively; this contract NEVER reads
    ///         `block.timestamp` itself (ERC-7562 forbids it).
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash)
        external
        returns (uint256 validationData)
    {
        // ── 1. Decode the inner signature blob ──────────────────────────
        // Format: abi.encode(address sessionKey, bytes ecdsaSig)
        if (userOp.signature.length < 96) {
            // Minimum ABI-encoded length for (address, bytes) with empty
            // bytes is 96 (32 + 32 offset + 32 length). Reject early.
            return SIG_VALIDATION_FAILED;
        }
        (address sessionKey, bytes memory innerSig) = abi.decode(
            userOp.signature,
            (address, bytes)
        );
        if (sessionKey == address(0)) return SIG_VALIDATION_FAILED;
        if (innerSig.length != 65) revert InvalidSignatureLength();

        // ── 2. Recover signer & match ───────────────────────────────────
        // OZ's ECDSA.recover rejects high-s and zero-r/zero-s; no malleability.
        address recovered = userOpHash.recover(innerSig);
        if (recovered != sessionKey) return SIG_VALIDATION_FAILED;

        // ── 3. Look up scope ────────────────────────────────────────────
        Scope storage scope = scopes[msg.sender][sessionKey];
        if (scope.recipient == address(0)) revert ScopeNotFound();

        // ── 4. Parse the AA's callData strictly ─────────────────────────
        bytes calldata cd = userOp.callData;
        if (cd.length < 4) revert BadSelector();
        if (bytes4(cd[0:4]) != SELECTOR_EXECUTE) revert BadSelector();

        // BlankAccount.execute(address target, uint256 value, bytes data)
        (address target, uint256 value, bytes memory innerData) = abi.decode(
            cd[4:],
            (address, uint256, bytes)
        );

        // Target MUST be the scoped recipient (ETH path) or the scoped token
        // (ERC-20 path). Self-calls into the AA are explicitly banned —
        // would otherwise let a session key call setOwner / upgrade / etc.
        if (target == msg.sender) revert TargetIsAccount();

        // ── 5. Token-specific validation ────────────────────────────────
        uint256 spent;
        if (scope.spendToken == address(0)) {
            // Native ETH: target must be recipient, no inner calldata, value carries amount.
            if (target != scope.recipient) revert TargetNotRecipient();
            if (innerData.length != 0) revert InvalidEthCalldata();
            spent = value;
        } else {
            // ERC-20: target must be the token, value must be 0, inner data
            // must be transfer(recipient, amount).
            if (target != scope.spendToken) revert TargetNotRecipient();
            if (value != 0) revert InvalidInnerCalldata();
            if (innerData.length != 4 + 32 + 32) revert InvalidInnerCalldata();
            bytes4 innerSelector;
            assembly {
                // innerData is `bytes memory`: first 32 bytes = length, then payload.
                innerSelector := mload(add(innerData, 32))
            }
            if (innerSelector != SELECTOR_ERC20_TRANSFER) revert UnsupportedInnerSelector();
            // Decode amount + verify recipient.
            (address transferTo, uint256 amount) = abi.decode(
                _slice32_64(innerData),
                (address, uint256)
            );
            if (transferTo != scope.recipient) revert TargetNotRecipient();
            spent = amount;
        }
        if (spent > scope.maxAmountPerCall) revert AmountOverCap();

        // ── 6. Compute validAfter from stored lastFiredAt ───────────────
        // `lastFiredAt` is anchored to a real wall-clock value at setScope
        // (= setupTime - period), so `lastFiredAt + period` is always a
        // meaningful Unix timestamp. EntryPoint enforces it pre-execution.
        // Use uint256 math to detect uint48 overflow before assigning.
        uint256 candidateNext = uint256(scope.lastFiredAt) + uint256(scope.periodSeconds);
        // Cap at validUntil so a long-lived authorization doesn't overflow
        // uint48 (~year 8.9M); also gives EntryPoint a clean "expired"
        // signal when the next fire would land past authorization end.
        uint48 nextAllowedAt = candidateNext > uint256(scope.validUntil)
            ? scope.validUntil
            : uint48(candidateNext);

        // Bump `lastFiredAt` to the new boundary. ERC-7562-legal because
        // the slot is account-associated (keyed by msg.sender). Trade-off:
        // if execution phase reverts, the period is "burned" — same as
        // ZeroDev's WeightedECDSAValidator pattern.
        scope.lastFiredAt = nextAllowedAt;

        emit SessionFired(msg.sender, sessionKey, scope.recipient, scope.spendToken, spent, nextAllowedAt);

        // ── 7. Pack and return ──────────────────────────────────────────
        // sigFailed = false (we got here ⇒ sig matched session key);
        // validUntil = scope.validUntil (hard expiry of authorization);
        // validAfter = nextAllowedAt (frequency cap, EntryPoint enforces).
        return _packValidationData(false, scope.validUntil, nextAllowedAt);
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    /// @dev Slice [4:] of a `bytes memory` payload (skip the 4-byte selector).
    ///      Used to decode `transfer(address,uint256)` arguments after the
    ///      selector. Returns a NEW `bytes memory` (32+32 bytes of args).
    function _slice32_64(bytes memory data) private pure returns (bytes memory out) {
        require(data.length >= 4 + 32 + 32, "slice");
        out = new bytes(64);
        for (uint256 i = 0; i < 64; i++) {
            out[i] = data[4 + i];
        }
    }
}
