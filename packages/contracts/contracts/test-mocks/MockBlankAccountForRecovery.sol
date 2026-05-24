// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// Minimal mock of BlankAccount.setOwner for GuardianModule recovery
/// tests. Tracks the last-set pubkey + the caller so tests can assert
/// the rotate-via-guardian path actually reaches the account contract.
///
/// Mirrors the `onlyRecoveryModule` gate of the real BlankAccount, but
/// keeps the recoveryModule address mutable for test setup (the real
/// contract sets it once in initialize + via setRecoveryModule).
contract MockBlankAccountForRecovery {
    uint256 public ownerX;
    uint256 public ownerY;
    address public recoveryModule;
    address public lastCaller;
    uint256 public setOwnerCallCount;

    event OwnerChanged(uint256 newX, uint256 newY);

    function setRecoveryModule(address newModule) external {
        recoveryModule = newModule;
    }

    function setOwner(uint256 newX, uint256 newY) external {
        require(msg.sender == recoveryModule, "Mock: not recovery module");
        ownerX = newX;
        ownerY = newY;
        lastCaller = msg.sender;
        setOwnerCallCount += 1;
        emit OwnerChanged(newX, newY);
    }
}
