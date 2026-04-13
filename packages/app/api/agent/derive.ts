/**
 * /api/agent/derive — server-side AI agent derivation + ECDSA attestation
 *
 * Flow:
 *   1. Frontend POSTs { user, template, context, chainId, paymentHubAddress }
 *   2. Server runs an AI provider with the template prompt, gets a number back
 *   3. Server signs (user, nonce, expiry, chainId, paymentHubAddress) with the
 *      AGENT_PRIVATE_KEY — that signature recovers to AGENT_ADDRESS on-chain
 *   4. Frontend receives { amount, agent, nonce, expiry, signature, provider }
 *   5. Frontend encrypts amount via cofhe-shim, calls sendPaymentAsAgent with
 *      the attestation params. Contract verifies ECDSA, emits AgentPaymentSubmission.
 *
 * AI providers (configurable preference, automatic fallback):
 *   - PRIMARY:   NVIDIA Kimi K2 instruct (NVIDIA_API_KEY)
 *   - FALLBACK:  Anthropic Claude opus-4-6 (ANTHROPIC_API_KEY)
 *   - At least ONE must be configured. AGENT_PRIVATE_KEY always required.
 *   - Override order via AGENT_PROVIDER_PREFERENCE=anthropic if you want
 *     Claude tried first instead.
 *
 * Trust model: the AGENT private key only ever exists server-side. Anyone can
 * inspect AGENT_ADDRESS to know which on-chain entity attested to the
 * derivation. Replay is prevented by the nonce mapping in PaymentHub.
 */

import Anthropic from "@anthropic-ai/sdk";
import { ethers } from "ethers";

// ─── AI Providers ─────────────────────────────────────────────────────

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const KIMI_MODEL = "moonshotai/kimi-k2-instruct"; // production-stable variant
const CLAUDE_MODEL = "claude-opus-4-6";

type ProviderId = "kimi" | "anthropic";

interface ProviderResult {
  provider: ProviderId;
  text: string;
}

async function runKimi(prompt: string): Promise<ProviderResult> {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error("NVIDIA_API_KEY not set");

  const res = await fetch(NVIDIA_BASE_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({
      model: KIMI_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 50,
      temperature: 0.0,
      stream: false,
    }),
    // Soft cap so a hung NVIDIA call doesn't block the whole request — the
    // fallback path takes over instead.
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Kimi HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as any;
  const text = json?.choices?.[0]?.message?.content ?? "";
  if (!text) throw new Error("Kimi returned empty content");
  return { provider: "kimi", text };
}

async function runAnthropic(prompt: string): Promise<ProviderResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 50,
    messages: [{ role: "user", content: prompt }],
  });
  const block = response.content[0];
  const text = block && block.type === "text" ? block.text : "";
  if (!text) throw new Error("Anthropic returned empty content");
  return { provider: "anthropic", text };
}

/**
 * Try providers in preference order. Returns first success.
 * If both fail, throws a combined error so the caller can surface details.
 */
async function runAgent(prompt: string): Promise<ProviderResult> {
  // Preference: kimi first by default. Override via env to debug Claude.
  const preference =
    process.env.AGENT_PROVIDER_PREFERENCE === "anthropic"
      ? (["anthropic", "kimi"] as const)
      : (["kimi", "anthropic"] as const);

  const errors: string[] = [];
  for (const id of preference) {
    try {
      if (id === "kimi") return await runKimi(prompt);
      if (id === "anthropic") return await runAnthropic(prompt);
    } catch (err) {
      errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`All AI providers failed — ${errors.join(" | ")}`);
}

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

  // Required env vars: at least one AI provider key + the agent signing key.
  const agentKey = process.env.AGENT_PRIVATE_KEY;
  const hasKimi = !!process.env.NVIDIA_API_KEY;
  const hasClaude = !!process.env.ANTHROPIC_API_KEY;
  if (!agentKey) {
    res.status(500).json({ error: "Server not configured — missing AGENT_PRIVATE_KEY" });
    return;
  }
  if (!hasKimi && !hasClaude) {
    res.status(500).json({ error: "Server not configured — set at least one of NVIDIA_API_KEY (Kimi) or ANTHROPIC_API_KEY (Claude)" });
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

  // Run AI provider — Kimi primary, Anthropic fallback (or reversed if env override).
  let amount: bigint;
  let rawText: string;
  let providerUsed: ProviderId;
  try {
    const result = await runAgent(tpl.buildPrompt({ context }));
    rawText = result.text;
    providerUsed = result.provider;
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
    provider: providerUsed,
    model: providerUsed === "kimi" ? KIMI_MODEL : CLAUDE_MODEL,
  });
}
