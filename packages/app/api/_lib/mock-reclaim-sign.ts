/**
 * Mock Reclaim proof signer (testnet only).
 *
 * MockReclaimVerifier.verifyAndConsume recovers an EIP-191 signature over
 *   keccak256(abi.encode(uint256 chainId, address verifier, address offramp,
 *     uint64 fillId, address taker, uint32 providerId,
 *     bytes32 receiverHandle, uint64 amountMicroUSD))
 * and requires the signer to be the verifier's `operator`. The operator key
 * is a server secret (MOCK_RECLAIM_OPERATOR_PK), so the taker cannot sign
 * this themselves.
 *
 * The client sends only { chainId, offramp, fillId }. Every bound field is
 * read from the chain, so the server never signs a value the caller chose:
 *   - fill must exist and be Locked
 *   - taker, amount come from getFill
 *   - providerId is the offer's rail, receiver is the offer's handle hash
 *   - verifier is offramp.reclaimAdapter().verifier()
 * The digest is then cross-checked against verifier.attestationDigest so a
 * layout drift fails here instead of on-chain.
 *
 * A signature for an unofficial offramp address is useless against the real
 * one: the digest binds the offramp, and the adapter only accepts calls from
 * allowlisted offramps.
 *
 * Lives in `_lib/` and is called from `/api/relay` with
 * `kind: "mock-reclaim-sign"` because of the Vercel function cap.
 */

import {
  createPublicClient,
  encodeAbiParameters,
  http,
  keccak256,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { RPC_URLS } from "./addresses.js";

const FILL_STATE_LOCKED = 0;

const OFFRAMP_ABI = [
  { type: "function", name: "getFill", stateMutability: "view", inputs: [{ name: "fillId", type: "uint64" }], outputs: [
    { name: "offerId", type: "uint64" },
    { name: "taker", type: "address" },
    { name: "fiatAmountAtLockMicroUSD", type: "uint64" },
    { name: "lockedAt", type: "uint32" },
    { name: "proofSubmittedAt", type: "uint32" },
    { name: "reclaimProofHash", type: "bytes32" },
    { name: "state", type: "uint8" },
  ] },
  { type: "function", name: "getOffer", stateMutability: "view", inputs: [{ name: "offerId", type: "uint64" }], outputs: [
    { name: "maker", type: "address" },
    { name: "vault", type: "address" },
    { name: "fiatAmountMicroUSD", type: "uint64" },
    { name: "fiatRateMicroUSD", type: "uint64" },
    { name: "fiatRail", type: "uint32" },
    { name: "makerHandleHash", type: "bytes32" },
    { name: "expiry", type: "uint32" },
    { name: "state", type: "uint8" },
  ] },
  { type: "function", name: "nextFillId", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "reclaimAdapter", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

const ADAPTER_ABI = [
  { type: "function", name: "verifier", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

const VERIFIER_ABI = [
  { type: "function", name: "operator", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "attestationDigest", stateMutability: "view", inputs: [
    { name: "offramp", type: "address" },
    { name: "fillId", type: "uint64" },
    { name: "taker", type: "address" },
    { name: "providerId", type: "uint32" },
    { name: "expectedReceiver", type: "bytes32" },
    { name: "expectedAmount", type: "uint64" },
  ], outputs: [{ name: "", type: "bytes32" }] },
] as const;

export interface MockSignRequest {
  kind: "mock-reclaim-sign";
  chainId: number;
  offramp: `0x${string}`;
  fillId: string;
}

export function isValidMockSignRequest(body: unknown): body is MockSignRequest {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.kind !== "mock-reclaim-sign") return false;
  if (typeof b.chainId !== "number" || !RPC_URLS[b.chainId]) return false;
  if (typeof b.offramp !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(b.offramp)) return false;
  if (typeof b.fillId !== "string" || !/^\d{1,20}$/.test(b.fillId)) return false;
  return BigInt(b.fillId) < 2n ** 64n;
}

/** Digest the MockReclaimVerifier expects. Exported for tests. */
export function mockReclaimDigest(p: {
  chainId: number;
  verifier: `0x${string}`;
  offramp: `0x${string}`;
  fillId: bigint;
  taker: `0x${string}`;
  providerId: number;
  receiverHandle: Hex;
  amountMicroUSD: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint64" },
        { type: "address" },
        { type: "uint32" },
        { type: "bytes32" },
        { type: "uint64" },
      ],
      [
        BigInt(p.chainId),
        p.verifier,
        p.offramp,
        p.fillId,
        p.taker,
        p.providerId,
        p.receiverHandle,
        p.amountMicroUSD,
      ],
    ),
  );
}

type Res = { status: (code: number) => { json: (body: object) => void } };

export async function handleMockReclaimSign(body: unknown, res: Res): Promise<void> {
  const pkRaw = process.env.MOCK_RECLAIM_OPERATOR_PK;
  if (!pkRaw) {
    res.status(503).json({ error: "MOCK_RECLAIM_OPERATOR_PK env var not configured" });
    return;
  }
  const pk: Hex = pkRaw.startsWith("0x") ? (pkRaw as Hex) : (`0x${pkRaw}` as Hex);

  if (!isValidMockSignRequest(body)) {
    res.status(400).json({
      error:
        "Invalid request. Expected { kind:'mock-reclaim-sign', chainId:<supported chain>, offramp:0x<40hex>, fillId:numericString }",
    });
    return;
  }

  const fillId = BigInt(body.fillId);
  const client = createPublicClient({ transport: http(RPC_URLS[body.chainId]) });

  try {
    const nextFillId = await client.readContract({ address: body.offramp, abi: OFFRAMP_ABI, functionName: "nextFillId" });
    if (fillId >= nextFillId) {
      res.status(404).json({ error: `Fill #${fillId} does not exist.` });
      return;
    }
    const fill = await client.readContract({ address: body.offramp, abi: OFFRAMP_ABI, functionName: "getFill", args: [fillId] });
    const [offerId, taker, amountMicroUSD, , , , state] = fill;
    if (state !== FILL_STATE_LOCKED) {
      res.status(409).json({ error: `Fill #${fillId} is not awaiting a payment proof.` });
      return;
    }
    const offer = await client.readContract({ address: body.offramp, abi: OFFRAMP_ABI, functionName: "getOffer", args: [offerId] });
    const providerId = offer[4];
    const receiverHandle = offer[5];

    const adapter = await client.readContract({ address: body.offramp, abi: OFFRAMP_ABI, functionName: "reclaimAdapter" });
    const verifier = await client.readContract({ address: adapter, abi: ADAPTER_ABI, functionName: "verifier" });

    const account = privateKeyToAccount(pk);
    const operator = await client.readContract({ address: verifier, abi: VERIFIER_ABI, functionName: "operator" });
    if (operator.toLowerCase() !== account.address.toLowerCase()) {
      res.status(503).json({ error: "Server key is not the verifier operator on this chain." });
      return;
    }

    const digest = mockReclaimDigest({
      chainId: body.chainId,
      verifier,
      offramp: body.offramp,
      fillId,
      taker,
      providerId,
      receiverHandle,
      amountMicroUSD,
    });
    const onChainDigest = await client.readContract({
      address: verifier,
      abi: VERIFIER_ABI,
      functionName: "attestationDigest",
      args: [body.offramp, fillId, taker, providerId, receiverHandle, amountMicroUSD],
    });
    if (onChainDigest.toLowerCase() !== digest.toLowerCase()) {
      res.status(500).json({ error: "Attestation layout mismatch with the deployed verifier." });
      return;
    }

    const signature = await account.signMessage({ message: { raw: digest } });
    res.status(200).json({
      signature,
      signer: account.address,
      providerId,
      taker,
      amountMicroUSD: amountMicroUSD.toString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Could not read the fill on-chain: ${msg.slice(0, 200)}` });
  }
}
