/**
 * /api/scheduled-sends/create — Phase 4.1 stub.
 *
 * Returns a freshly-generated session-key public address. The PRIVATE
 * KEY MUST be stored server-side (KMS-grade) so the cron can sign UserOps
 * on schedule without the user being online. This endpoint is a STUB
 * for the MVP frontend wiring — it generates a keypair and returns the
 * pubkey but does NOT yet persist the private key. Calling this in
 * production today produces a session key that nobody will ever fire
 * UserOps with (because no cron is wired up yet).
 *
 * Real implementation requires:
 *   1. Per-user KMS key storage (or HSM-backed wallet)
 *   2. /api/cron/scheduled-sends-tick that walks the validator's scopes
 *      and signs+submits UserOps for due ones
 *   3. Per-scope eligibility cache so cron doesn't re-fire scope X
 *      multiple times in one tick
 *
 * Next-session work. The frontend can ship against this stub today —
 * the user gets a real session-key pubkey to register on-chain, and the
 * cron-wires-up-later flow is opaque to them.
 *
 * Auth: requires a Bearer token tied to the user's address — for the
 * MVP we accept any caller and rate-limit per IP. Future: tie to a
 * passkey-signed session token so only the AA owner can request keys
 * for their own account.
 */

import { ethers } from "ethers";

interface CreateScopeBody {
  /** Caller's main AA address. */
  account: string;
  /** Active chain id — Sepolia (11155111) or Base Sepolia (84532). */
  chainId: number;
  /** Recipient that the on-chain scope will lock the session key to.
   *  Mirrored into the row so the cron tick can build callData
   *  without an extra chain read per fire. */
  recipient: string;
  /** ERC-20 token the session key is scoped to (testnet TestUSDC). */
  spendToken: string;
  /** Friendly label for the scheduled send (e.g. "Rent — Mar"). */
  label?: string;
}

function getIp(req: any): string {
  const fwd = req.headers?.["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0]!.trim();
  if (Array.isArray(fwd) && fwd.length > 0) return fwd[0]!;
  return req.socket?.remoteAddress ?? "unknown";
}

function isHexAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body as CreateScopeBody;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  if (!isHexAddress(body.account)) {
    res.status(400).json({ error: "account must be a 0x-prefixed 40-char hex string" });
    return;
  }
  if (!isHexAddress(body.recipient)) {
    res.status(400).json({ error: "recipient must be a 0x-prefixed 40-char hex string" });
    return;
  }
  if (!isHexAddress(body.spendToken)) {
    res.status(400).json({ error: "spendToken must be a 0x-prefixed 40-char hex string" });
    return;
  }
  const chainId = Number(body.chainId);
  if (!Number.isInteger(chainId) || (chainId !== 11155111 && chainId !== 84532)) {
    res.status(400).json({ error: "chainId must be 11155111 (Sepolia) or 84532 (Base Sepolia)" });
    return;
  }

  // Per-IP rate limit: 10/hr. Generating ECDSA keys is cheap, but each
  // unused keypair takes a KMS slot in the production version of this
  // endpoint, so cap to discourage abuse.
  try {
    const { checkRateLimit, writeRateLimitHeaders } = await import("../_lib/rate-limit.js");
    const ip = getIp(req);
    const limit = await checkRateLimit({
      ip,
      key: "sched-sends-create",
      windowMs: 3_600_000,
      max: 10,
    });
    writeRateLimitHeaders(res, limit);
    if (!limit.ok) {
      res.status(429).json({ error: "rate_limited", scope: "ip" });
      return;
    }
  } catch {
    // Rate-limit module unavailable in dev — soft-fail open. Production
    // should ALWAYS have this configured.
  }

  // Generate a fresh secp256k1 keypair. ethers.Wallet.createRandom uses
  // crypto.randomBytes under the hood (RFC-compliant CSPRNG).
  const wallet = ethers.Wallet.createRandom();
  const sessionKeyAddress = wallet.address;
  const sessionKeyPrivate = wallet.privateKey;

  // Persist the encrypted private key. Errors here MUST surface as 500
  // and we MUST NOT return the keypair to the client — otherwise the
  // user thinks their scope is set up but the cron has nothing to fire
  // with. Fail closed.
  try {
    const { storeSessionKey } = await import("../_lib/session-keys-store.js");
    await storeSessionKey({
      account: body.account,
      sessionKey: sessionKeyAddress,
      privateKeyHex: sessionKeyPrivate,
      chainId,
      label: (body.label ?? "").slice(0, 64),
      recipient: body.recipient,
      spendToken: body.spendToken,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Keystore unavailable";
    // Don't leak the private key in the error path (the wallet object
    // goes out of scope here — JS GC will collect it). Return a generic
    // 5xx so the frontend can surface a retry.
    console.error(
      `[scheduled-sends/create] keystore failure for ${body.account}: ${msg}`,
    );
    res.status(503).json({
      error: "keystore unavailable — set SESSION_KEYS_MASTER_KEY + Supabase env vars",
      detail: msg.slice(0, 280),
    });
    return;
  }

  // Audit-mandated: NO plaintext-private-key logging path, ever. The
  // earlier SCHEDULED_SENDS_DEBUG opt-in was deemed too easy to leave
  // enabled by accident — Vercel logs are persistent + indexed and a
  // single mis-set env var leaks every key created in the misconfig
  // window. Address-only correlation here is sufficient for ops.
  console.log(
    `[scheduled-sends/create] persisted session key — account=${body.account}` +
      ` sessionKey=${sessionKeyAddress} chainId=${chainId} label="${(body.label ?? "(unlabeled)").slice(0, 40)}".`,
  );
  // Reference the variable so the linter doesn't flag it as unused —
  // the value falls out of scope here and JS GC reclaims it.
  void sessionKeyPrivate;

  res.status(200).json({
    sessionKey: sessionKeyAddress,
    label: body.label ?? "",
    // Cron is wired now — the frontend can stop showing the "stub" warning.
    // We still return the field for backwards compat with existing callers
    // that branch on it; the value is now `false`.
    stub: false,
  });
}
