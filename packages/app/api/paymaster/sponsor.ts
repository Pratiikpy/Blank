/**
 * /api/paymaster/sponsor: sign BlankPaymaster sponsorship for a UserOp.
 *
 * POST { chainId, userOp, account?: { ownerX, ownerY, recoveryModule?, salt? } }
 *   200 { paymasterAndData, gasFees, maxFeePerGas, maxPriorityFeePerGas, validUntil, ... }
 *   4xx { error, code }   the op is not sponsorable as built (code says why)
 *   503 { error, code }   sponsorship is not configured on this chain
 *
 * The client puts paymasterAndData and gasFees into the UserOp unchanged,
 * then computes the userOpHash and signs it with the passkey. All checks
 * live in _lib/paymaster-sponsor.ts.
 *
 * GET ?chainId=N reports whether sponsorship is ready: signer env present
 * and equal to the paymaster's verifyingSigner, caps and code hash set.
 * usePaymasterHealth reads it.
 */

function ipFromHeaders(headers: Record<string, string | string[] | undefined>): string {
  const fwd = headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0].trim();
  if (Array.isArray(fwd)) return fwd[0].split(",")[0].trim();
  return "unknown";
}

export default async function handler(req: any, res: any) {
  try {
    return await handleImpl(req, res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/paymaster/sponsor] unhandled:", err);
    res.status(500).json({ error: `sponsor crashed: ${msg}` });
  }
}

async function handleImpl(req: any, res: any) {
  const { ethers } = await import("ethers");
  const lib = await import("../_lib/paymaster-sponsor.js");
  const { getContracts } = await import("../_lib/addresses.js");

  if (req.method === "GET") {
    const chainId = Number(req.query?.chainId);
    const urls = lib.SPONSOR_RPC_URLS[chainId];
    const contracts = getContracts(chainId);
    if (!urls || !contracts) {
      res.status(400).json({ error: "unsupported chainId" });
      return;
    }
    const health: Record<string, unknown> = { chainId, paymaster: contracts.BlankPaymaster };
    try {
      const signer = lib.loadSponsorSigner();
      const provider = new ethers.JsonRpcProvider(urls[0]);
      const chain = lib.ethersSponsorChain(provider, chainId, contracts.BlankPaymaster);
      const cfg = await chain.paymasterConfig(ethers.ZeroAddress);
      const signerMatches = cfg.verifyingSigner.toLowerCase() === signer.address.toLowerCase();
      const capsSet = cfg.maxCostCap > 0n && cfg.maxFeePerGasCap > 0n;
      const codeHashSet = cfg.accountCodeHash !== ethers.ZeroHash;
      Object.assign(health, {
        ready: signerMatches && capsSet && codeHashSet,
        signerMatches,
        capsSet,
        codeHashSet,
        maxFeePerGasCap: cfg.maxFeePerGasCap.toString(),
        maxCostCap: cfg.maxCostCap.toString(),
      });
    } catch (err) {
      Object.assign(health, { ready: false, error: err instanceof Error ? err.message : String(err) });
    }
    res.setHeader?.("Cache-Control", "public, max-age=30");
    res.status(200).json(health);
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { res.status(400).json({ error: "invalid JSON body", code: "BAD_REQUEST" }); return; }
  }
  const chainId = body?.chainId;
  const urls = typeof chainId === "number" ? lib.SPONSOR_RPC_URLS[chainId] : undefined;
  const contracts = typeof chainId === "number" ? getContracts(chainId) : null;
  if (!urls || urls.length === 0 || !contracts) {
    res.status(400).json({ error: "unsupported chainId", code: "BAD_REQUEST" });
    return;
  }
  const sender = typeof body?.userOp?.sender === "string" ? body.userOp.sender.toLowerCase() : "";
  if (!ethers.isAddress(sender)) {
    res.status(400).json({ error: "invalid sender", code: "BAD_REQUEST" });
    return;
  }

  const { checkRateLimit, writeRateLimitHeaders } = await import("../_lib/rate-limit.js");
  const ip = ipFromHeaders(req.headers ?? {});
  const byIp = await checkRateLimit({ ip, key: "pm-sponsor", windowMs: 60_000, max: 20 });
  writeRateLimitHeaders(res, byIp);
  if (!byIp.ok) {
    res.status(429).json({ error: `Rate limit exceeded, try again in ${byIp.resetSeconds}s`, code: "RATE_LIMITED" });
    return;
  }
  const bySender = await checkRateLimit({ ip: `${chainId}:${sender}`, key: "pm-sponsor-sender", windowMs: 60_000, max: 10 });
  if (!bySender.ok) {
    res.status(429).json({ error: `Too many sponsored ops for this account, try again in ${bySender.resetSeconds}s`, code: "RATE_LIMITED" });
    return;
  }

  try {
    const signer = lib.loadSponsorSigner();
    const provider = new ethers.JsonRpcProvider(urls[0]);
    const chain = lib.ethersSponsorChain(provider, chainId, contracts.BlankPaymaster);
    const result = await lib.sponsorUserOp(chain, signer, { userOp: body.userOp, account: body.account });
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof lib.SponsorError) {
      if (err.retryAfterSeconds) res.setHeader?.("Retry-After", String(err.retryAfterSeconds));
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
}
