// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/**
 * @dev ReentrancyGuard compatible with UUPS proxies.
 * Uses a storage variable (not transient storage) for maximum compatibility.
 * The _status variable is initialized to 1 (NOT_ENTERED) by default in Solidity,
 * so no explicit initializer is needed — uninitialized storage reads as 0,
 * but we use 1/2 pattern where 1 = not entered.
 *
 * For proxy contracts: storage slot is shared between implementation and proxy.
 * Since _status defaults to 0 on proxy, we treat 0 AND 1 as "not entered":
 * only status == 2 means "entered".
 */
abstract contract ReentrancyGuard {
    uint256 private _status;

    error ReentrancyGuardReentrantCall();

    modifier nonReentrant() {
        if (_status == 2) revert ReentrancyGuardReentrantCall();
        _status = 2;
        _;
        _status = 1;
    }
}
