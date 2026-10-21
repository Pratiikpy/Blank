// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @dev Test double for PaymentReceipts. Takes each shared handle the way the
///      real contract does and counts the calls, so a test can tell a settled
///      sale from a voided one without reading encrypted counters.
contract MockReceiptsSpy {
    uint256 public userBumps;
    uint256 public globalBumps;

    function bumpUserReceived(address, sharedEuint64 shared) external {
        FHE.receiveEuint64Param(shared);
        userBumps++;
    }

    function bumpGlobal(sharedEuint64 shared) external {
        FHE.receiveEuint64Param(shared);
        globalBumps++;
    }
}
