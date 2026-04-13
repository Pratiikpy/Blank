/**
 * /api/agent/derive — server-side AI agent derivation + ECDSA attestation
 *
 * Flow:
 *   1. Frontend POSTs { user, template, context, chainId, paymentHubAddress }
 *   2. Server runs Claude with a template-specific prompt, gets a number back
 *   3. Server signs (user, nonce, expiry, chainId, paymentHubAddress) with the
 *      AGENT_PRIVATE_KEY — that signature recovers to AGENT_ADDRESS on-chain
 *   4. Frontend receives { amount, agent, nonce, expiry, signature }
 *   5. Frontend encrypts amount via cofhe-shim, calls sendPaymentAsAgent with
 *      the attestation params. Contract verifies ECDSA, emits AgentPaymentSubmission.
 *
 * Trust model: the AGENT private key only ever exists server-side. Anyone can
 * inspect AGENT_ADDRESS to know which on-chain entity attested to the
 * derivation. Replay is prevented by the nonce mapping in PaymentHub.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ethers } from "ethers";

// ─── Templates ────────────────────────────────────────────────────────
// Each template knows how to (a) build a prompt for Claude and (b) parse
// the model's reply into a uint64 USDC amount (6 decimals).

interface Template {
  buildPrompt: (ctx: { context: string }) => string;
  parseResponse: (raw: string) => bigint;
}

const TEMPLATES: Record<string, Template> = {
  payroll_line: {
    buildPrompt: ({ context }) => `You are a payroll-derivation agent. Read the role + region
context and return ONE single number — the appropriate monthly USDC salary in
6-decimal integer form (e.g. 5000 USDC = 5000000000). No explanation, no
currency symbol, no commas, no decimals — JUST the integer.

Context:
${context}

Output:`,
    parseResponse: (raw) => {
      const match = raw.trim().match(/-?\d+/);
      if (!match) throw new Error("Could not parse number from agent response");
      const n = BigInt(match[0]);
      if (n <= 0n) throw new Error("Agent returned non-positive amount");
      // Cap at uint64 max to be safe before encryption
      const MAX = (1n << 64n) - 1n;
      if (n > MAX) throw new Error("Agent amount exceeds uint64 max");
      return n;
    },
  },
  expense_share: {
    buildPrompt: ({ context }) => `You are a group-expense splitting agent. Read the receipt
and split context, return ONE single number — this person's share in 6-decimal
USDC integer form. No explanation, no symbol, no commas — JUST the integer.

Context:
${context}

Output:`,
    parseResponse: (raw) => {
      const match = raw.trim().match(/-?\d+/);
      if (!match) throw new Error("Could not parse number from agent response");
      const n = BigInt(match[0]);
      if (n < 0n) throw new Error("Agent returned negative share");
      return n;
    },
  },
};

// ─── In-memory rate limit (5 req / IP / minute) ───────────────────────
// Vercel cold starts wipe this — fine for hackathon scope. Move to Redis
// (Vercel KV) before production.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 5;
const rateMap = new Map<string, number[]>();

function ipFromHeaders(req: { headers: Record<string, string | string[] | undefined> }) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0].trim();
  if (Array.isArray(fwd)) return fwd[0].split(",")[0].trim();
  return "unknown";
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const calls = (rateMap.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (calls.length >= RATE_MAX) {
    rateMap.set(ip, calls);
    return true;
  }
  rateMap.set(ip, [...calls, now]);
  return false;
}

// ─── Handler ──────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Rate limit by IP
  const ip = ipFromHeaders(req);
  if (rateLimited(ip)) {
    res.status(429).json({ error: "Rate limit exceeded — try again in a minute" });
    return;
  }

  // Required env vars
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const agentKey = process.env.AGENT_PRIVATE_KEY;
  if (!apiKey || !agentKey) {
    res.status(500).json({ error: "Server not configured — missing ANTHROPIC_API_KEY or AGENT_PRIVATE_KEY" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }
  }
  const { user, template, context, chainId, paymentHubAddress } = body ?? {};

  // Validate
  if (!user || typeof user !== "string" || !ethers.isAddress(user)) {
    res.status(400).json({ error: "Invalid `user` address" });
    return;
  }
  if (!paymentHubAddress || !ethers.isAddress(paymentHubAddress)) {
    res.status(400).json({ error: "Invalid `paymentHubAddress`" });
    return;
  }
  if (typeof chainId !== "number" || chainId <= 0) {
    res.status(400).json({ error: "Invalid `chainId`" });
    return;
  }
  if (typeof template !== "string" || !TEMPLATES[template]) {
    res.status(400).json({ error: `Unknown template — must be one of ${Object.keys(TEMPLATES).join(", ")}` });
    return;
  }
  if (typeof context !== "string" || context.length === 0 || context.length > 4_000) {
    res.status(400).json({ error: "`context` must be a 1..4000 char string" });
    return;
  }

  const tpl = TEMPLATES[template];

  // Run Claude
  let amount: bigint;
  let rawText: string;
  try {
    const anthropic = new Anthropic({ apiKey });
    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 50,
      messages: [{ role: "user", content: tpl.buildPrompt({ context }) }],
    });
    const block = response.content[0];
    rawText = block && block.type === "text" ? block.text : "";
    amount = tpl.parseResponse(rawText);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Agent derivation failed";
    res.status(502).json({ error: `Agent failed: ${msg}` });
    return;
  }

  // Sign attestation
  const wallet = new ethers.Wallet(agentKey);
  const nonce = ethers.hexlify(ethers.randomBytes(32));
  const expiry = Math.floor(Date.now() / 1000) + 600; // 10 minutes

  const innerHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "bytes32", "uint256", "uint256", "address"],
      [user, nonce, expiry, chainId, paymentHubAddress],
    ),
  );
  const signature = await wallet.signMessage(ethers.getBytes(innerHash));

  res.status(200).json({
    amount: amount.toString(),
    agent: wallet.address,
    nonce,
    expiry,
    signature,
    raw: rawText,
    template,
  });
}
