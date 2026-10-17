// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/// @title ProofOfBalance (retired)
/// @notice Retired before mainnet. The "balance" was an encrypted input the
///         prover chose, not their vault balance, so a verdict proved nothing
///         about funds. createProof and revealProof revert; getProof still
///         reads records made before retirement. Use
///         PaymentReceipts.proveBalanceAbove, which reads the vault balance.
contract ProofOfBalance is UUPSUpgradeable, OwnableUpgradeable {

    struct BalanceProof {
        address prover;
        uint64  thresholdMicroUSD; // plaintext threshold
        ebool   met;
        uint64  createdAt;
        bool    revealed;
        bool    revealedValue; // only valid when revealed=true
    }

    mapping(uint256 => BalanceProof) public proofs;
    uint256 public nextProofId;

    event ProofCreated(uint256 indexed proofId, address indexed prover, uint64 thresholdMicroUSD);
    event ProofRevealed(uint256 indexed proofId, bool met);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize() public initializer {
        __Ownable_init(msg.sender);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /// @notice Retired. Kept so the selector reverts with a clear reason.
    function createProof(externalEuint64, bytes calldata, uint64) external pure returns (uint256) {
        revert("ProofOfBalance: retired");
    }

    /// @notice Retired. Publishing a verdict for a self-chosen input would
    ///         still present it as a balance proof.
    function revealProof(uint256, bool, bytes calldata) external pure {
        revert("ProofOfBalance: retired");
    }

    function getProof(uint256 proofId) external view returns (
        address prover,
        uint64 thresholdMicroUSD,
        uint64 createdAt,
        bool revealed,
        bool revealedValue
    ) {
        BalanceProof storage p = proofs[proofId];
        return (p.prover, p.thresholdMicroUSD, p.createdAt, p.revealed, p.revealedValue);
    }
}
