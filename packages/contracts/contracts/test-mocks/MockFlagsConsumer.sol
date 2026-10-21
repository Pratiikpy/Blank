// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IEncryptedFlagsShared {
    function canSend(address user) external returns (sharedEbool);
    function canReceive(address user) external returns (sharedEbool);
    function calculateFeeVerified(sharedEuint64 amount) external returns (sharedEuint64 fee, sharedEuint64 netAmount);
    function calculateMerchantFeeVerified(sharedEuint64 amount, address merchant)
        external
        returns (sharedEuint64 fee, sharedEuint64 netAmount);
}

/// @dev Test double for a contract that consumes EncryptedFlags results. It
///      takes each shared handle with receive...FromCall, keeps it, and uses it
///      in a further FHE operation, which is what a raw handle could not do.
contract MockFlagsConsumer {
    IEncryptedFlagsShared public immutable flags;

    ebool public sendOk;
    ebool public receiveOk;
    euint64 public fee;
    euint64 public net;
    euint64 public gated;

    constructor(address flags_) {
        flags = IEncryptedFlagsShared(flags_);
    }

    function checkSend(address user) external {
        ebool ok = FHE.receiveEboolFromCall(flags.canSend(user), address(flags));
        FHE.allowThis(ok);
        sendOk = ok;
    }

    function checkReceive(address user) external {
        ebool ok = FHE.receiveEboolFromCall(flags.canReceive(user), address(flags));
        FHE.allowThis(ok);
        receiveOk = ok;
    }

    /// @dev Returns `amount` when `user` may send, 0 otherwise, computed from
    ///      the received handle.
    function gateAmount(address user, uint64 amount) external {
        ebool ok = FHE.receiveEboolFromCall(flags.canSend(user), address(flags));
        euint64 a = FHE.asEuint64(amount);
        euint64 result = FHE.select(ok, a, FHE.asEuint64(0));
        FHE.allowThis(result);
        gated = result;
    }

    function feeFor(uint64 amount) external {
        euint64 a = FHE.asEuint64(amount);
        FHE.allowThis(a);
        (sharedEuint64 f, sharedEuint64 n) = flags.calculateFeeVerified(FHE.shareEuint64(a, address(flags)));
        _keep(f, n);
    }

    function merchantFeeFor(uint64 amount, address merchant) external {
        euint64 a = FHE.asEuint64(amount);
        FHE.allowThis(a);
        (sharedEuint64 f, sharedEuint64 n) =
            flags.calculateMerchantFeeVerified(FHE.shareEuint64(a, address(flags)), merchant);
        _keep(f, n);
    }

    function _keep(sharedEuint64 f, sharedEuint64 n) internal {
        euint64 feeHandle = FHE.receiveEuint64FromCall(f, address(flags));
        euint64 netHandle = FHE.receiveEuint64FromCall(n, address(flags));
        FHE.allowThis(feeHandle);
        FHE.allowThis(netHandle);
        fee = feeHandle;
        net = netHandle;
    }
}
