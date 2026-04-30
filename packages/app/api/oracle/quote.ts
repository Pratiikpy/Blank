/**
 * /api/oracle/quote — Phase 5.7 signed price quote.
 *
 * Returns an ECDSA-signed quote that BusinessHub.payInvoiceWithOracleQuote
 * verifies on chain. Used for invoice payments where the payer wants to
 * pay in token X but the invoice settles in USDC AND no Uniswap pool
 * exists for X/USDC at the requested fee tier.
 *
 * Trust model:
 *   • The signing key (`ORACLE_PRIVATE_KEY`) lives server-side in env.
 *     The on-chain `BusinessHub.oracleAttestationAddress` is set by the
 *     contract owner to the corresponding public address. Compromise of
 *     ORACLE_PRIVATE_KEY → attacker can sign quotes that under-pay
 *     vendors. Mitigation: rotate via `setOracleAttestationAddress`,
 *     which immediately invalidates every pre-rotation signature.
 *   • Sanity bounds in the contract (ratePpm ∈ [1, 1e8]) catch wildly
 *     wrong rates even with a valid signature. So a misbehaving CoinGecko
 *     fetch can't drain the contract — the contract caps the damage.
 *
 * Backend MUST NEVER serve quotes for tokens it can't price reliably.
 * The endpoint refuses quotes outside a small allowlist (USDC + USDT +
 * stable variants) on testnet. Mainnet would expand this.
 *
 * Auth: NONE. Anyone can request a quote (the rate is public anyway).
 * Rate-limit: 60/hr per IP to discourage spam — signing is cheap but
 * each pair-fetch hits CoinGecko's free tier.
 */

import { ethers } from "ethers";

interface QuoteRequest {
  /** AA address that will be msg.sender on payInvoiceWithOracleQuote.
   *  Bound into the digest to prevent cross-payer replay. */
  payer: string;
  /** Invoice id being paid. Bound into the digest. */
  invoiceId: string;
  /** ERC-20 the payer is spending. */
  payToken: string;
  /** Caller-supplied input amount (smallest unit). */
  payAmountIn: string;
  /** Target chain id. Bound into the digest to prevent cross-chain replay. */
  chainId: number;
  /** BusinessHub proxy address. Bound into the digest to prevent
   *  cross-contract replay (e.g. if the same key signs for multiple deploys). */
  businessHub: string;
}

interface QuoteResponse {
  /** Computed expected output in USDC base units (6 decimals). */
  expectedUsdcOut: string;
  /** tokenOut-per-tokenIn rate × 1e6, as the contract expects. */
  ratePpm: string;
  /** Unix seconds; quote rejected after. */
  expiresAt: number;
  /** Random 32-byte hex; the contract uses the (payer, nonce) pair to
   *  prevent replay. */
  nonce: string;
  /** ECDSA signature, EIP-191 prefixed digest. */
  signature: string;
}

// Testnet allowlist of pay-tokens. Each entry includes the chain it
// applies to + a hardcoded testnet address. CoinGecko isn't reliable for
// testnet tokens (no real market price), so we model stable-stable pairs
// as 1:1 with no slippage. Mainnet would query a real price oracle here.
const ALLOWED_PAY_TOKENS: Array<{
  chainId: number;
  address: string;
  ratePpm: bigint;
  symbol: string;
}> = [
  // Sepolia + Base Sepolia: any of our test ERC-20s as 1:1 with USDC.
  { chainId: 11155111, address: "0x16369cd4b9533795dcdc0d67db3e4c621ef97d68", ratePpm: 1_000_000n, symbol: "TestUSDC" },
  { chainId: 84532, address: "0x6377ef23b3464019ecf35528be6eb6d6d57d0b1a", ratePpm: 1_000_000n, symbol: "TestUSDC" },
  // Add more as the operator deploys additional testnet ERC-20s. Mainnet
  // entries would replace ratePpm with a CoinGecko-fetched value.
];

const QUOTE_TTL_SECONDS = 5 * 60; // 5min — short enough that stale
                                  // quotes can't be hoarded for a price flip,
                                  // long enough that a slow user can complete
                                  // an approve + execute round-trip.

function isHexAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}

function getIp(req: any): string {
  const fwd = req.headers?.["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0]!.trim();
  if (Array.isArray(fwd) && fwd.length > 0) return fwd[0]!;
  return req.socket?.remoteAddress ?? "unknown";
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body as QuoteRequest;
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Invalid body" });
    return;
  }
  if (!isHexAddress(body.payer)) {
    res.status(400).json({ error: "payer must be a 0x-prefixed 40-char hex string" });
    return;
  }
  if (!isHexAddress(body.payToken)) {
    res.status(400).json({ error: "payToken must be a 0x-prefixed 40-char hex string" });
    return;
  }
  if (!isHexAddress(body.businessHub)) {
    res.status(400).json({ error: "businessHub must be a 0x-prefixed 40-char hex string" });
    return;
  }
  const chainId = Number(body.chainId);
  if (!Number.isInteger(chainId) || (chainId !== 11155111 && chainId !== 84532)) {
    res.status(400).json({ error: "chainId must be 11155111 or 84532" });
    return;
  }

  let payAmountIn: bigint;
  let invoiceId: bigint;
  try {
    payAmountIn = BigInt(body.payAmountIn);
    invoiceId = BigInt(body.invoiceId);
  } catch {
    res.status(400).json({ error: "payAmountIn and invoiceId must be decimal/hex bigint strings" });
    return;
  }
  if (payAmountIn <= 0n) {
    res.status(400).json({ error: "payAmountIn must be positive" });
    return;
  }

  // Per-IP rate limit. Free CoinGecko ~30 req/min — keep us well under
  // even when multiple users are quoting. Sign-cycle is cheap, so the
  // limit's about CG quota, not CPU.
  //
  // Audit Top-28 #6: previously this whole block was wrapped in a
  // try/catch that fell through silently on ANY error — module-load
  // failure, KV connection blip, etc. — leaving the endpoint completely
  // unrate-limited. In production that's a free signing oracle for any
  // attacker who can crash the rate-limit module once. We now fail
  // CLOSED in production and only fall through in dev. Module-load
  // problems must surface so they get fixed.
  try {
    const { checkRateLimit, writeRateLimitHeaders } = await import("../_lib/rate-limit.js");
    const ip = getIp(req);
    const limit = await checkRateLimit({
      ip,
      key: "oracle-quote",
      windowMs: 3_600_000,
      max: 60,
    });
    writeRateLimitHeaders(res, limit);
    if (!limit.ok) {
      res.status(429).json({ error: "rate_limited", scope: "ip" });
      return;
    }
  } catch (err) {
    const isProd = process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production";
    console.error("[oracle/quote] rate-limit module failed:", err);
    if (isProd) {
      res.status(503).json({
        error: "rate_limit_unavailable",
        hint: "Rate-limit infrastructure is unhealthy — refusing to sign quotes until it recovers.",
      });
      return;
    }
    // dev: fall through so local development isn't blocked when KV is offline
  }

  // Look up the rate. Allowlist gate prevents accidental signing for
  // tokens we don't have a reliable price for. Returns 422 (rather than
  // 404) because the request was well-formed but business logic refuses.
  const allowed = ALLOWED_PAY_TOKENS.find(
    (t) => t.chainId === chainId && t.address.toLowerCase() === body.payToken.toLowerCase(),
  );
  if (!allowed) {
    res.status(422).json({
      error: "payToken not in oracle allowlist for this chain",
      hint: "Use the Uniswap-routed payInvoiceWithSwap flow instead, or contact the operator to add this token to ALLOWED_PAY_TOKENS",
    });
    return;
  }

  // Compute expectedUsdcOut = payAmountIn * ratePpm / 1e6 (matches
  // contract's derivation). On-chain rounding is floor; we mirror that
  // here so the contract's mismatch-by-1-wei tolerance is unnecessary
  // most of the time but available when needed.
  const expectedUsdcOut = (payAmountIn * allowed.ratePpm) / 1_000_000n;
  if (expectedUsdcOut === 0n) {
    res.status(400).json({
      error: "payAmountIn too small — would round to zero USDC",
      hint: "minimum payAmountIn at this rate is 1_000_000 / ratePpm wei",
    });
    return;
  }

  // Pre-flight: oracle key configured + well-formed. We validate the
  // shape here (32-byte hex, optional 0x prefix) so a malformed key
  // returns a clean 503 instead of bubbling ethers' constructor throw
  // as a generic 500 — operators can read the error and fix the env.
  const oracleKey = process.env.ORACLE_PRIVATE_KEY;
  if (!oracleKey) {
    res.status(503).json({ error: "ORACLE_PRIVATE_KEY env var unset" });
    return;
  }
  if (!/^0x?[0-9a-fA-F]{64}$/.test(oracleKey) && !/^[0-9a-fA-F]{64}$/.test(oracleKey)) {
    res.status(503).json({
      error: "ORACLE_PRIVATE_KEY malformed — must be 32 bytes hex (64 chars, optional 0x prefix)",
    });
    return;
  }

  const expiresAt = Math.floor(Date.now() / 1000) + QUOTE_TTL_SECONDS;
  const nonce = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Build digest matching the contract's `keccak256(abi.encode(...))`
  // ordering EXACTLY — any field-order drift between server and chain
  // breaks signature verification.
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "uint256",
        "address",
        "uint256",
        "uint256",
        "uint256",
        "uint256",
        "bytes32",
        "address",
        "uint256",
        "address",
      ],
      [
        invoiceId,
        body.payToken,
        payAmountIn,
        expectedUsdcOut,
        allowed.ratePpm,
        BigInt(expiresAt),
        nonce,
        body.businessHub,
        BigInt(chainId),
        body.payer,
      ],
    ),
  );

  // EIP-191 prefix. ethers' signMessage(getBytes(digest)) adds the
  // canonical "\x19Ethereum Signed Message:\n32" prefix — same as the
  // contract's MessageHashUtils.toEthSignedMessageHash.
  const wallet = new ethers.Wallet(oracleKey);
  const signature = await wallet.signMessage(ethers.getBytes(digest));

  // ⚠️ NEVER log the digest (predictable + signed = useful to attacker).
  // Log address-level correlation only.
  console.log(
    `[oracle/quote] signed quote for payer=${body.payer.slice(0, 10)}… ` +
      `payToken=${allowed.symbol} payAmountIn=${payAmountIn.toString()} ` +
      `chainId=${chainId} expiresAt=${expiresAt}`,
  );

  const response: QuoteResponse = {
    expectedUsdcOut: expectedUsdcOut.toString(),
    ratePpm: allowed.ratePpm.toString(),
    expiresAt,
    nonce,
    signature,
  };
  res.status(200).json(response);
}
