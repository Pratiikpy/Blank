import { useCallback } from "react";
import { useWriteContract } from "wagmi";
import { encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import { useSmartAccount } from "./useSmartAccount";
import { usePassphrasePrompt } from "@/components/PassphrasePrompt";

// Module-load marker — proves Vite served fresh module to the page.
// If you don't see this in the browser console at app boot, the page is
// running a stale cached bundle and any diagnostics added below will
// silently no-op.
if (typeof window !== "undefined") {
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
      console.log("[unifiedWrite] called", { fn: params.functionName, isSmartAccount, smartAccountStatus: smartAccount.status, hasAccount: !!smartAccount.account });
      // EOA path — wagmi unchanged. Cast as any because wagmi's strict
      // ABI inference would require literal abis at every call site.
      if (!isSmartAccount) {
        console.log("[unifiedWrite] taking EOA wagmi path");
        const hash = await writeContractAsync({
          address: params.address,
          abi: params.abi,
          functionName: params.functionName,
          args: params.args ?? [],
          value: params.value,
          gas: params.gas,
        } as any);
        return hash as Hex;
      }

      // AA path — encode the call data, send via UserOp.
      console.log("[unifiedWrite] taking AA passkey path, requesting passphrase...");
      const data = encodeFunctionData({
        abi: params.abi,
        functionName: params.functionName,
        args: params.args ?? [],
      });

      const passphrase = await passphrasePrompt.request({
        title: `Sign ${params.functionName}`,
        subtitle: `Submit via your smart wallet — gas sponsored.`,
      });
      console.log("[unifiedWrite] passphrase obtained, calling sendUserOp...");
      if (!passphrase) throw new Error("Cancelled");

      const result = await smartAccount.sendUserOp(
        params.address,
        params.value ?? 0n,
        data,
        passphrase,
      );
      if (!result) throw new Error(smartAccount.error ?? "UserOp submission failed");
      return result.txHash;
    },
    [isSmartAccount, writeContractAsync, smartAccount, passphrasePrompt],
  );

  // Same as unifiedWrite but also returns the relayer's pre-confirmed receipt
  // when on the AA path. Callers wanting the receipt should use this method to
  // avoid the post-relay RPC poll roulette.
  const unifiedWriteAndWait = useCallback(
    async (params: UnifiedWriteParams): Promise<UnifiedWriteAndWaitResult> => {
      console.log("[unifiedWriteAndWait] called", { fn: params.functionName, isSmartAccount, smartAccountStatus: smartAccount.status });
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
        subtitle: `Submit via your smart wallet — gas sponsored.`,
      });
      if (!passphrase) throw new Error("Cancelled");

      const result = await smartAccount.sendUserOp(
        params.address,
        params.value ?? 0n,
        data,
        passphrase,
      );
      if (!result) throw new Error(smartAccount.error ?? "UserOp submission failed");

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

      const result = await smartAccount.sendBatchUserOp(targets, values, datas, passphrase);
      if (!result) throw new Error(smartAccount.error ?? "Batch UserOp submission failed");
      return result.txHash;
    },
    [isSmartAccount, writeContractAsync, smartAccount, passphrasePrompt],
  );

  return { isSmartAccount, senderAddress, unifiedWrite, unifiedWriteBatch, unifiedWriteAndWait };
}
