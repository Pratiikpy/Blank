// Frontend wrapper around `/api/faucet/usdc`. Mirrors the shape of
// `email-client.ts` so consumers feel familiar.
//
// The endpoint is rate-limited server-side (per-IP and per-address) so
// callers can safely retry on transient network errors without worrying
// about overspending the test treasury.

export interface FaucetUsdcArgs {
  /** Smart-account or EOA address to receive 100 testnet USDC. */
  address: string;
  /** Active chain id — drives which TestUSDC contract gets minted from. */
  chainId: number;
}

export interface FaucetUsdcResult {
  ok: boolean;
  /** Mint tx hash on success. */
  hash?: string;
  /** Minted amount in token base units (string for safety; 100 USDC = "100000000"). */
  amount?: string;
  /** Server error string when ok=false. */
  error?: string;
  /** When server returned 429: which scope tripped the limit ("ip" / "address"). */
  rateLimitScope?: "ip" | "address";
}

interface FaucetResponseBody {
  ok?: boolean;
  hash?: string;
  amount?: string;
  error?: string;
  scope?: "ip" | "address";
}

export async function faucetUsdc(args: FaucetUsdcArgs): Promise<FaucetUsdcResult> {
  try {
    const res = await fetch("/api/faucet/usdc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = (await res.json().catch(() => ({}))) as FaucetResponseBody;
    if (res.status === 429) {
      return {
        ok: false,
        error: "rate_limited",
        rateLimitScope: body.scope,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        error: body.error ?? `HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      hash: body.hash,
      amount: body.amount,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
