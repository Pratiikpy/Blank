/**
 * /api/mock-reclaim-sign — server-side mock proof signer for Wave 5 Offramp.
 *
 * Why this exists:
 *   The Offramp mock-mode design has a structural mismatch. The frontend's
 *   `useReclaimProof` previously had the taker (Bob) sign the proof with
 *   their own wallet, but `MockReclaimVerifier.verifyAndConsume()` recovers
 *   the signature against `operator` (the deployer key). Bob ≠ operator,
 *   so every on-chain mock-proof submission was rejected.
 *
 *   This endpoint fixes that loop. The operator's private key lives in a
 *   Vercel env var (MOCK_RECLAIM_OPERATOR_PK), the frontend POSTs the
 *   proof inputs here, and the server returns a 65-byte ECDSA signature
 *   over the EIP-191-prefixed `keccak256(abi.encode(providerId,
 *   receiverHandle, amountMicroUSD))` — exactly what the on-chain
 *   verifier recovers against.
 *
 * Trust model:
 *   - The operator key is a SERVER SECRET. Never exposed to the client.
 *   - Anyone can call this endpoint, but a successful signature only
 *     unlocks on-chain settlement for an offer that's actually been
 *     created and that the requester provides correct inputs for. The
 *     P2POfframp contract still gates state transitions on the fill
 *     state machine (Locked → ProofSubmitted → Released), so a forged
 *     proof against a fill the caller doesn't own can't drain anything
 *     they don't already control.
 *   - For mainnet, this whole endpoint goes away. Real Reclaim live
 *     mode replaces it.
 *
 * Request body (JSON):
 *   { providerId: number, receiverHandle: 0x...64hex, amountMicroUSD: string }
 *
 * Response (200):
 *   { signature: "0x<130 hex>", signer: "0x<operator address>" }
 *
 * Response (400 / 500):
 *   { error: "<reason>" }
 */

import {
  encodeAbiParameters,
  keccak256,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

interface SignRequest {
  providerId: number;
  receiverHandle: Hex;
  amountMicroUSD: string;
}

interface SignResponse {
  signature: Hex;
  signer: `0x${string}`;
}

interface ErrorResponse {
  error: string;
}

function isValidRequest(body: unknown): body is SignRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.providerId !== "number" || !Number.isInteger(b.providerId) || b.providerId < 0) return false;
  if (typeof b.receiverHandle !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.receiverHandle)) return false;
  if (typeof b.amountMicroUSD !== "string" || !/^\d+$/.test(b.amountMicroUSD)) return false;
  return true;
}

export default async function handler(
  req: { method?: string; body?: unknown },
  res: {
    status: (code: number) => { json: (body: SignResponse | ErrorResponse) => void };
  },
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const pkRaw = process.env.MOCK_RECLAIM_OPERATOR_PK;
  if (!pkRaw) {
    res.status(503).json({ error: "MOCK_RECLAIM_OPERATOR_PK env var not configured" });
    return;
  }
  const pk: Hex = pkRaw.startsWith("0x") ? (pkRaw as Hex) : (`0x${pkRaw}` as Hex);

  if (!isValidRequest(req.body)) {
    res.status(400).json({ error: "Invalid request body — expected { providerId: number, receiverHandle: 0x<64hex>, amountMicroUSD: numericString }" });
    return;
  }
  const { providerId, receiverHandle, amountMicroUSD } = req.body;

  // Reconstruct the exact hash the on-chain verifier expects.
  // Solidity: keccak256(abi.encode(uint32 providerId, bytes32 receiverHandle, uint64 amount))
  // The encoding pads each field to 32 bytes per Solidity ABI rules.
  const message = keccak256(
    encodeAbiParameters(
      [
        { type: "uint32" },
        { type: "bytes32" },
        { type: "uint64" },
      ],
      [providerId, receiverHandle, BigInt(amountMicroUSD)],
    ),
  );

  // Sign as EIP-191 personal_sign. viem's signMessage prepends
  // "\x19Ethereum Signed Message:\n32" + message before signing — matches
  // exactly what MockReclaimVerifier reconstructs in verifyAndConsume.
  try {
    const account = privateKeyToAccount(pk);
    const signature = await account.signMessage({ message: { raw: message } });
    res.status(200).json({ signature, signer: account.address });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Sign failed: ${msg}` });
  }
}
