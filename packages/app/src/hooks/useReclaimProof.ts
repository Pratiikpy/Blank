import { useCallback, useState } from "react";
import { keccak256, toBytes, encodeAbiParameters, type Hex } from "viem";
import { useSignMessage, useAccount } from "wagmi";

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

/**
 * Compute the EIP-191 personal-sign message that MockReclaimVerifier
 * reconstructs. Used by the mock path so the same connected wallet
 * that the MockReclaimVerifier was initialized with can produce a
 * valid signature off-chain.
 *
 * NOTE: in production this would NEVER be the taker's wallet — the
 * MockReclaimVerifier ships with operator=address(0) (disabled) and
 * all proofs go through the real Reclaim SDK. The mock path here is
 * for testnet flows where the connected wallet IS the configured
 * operator (single-user demos / hardhat tests).
 */
function buildMockMessage(req: ReclaimProofRequest): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint32" },
        { type: "bytes32" },
        { type: "uint64" },
      ],
      [req.providerId, req.receiverHandle as Hex, req.amountMicroUSD],
    ),
  );
}

export function useReclaimProof(mode: ReclaimMode = ENV_MODE) {
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
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

        if (!address) throw new Error("Connect a wallet to sign the mock proof.");

        const messageHash = buildMockMessage(req);
        setState("proving");
        const signature = await signMessageAsync({
          message: { raw: messageHash },
        });

        const proof = signature as Hex;
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
    [address, mode, signMessageAsync],
  );

  const reset = useCallback(() => {
    setError(null);
    setState("idle");
  }, []);

  return { mode, state, error, requestProof, reset };
}
