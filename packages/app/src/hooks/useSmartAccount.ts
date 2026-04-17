import { useState, useEffect, useCallback, useRef } from "react";
import { usePublicClient } from "wagmi";
import type { Address, Hex } from "viem";
import { useChain } from "@/providers/ChainProvider";
import { BlankAccountFactoryAbi } from "@/lib/abis";
import {
  hasPasskey,
  getPasskeyPubkey,
  createPasskey,
  signHash,
  deletePasskey,
} from "@/lib/passkey";
import {
  buildUserOp,
  computeUserOpHash,
  encodeBlankPaymasterData,
  encodeExecuteCall,
  encodeExecuteBatchCall,
  encodeP256Signature,
  getNextNonce,
  serializeUserOp,
  type PackedUserOperation,
  ENTRYPOINT_V08,
} from "@/lib/userop";
import { broadcastAction, onCrossTabAction } from "@/lib/cross-tab";

// Result shape returned from submitCallData / sendUserOp. The optional
// blockNumber/blockHash/status/logs are forwarded from /api/relay which
// already waited for receipt server-side (skips client-side RPC polling).
export interface UserOpResult {
  txHash: Hex;
  userOpHash: Hex;
  blockNumber?: bigint;
  blockHash?: Hex;
  status?: "success" | "reverted";
  logs?: Array<{ address: Hex; topics: Hex[]; data: Hex }>;
}

// ────────────────────────────────────────────────────────────────────
//  useSmartAccount — the AA orchestration hook.
//
//  Lifecycle:
//   1. Mount: check for an existing passkey on the active chain. If yes,
//      compute the counterfactual smart-account address and expose it.
//   2. createAccount(passphrase): generate a new P-256 passkey, encrypt
//      with the passphrase, store in IndexedDB. Counterfactual address
//      becomes available immediately. Real on-chain deployment happens
//      lazily on the first UserOp via initCode.
//   3. sendUserOp(target, value, data, passphrase): build PackedUserOp,
//      compute hash via EntryPoint, prompt for passphrase, sign with the
//      passkey, submit through /api/relay. Returns the tx hash.
//
//  The smart account address is fully deterministic: same (pubX, pubY,
//  recovery, salt) → same address. salt = 0 by default (one account per
//  passkey per chain).
// ────────────────────────────────────────────────────────────────────

export type SmartAccountStatus =
  | "idle"
  | "no-passkey"
  | "ready"           // passkey exists, counterfactual address known
  | "deploying"       // first UserOp in flight (carries initCode)
  | "submitting"      // subsequent UserOp in flight
  | "error";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export interface SmartAccount {
  address: Address;
  pubX: Hex;
  pubY: Hex;
  isDeployed: boolean;
}

export function useSmartAccount() {
  const { activeChainId, contracts } = useChain();
  // R5-C bugfix: pass `chainId` so wagmi resolves a public client for the
  // active chain EVEN WHEN no wallet is connected (passkey-only mode).
  // Without this, `usePublicClient()` returns `undefined` for anonymous
  // users and `resolveAccount()` early-returns forever, leaving the
  // smart-account status at "idle" and the BlankApp gate closed.
  const publicClient = usePublicClient({ chainId: activeChainId });
  const [status, setStatus] = useState<SmartAccountStatus>("idle");
  const [account, setAccount] = useState<SmartAccount | null>(null);
  const [error, setError] = useState<string | null>(null);

  // #123: parallel submitCallData calls previously both read the same nonce
  // from the EntryPoint (on-chain) because the first tx hadn't mined. Second
  // UserOp then collided. Track a local "next nonce" ref: on submit we use
  // max(on-chain, local + 1) and bump the local counter immediately. Reset
  // when the smart account is re-resolved (address change, chain change).
  const pendingNonceRef = useRef<bigint | null>(null);

  // Also dedup in-flight submissions by callData hash — if a second caller
  // fires the same calldata before the first returns (double-click under
  // load), return the same promise rather than building a second UserOp.
  const inflightRef = useRef<Map<string, Promise<UserOpResult | null>>>(
    new Map(),
  );

  // ─── Counterfactual address resolution ─────────────────────────────

  const resolveAccount = useCallback(async () => {
    if (!publicClient) return;
    setError(null);

    // RPC calls below can throw on rate-limit / network blip. Without
    // the outer try/catch, the error bubbles to the useEffect below as
    // an unhandled promise rejection — breaks Sentry budgets in prod
    // and fails strict e2e harnesses. Catch, surface in state, and let
    // the next `resolveAccount` call (chain switch, manual refresh)
    // retry.
    try {
      const exists = await hasPasskey(activeChainId);
      if (!exists) {
        setStatus("no-passkey");
        setAccount(null);
        return;
      }

      const pub = await getPasskeyPubkey(activeChainId);
      if (!pub) {
        setStatus("no-passkey");
        return;
      }

      const predicted = (await publicClient.readContract({
        address: contracts.BlankAccountFactory,
        abi: BlankAccountFactoryAbi,
        functionName: "getAddress",
        args: [BigInt(pub.pubX), BigInt(pub.pubY), ZERO_ADDRESS, 0n],
      })) as Address;

      const code = await publicClient.getCode({ address: predicted });
      const isDeployed = code !== undefined && code !== "0x";

      setAccount({
        address: predicted,
        pubX: pub.pubX,
        pubY: pub.pubY,
        isDeployed,
      });
      setStatus("ready");

      // #123: reset local nonce counter whenever we re-resolve — account
      // change / chain change / fresh mount all invalidate the local hint.
      pendingNonceRef.current = null;
      inflightRef.current.clear();
    } catch (err) {
      // Common: RPC rate-limited (1rpc.io has low limits), transient
      // network error, or factory read reverted (chain switched to a
      // chain where the factory isn't deployed). Surface as an error
      // state but don't crash the page.
      const msg = err instanceof Error ? err.message : "Failed to resolve smart account";
      setError(msg);
      setStatus("error");
    }
  }, [publicClient, activeChainId, contracts]);

  useEffect(() => {
    // useEffect callbacks can't be async. Swallow any rejection from
    // resolveAccount so React doesn't emit an unhandled-promise warning
    // and e2e harnesses don't see a page-level error.
    resolveAccount().catch((err) => {
      console.warn("[useSmartAccount] resolveAccount unhandled:", err);
    });
  }, [resolveAccount]);

  // #246: cross-tab nonce sync — another tab just consumed a nonce for the
  // same (address, chainId). Bump our local hint to at least nonce+1 so a
  // concurrent submit here doesn't read the same on-chain value and collide.
  useEffect(() => {
    if (!account) return;
    const unsub = onCrossTabAction((action, data) => {
      if (action !== "aa_nonce_used" || !data) return;
      if (data.address !== account.address) return;
      // ChainId guard: optional — if the other tab didn't attach it, assume
      // same chain (the broadcast channel is per-origin, not per-chain).
      if (data.chainId !== undefined && data.chainId !== activeChainId) return;
      try {
        const consumed = BigInt(data.nonce as string);
        const next = consumed + 1n;
        const current = pendingNonceRef.current;
        if (current === null || next > current) {
          pendingNonceRef.current = next;
        }
      } catch {
        // Malformed payload — ignore.
      }
    });
    return unsub;
  }, [account, activeChainId]);

  // ─── Passkey lifecycle ─────────────────────────────────────────────

  const createAccount = useCallback(
    async (passphrase: string, label?: string): Promise<SmartAccount | null> => {
      if (!publicClient) {
        setError("Network not ready");
        return null;
      }
      try {
        const pub = await createPasskey(activeChainId, passphrase, label);
        const predicted = (await publicClient.readContract({
          address: contracts.BlankAccountFactory,
          abi: BlankAccountFactoryAbi,
          functionName: "getAddress",
          args: [BigInt(pub.pubX), BigInt(pub.pubY), ZERO_ADDRESS, 0n],
        })) as Address;

        const result: SmartAccount = {
          address: predicted,
          pubX: pub.pubX,
          pubY: pub.pubY,
          isDeployed: false, // freshly created — initCode will deploy on first UserOp
        };
        setAccount(result);
        setStatus("ready");
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Account creation failed";
        setError(msg);
        setStatus("error");
        return null;
      }
    },
    [publicClient, activeChainId, contracts],
  );

  const removeAccount = useCallback(async () => {
    await deletePasskey(activeChainId);
    setAccount(null);
    setStatus("no-passkey");
  }, [activeChainId]);

  // ─── Send UserOp (core path used by both single + batch) ───────────

  const submitCallData = useCallback(
    async (
      callData: Hex,
      passphrase: string,
    ): Promise<UserOpResult | null> => {
      if (!publicClient || !account) {
        setError("No smart account ready");
        return null;
      }

      // #123 part A: in-flight dedup — if this exact callData is already
      // being submitted (double-click race), return the existing promise
      // rather than building a second UserOp with a colliding nonce.
      const existing = inflightRef.current.get(callData);
      if (existing) return existing;

      const work = (async (): Promise<UserOpResult | null> => {
        setError(null);
        const isFirstOp = !account.isDeployed;
        setStatus(isFirstOp ? "deploying" : "submitting");

        try {
          // #123 part B: local nonce counter. The on-chain read returns N
          // only after the previous tx mines. If two sends happen back-to-back,
          // both would read N and collide. Keep a local hint and take the max.
          const onChainNonce = await getNextNonce(publicClient, account.address, 0n);
          const localHint = pendingNonceRef.current;
          const nonce =
            localHint !== null && localHint > onChainNonce ? localHint : onChainNonce;
          pendingNonceRef.current = nonce + 1n;

          // First UserOp must include initCode so EntryPoint deploys via factory.
          let initCode: Hex = "0x";
          if (isFirstOp) {
            const { encodeFactoryInitCode } = await import("@/lib/userop");
            initCode = encodeFactoryInitCode(
              contracts.BlankAccountFactory,
              account.pubX,
              account.pubY,
              ZERO_ADDRESS,
              0n,
            );
          }

          // R5-D: wire the paymaster. Without this, the UserOp has
          // paymasterAndData="0x" which means the smart account must
          // pre-fund ETH to pay gas. Passkey accounts start with 0 ETH
          // so EntryPoint reverts with "insufficient funds" at pre-
          // validation (gasUsed ≈ 44k, no event emitted). Setting the
          // paymaster makes BlankPaymaster sponsor gas in exchange for
          // a USDC fee (0 for testnet) out of the smart account's USDC.
          const paymasterAndData = contracts.BlankPaymaster
            ? encodeBlankPaymasterData(contracts.BlankPaymaster, 0n)
            : ("0x" as Hex);

          // First UserOp must include initCode + creates the account via
          // the factory's createAccount call. Factory + UUPS proxy + init
          // costs ~300-500k gas, plus validateUserOp's P-256 verify on
          // top — the protocol-default 2M verifGas is too tight for the
          // initCode path. Bump to 5M for first ops only; subsequent ones
          // (no initCode) reuse the lower default.
          const verificationGasLimit = isFirstOp ? 5_000_000n : undefined;

          let userOp: PackedUserOperation = buildUserOp({
            sender: account.address,
            nonce,
            initCode,
            callData,
            paymasterAndData,
            verificationGasLimit,
          });

          // Authoritative hash via on-chain EntryPoint view call
          const userOpHash = await computeUserOpHash(publicClient, userOp);

          // Sign with passkey (prompts for passphrase decrypt)
          const sig = await signHash(activeChainId, passphrase, userOpHash);
          userOp = { ...userOp, signature: encodeP256Signature(sig.r, sig.s) };

          // Submit via relayer
          const res = await fetch("/api/relay", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userOp: serializeUserOp(userOp),
              chainId: activeChainId,
            }),
          });

          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            // Relay failed — roll back local nonce so next attempt doesn't skip.
            pendingNonceRef.current = nonce;
            throw new Error((body as any).error ?? `relay HTTP ${res.status}`);
          }
          const resBody = (await res.json()) as {
            hash: Hex;
            userOpSuccess?: boolean;
            blockNumber?: string | number;
            blockHash?: Hex;
            status?: "success" | "reverted";
            logs?: Array<{ address: Hex; topics: Hex[]; data: Hex }>;
          };

          // #246: sibling tabs running this same smart account must also know
          // that `nonce` is now consumed so a parallel submit there takes
          // max(onchain, nonce+1) instead of colliding with us.
          broadcastAction("aa_nonce_used", {
            nonce: nonce.toString(),
            address: account.address,
            chainId: activeChainId,
          });

          await resolveAccount(); // refresh isDeployed for next call
          setStatus("ready");
          // Forward the relayer's receipt verbatim. Free public RPC tiers
          // (sepolia.base.org) can take 30-60s to make a tx visible to
          // getTransactionReceipt — the relayer already waited via tx.wait()
          // so we trust its view rather than re-polling the chain.
          return {
            txHash: resBody.hash,
            userOpHash,
            blockNumber: resBody.blockNumber !== undefined ? BigInt(resBody.blockNumber) : undefined,
            blockHash: resBody.blockHash,
            status: resBody.status,
            logs: resBody.logs,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : "UserOp submission failed";
          setError(msg);
          setStatus("error");
          // Re-throw so the caller's try/catch sees the real message.
          // Returning null here previously meant the caller read the
          // stale `error` state instead and users saw generic toasts
          // like "UserOp submission failed" with no actionable detail
          // about what actually broke (insufficient relayer gas,
          // reverted tx, bad signature, etc).
          throw err instanceof Error ? err : new Error(msg);
        }
      })();

      inflightRef.current.set(callData, work);
      try {
        return await work;
      } finally {
        inflightRef.current.delete(callData);
      }
    },
    [publicClient, account, resolveAccount, activeChainId, contracts],
  );

  const sendUserOp = useCallback(
    (target: Address, value: bigint, data: Hex, passphrase: string) =>
      submitCallData(encodeExecuteCall(target, value, data), passphrase),
    [submitCallData],
  );

  const sendBatchUserOp = useCallback(
    (
      targets: readonly Address[],
      values: readonly bigint[],
      datas: readonly Hex[],
      passphrase: string,
    ) => submitCallData(encodeExecuteBatchCall(targets, values, datas), passphrase),
    [submitCallData],
  );

  return {
    status,
    account,
    error,
    entryPoint: ENTRYPOINT_V08,
    createAccount,
    removeAccount,
    sendUserOp,
    sendBatchUserOp,
    refresh: resolveAccount,
  };
}
