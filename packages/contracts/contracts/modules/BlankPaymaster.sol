// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@account-abstraction/contracts/core/BasePaymaster.sol";
import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title BlankPaymaster — ERC-4337 paymaster sponsoring gas in exchange for
 *                         token fees (default 1% of the transferred amount).
 *
 * @dev Ported from Z0tz cctp-bridge (modules/Z0tzPaymaster.sol). Renamed and
 *      adapted to Blank's contract surface — same security model, same
 *      whitelisting pattern.
 *
 * Security model:
 *  - Only sponsors accounts deployed by the approved BlankAccountFactory
 *  - Only sponsors execute() calls to whitelisted target contracts (Blank's
 *    own hubs/vault/etc.) — prevents griefers from draining the paymaster
 *    by aiming UserOps at arbitrary contracts.
 *  - Optional per-account whitelist on top of the above (rate-limit / KYC).
 *
 * Fee model:
 *  - feeRateBps basis points (default 100 = 1%) of the transferAmount in
 *    paymasterAndData. Capped at maxFeeCap to prevent gas-price spikes
 *    from accidentally taking large fees.
 *  - Fees collected to `treasury` in `feeToken` (e.g. TestUSDC on Sepolia).
 */
contract BlankPaymaster is BasePaymaster {
    IERC20 public feeToken;

    uint256 public feeRateBps = 100;     // 1% = 100 basis points
    uint256 public maxFeeCap;            // Hard cap in token units
    address public treasury;

    address public approvedFactory;
    mapping(address => bool) public approvedTargets;
    uint256 public approvedTargetsCount;

    mapping(address => bool) public whitelisted;
    bool public whitelistEnabled;

    event FeeCollected(address indexed account, uint256 amount);
    event ConfigUpdated(uint256 feeRateBps, uint256 maxFeeCap);
    event FactoryUpdated(address factory);
    event TargetApproved(address target, bool approved);

    constructor(
        IEntryPoint _entryPoint,
        IERC20 _feeToken,
        address _treasury,
        uint256 _maxFeeCap,
        address _approvedFactory
    ) BasePaymaster(_entryPoint) {
        feeToken = _feeToken;
        treasury = _treasury;
        maxFeeCap = _maxFeeCap;
        approvedFactory = _approvedFactory;
    }

    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 /*userOpHash*/,
        uint256 /*maxCost*/
    ) internal virtual override returns (bytes memory context, uint256 validationData) {
        // 1. Optional per-account whitelist
        if (whitelistEnabled) {
            require(whitelisted[userOp.sender], "BlankPaymaster: not whitelisted");
        }

        // 2. Account being deployed? Verify it's from our approved factory.
        if (userOp.initCode.length > 0 && approvedFactory != address(0)) {
            address initFactory = address(bytes20(userOp.initCode[:20]));
            require(initFactory == approvedFactory, "BlankPaymaster: unapproved factory");
        }

        // 3. Verify the execute() target if any approved targets are set.
        //    execute(address,uint256,bytes) selector = 0xb61d27f6 — first 4
        //    bytes of callData. Target sits at offset 16..36 (selector + arg0 padding).
        if (userOp.callData.length >= 68 && approvedTargetsCount > 0) {
            bytes4 selector = bytes4(userOp.callData[:4]);
            if (selector == bytes4(0xb61d27f6)) {
                address target = address(bytes20(userOp.callData[16:36]));
                require(approvedTargets[target], "BlankPaymaster: unapproved target");
            }
        }

        // 4. Compute fee from paymasterAndData (caller-provided transferAmount).
        uint256 transferAmount = 0;
        if (userOp.paymasterAndData.length >= PAYMASTER_DATA_OFFSET + 32) {
            transferAmount = abi.decode(
                userOp.paymasterAndData[PAYMASTER_DATA_OFFSET:PAYMASTER_DATA_OFFSET + 32],
                (uint256)
            );
        }
        uint256 fee = (transferAmount * feeRateBps) / 10000;
        if (fee > maxFeeCap && maxFeeCap > 0) {
            fee = maxFeeCap;
        }

        // 5. Sender must hold enough feeToken to pay the fee.
        uint256 senderBalance = feeToken.balanceOf(userOp.sender);
        require(senderBalance >= fee, "BlankPaymaster: insufficient token balance for fee");

        context = abi.encode(userOp.sender, fee);
        validationData = 0;
    }

    function _postOp(
        PostOpMode /*mode*/,
        bytes calldata context,
        uint256 /*actualGasCost*/,
        uint256 /*actualUserOpFeePerGas*/
    ) internal virtual override {
        (address account, uint256 fee) = abi.decode(context, (address, uint256));
        if (fee > 0) {
            bool success = feeToken.transferFrom(account, treasury, fee);
            require(success, "BlankPaymaster: fee transfer failed");
            emit FeeCollected(account, fee);
        }
    }

    // ─── Admin: security ────────────────────────────────────────────────

    function setApprovedFactory(address _factory) external onlyOwner {
        approvedFactory = _factory;
        emit FactoryUpdated(_factory);
    }

    function setApprovedTarget(address target, bool approved) external onlyOwner {
        if (approved && !approvedTargets[target]) {
            approvedTargetsCount++;
        } else if (!approved && approvedTargets[target]) {
            approvedTargetsCount--;
        }
        approvedTargets[target] = approved;
        emit TargetApproved(target, approved);
    }

    // ─── Admin: fees ────────────────────────────────────────────────────

    function setFeeConfig(uint256 _feeRateBps, uint256 _maxFeeCap) external onlyOwner {
        require(_feeRateBps <= 1000, "BlankPaymaster: fee rate too high"); // max 10%
        feeRateBps = _feeRateBps;
        maxFeeCap = _maxFeeCap;
        emit ConfigUpdated(_feeRateBps, _maxFeeCap);
    }

    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
    }

    function setWhitelist(address account, bool status) external onlyOwner {
        whitelisted[account] = status;
    }

    function setWhitelistEnabled(bool enabled) external onlyOwner {
        whitelistEnabled = enabled;
    }

    receive() external payable {
        entryPoint.depositTo{value: msg.value}(address(this));
    }
}
