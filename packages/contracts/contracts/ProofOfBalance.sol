// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/*
 * ProofOfBalance
 *
 * Wave 5 Block 10 (bonus FHE): prove your encrypted balance is at
 * or above a plaintext threshold WITHOUT revealing the balance.
 *
 * Differs from Wave 4 PaymentReceipts.createIncomeProof (which proves
 * cumulative income) — this one proves SPOT balance at proof time.
 *
 * Use cases:
 *   - "I have at least $10K" to a rental application
 *   - "I have at least $500" to a sponsorship gate
 *   - Any FHE.gte threshold gate over your own balance
 *
 * Flow:
 *   1. Prover supplies an InEuint64 encrypted balance (their own).
 *   2. Contract evaluates FHE.gte(encBalance, threshold) -> ebool.
 *   3. ebool published via FHE.allowPublic so anyone can later
 *      decrypt the verdict (true/false). NOT the underlying balance.
 *   4. Proof is stored under nextProofId. Public verifier page at
 *      /proof/balance/:chainId/:id reads getProof + the published
 *      verdict to render green/red.
 *
 * v1 limitations honest: the InEuint64 must be encrypted under the
 * prover's context. A future Wave 6 version reads the vault balance
 * directly via vault.balanceOfHandle() + FHE.gte so the prover
 * can't lie. v1 trades that for simpler UX (one tx, no permit
 * dance).
 */
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

    /// Create a balance-threshold proof. Returns proofId.
    function createProof(
        InEuint64 calldata encBalance,
        uint64 thresholdMicroUSD
    ) external returns (uint256 proofId) {
        require(thresholdMicroUSD > 0, "ProofOfBalance: threshold=0");
        proofId = nextProofId++;

        euint64 balance = FHE.asEuint64(encBalance);
        ebool met = FHE.gte(balance, FHE.asEuint64(thresholdMicroUSD));

        FHE.allowThis(met);
        FHE.allow(met, msg.sender);
        FHE.allowPublic(met);

        proofs[proofId] = BalanceProof({
            prover: msg.sender,
            thresholdMicroUSD: thresholdMicroUSD,
            met: met,
            createdAt: uint64(block.timestamp),
            revealed: false,
            revealedValue: false
        });

        emit ProofCreated(proofId, msg.sender, thresholdMicroUSD);
    }

    /// Off-chain caller decrypts the ebool via cofhe + submits the
    /// plaintext + signature. Mirrors the
    /// PaymentReceipts.publishCloseResult pattern from Wave 4.
    function revealProof(uint256 proofId, bool plaintext, bytes calldata signature) external {
        BalanceProof storage p = proofs[proofId];
        require(p.prover != address(0), "ProofOfBalance: unknown proof");
        require(!p.revealed, "ProofOfBalance: already revealed");
        // FHE library publishes the bool with signature verification.
        FHE.publishDecryptResult(p.met, plaintext, signature);
        p.revealed = true;
        p.revealedValue = plaintext;
        emit ProofRevealed(proofId, plaintext);
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
