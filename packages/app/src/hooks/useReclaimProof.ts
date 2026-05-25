import { useCallback, useState } from "react";
import { keccak256, toBytes, type Hex } from "viem";
import { useAccount } from "wagmi";

import type { RailId } from "@/lib/reclaim-providers";

// Wave 5 Block 1 — Reclaim Protocol proof request.
//
// v1 ships TWO modes:
//   1. mock: takes a locally-signed attestation from the connected user
//      acting as the MockReclaimVerifier operator. The signed message
//      matches what MockReclaimVerifier.verifyAndConsume reconstructs.
//      Used for testnet smoke until Reclaim Protocol's UPI templates
//      are registered (Block 0.5 spike).
//   2. live: opens the Reclaim Protocol JS SDK widget. The taker signs
//      into their UPI / Wise / Venmo / PayPal sandbox, the SDK reads
//      the transaction page via TLSNotary-style zkTLS, and returns
//      the signed attestation that the on-chain ReclaimVerifier
//      validates. NOT YET ENABLED — placeholder import + flag toggle.
//
// Mode is selected by import.meta.env.VITE_RECLAIM_MODE; defaults to
// "mock" so testnet smoke works out of the box. Switch to "live"
// after the spike captures real provider IDs + verifier addresses.

export type ReclaimMode = "mock" | "live";

export type ReclaimState =
  | "idle"
  | "widget-open"
  | "proving"
  | "ready"
  | "error";

export interface ReclaimProofRequest {
  receiverHandle: string;
  amountMicroUSD: bigint;
  providerId: RailId;
}

export interface ReclaimProofResult {
  proof: Hex;
  providerId: RailId;
  proofHashLocal: Hex; // matches MockReclaimVerifier.proofHash = keccak256(proof)
}

const ENV_MODE = (import.meta.env?.VITE_RECLAIM_MODE as ReclaimMode | undefined) ?? "mock";

export function useReclaimProof(mode: ReclaimMode = ENV_MODE) {
  const { address } = useAccount();
  const [state, setState] = useState<ReclaimState>("idle");
  const [error, setError] = useState<string | null>(null);

  const requestProof = useCallback(
    async (req: ReclaimProofRequest): Promise<ReclaimProofResult> => {
      setError(null);
      setState("widget-open");

      try {
        if (mode === "live") {
          // Real Reclaim Protocol integration lives behind a feature
          // flag. Block 0.5 spike captures provider IDs + verifier
          // addresses; once available, dynamic-import @reclaimprotocol/js-sdk
          // here, drive its widget, and return the signed attestation.
          throw new Error(
            "Reclaim live mode not yet wired. Block 0.5 spike pending. " +
              "Set VITE_RECLAIM_MODE=mock to run testnet smoke against MockReclaimVerifier.",
          );
        }

        if (!address) throw new Error("Connect a wallet to take the offer first.");

        // Wave 5.5 — server-side mock signing. The MockReclaimVerifier
        // on-chain recovers the signature against `operator` (the
        // deployer key); having the taker sign with their own wallet
        // would never satisfy that check. We POST to /api/mock-reclaim-sign
        // which signs with the operator PK (server-only env var).
        // Replaces the prior wallet-sign flow that always failed on-chain.
        setState("proving");
        const resp = await fetch("/api/mock-reclaim-sign", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            providerId: req.providerId,
            receiverHandle: req.receiverHandle,
            amountMicroUSD: req.amountMicroUSD.toString(),
          }),
        });
        if (!resp.ok) {
          const body = (await resp.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `mock-reclaim-sign HTTP ${resp.status}`);
        }
        const { signature } = (await resp.json()) as { signature: Hex; signer: `0x${string}` };

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
