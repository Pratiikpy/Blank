import { useCallback, useState } from "react";
import { keccak256, toBytes, type Hex } from "viem";

import { useEffectiveAddress } from "./useEffectiveAddress";
import type { RailId } from "@/lib/reclaim-providers";

// Wave 5 Block 1 — Reclaim Protocol proof request.
//
// v1 ships TWO modes:
//   1. mock: /api/relay (kind "mock-reclaim-sign") reads the fill on-chain
//      and returns an operator signature bound to (chain, verifier,
//      offramp, fillId, taker, rail, receiver, amount). One signature
//      settles exactly one fill. Used on testnet until Reclaim Protocol's
//      UPI templates are registered.
//   2. live: opens the Reclaim Protocol JS SDK widget. NOT YET ENABLED.
//
// Mode is selected by import.meta.env.VITE_RECLAIM_MODE; defaults to
// "mock" so testnet works out of the box.

export type ReclaimMode = "mock" | "live";

export type ReclaimState =
  | "idle"
  | "widget-open"
  | "proving"
  | "ready"
  | "error";

export interface ReclaimProofRequest {
  chainId: number;
  offramp: `0x${string}`;
  fillId: bigint;
  /** The offer's rail. The contract rejects any other providerId. */
  providerId: RailId;
}

export interface ReclaimProofResult {
  proof: Hex;
  providerId: RailId;
  proofHashLocal: Hex;
}

const ENV_MODE = (import.meta.env?.VITE_RECLAIM_MODE as ReclaimMode | undefined) ?? "mock";

export function useReclaimProof(mode: ReclaimMode = ENV_MODE) {
  const { effectiveAddress: address } = useEffectiveAddress();
  const [state, setState] = useState<ReclaimState>("idle");
  const [error, setError] = useState<string | null>(null);

  const requestProof = useCallback(
    async (req: ReclaimProofRequest): Promise<ReclaimProofResult> => {
      setError(null);
      setState("widget-open");

      try {
        if (mode === "live") {
          throw new Error(
            "Reclaim live mode is not wired yet. Set VITE_RECLAIM_MODE=mock to use the testnet verifier.",
          );
        }

        if (!address) throw new Error("Connect a wallet to take the offer first.");

        setState("proving");
        const resp = await fetch("/api/relay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "mock-reclaim-sign",
            chainId: req.chainId,
            offramp: req.offramp,
            fillId: req.fillId.toString(),
          }),
        });
        if (!resp.ok) {
          const body = (await resp.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `mock-reclaim-sign HTTP ${resp.status}`);
        }
        const { signature, providerId, taker } = (await resp.json()) as {
          signature: Hex;
          signer: `0x${string}`;
          providerId: number;
          taker: `0x${string}`;
        };
        if (providerId !== req.providerId) {
          throw new Error("Attestation rail does not match the offer rail.");
        }
        if (taker.toLowerCase() !== address.toLowerCase()) {
          throw new Error("This fill was locked by another account. Only the taker can submit the proof.");
        }

        const proof = signature;
        const proofHashLocal = keccak256(toBytes(proof));
        setState("ready");
        return { proof, providerId: req.providerId, proofHashLocal };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setState("error");
        throw e;
      }
    },
    [address, mode],
  );

  const reset = useCallback(() => {
    setError(null);
    setState("idle");
  }, []);

  return { mode, state, error, requestProof, reset };
}
