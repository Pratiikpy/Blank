// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

interface IReclaimVerifier {
    function verifyAndConsume(
        bytes calldata proof,
        uint32 providerId,
        bytes32 expectedReceiver,
        uint64 expectedAmount
    ) external view returns (bool ok, bytes32 proofHash);
}

/// @title ReclaimAdapter
/// @notice Thin adapter in front of a Reclaim Protocol verifier (or the
///         MockReclaimVerifier fallback). Enforces:
///           - the provider ID is on the allowlist for the given rail
///           - the underlying verifier validates the proof
///           - the resulting proofHash hasn't been used before (replay
///             guard)
///         P2POfframp.sol calls this from submitProof. Keeping the
///         allowlist + replay map here means the Offramp contract
///         stays focused on order/fill state.
///
/// @dev    UUPS so the allowlist + verifier address can be rotated
///         without a redeploy. Append-only storage.
contract ReclaimAdapter is UUPSUpgradeable, OwnableUpgradeable {
    /// Rail identifiers — kept stable across deploys so P2POfframp
    /// can store them as plaintext uint32 on Offer.fiatRail.
    uint32 public constant RAIL_UPI_PHONEPE = 1;
    uint32 public constant RAIL_UPI_GPAY    = 2;
    uint32 public constant RAIL_UPI_PAYTM   = 3;
    uint32 public constant RAIL_WISE        = 4;
    uint32 public constant RAIL_VENMO       = 5;
    uint32 public constant RAIL_PAYPAL      = 6;

    IReclaimVerifier public verifier;

    /// Allowlisted provider IDs. Wave 5 v0 keeps it simple: any
    /// non-zero providerId entered here is accepted by submitProof.
    /// Future Wave 6 work can refine to per-chain provider sets.
    mapping(uint32 => bool) public allowedProviders;

    /// Anti-replay: proofHash returned by the verifier is marked used
    /// the first time it succeeds. Re-submitting the same proof
    /// reverts.
    mapping(bytes32 => bool) public usedProofs;

    /// Authorized callers — only P2POfframp (and its upgrades) should
    /// be able to mark proofs as used. Public verifyAndConsume reads
    /// from here. Owner controls the set.
    mapping(address => bool) public allowedCallers;

    event VerifierChanged(address indexed previous, address indexed next);
    event ProviderAllowed(uint32 indexed providerId, bool allowed);
    event CallerAllowed(address indexed caller, bool allowed);
    event ProofConsumed(bytes32 indexed proofHash, uint32 providerId, address indexed caller);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address _verifier) public initializer {
        __Ownable_init(msg.sender);
        verifier = IReclaimVerifier(_verifier);
        emit VerifierChanged(address(0), _verifier);

        // Default-allow the 6 known rails. Owner can disable any.
        allowedProviders[RAIL_UPI_PHONEPE] = true;
        allowedProviders[RAIL_UPI_GPAY]    = true;
        allowedProviders[RAIL_UPI_PAYTM]   = true;
        allowedProviders[RAIL_WISE]        = true;
        allowedProviders[RAIL_VENMO]       = true;
        allowedProviders[RAIL_PAYPAL]      = true;

        emit ProviderAllowed(RAIL_UPI_PHONEPE, true);
        emit ProviderAllowed(RAIL_UPI_GPAY, true);
        emit ProviderAllowed(RAIL_UPI_PAYTM, true);
        emit ProviderAllowed(RAIL_WISE, true);
        emit ProviderAllowed(RAIL_VENMO, true);
        emit ProviderAllowed(RAIL_PAYPAL, true);
    }

    function setVerifier(address _verifier) external onlyOwner {
        emit VerifierChanged(address(verifier), _verifier);
        verifier = IReclaimVerifier(_verifier);
    }

    function setProvider(uint32 providerId, bool allowed) external onlyOwner {
        allowedProviders[providerId] = allowed;
        emit ProviderAllowed(providerId, allowed);
    }

    function setCaller(address caller, bool allowed) external onlyOwner {
        allowedCallers[caller] = allowed;
        emit CallerAllowed(caller, allowed);
    }

    /// Called by P2POfframp.submitProof. Reverts on:
    ///   - caller not allowlisted
    ///   - providerId not allowlisted
    ///   - verifier rejects the proof
    ///   - amount mismatch (verifier-enforced)
    ///   - replay
    function verifyAndConsume(
        bytes calldata proof,
        uint32 providerId,
        bytes32 expectedReceiver,
        uint64 expectedAmount
    ) external returns (bytes32 proofHash) {
        require(allowedCallers[msg.sender], "ReclaimAdapter: caller not allowed");
        require(allowedProviders[providerId], "ReclaimAdapter: provider not allowed");

        (bool ok, bytes32 hash) = verifier.verifyAndConsume(
            proof, providerId, expectedReceiver, expectedAmount
        );
        require(ok, "ReclaimAdapter: verifier rejected");
        require(!usedProofs[hash], "ReclaimAdapter: proof replayed");

        usedProofs[hash] = true;
        emit ProofConsumed(hash, providerId, msg.sender);
        return hash;
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}
}
