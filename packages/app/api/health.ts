/**
 * /api/health — backend feature-flag report
 *
 * Returns a JSON body listing which server-dependent features are
 * actually configured + an overall HTTP status:
 *
 *   200 — all required env present, both AA + AI agents fully wired
 *   207 — partial: app works, but some features will return errors
 *         (one of {ANTHROPIC_API_KEY, AGENT_PRIVATE_KEY, RELAYER_PRIVATE_KEY} missing)
 *   503 — no server-side keys at all; AA + agents fully unavailable
 *
 * Use cases:
 *   - Vercel deploy preview: hit /api/health to know what's safe to demo
 *   - Frontend feature flags: fetch on app boot to gray out broken buttons
 *   - Monitoring: page on 503 in prod
 *
 * Never returns the actual env values — only "set" / "missing" booleans.
 */

interface FeatureStatus {
  required: boolean;
  set: boolean;
  envVar: string;
  feature: string;
}

/**
 * Poll a URL with a short timeout. Returns true if the URL responds with
 * ANY HTTP status (including 4xx) — we only care that the network is
 * reachable, not that we have auth for the endpoint.
 */
async function probe(url: string, timeoutMs = 3000): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export default async function handler(_req: any, res: any) {
  const features: FeatureStatus[] = [
    {
      envVar: "NVIDIA_API_KEY",
      set: !!process.env.NVIDIA_API_KEY,
      required: false,
      feature: "AI agent derivation — Kimi K2 instruct (PRIMARY)",
    },
    {
      envVar: "ANTHROPIC_API_KEY",
      set: !!process.env.ANTHROPIC_API_KEY,
      required: false,
      feature: "AI agent derivation — Claude opus-4-6 (FALLBACK)",
    },
    {
      envVar: "AGENT_PRIVATE_KEY",
      set: !!process.env.AGENT_PRIVATE_KEY,
      required: false,
      feature: "Agent ECDSA attestation signing (required for /api/agent/derive)",
    },
    {
      envVar: "RELAYER_PRIVATE_KEY",
      set: !!process.env.RELAYER_PRIVATE_KEY,
      required: false,
      feature: "ERC-4337 UserOp relay (/api/relay, smart wallet shield/send)",
    },
    {
      envVar: "SEPOLIA_RPC_URL",
      set: !!process.env.SEPOLIA_RPC_URL,
      required: false,
      feature: "Eth Sepolia RPC (private — public nodes have nonce races)",
    },
    {
      envVar: "BASE_SEPOLIA_RPC_URL",
      set: !!process.env.BASE_SEPOLIA_RPC_URL,
      required: false,
      feature: "Base Sepolia RPC (private)",
    },
  ];

  const missingRequired = features.filter((f) => f.required && !f.set);
  const missingOptional = features.filter((f) => !f.required && !f.set);

  const allOptionalSet = missingOptional.length === 0;
  const someOptionalSet = features.some((f) => !f.required && f.set);

  let httpStatus: number;
  let summary: string;

  if (missingRequired.length > 0) {
    httpStatus = 503;
    summary = `Missing required env: ${missingRequired.map((f) => f.envVar).join(", ")}`;
  } else if (allOptionalSet) {
    httpStatus = 200;
    summary = "All features configured.";
  } else if (someOptionalSet) {
    httpStatus = 207;
    summary = `Partial: ${missingOptional.length} optional feature(s) disabled. Frontend EOA path still works.`;
  } else {
    httpStatus = 503;
    summary = "No server-side env vars set. AA + AI agents unavailable. Frontend EOA path still works.";
  }

  // Derived feature flags — what the frontend should actually expect to work.
  const agentsReachable =
    !!process.env.AGENT_PRIVATE_KEY &&
    (!!process.env.NVIDIA_API_KEY || !!process.env.ANTHROPIC_API_KEY);
  const relayReachable =
    !!process.env.RELAYER_PRIVATE_KEY &&
    !!process.env.SEPOLIA_RPC_URL &&
    !!process.env.BASE_SEPOLIA_RPC_URL;

  // Layer 8 + 12: probe external dependencies in parallel. Doesn't fail
  // the request — just reports liveness so frontend can show a "FHE
  // network degraded" banner and judges can see what's green/red.
  const [cofheProbe, verifierProbe, tnProbe] = await Promise.all([
    probe("https://testnet-cofhe.fhenix.zone"),
    probe("https://testnet-cofhe-vrf.fhenix.zone"),
    probe("https://testnet-cofhe-tn.fhenix.zone"),
  ]);

  const fhenixReachable = cofheProbe.ok && verifierProbe.ok && tnProbe.ok;

  res.status(httpStatus).json({
    status: httpStatus === 200 ? "ok" : httpStatus === 207 ? "partial" : "degraded",
    summary,
    features,
    derived: {
      agentsReachable,
      relayReachable,
      agentPrimary: process.env.NVIDIA_API_KEY ? "kimi-k2-instruct" : "claude-opus-4-6",
      agentFallback: process.env.NVIDIA_API_KEY && process.env.ANTHROPIC_API_KEY
        ? "claude-opus-4-6"
        : "none",
      fhenixReachable,
    },
    fhenix: {
      cofhe: cofheProbe,
      verifier: verifierProbe,
      thresholdNetwork: tnProbe,
    },
    missingRequired: missingRequired.map((f) => f.envVar),
    missingOptional: missingOptional.map((f) => f.envVar),
    timestamp: new Date().toISOString(),
  });
}
