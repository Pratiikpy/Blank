import { useCallback } from "react";
import { usePublicClient } from "wagmi";
import { useChain } from "@/providers/ChainProvider";
import { ProofOfBalanceAbi } from "@/lib/abis";

// ──────────────────────────────────────────────────────────────────
//  useProofOfBalance: read-only access to retired ProofOfBalance records.
//
//  ProofOfBalance took the "balance" as an encrypted input the prover chose,
//  so its verdicts said nothing about real funds. createProof and
//  revealProof now revert on-chain. getProof still reads records made before
//  retirement, which is all this hook exposes.
//
//  New balance proofs: useQualificationProof.createBalanceProof, which calls
//  PaymentReceipts.proveBalanceAbove against the vault balance itself.
// ──────────────────────────────────────────────────────────────────

export interface BalanceProofRecord {
  id: bigint;
  prover: `0x${string}`;
  thresholdMicroUSD: bigint;
  createdAt: bigint;
  revealed: boolean;
  revealedValue: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000";

export function useProofOfBalance() {
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const proofOfBalanceAddr = contracts.ProofOfBalance as `0x${string}`;
  const deployed = !!proofOfBalanceAddr && proofOfBalanceAddr !== ZERO;

  /** Null when the id has no record (prover is zero) or the read fails. */
  const fetchProof = useCallback(
    async (proofId: bigint): Promise<BalanceProofRecord | null> => {
      if (!publicClient || !deployed) return null;
      try {
        const result = (await publicClient.readContract({
          address: proofOfBalanceAddr,
          abi: ProofOfBalanceAbi,
          functionName: "getProof",
          args: [proofId],
        })) as readonly [`0x${string}`, bigint, bigint, boolean, boolean];
        if (result[0] === ZERO) return null;
        return {
          id: proofId,
          prover: result[0],
          thresholdMicroUSD: result[1],
          createdAt: result[2],
          revealed: result[3],
          revealedValue: result[4],
        };
      } catch {
        return null;
      }
    },
    [publicClient, deployed, proofOfBalanceAddr],
  );

  return { deployed, fetchProof };
}
