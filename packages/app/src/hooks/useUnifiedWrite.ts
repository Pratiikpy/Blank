import { useCallback } from "react";
import { useWriteContract } from "wagmi";
import { encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { useSmartAccount } from "./useSmartAccount";
import { usePassphrasePrompt } from "@/components/PassphrasePrompt";

// Module-load marker — proves Vite served fresh module to the page.
// If you don't see this in the browser console at app boot, the page is
// running a stale cached bundle and any diagnostics added below will
// silently no-op.
// §3.18 of BEST_VERSION_FULL_PLAN: dev-only logs. Production builds drop
// these via esbuild config. Pre-fix all 6 calls fired on every contract
// write, polluting prod console output.
if (typeof window !== "undefined" && import.meta.env.DEV) {
  // eslint-disable-next-line no-console
  console.log("[useUnifiedWrite.module] loaded build-2026-04-14-A");
}

// ──────────────────────────────────────────────────────────────────
//  useUnifiedWrite — single-call API that branches on wallet type
//
//  When the user has an active smart wallet (passkey + counterfactual
//  address), all writes route through BlankAccount.execute via UserOp +
//  /api/relay. When they don't, calls fall through to wagmi's
//  writeContractAsync exactly as before.
//
//  API mirrors wagmi's writeContractAsync — every existing hook can swap
//  `writeContractAsync({...})` for `unifiedWrite({...})` and get the
//  smart-wallet path for free. The returned tx hash is the on-chain
//  EntryPoint transaction in AA mode (not the inner UserOp hash —
//  callers usually want to wait on this for confirmation).
//
//  For multi-call atomic operations (e.g. approve + deposit), use
//  unifiedWriteBatch which encodes via BlankAccount.executeBatch in AA
//  mode, or falls back to sequential writeContractAsync calls in EOA mode.
// ──────────────────────────────────────────────────────────────────

export interface UnifiedWriteParams {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
  gas?: bigint;
  /** Gas-payment mode for the AA path (Phase 7.5). Ignored for EOA path.
   *   • `"sponsored"` (default) — BlankPaymaster covers gas
   *   • `"self"` — AA pays gas from its own ETH balance
   *
   * Pass `"self"` when `usePaymasterHealth().status` is `"degraded"` or
   * `"unavailable"` AND the AA has ETH on the active chain. The
   * `FundAccountModal` (Phase 7.6) is the standard UX for getting ETH
   * onto the AA when that's not yet true. */
  paymaster?: "sponsored" | "self";
}

export interface UnifiedBatchCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

/** Receipt summary the relayer already saw — present only on the AA path. */
export interface UnifiedReceipt {
  blockNumber: bigint;
  blockHash?: Hex;
  status: "success" | "reverted";
  logs: Array<{ address: Hex; topics: Hex[]; data: Hex }>;
}

export interface UnifiedWriteAndWaitResult {
  hash: Hex;
  /** AA path: present (relayer-side `tx.wait()` already completed). EOA path: undefined — caller must poll itself. */
  receipt?: UnifiedReceipt;
}

export interface UseUnifiedWriteReturn {
  /** True when the active wallet is a smart account (UserOps via relayer). */
  isSmartAccount: boolean;
  /** The active sender address — smart-account address in AA mode, connected EOA otherwise. */
  senderAddress: Address | null;
  /** Single contract write — branches between AA UserOp and wagmi writeContractAsync. */
  unifiedWrite: (params: UnifiedWriteParams) => Promise<Hex>;
  /** Atomic batch of writes — one UserOp via executeBatch in AA mode, sequential in EOA mode. */
  unifiedWriteBatch: (calls: readonly UnifiedBatchCall[], promptCopy?: { title?: string; subtitle?: string }) => Promise<Hex>;
  /**
   * Same as unifiedWrite, but also surfaces the relayer's receipt on the AA
   * path so callers don't need to re-poll the chain (free RPC tiers like
   * sepolia.base.org rate-limit getTransactionReceipt enough that waits can
   * silently exceed a minute even when the tx is mined). On EOA, `receipt`
   * is undefined — caller still uses publicClient.waitForTransactionReceipt.
   */
  unifiedWriteAndWait: (params: UnifiedWriteParams) => Promise<UnifiedWriteAndWaitResult>;
}

/**
 * §3.18 of BEST_VERSION_FULL_PLAN: post-confirm RPC settlement window.
 * After an AA UserOp lands on-chain, the public RPC nodes used for
 * EntryPoint.getNonce() lag a block or two behind. Without a brief wait,
 * back-to-back unifiedWriteAndWait calls (e.g. approve then write) can
 * read the pre-mine nonce and fire a UserOp that EntryPoint rejects
 * with AA25 (invalid account nonce). 2.5s covers public-node lag in
 * practice. A future refactor (audit iter 8) replaces this with a
 * polling loop on EntryPoint.getNonce() until the increment is visible.
 */
const RPC_SETTLEMENT_DELAY_MS = 2_500;

/**
 * Map cryptic low-level errors from the relayer / EntryPoint / wagmi into
 * something a user can act on. The input messages are e.g.
 * "entryPoint.handleOps failed: insufficient funds for intrinsic transaction cost..."
 * and the user sees that verbatim today — no idea if they should retry, top
 * up their wallet, or contact support.
 */
function humanizeWriteError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "Transaction failed");
  const s = raw.toLowerCase();
  if (s.includes("cancelled") || s.includes("user rejected") || s.includes("denied")) {
    return "Cancelled.";
  }
  if (s.includes("insufficient funds for intrinsic") || s.includes("insufficient funds for gas")) {
    return "The relayer ran out of gas money. Please try again in a moment, or let us know if this keeps happening.";
  }
  if (s.includes("connector not connected")) {
    return "Wallet not connected. If you signed up with a passphrase, try refreshing the page.";
  }
  // Paymaster funding issues — symptoms include "aa31", "paymaster deposit",
  // and also the bare "transaction execution reverted (..., reason=null)"
  // that EntryPoint emits when the paymaster's stake is too low to
  // pre-fund the UserOp. The user-visible root cause is paymaster funding,
  // not their own wallet.
  if (
    s.includes("aa31") ||
    s.includes("paymaster deposit too low") ||
    (s.includes("entrypoint.handleops failed") && s.includes("reason=null"))
  ) {
    return "The gas sponsor is out of funds. The Blank team has been notified; please try again in a few minutes.";
  }
  if (s.includes("entrypoint") && s.includes("reverted")) {
    return "The smart wallet rejected this transaction. Check the amount and try again.";
  }
  if (s.includes("nonce") && (s.includes("already") || s.includes("used") || s.includes("too low"))) {
    return "Another transaction is still pending. Please wait a few seconds and try again.";
  }
  if (s.includes("timeout") || s.includes("aborted")) {
    return "Request timed out. The network may be slow — please try again.";
  }
  if (s.includes("rate limit")) {
    return "Too many requests. Please wait a minute and try again.";
  }

  // §3.14 of BEST_VERSION_FULL_PLAN: contract-revert mappings. Pre-fix users
  // saw raw strings like "ClaimLinks: bad secret/email" with the contract
  // namespace prefix. The full extraction to lib/error-messages.ts is a
  // Wave 5 candidate; these inline mappings cover the common user paths.
  if (s.includes("claimlinks: bad secret") || s.includes("claimlinks: bad secret/email")) {
    return "This link is for a different recipient.";
  }
  if (s.includes("claimlinks: expired")) {
    return "This link has expired.";
  }
  if (s.includes("claimlinks: already claimed")) {
    return "This link has already been claimed.";
  }
  if (s.includes("claimlinks: refunded") || s.includes("claimlinks: already refunded")) {
    return "This link was refunded by the sender.";
  }
  if (s.includes("claimlinks: expiry too long")) {
    return "Link expiry must be 1 second to 365 days.";
  }
  if (s.includes("claimlinks: not bound address")) {
    return "Only the address this link was sent to can claim it.";
  }
  if (s.includes("encryptedescrow: no arbiter")) {
    return "No arbiter set; wait for the deadline to refund instead.";
  }
  if (s.includes("encryptedescrow: not active")) {
    return "This escrow is no longer active.";
  }
  if (s.includes("encryptedescrow: not yet expired")) {
    return "The escrow deadline hasn't passed yet.";
  }
  if (s.includes("encryptedescrow: bad beneficiary")) {
    return "Beneficiary must be a different address from yours.";
  }
  if (s.includes("encryptedescrow: deadline")) {
    return "Escrow deadline must be at least 1 day from now.";
  }
  if (s.includes("encryptedescrow: already delivered")) {
    return "Delivery already marked.";
  }
  if (s.includes("encryptedescrow: already approved")) {
    return "Release already approved.";
  }
  if (s.includes("encryptedescrow: not arbiter")) {
    return "Only the arbiter can decide this escrow.";
  }
  if (s.includes("storefront: not winner")) {
    return "Only the auction winner can claim.";
  }
  if (s.includes("storefront: winner not revealed")) {
    return "Auction winner pending. Run revealWinner first.";
  }
  if (s.includes("storefront: winner already revealed")) {
    return "Auction winner already published.";
  }
  if (s.includes("storefront: auction settlement disabled")) {
    return "Auction settlement is temporarily disabled.";
  }
  if (s.includes("crowdfund: no contributions")) {
    return "Cannot close a campaign with no contributors.";
  }
  if (s.includes("crowdfund: already published")) {
    return "Campaign verdict already published.";
  }

  // Unrecognized: surface the raw message so it's still debuggable but
  // cap the length so it fits in a toast.
  return raw.length > 180 ? raw.slice(0, 180) + "…" : raw;
}

export function useUnifiedWrite(): UseUnifiedWriteReturn {
  const { writeContractAsync } = useWriteContract();
  const smartAccount = useSmartAccount();
  const passphrasePrompt = usePassphrasePrompt();

  const isSmartAccount =
    smartAccount.status === "ready" && smartAccount.account !== null;
  const senderAddress = isSmartAccount
    ? (smartAccount.account!.address as Address)
    : null;

  const unifiedWrite = useCallback(
    async (params: UnifiedWriteParams): Promise<Hex> => {
      if (import.meta.env.DEV) console.log("[unifiedWrite] called", { fn: params.functionName, isSmartAccount, smartAccountStatus: smartAccount.status, hasAccount: !!smartAccount.account });
      // EOA path — wagmi unchanged. Cast as any because wagmi's strict
      // ABI inference would require literal abis at every call site.
      if (!isSmartAccount) {
        if (import.meta.env.DEV) console.log("[unifiedWrite] taking EOA wagmi path");
        try {
          const hash = await writeContractAsync({
            address: params.address,
            abi: params.abi,
            functionName: params.functionName,
            args: params.args ?? [],
            value: params.value,
            gas: params.gas,
          } as any);
          return hash as Hex;
        } catch (err) {
          throw new Error(humanizeWriteError(err));
        }
      }

      // AA path — encode the call data, send via UserOp.
      if (import.meta.env.DEV) console.log("[unifiedWrite] taking AA passkey path, requesting passphrase...");
      const data = encodeFunctionData({
        abi: params.abi,
        functionName: params.functionName,
        args: params.args ?? [],
      });

      const passphrase = await passphrasePrompt.request({
        title: `Sign ${params.functionName}`,
        subtitle:
          params.paymaster === "self"
            ? `Submit via your smart wallet — paid from your wallet's ETH.`
            : `Submit via your smart wallet — gas sponsored.`,
      });
      if (import.meta.env.DEV) console.log("[unifiedWrite] passphrase obtained, calling sendUserOp...");
      if (!passphrase) throw new Error("Cancelled");

      let result;
      try {
        // Plumb the caller's `gas` into the UserOp's callGasLimit. Without
        // this the AA path silently uses buildUserOp's 2M default, which is
        // too low for batch FHE ops (e.g. runPayroll multi-recipient).
        const submitOpts: { paymaster?: "sponsored" | "self"; callGasLimit?: bigint } = {};
        if (params.paymaster) submitOpts.paymaster = params.paymaster;
        if (params.gas) submitOpts.callGasLimit = params.gas;
        result = await smartAccount.sendUserOp(
          params.address,
          params.value ?? 0n,
          data,
          passphrase,
          Object.keys(submitOpts).length > 0 ? submitOpts : undefined,
        );
      } catch (err) {
        throw new Error(humanizeWriteError(err));
      }
      if (!result) throw new Error(humanizeWriteError(smartAccount.error ?? "UserOp submission failed"));
      return result.txHash;
    },
    [isSmartAccount, writeContractAsync, smartAccount, passphrasePrompt],
  );

  // Same as unifiedWrite but also returns the relayer's pre-confirmed receipt
  // when on the AA path. Callers wanting the receipt should use this method to
  // avoid the post-relay RPC poll roulette.
  const unifiedWriteAndWait = useCallback(
    async (params: UnifiedWriteParams): Promise<UnifiedWriteAndWaitResult> => {
      if (import.meta.env.DEV) console.log("[unifiedWriteAndWait] called", { fn: params.functionName, isSmartAccount, smartAccountStatus: smartAccount.status });
      if (!isSmartAccount) {
        const hash = await writeContractAsync({
          address: params.address,
          abi: params.abi,
          functionName: params.functionName,
          args: params.args ?? [],
          value: params.value,
          gas: params.gas,
        } as any);
        return { hash: hash as Hex };
      }

      const data = encodeFunctionData({
        abi: params.abi,
        functionName: params.functionName,
        args: params.args ?? [],
      });

      const passphrase = await passphrasePrompt.request({
        title: `Sign ${params.functionName}`,
        subtitle:
          params.paymaster === "self"
            ? `Submit via your smart wallet — paid from your wallet's ETH.`
            : `Submit via your smart wallet — gas sponsored.`,
      });
      if (!passphrase) throw new Error("Cancelled");

      let result;
      try {
        const submitOpts: { paymaster?: "sponsored" | "self"; callGasLimit?: bigint } = {};
        if (params.paymaster) submitOpts.paymaster = params.paymaster;
        if (params.gas) submitOpts.callGasLimit = params.gas;
        result = await smartAccount.sendUserOp(
          params.address,
          params.value ?? 0n,
          data,
          passphrase,
          Object.keys(submitOpts).length > 0 ? submitOpts : undefined,
        );
      } catch (err) {
        throw new Error(humanizeWriteError(err));
      }
      if (!result) throw new Error(humanizeWriteError(smartAccount.error ?? "UserOp submission failed"));

      // Forward the relayer's view: blockNumber + status + logs from /api/relay.
      const receipt: UnifiedReceipt | undefined =
        result.blockNumber !== undefined && result.status
          ? {
              blockNumber: result.blockNumber,
              blockHash: result.blockHash,
              status: result.status,
              logs: result.logs ?? [],
            }
          : undefined;

      // §3.18 named-constant: see RPC_SETTLEMENT_DELAY_MS at module top.
      // Defence-in-depth for hooks that fire approve → write back-to-back
      // (useExchange, useSendPayment, useBusinessHub) when the local
      // nonce hint hasn't propagated.
      if (isSmartAccount && receipt?.status === "success") {
        await new Promise((r) => setTimeout(r, RPC_SETTLEMENT_DELAY_MS));
      }

      return { hash: result.txHash, receipt };
    },
    [isSmartAccount, writeContractAsync, smartAccount, passphrasePrompt],
  );

  const unifiedWriteBatch = useCallback(
    async (
      calls: readonly UnifiedBatchCall[],
      promptCopy?: { title?: string; subtitle?: string },
    ): Promise<Hex> => {
      if (calls.length === 0) throw new Error("unifiedWriteBatch: empty call list");

      // EOA mode — execute sequentially. Each call gets its own MetaMask
      // popup since wagmi has no native batch. Returns the LAST tx hash.
      // Callers that need atomicity should ensure the user is on a smart
      // account (check isSmartAccount before calling) or restructure.
      if (!isSmartAccount) {
        let lastHash: Hex | undefined;
        for (const c of calls) {
          const h = await writeContractAsync({
            address: c.address,
            abi: c.abi,
            functionName: c.functionName,
            args: c.args ?? [],
            value: c.value,
            gas: BigInt(5_000_000),
          } as any);
          lastHash = h as Hex;
        }
        return lastHash!;
      }

      // AA mode — encode each call, bundle into one executeBatch UserOp.
      const targets: Address[] = [];
      const values: bigint[] = [];
      const datas: Hex[] = [];
      for (const c of calls) {
        targets.push(c.address);
        values.push(c.value ?? 0n);
        datas.push(
          encodeFunctionData({
            abi: c.abi,
            functionName: c.functionName,
            args: c.args ?? [],
          }),
        );
      }

      const passphrase = await passphrasePrompt.request({
        title: promptCopy?.title ?? `Sign ${calls.length} bundled calls`,
        subtitle:
          promptCopy?.subtitle ??
          `Atomic — ${calls.length} contract calls in one UserOp. One signature, one transaction.`,
      });
      if (!passphrase) throw new Error("Cancelled");

      let result;
      try {
        result = await smartAccount.sendBatchUserOp(targets, values, datas, passphrase);
      } catch (err) {
        throw new Error(humanizeWriteError(err));
      }
      if (!result) throw new Error(humanizeWriteError(smartAccount.error ?? "Batch UserOp submission failed"));
      return result.txHash;
    },
    [isSmartAccount, writeContractAsync, smartAccount, passphrasePrompt],
  );

  return { isSmartAccount, senderAddress, unifiedWrite, unifiedWriteBatch, unifiedWriteAndWait };
}
