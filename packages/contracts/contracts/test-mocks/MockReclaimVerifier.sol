// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title MockReclaimVerifier
/// @notice Testnet stand-in for a Reclaim Protocol verifier. Accepts any
///         attestation signed by a known operator key.
///
/// @dev    The operator signs (EIP-191 personal_sign over the 32-byte digest):
///           keccak256(abi.encode(
///             uint256 chainId, address verifier, address offramp,
///             uint64 fillId, address taker,
///             uint32 providerId, bytes32 receiverHandle, uint64 amountMicroUSD))
///         Binding the fill, taker, chain and both contracts means one
///         signature settles exactly one fill. The digest itself is the
///         replay key, so re-encoding the signature (high-s, v=0/1) cannot
///         mint a second key. Operator = address(0) disables the mock.
contract MockReclaimVerifier is UUPSUpgradeable, OwnableUpgradeable {
    address public operator;

    event OperatorChanged(address indexed previous, address indexed next);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address _operator) public initializer {
        __Ownable_init(msg.sender);
        operator = _operator;
        emit OperatorChanged(address(0), _operator);
    }

    function setOperator(address _operator) external onlyOwner {
        emit OperatorChanged(operator, _operator);
        operator = _operator;
    }

    /// @notice Digest the operator must sign for a given fill.
    function attestationDigest(
        address offramp,
        uint64 fillId,
        address taker,
        uint32 providerId,
        bytes32 expectedReceiver,
        uint64 expectedAmount
    ) public view returns (bytes32) {
        return keccak256(abi.encode(
            block.chainid, address(this), offramp, fillId, taker,
            providerId, expectedReceiver, expectedAmount
        ));
    }

    /// @notice Verify a mock proof. Returns the digest as the replay key.
    ///         Reverts on bad signature, missing operator or any field mismatch.
    /// @param  proof 65-byte signature over attestationDigest(...).
    function verifyAndConsume(
        bytes calldata proof,
        uint32 providerId,
        bytes32 expectedReceiver,
        uint64 expectedAmount,
        uint64 fillId,
        address taker,
        address offramp
    ) external view returns (bool ok, bytes32 proofHash) {
        require(operator != address(0), "MockReclaimVerifier: disabled");
        require(proof.length == 65, "MockReclaimVerifier: bad sig length");

        bytes32 digest = attestationDigest(offramp, fillId, taker, providerId, expectedReceiver, expectedAmount);
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(
            MessageHashUtils.toEthSignedMessageHash(digest),
            proof
        );
        require(err == ECDSA.RecoverError.NoError, "MockReclaimVerifier: bad signature");
        require(recovered == operator, "MockReclaimVerifier: wrong signer");

        return (true, digest);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
