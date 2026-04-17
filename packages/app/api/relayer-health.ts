/**
 * /api/relayer-health — exposes relayer + paymaster ETH balances per chain.
 *
 * Used by ops + the optional Slack alert cron to know when to refill.
 * Frontend can also call this to disable smart-wallet flows when the
 * relayer is underwater (graceful degradation).
 *
 * Returns 200 always (never blocks the frontend); status field reports
 * health verbally so callers can branch.
 */

// Same pattern as derive.ts — lazy-import ethers and _lib/signer inside the
// handler so any module-load failure is caught by the outer try/catch and
// surfaced as JSON, not as Vercel's opaque FUNCTION_INVOCATION_FAILED.

export default async function handler(req: any, res: any) {
  try {
    return await handleImpl(req, res);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[/api/relayer-health] unhandled:", err);
    res.status(500).json({ error: `relayer-health crashed: ${msg}` });
    return;
  }
}

async function handleImpl(_req: any, res: any) {
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
