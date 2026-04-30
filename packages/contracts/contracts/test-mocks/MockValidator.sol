// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";

/// @notice Test-only IBlankValidator that returns a configurable
///         validationData. Used by BlankAccountValidator.test.ts to
///         exercise the dispatch logic in `BlankAccount._validateSignature`
///         without bringing in the full SessionKeyValidator scope-parse
///         + ECDSA-verify surface.
contract MockValidator {
    uint256 public nextReturn;
    /// @dev Captures the last call so tests can assert on the forwarded
    ///      userOp shape (especially that `signature` was replaced with
    ///      the inner sig, not the outer wrapper).
    bytes public lastSignatureSeen;
    bytes32 public lastHashSeen;
    address public lastSenderSeen;

    function setNextReturn(uint256 v) external {
        nextReturn = v;
    }

    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) external returns (uint256) {
        lastSignatureSeen = userOp.signature;
        lastHashSeen = userOpHash;
        lastSenderSeen = userOp.sender;
        return nextReturn;
    }
}
