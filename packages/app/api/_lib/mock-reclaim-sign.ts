/**
 * Mock Reclaim proof signer — Wave 5.5
 *
 * The on-chain `MockReclaimVerifier.verifyAndConsume` recovers an ECDSA
 * signature against the contract's `operator` address (= deployer key).
 * The frontend's prior wallet-sign path always failed because the taker
 * (Bob) is not the operator. This helper signs the canonical message
 * with the operator PK so the on-chain check actually passes.
 *
 * Lives in `_lib/` (not as a standalone function) because Vercel Hobby
 * plan caps at 12 serverless functions and we hit that ceiling. Called
 * from `/api/relay` when the request body carries `kind: "mock-reclaim-sign"`.
 *
 * Trust model:
 *   - Operator PK is a SERVER SECRET in MOCK_RECLAIM_OPERATOR_PK env.
 *   - A successful signature only unlocks settlement for a P2POfframp
 *     fill that the requester has already locked on-chain — the state
 *     machine still gates everything; this just produces the
 *     attestation Bob would otherwise get from real Reclaim Protocol.
 *   - Goes away for mainnet, replaced by Reclaim live mode.
 */

import {
  encodeAbiParameters,
  keccak256,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

interface MockSignRequest {
  kind: "mock-reclaim-sign";
  providerId: number;
  receiverHandle: Hex;
  amountMicroUSD: string;
}

function isValid(body: unknown): body is MockSignRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.kind !== "mock-reclaim-sign") return false;
  if (typeof b.providerId !== "number" || !Number.isInteger(b.providerId) || b.providerId < 0) return false;
  if (typeof b.receiverHandle !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(b.receiverHandle)) return false;
  if (typeof b.amountMicroUSD !== "string" || !/^\d+$/.test(b.amountMicroUSD)) return false;
  return true;
}

export async function handleMockReclaimSign(
  body: unknown,
  res: {
    status: (code: number) => { json: (body: object) => void };
  },
): Promise<void> {
  const pkRaw = process.env.MOCK_RECLAIM_OPERATOR_PK;
  if (!pkRaw) {
    res.status(503).json({ error: "MOCK_RECLAIM_OPERATOR_PK env var not configured" });
    return;
  }
  const pk: Hex = pkRaw.startsWith("0x") ? (pkRaw as Hex) : (`0x${pkRaw}` as Hex);

  if (!isValid(body)) {
    res.status(400).json({
      error: "Invalid request — expected { kind:'mock-reclaim-sign', providerId:number, receiverHandle:0x<64hex>, amountMicroUSD:numericString }",
    });
    return;
  }

  const message = keccak256(
    encodeAbiParameters(
      [
        { type: "uint32" },
        { type: "bytes32" },
        { type: "uint64" },
      ],
      [body.providerId, body.receiverHandle, BigInt(body.amountMicroUSD)],
    ),
  );

  try {
    const account = privateKeyToAccount(pk);
    const signature = await account.signMessage({ message: { raw: message } });
    res.status(200).json({ signature, signer: account.address });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `Sign failed: ${msg}` });
  }
}
