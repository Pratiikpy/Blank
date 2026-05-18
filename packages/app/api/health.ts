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

export default async function handler(req: any, res: any) {
  // Dispatcher: /api/health?kind=relayer routes to relayer-balance probe.
  // Kept inline to stay under Vercel Hobby's 12-function cap (consolidated
  // from former /api/relayer-health endpoint; vercel.json rewrites the
  // old URL to this kind switch).
  const kind = typeof req.query?.kind === "string" ? req.query.kind : "";
  if (kind === "relayer") {
    return handleRelayer(req, res);
  }

  const features: FeatureStatus[] = [
    {
      envVar: "NVIDIA_API_KEY",
      set: !!process.env.NVIDIA_API_KEY,
      required: false,
      feature: "AI agent derivation, Kimi K2 instruct (PRIMARY)",
    },
    {
      envVar: "ANTHROPIC_API_KEY",
      set: !!process.env.ANTHROPIC_API_KEY,
      required: false,
      feature: "AI agent derivation, Claude opus-4-6 (FALLBACK)",
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
      feature: "Eth Sepolia RPC (private; public nodes have nonce races)",
    },
    {
      envVar: "BASE_SEPOLIA_RPC_URL",
      set: !!process.env.BASE_SEPOLIA_RPC_URL,
      required: false,
      feature: "Base Sepolia RPC (private)",
    },
    {
      envVar: "RESEND_API_KEY",
      set: !!process.env.RESEND_API_KEY,
      required: false,
      feature: "Transactional email via Resend (invoices, payment requests, reminders)",
    },
    {
      envVar: "EMAIL_FROM",
      set: !!process.env.EMAIL_FROM,
      required: false,
      feature: "Default From address for outbound email (e.g. \"Blank <invoices@blank.app>\")",
    },
    {
      envVar: "PINATA_JWT",
      set: !!process.env.PINATA_JWT,
      required: false,
      feature: "Pinata IPFS pinning (server-side uploads for invoice PDFs, escrow files)",
    },
    {
      envVar: "VAPID_PUBLIC_KEY",
      set: !!process.env.VAPID_PUBLIC_KEY,
      required: false,
      feature: "Web Push VAPID public key (must match VITE_VAPID_PUBLIC_KEY shipped to client)",
    },
    {
      envVar: "VAPID_PRIVATE_KEY",
      set: !!process.env.VAPID_PRIVATE_KEY,
      required: false,
      feature: "Web Push VAPID private key (signs notifications to push services)",
    },
    {
      envVar: "PUSH_NOTIFY_SECRET",
      set: !!process.env.PUSH_NOTIFY_SECRET,
      required: false,
      feature: "Bearer secret protecting /api/push/notify (set on Supabase webhook + Vercel)",
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

// ─── /api/health?kind=relayer ──────────────────────────────────────
// Exposes relayer + paymaster ETH balances per chain. Used by ops and
// the optional Slack alert cron to know when to refill. Frontend can
// also call this to disable smart-wallet flows when the relayer is
// underwater (graceful degradation).
//
// Returns 200 always (never blocks the frontend); status field reports
// health verbally so callers can branch.
//
// Lazy-import ethers + _lib/signer inside the handler so any module-
// load failure is caught by the outer try/catch and surfaced as JSON,
// not as Vercel's opaque FUNCTION_INVOCATION_FAILED.

async function handleRelayer(req: any, res: any) {
  try {
    return await relayerImpl(req, res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/health?kind=relayer] unhandled:", err);
    res.status(500).json({ error: `relayer-health crashed: ${msg}` });
    return;
  }
}

async function relayerImpl(_req: any, res: any) {
  const ethers = await import("ethers");
  const { getSigner } = await import("./_lib/signer.js");

  const SUPPORTED_CHAINS: Record<number, { name: string; rpcUrl: string; lowEthThreshold: bigint }> = {
    11155111: {
      name: "Ethereum Sepolia",
      rpcUrl: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com",
      lowEthThreshold: ethers.parseEther("0.5"),
    },
    84532: {
      name: "Base Sepolia",
      rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      lowEthThreshold: ethers.parseEther("0.5"),
    },
  };

  let relayerAddress: string;
  try {
    const signer = getSigner("relayer");
    relayerAddress = await signer.getAddress();
  } catch (err) {
    res.status(200).json({
      status: "unconfigured",
      error: err instanceof Error ? err.message : String(err),
      chains: {},
    });
    return;
  }

  const probes = await Promise.all(
    Object.entries(SUPPORTED_CHAINS).map(async ([chainIdStr, cfg]) => {
      const chainId = Number(chainIdStr);
      try {
        const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
        const balance = await provider.getBalance(relayerAddress);
        const lowFunds = balance < cfg.lowEthThreshold;
        return [chainId, {
          chainName: cfg.name,
          balanceWei: balance.toString(),
          balanceEth: ethers.formatEther(balance),
          lowFunds,
          thresholdEth: ethers.formatEther(cfg.lowEthThreshold),
        }];
      } catch (err) {
        return [chainId, {
          chainName: cfg.name,
          error: err instanceof Error ? err.message : String(err),
        }];
      }
    }),
  );

  const chains = Object.fromEntries(probes);
  const anyLowFunds = Object.values(chains).some((c: any) => c.lowFunds === true);
  const anyError = Object.values(chains).some((c: any) => c.error);

  res.status(200).json({
    status: anyLowFunds ? "low_funds" : anyError ? "degraded" : "ok",
    relayer: relayerAddress,
    chains,
    timestamp: new Date().toISOString(),
  });
}
