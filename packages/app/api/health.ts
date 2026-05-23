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
  // Dispatcher: /api/health?kind=relayer routes to relayer-balance probe;
  // /api/health?kind=status routes to the consolidated /status page view.
  // Kept inline to stay under Vercel Hobby's 12-function cap (consolidated
  // from former /api/relayer-health endpoint; vercel.json rewrites the
  // old URL to this kind switch).
  const kind = typeof req.query?.kind === "string" ? req.query.kind : "";
  if (kind === "relayer") {
    return handleRelayer(req, res);
  }
  if (kind === "status") {
    return handleStatus(req, res);
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

// ─── /api/health?kind=status ───────────────────────────────────────
// Consolidated status view for the /status page. Reports per-chain RPC
// liveness, paymaster deposit, relayer ETH, FHE network probes, and
// last-deployed sha. Public; no auth (status pages are read-only).
//
// Returns 200 always so the /status screen can render a "degraded"
// banner even when chain RPCs are down.

async function handleStatus(_req: any, res: any) {
  try {
    const ethers = await import("ethers");
    const { getContracts, RPC_URLS, ETH_SEPOLIA_ID, BASE_SEPOLIA_ID } = await import(
      "./_lib/addresses.js"
    );

    const ENTRYPOINT_ABI = ["function balanceOf(address) view returns (uint256)"];
    const PAYMASTER_WARN_WEI = ethers.parseEther("0.5");
    const PAYMASTER_PAGE_WEI = ethers.parseEther("0.1");
    const RELAYER_WARN_WEI = ethers.parseEther("0.05");
    const RELAYER_PAGE_WEI = ethers.parseEther("0.01");

    let relayerAddress: string | null = null;
    try {
      const { getSigner } = await import("./_lib/signer.js");
      relayerAddress = await getSigner("relayer").getAddress();
    } catch {
      // relayer not configured; chain-side balance probes report null
    }

    const chains = [ETH_SEPOLIA_ID, BASE_SEPOLIA_ID] as const;
    const chainSnapshots = await Promise.all(
      chains.map(async (chainId) => {
        const contracts = getContracts(chainId);
        const rpcUrl = RPC_URLS[chainId];
        const label = chainId === ETH_SEPOLIA_ID ? "Ethereum Sepolia" : "Base Sepolia";

        if (!contracts || !rpcUrl) {
          return {
            chainId,
            label,
            rpc: { ok: false, error: "not configured" },
            paymaster: null,
            relayer: null,
          };
        }

        const provider = new ethers.JsonRpcProvider(rpcUrl);

        // RPC liveness: cheap getBlockNumber probe with a 3s budget.
        let rpcStatus: { ok: boolean; blockNumber?: number; error?: string };
        try {
          const blockNumber = await Promise.race([
            provider.getBlockNumber(),
            new Promise<number>((_, reject) => setTimeout(() => reject(new Error("rpc-timeout")), 3000)),
          ]);
          rpcStatus = { ok: true, blockNumber };
        } catch (err) {
          rpcStatus = { ok: false, error: err instanceof Error ? err.message.slice(0, 120) : String(err) };
        }

        // Paymaster + relayer balances. Skip if RPC is down.
        let paymasterStatus: { ok: boolean; balanceEth?: string; level?: "ok" | "warn" | "page"; address?: string; error?: string } | null = null;
        let relayerStatus: { ok: boolean; balanceEth?: string; level?: "ok" | "warn" | "page"; address?: string; error?: string } | null = null;

        if (rpcStatus.ok) {
          try {
            const entrypoint = new ethers.Contract(contracts.EntryPoint, ENTRYPOINT_ABI, provider);
            const deposit: bigint = await entrypoint.balanceOf(contracts.BlankPaymaster);
            paymasterStatus = {
              ok: true,
              address: contracts.BlankPaymaster,
              balanceEth: ethers.formatEther(deposit),
              level: deposit < PAYMASTER_PAGE_WEI ? "page" : deposit < PAYMASTER_WARN_WEI ? "warn" : "ok",
            };
          } catch (err) {
            paymasterStatus = {
              ok: false,
              address: contracts.BlankPaymaster,
              error: err instanceof Error ? err.message.slice(0, 120) : String(err),
            };
          }

          if (relayerAddress) {
            try {
              const balance = await provider.getBalance(relayerAddress);
              relayerStatus = {
                ok: true,
                address: relayerAddress,
                balanceEth: ethers.formatEther(balance),
                level: balance < RELAYER_PAGE_WEI ? "page" : balance < RELAYER_WARN_WEI ? "warn" : "ok",
              };
            } catch (err) {
              relayerStatus = {
                ok: false,
                address: relayerAddress,
                error: err instanceof Error ? err.message.slice(0, 120) : String(err),
              };
            }
          }
        }

        return {
          chainId,
          label,
          rpc: rpcStatus,
          paymaster: paymasterStatus,
          relayer: relayerStatus,
        };
      }),
    );

    // FHE network probes. Reuse the same endpoints the main health
    // handler probes. Don't fail the status if these are slow; surface
    // them so judges can see what's up.
    const [cofheProbe, verifierProbe, tnProbe] = await Promise.all([
      probe("https://testnet-cofhe.fhenix.zone"),
      probe("https://testnet-cofhe-vrf.fhenix.zone"),
      probe("https://testnet-cofhe-tn.fhenix.zone"),
    ]);
    const fhenixReachable = cofheProbe.ok && verifierProbe.ok && tnProbe.ok;

    // Derive overall status: page if any chain has page-level balance or
    // RPC is hard-down on a chain; warn if anything is warn-level or
    // FHE network is degraded; ok otherwise.
    const anyPage = chainSnapshots.some(
      (c) => c.paymaster?.level === "page" || c.relayer?.level === "page" || !c.rpc.ok,
    );
    const anyWarn = chainSnapshots.some(
      (c) => c.paymaster?.level === "warn" || c.relayer?.level === "warn",
    );
    const overall: "ok" | "warn" | "page" =
      anyPage ? "page" : anyWarn || !fhenixReachable ? "warn" : "ok";

    res.status(200).json({
      status: overall,
      chains: chainSnapshots,
      fhenix: {
        reachable: fhenixReachable,
        cofhe: cofheProbe,
        verifier: verifierProbe,
        thresholdNetwork: tnProbe,
      },
      deploy: {
        sha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
        branch: process.env.VERCEL_GIT_COMMIT_REF ?? null,
        env: process.env.VERCEL_ENV ?? "unknown",
        region: process.env.VERCEL_REGION ?? null,
      },
      thresholds: {
        paymasterWarnEth: "0.5",
        paymasterPageEth: "0.1",
        relayerWarnEth: "0.05",
        relayerPageEth: "0.01",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/health?kind=status] crashed:", err);
    res.status(500).json({ error: `status crashed: ${msg.slice(0, 200)}` });
  }
}
