// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title MockReclaimVerifier
/// @notice Wave 5 Block 0.5 fallback for the P2P offramp dispute path.
///         Mirrors the IProofVerifier surface that Reclaim Protocol's
///         on-chain verifier exposes, but accepts any proof signed by
///         a known operator key. Used when Reclaim's sandbox UPI
///         templates are unavailable so the demo + smoke flow can
///         still capture a real on-chain tx hash.
///
/// @dev    Operator signs (proofHash || providerId || receiverHandle ||
///         amountMicroUSD) and the bytes blob is the raw signature.
///         Switching off mock mode: deploy with operator = address(0)
///         and the contract reverts all verify calls (forces routing
///         through the real Reclaim adapter instead).
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

    /// @notice Verify a mock proof. Returns the proofHash that the
    ///         adapter uses for anti-replay. Reverts on bad signature,
    ///         missing operator, or amount mismatch.
    /// @param  proof              EIP-191 signature over the message
    ///                            below (65 bytes).
    /// @param  providerId         Rail provider ID. Mock accepts any.
    /// @param  expectedReceiver   Maker's handle digest the taker is
    ///                            paying. Echoed in the signed message.
    /// @param  expectedAmount     The plaintext fiat amount in microUSD
    ///                            the taker should have paid.
    function verifyAndConsume(
        bytes calldata proof,
        uint32 providerId,
        bytes32 expectedReceiver,
        uint64 expectedAmount
    ) external view returns (bool ok, bytes32 proofHash) {
        require(operator != address(0), "MockReclaimVerifier: disabled");
        require(proof.length == 65, "MockReclaimVerifier: bad sig length");

        // Reconstruct the message that the operator should have signed.
        bytes32 message = keccak256(
            abi.encode(providerId, expectedReceiver, expectedAmount)
        );
        bytes32 ethSignedMessage = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", message)
        );

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(proof.offset)
            s := calldataload(add(proof.offset, 32))
            v := byte(0, calldataload(add(proof.offset, 64)))
        }
        if (v < 27) v += 27;

        address recovered = ecrecover(ethSignedMessage, v, r, s);
        require(recovered != address(0), "MockReclaimVerifier: ecrecover failed");
        require(recovered == operator, "MockReclaimVerifier: wrong signer");

        // proofHash is deterministic over the proof bytes so the adapter
        // can store usedProofs[h] = true for anti-replay.
        proofHash = keccak256(proof);
        return (true, proofHash);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
