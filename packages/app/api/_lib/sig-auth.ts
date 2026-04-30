/**
 * Wallet-signed auth for the email-trigger endpoints.
 *
 * The /api/invoices/send-email and /api/requests/send-email endpoints
 * trigger Resend emails on behalf of the row's owner. Without auth, an
 * attacker who learns an invoice ID could spam the client's inbox with
 * fake "your invoice is ready" messages — annoying, free, and
 * essentially undetectable. Wallet-signed auth proves the caller
 * controls the address that owns the invoice.
 *
 * Verification is via viem's `publicClient.verifyMessage`, which
 * transparently handles BOTH:
 *   • EOA signatures — viem does ecrecover and matches against the
 *     claimed address.
 *   • ERC-1271 contract signatures — viem calls `isValidSignature`
 *     on the signer address and checks the magic value `0x1626ba7e`.
 *     Our `BlankAccount.sol` implements this for passkey AAs, so a
 *     passkey-signed message verifies correctly here.
 *
 * Replay protection: the message contains a unix-second timestamp;
 * we reject anything outside `SIGNATURE_WINDOW_SECONDS`. A signature
 * captured by an attacker after the window expires cannot be replayed.
 */
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { sepolia, baseSepolia } from "viem/chains";

import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID } from "./addresses";

/** Max age (seconds) of a signature timestamp before we reject it.
 *
 *  Audit Top-28 #14: tightened from 5 min → 90s. The signature carries no
 *  nonce, so the sole replay defence is the time window. A 5-min budget
 *  let an attacker who scraped a signature from a CSP report or a leaked
 *  log replay it for many minutes. 90s is a generous round-trip allowance
 *  (typical wallet sign + network latency is sub-5s) while shrinking the
 *  attacker's window an order of magnitude. We also tolerate 30s of clock
 *  skew in the future direction (see verifyMessageTimestamp).
 */
export const SIGNATURE_WINDOW_SECONDS = 90;

const cachedClients = new Map<number, PublicClient>();

function getPublicClient(chainId: number): PublicClient | null {
  if (cachedClients.has(chainId)) return cachedClients.get(chainId)!;

  let client: PublicClient | null = null;
  if (chainId === ETH_SEPOLIA_ID) {
    const rpc = process.env.SEPOLIA_RPC_URL;
    client = createPublicClient({
      chain: sepolia,
      transport: rpc ? http(rpc) : http(),
    }) as unknown as PublicClient;
  } else if (chainId === BASE_SEPOLIA_ID) {
    const rpc = process.env.BASE_SEPOLIA_RPC_URL;
    client = createPublicClient({
      chain: baseSepolia,
      transport: rpc ? http(rpc) : http(),
    }) as unknown as PublicClient;
  }
  if (client) cachedClients.set(chainId, client);
  return client;
}

export interface VerifyOwnerSignatureArgs {
  /** Chain on which the signer's contract lives (matters only for ERC-1271). */
  chainId: number;
  /** Claimed signer address — verified against the message + sig. */
  signer: Address;
  /** Plain-text message that was signed. The verifier prefixes it
   *  with the EIP-191 personal-sign envelope automatically. */
  message: string;
  /** 65-byte EOA sig OR opaque ERC-1271 contract-sig bytes. */
  signature: Hex;
}

export async function verifyOwnerSignature(
  args: VerifyOwnerSignatureArgs,
): Promise<{ ok: boolean; reason?: string }> {
  const client = getPublicClient(args.chainId);
  if (!client) {
    return { ok: false, reason: `unsupported chainId ${args.chainId}` };
  }
  try {
    const ok = await client.verifyMessage({
      address: args.signer,
      message: args.message,
      signature: args.signature,
    });
    return ok ? { ok: true } : { ok: false, reason: "signature does not verify against claimed signer" };
  } catch (err) {
    // Common error modes:
    //   • Signer is a non-1271 contract (no isValidSignature method) → revert
    //   • RPC down / unreachable
    //   • Malformed sig bytes
    return {
      ok: false,
      reason: err instanceof Error ? err.message.slice(0, 240) : "verifier threw",
    };
  }
}

/** Build the canonical message bytes for an invoice-email request.
 *  Both client + server compute this identically. */
export function buildInvoiceEmailMessage(args: {
  invoiceId: number;
  recipient: string;
  signedAt: number;
  chainId: number;
}): string {
  return [
    "Blank: send invoice email",
    `invoiceId: ${args.invoiceId}`,
    `recipient: ${args.recipient.toLowerCase()}`,
    `chainId: ${args.chainId}`,
    `signedAt: ${args.signedAt}`,
  ].join("\n");
}

/** Build the canonical message bytes for a payment-request email. */
export function buildRequestEmailMessage(args: {
  requestId: number;
  recipient: string;
  signedAt: number;
  chainId: number;
}): string {
  return [
    "Blank: send payment-request email",
    `requestId: ${args.requestId}`,
    `recipient: ${args.recipient.toLowerCase()}`,
    `chainId: ${args.chainId}`,
    `signedAt: ${args.signedAt}`,
  ].join("\n");
}

/** Whether strict-auth is enabled. When unset, endpoints accept
 *  unsigned requests (with a server-side warning) for backward compat
 *  during rollout. Set to "1" in production env to require signatures. */
export function strictEmailAuthEnabled(): boolean {
  return process.env.STRICT_EMAIL_AUTH === "1";
}

/** Tolerate clients whose clocks are slightly fast.
 *  60s is plenty for typical NTP drift; anything more suggests an attacker
 *  trying to expand the replay window. */
const FUTURE_CLOCK_SKEW_TOLERANCE_SECONDS = 60;

/** Common timestamp-window check + boolean status. Returns null on success,
 *  a 4xx reason string on failure.
 *
 *  Audit Top-28 #14: previously this used Math.abs(now - signedAt) which
 *  is symmetric — a 5-min-old signature was accepted just as readily as
 *  a 5-min-future one. Replay risk is asymmetric: a stolen old signature
 *  is what attackers reuse, so the past-window matters most. We now bound
 *  the past by SIGNATURE_WINDOW_SECONDS (90s) and the future by a small
 *  clock-skew tolerance (60s), shrinking the attacker's effective window
 *  by ~3× without breaking signers whose clocks lead by a few seconds. */
export function checkTimestampWindow(signedAt: unknown): string | null {
  if (typeof signedAt !== "number" || !Number.isFinite(signedAt)) {
    return "signedAt must be a unix-seconds number";
  }
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = now - signedAt;
  if (ageSeconds > SIGNATURE_WINDOW_SECONDS) {
    return `signedAt is too old (max ${SIGNATURE_WINDOW_SECONDS}s; server now=${now}, signed=${signedAt})`;
  }
  if (ageSeconds < -FUTURE_CLOCK_SKEW_TOLERANCE_SECONDS) {
    return `signedAt is too far in the future (max ${FUTURE_CLOCK_SKEW_TOLERANCE_SECONDS}s skew; server now=${now}, signed=${signedAt})`;
  }
  return null;
}
