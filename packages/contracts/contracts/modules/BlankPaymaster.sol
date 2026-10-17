// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@account-abstraction/contracts/core/BasePaymaster.sol";
import "@account-abstraction/contracts/core/Helpers.sol";
import "@account-abstraction/contracts/core/UserOperationLib.sol";
import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title BlankPaymaster
 * @notice Verifying paymaster for BlankAccount UserOps (EntryPoint v0.8).
 *
 * Sponsorship requires all of:
 *  - a signature from `verifyingSigner` (held by the Blank backend) over the
 *    UserOp fields, chain id, this address and a validity window
 *  - a sender whose runtime code hash equals `accountCodeHash` (the BlankAccount
 *    ERC1967 proxy), and, on first deploy, initCode from `approvedFactory`
 *  - gas prices and maxCost within owner-set caps
 *  - call targets on the allowlist (when any are set). A call to the sender
 *    itself is allowed only for upgradeToAndCall(approved impl, ""),
 *    enableValidator(approved validator) or setRecoveryModule(approved
 *    module), with value 0, so new accounts can adopt the current
 *    implementation and modules without first holding ETH
 *  - a sender not flagged for an unpaid fee
 *
 * paymasterAndData layout:
 *   [0:20]   paymaster
 *   [20:36]  paymasterVerificationGasLimit
 *   [36:52]  paymasterPostOpGasLimit
 *   [52:58]  validUntil (uint48)
 *   [58:64]  validAfter (uint48)
 *   [64:129] ECDSA signature (65 bytes) over getHash(userOp, validUntil, validAfter)
 *
 * Fee: charged in postOp from actualGasCost, converted at `feeTokenPerEth`
 * plus `feeMarkupBps`, capped at `maxFeeCap`. `feeTokenPerEth == 0` means free
 * sponsorship. If the fee pull fails the sender is flagged and gets no further
 * sponsorship until the owner clears it, so a failed pull cannot be repeated.
 */
contract BlankPaymaster is BasePaymaster {
    using UserOperationLib for PackedUserOperation;

    uint256 private constant VALID_TIMESTAMP_OFFSET = PAYMASTER_DATA_OFFSET;
    uint256 private constant SIGNATURE_OFFSET = PAYMASTER_DATA_OFFSET + 12;
    uint256 private constant SIGNATURE_LENGTH = 65;

    IERC20 public feeToken;
    address public treasury;

    /// @notice Fee token smallest units per 1 ETH (1e18 wei) of gas. 0 = free.
    uint256 public feeTokenPerEth;
    /// @notice Markup over the converted gas cost, in basis points.
    uint256 public feeMarkupBps;
    /// @notice Hard cap on the fee for a single UserOp, in token units. 0 = no cap.
    uint256 public maxFeeCap;

    address public approvedFactory;
    bytes32 public accountCodeHash;
    address public verifyingSigner;

    uint256 public maxFeePerGasCap;
    uint256 public maxPriorityFeePerGasCap;
    uint256 public maxCostCap;

    /// @notice Minimum seconds between sponsored ops per sender. 0 = no limit.
    uint48 public minSponsorInterval;
    mapping(address => uint48) public lastSponsoredAt;
    mapping(address => bool) public feeDefaulted;

    mapping(address => bool) public approvedTargets;
    uint256 public approvedTargetsCount;

    mapping(address => bool) public whitelisted;
    bool public whitelistEnabled;

    mapping(address => bool) public approvedImplementations;
    mapping(address => bool) public approvedValidators;
    mapping(address => bool) public approvedRecoveryModules;

    bytes4 private constant UPGRADE_TO_AND_CALL = bytes4(keccak256("upgradeToAndCall(address,bytes)"));
    bytes4 private constant ENABLE_VALIDATOR = bytes4(keccak256("enableValidator(address)"));
    bytes4 private constant SET_RECOVERY_MODULE = bytes4(keccak256("setRecoveryModule(address)"));

    event FeeCollected(address indexed account, uint256 amount);
    event FeeDefaulted(address indexed account, uint256 amount);
    event FeeDefaultCleared(address indexed account);
    event FeeConfigUpdated(uint256 feeTokenPerEth, uint256 feeMarkupBps, uint256 maxFeeCap);
    event GasCapsUpdated(uint256 maxFeePerGas, uint256 maxPriorityFeePerGas, uint256 maxCost);
    event SponsorIntervalUpdated(uint48 interval);
    event FactoryUpdated(address factory);
    event AccountCodeHashUpdated(bytes32 codeHash);
    event VerifyingSignerUpdated(address signer);
    event TargetApproved(address target, bool approved);
    event TreasuryUpdated(address treasury);
    event ImplementationApproved(address implementation, bool approved);
    event ValidatorApproved(address validator, bool approved);
    event RecoveryModuleApproved(address module, bool approved);

    constructor(
        IEntryPoint _entryPoint,
        IERC20 _feeToken,
        address _treasury,
        address _approvedFactory,
        address _verifyingSigner
    ) BasePaymaster(_entryPoint) {
        require(_verifyingSigner != address(0), "BlankPaymaster: signer=0");
        require(_treasury != address(0), "BlankPaymaster: treasury=0");
        feeToken = _feeToken;
        treasury = _treasury;
        approvedFactory = _approvedFactory;
        verifyingSigner = _verifyingSigner;
    }

    // ─── Validation ─────────────────────────────────────────────────────

    /// @notice Hash the backend signs (EIP-191 personal_sign over this value).
    /// @dev Covers every UserOp field except the signatures, plus chain id and
    ///      this paymaster, so a signature cannot be replayed elsewhere.
    function getHash(
        PackedUserOperation calldata userOp,
        uint48 validUntil,
        uint48 validAfter
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                uint256(bytes32(userOp.paymasterAndData[UserOperationLib.PAYMASTER_VALIDATION_GAS_OFFSET:PAYMASTER_DATA_OFFSET])),
                userOp.preVerificationGas,
                userOp.gasFees,
                block.chainid,
                address(this),
                validUntil,
                validAfter
            )
        );
    }

    function parsePaymasterAndData(bytes calldata paymasterAndData)
        public
        pure
        returns (uint48 validUntil, uint48 validAfter, bytes calldata signature)
    {
        require(
            paymasterAndData.length == SIGNATURE_OFFSET + SIGNATURE_LENGTH,
            "BlankPaymaster: bad paymasterData length"
        );
        validUntil = uint48(bytes6(paymasterAndData[VALID_TIMESTAMP_OFFSET:VALID_TIMESTAMP_OFFSET + 6]));
        validAfter = uint48(bytes6(paymasterAndData[VALID_TIMESTAMP_OFFSET + 6:SIGNATURE_OFFSET]));
        signature = paymasterAndData[SIGNATURE_OFFSET:];
    }

    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32, /* userOpHash */
        uint256 maxCost
    ) internal virtual override returns (bytes memory context, uint256 validationData) {
        address sender = userOp.sender;

        if (whitelistEnabled) {
            require(whitelisted[sender], "BlankPaymaster: not whitelisted");
        }
        require(!feeDefaulted[sender], "BlankPaymaster: unpaid fee");

        _checkAccount(userOp);
        _checkGas(userOp, maxCost);
        _checkTargets(userOp.callData, sender);

        uint256 maxFee = _feeFor(maxCost);
        if (maxFee > 0) {
            require(feeToken.balanceOf(sender) >= maxFee, "BlankPaymaster: insufficient token balance for fee");
            require(feeToken.allowance(sender, address(this)) >= maxFee, "BlankPaymaster: insufficient fee allowance");
        }

        (uint48 validUntil, uint48 validAfter, bytes calldata signature) =
            parsePaymasterAndData(userOp.paymasterAndData);

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(getHash(userOp, validUntil, validAfter));
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);
        bool sigFailed = err != ECDSA.RecoverError.NoError || recovered != verifyingSigner;

        // Rate limit without reading block.timestamp in validation (ERC-7562):
        // the EntryPoint enforces validAfter.
        if (minSponsorInterval > 0 && lastSponsoredAt[sender] > 0) {
            uint48 earliest = lastSponsoredAt[sender] + minSponsorInterval;
            if (earliest > validAfter) validAfter = earliest;
        }

        context = abi.encode(sender, feeTokenPerEth, feeMarkupBps, maxFeeCap);
        validationData = _packValidationData(sigFailed, validUntil, validAfter);
    }

    function _checkAccount(PackedUserOperation calldata userOp) private view {
        if (userOp.initCode.length > 0) {
            require(userOp.initCode.length >= 20, "BlankPaymaster: bad initCode");
            require(address(bytes20(userOp.initCode[:20])) == approvedFactory, "BlankPaymaster: unapproved factory");
        }
        // The EntryPoint deploys the sender before paymaster validation, so the
        // code hash is checkable on the first op too.
        require(accountCodeHash != bytes32(0), "BlankPaymaster: account code hash unset");
        require(userOp.sender.codehash == accountCodeHash, "BlankPaymaster: not a Blank account");
    }

    function _checkGas(PackedUserOperation calldata userOp, uint256 maxCost) private view {
        require(maxCostCap > 0 && maxFeePerGasCap > 0, "BlankPaymaster: gas caps unset");
        (uint256 maxPriorityFeePerGas, uint256 maxFeePerGas) = UserOperationLib.unpackUints(userOp.gasFees);
        require(maxFeePerGas <= maxFeePerGasCap, "BlankPaymaster: maxFeePerGas over cap");
        require(maxPriorityFeePerGas <= maxPriorityFeePerGasCap, "BlankPaymaster: priority fee over cap");
        require(maxCost <= maxCostCap, "BlankPaymaster: maxCost over cap");
    }

    /// @dev Only execute / executeBatch to allowlisted targets are sponsored.
    ///      A target equal to the sender goes through _checkSelfCall instead.
    function _checkTargets(bytes calldata callData, address sender) private view {
        // Fail closed: an unconfigured paymaster sponsors nothing.
        require(approvedTargetsCount > 0, "BlankPaymaster: no targets approved");
        require(callData.length >= 4, "BlankPaymaster: empty callData");
        bytes4 selector = bytes4(callData[:4]);

        if (selector == bytes4(0xb61d27f6)) {
            // execute(address,uint256,bytes)
            require(callData.length >= 36, "BlankPaymaster: malformed execute");
            address target = address(bytes20(callData[16:36]));
            if (target == sender) {
                (, uint256 value, bytes memory data) = abi.decode(callData[4:], (address, uint256, bytes));
                _checkSelfCall(value, data);
            } else {
                require(approvedTargets[target], "BlankPaymaster: unapproved target");
            }
        } else if (selector == bytes4(0x47e1da2a)) {
            // executeBatch(address[],uint256[],bytes[]). BlankAccount decodes
            // strictly, so requiring the canonical 0x60 offset keeps our view
            // and the account's view of the targets identical.
            require(callData.length >= 100, "BlankPaymaster: malformed executeBatch");
            uint256 targetsOffset = uint256(bytes32(callData[4:36]));
            require(targetsOffset == 0x60, "BlankPaymaster: non-canonical executeBatch");
            uint256 lenAt = 4 + targetsOffset;
            require(callData.length >= lenAt + 32, "BlankPaymaster: truncated executeBatch");
            uint256 nTargets = uint256(bytes32(callData[lenAt:lenAt + 32]));
            require(nTargets > 0 && nTargets <= 20, "BlankPaymaster: bad batch size");
            require(callData.length >= lenAt + 32 + nTargets * 32, "BlankPaymaster: short targets");
            bool hasSelf;
            for (uint256 i = 0; i < nTargets; i++) {
                uint256 addrSlot = lenAt + 32 + i * 32;
                address target = address(bytes20(callData[addrSlot + 12:addrSlot + 32]));
                if (target == sender) {
                    hasSelf = true;
                } else {
                    require(approvedTargets[target], "BlankPaymaster: unapproved batch target");
                }
            }
            if (hasSelf) {
                // Decode the way the account does, so value and data are
                // exactly what the self-call runs with.
                (address[] memory targets, uint256[] memory values, bytes[] memory datas) =
                    abi.decode(callData[4:], (address[], uint256[], bytes[]));
                require(values.length == nTargets && datas.length == nTargets, "BlankPaymaster: batch length mismatch");
                for (uint256 i = 0; i < nTargets; i++) {
                    if (targets[i] == sender) _checkSelfCall(values[i], datas[i]);
                }
            }
        } else {
            revert("BlankPaymaster: selector not allowed");
        }
    }

    /// @dev The account's own admin calls: only the three adoption steps,
    ///      only with owner-approved arguments, canonical encoding, no value.
    function _checkSelfCall(uint256 value, bytes memory data) private view {
        require(value == 0, "BlankPaymaster: self-call with value");
        require(data.length >= 4, "BlankPaymaster: self-call not allowed");
        bytes4 sel = bytes4(data);
        if (sel == UPGRADE_TO_AND_CALL) {
            // upgradeToAndCall(impl, ""): selector, impl, offset 0x40, length 0.
            require(data.length == 100, "BlankPaymaster: upgrade data not allowed");
            require(_word(data, 36) == 0x40 && _word(data, 68) == 0, "BlankPaymaster: upgrade data not allowed");
            require(approvedImplementations[_addr(data)], "BlankPaymaster: unapproved implementation");
        } else if (sel == ENABLE_VALIDATOR) {
            require(data.length == 36, "BlankPaymaster: malformed self-call");
            require(approvedValidators[_addr(data)], "BlankPaymaster: unapproved validator");
        } else if (sel == SET_RECOVERY_MODULE) {
            require(data.length == 36, "BlankPaymaster: malformed self-call");
            require(approvedRecoveryModules[_addr(data)], "BlankPaymaster: unapproved recovery module");
        } else {
            revert("BlankPaymaster: self-call not allowed");
        }
    }

    function _word(bytes memory data, uint256 at) private pure returns (uint256 w) {
        assembly {
            w := mload(add(add(data, 32), at))
        }
    }

    /// @dev First argument as an address; dirty high bits are refused.
    function _addr(bytes memory data) private pure returns (address) {
        uint256 w = _word(data, 4);
        require(w >> 160 == 0, "BlankPaymaster: malformed self-call");
        return address(uint160(w));
    }

    function _feeFor(uint256 gasCostWei) internal view returns (uint256) {
        return _computeFee(gasCostWei, feeTokenPerEth, feeMarkupBps, maxFeeCap);
    }

    function _computeFee(uint256 gasCostWei, uint256 rate, uint256 markupBps, uint256 cap)
        internal
        pure
        returns (uint256 fee)
    {
        if (rate == 0) return 0;
        fee = (gasCostWei * rate * (10_000 + markupBps)) / (1e18 * 10_000);
        if (cap > 0 && fee > cap) fee = cap;
    }

    /// @notice Fee in token units for a given gas cost in wei, at current config.
    function quoteFee(uint256 gasCostWei) external view returns (uint256) {
        return _feeFor(gasCostWei);
    }

    function _postOp(
        PostOpMode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256
    ) internal virtual override {
        (address account, uint256 rate, uint256 markupBps, uint256 cap) =
            abi.decode(context, (address, uint256, uint256, uint256));
        lastSponsoredAt[account] = uint48(block.timestamp);

        uint256 fee = _computeFee(actualGasCost, rate, markupBps, cap);
        if (fee == 0) return;

        // Never revert here: a postOp revert rolls back the user's execution
        // but the paymaster still pays, which a caller could repeat at will.
        // A failed pull flags the sender instead.
        (bool ok, bytes memory ret) = address(feeToken).call(
            abi.encodeCall(IERC20.transferFrom, (account, treasury, fee))
        );
        if (ok && (ret.length == 0 ? address(feeToken).code.length > 0 : abi.decode(ret, (bool)))) {
            emit FeeCollected(account, fee);
        } else {
            feeDefaulted[account] = true;
            emit FeeDefaulted(account, fee);
        }
    }

    // ─── Admin ──────────────────────────────────────────────────────────

    function setVerifyingSigner(address signer) external onlyOwner {
        require(signer != address(0), "BlankPaymaster: signer=0");
        verifyingSigner = signer;
        emit VerifyingSignerUpdated(signer);
    }

    function setApprovedFactory(address _factory) external onlyOwner {
        approvedFactory = _factory;
        emit FactoryUpdated(_factory);
    }

    function setAccountCodeHash(bytes32 codeHash) external onlyOwner {
        accountCodeHash = codeHash;
        emit AccountCodeHashUpdated(codeHash);
    }

    function setGasCaps(uint256 _maxFeePerGas, uint256 _maxPriorityFeePerGas, uint256 _maxCost) external onlyOwner {
        require(_maxFeePerGas > 0 && _maxCost > 0, "BlankPaymaster: zero cap");
        require(_maxPriorityFeePerGas <= _maxFeePerGas, "BlankPaymaster: priority > max");
        maxFeePerGasCap = _maxFeePerGas;
        maxPriorityFeePerGasCap = _maxPriorityFeePerGas;
        maxCostCap = _maxCost;
        emit GasCapsUpdated(_maxFeePerGas, _maxPriorityFeePerGas, _maxCost);
    }

    function setSponsorInterval(uint48 interval) external onlyOwner {
        require(interval <= 1 days, "BlankPaymaster: interval too long");
        minSponsorInterval = interval;
        emit SponsorIntervalUpdated(interval);
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

    function setApprovedImplementation(address implementation, bool approved) external onlyOwner {
        require(!approved || implementation.code.length > 0, "BlankPaymaster: not a contract");
        approvedImplementations[implementation] = approved;
        emit ImplementationApproved(implementation, approved);
    }

    function setApprovedValidator(address validator, bool approved) external onlyOwner {
        require(!approved || validator.code.length > 0, "BlankPaymaster: not a contract");
        approvedValidators[validator] = approved;
        emit ValidatorApproved(validator, approved);
    }

    function setApprovedRecoveryModule(address module, bool approved) external onlyOwner {
        require(!approved || module.code.length > 0, "BlankPaymaster: not a contract");
        approvedRecoveryModules[module] = approved;
        emit RecoveryModuleApproved(module, approved);
    }

    function setFeeConfig(uint256 _feeTokenPerEth, uint256 _feeMarkupBps, uint256 _maxFeeCap) external onlyOwner {
        require(_feeMarkupBps <= 5_000, "BlankPaymaster: markup too high");
        feeTokenPerEth = _feeTokenPerEth;
        feeMarkupBps = _feeMarkupBps;
        maxFeeCap = _maxFeeCap;
        emit FeeConfigUpdated(_feeTokenPerEth, _feeMarkupBps, _maxFeeCap);
    }

    function clearFeeDefault(address account) external onlyOwner {
        feeDefaulted[account] = false;
        emit FeeDefaultCleared(account);
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "BlankPaymaster: treasury=0");
        treasury = _treasury;
        emit TreasuryUpdated(_treasury);
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
