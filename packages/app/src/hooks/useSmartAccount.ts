import { useState, useEffect, useCallback } from "react";
import { usePublicClient } from "wagmi";
import type { Address, Hex } from "viem";
import { CONTRACTS, SUPPORTED_CHAIN_ID } from "@/lib/constants";
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
  encodeExecuteCall,
  encodeExecuteBatchCall,
  encodeP256Signature,
  getNextNonce,
  serializeUserOp,
  type PackedUserOperation,
  ENTRYPOINT_V08,
} from "@/lib/userop";

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
  const publicClient = usePublicClient();
  const [status, setStatus] = useState<SmartAccountStatus>("idle");
  const [account, setAccount] = useState<SmartAccount | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ─── Counterfactual address resolution ─────────────────────────────

  const resolveAccount = useCallback(async () => {
    if (!publicClient) return;
    setError(null);

    const exists = await hasPasskey(SUPPORTED_CHAIN_ID);
    if (!exists) {
      setStatus("no-passkey");
      setAccount(null);
      return;
    }

    const pub = await getPasskeyPubkey(SUPPORTED_CHAIN_ID);
    if (!pub) {
      setStatus("no-passkey");
      return;
    }

    const predicted = (await publicClient.readContract({
      address: CONTRACTS.BlankAccountFactory,
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
  }, [publicClient]);

  useEffect(() => {
    resolveAccount();
  }, [resolveAccount]);

  // ─── Passkey lifecycle ─────────────────────────────────────────────

  const createAccount = useCallback(
    async (passphrase: string, label?: string): Promise<SmartAccount | null> => {
      if (!publicClient) {
        setError("Network not ready");
        return null;
      }
      try {
        const pub = await createPasskey(SUPPORTED_CHAIN_ID, passphrase, label);
        const predicted = (await publicClient.readContract({
          address: CONTRACTS.BlankAccountFactory,
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
    [publicClient],
  );

  const removeAccount = useCallback(async () => {
    await deletePasskey(SUPPORTED_CHAIN_ID);
    setAccount(null);
    setStatus("no-passkey");
  }, []);

  // ─── Send UserOp (core path used by both single + batch) ───────────

  const submitCallData = useCallback(
    async (
      callData: Hex,
      passphrase: string,
    ): Promise<{ txHash: Hex; userOpHash: Hex } | null> => {
      if (!publicClient || !account) {
        setError("No smart account ready");
        return null;
      }
      setError(null);
      const isFirstOp = !account.isDeployed;
      setStatus(isFirstOp ? "deploying" : "submitting");

      try {
        const nonce = await getNextNonce(publicClient, account.address, 0n);

        // First UserOp must include initCode so EntryPoint deploys via factory.
        let initCode: Hex = "0x";
        if (isFirstOp) {
          const { encodeFactoryInitCode } = await import("@/lib/userop");
          initCode = encodeFactoryInitCode(
            CONTRACTS.BlankAccountFactory,
            account.pubX,
            account.pubY,
            ZERO_ADDRESS,
            0n,
          );
        }

        let userOp: PackedUserOperation = buildUserOp({
          sender: account.address,
          nonce,
          initCode,
          callData,
        });

        // Authoritative hash via on-chain EntryPoint view call
        const userOpHash = await computeUserOpHash(publicClient, userOp);

        // Sign with passkey (prompts for passphrase decrypt)
        const sig = await signHash(SUPPORTED_CHAIN_ID, passphrase, userOpHash);
        userOp = { ...userOp, signature: encodeP256Signature(sig.r, sig.s) };

        // Submit via relayer
        const res = await fetch("/api/relay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userOp: serializeUserOp(userOp),
            chainId: SUPPORTED_CHAIN_ID,
          }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error((body as any).error ?? `relay HTTP ${res.status}`);
        }
        const { hash } = (await res.json()) as { hash: Hex };

        await resolveAccount(); // refresh isDeployed for next call
        setStatus("ready");
        return { txHash: hash, userOpHash };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "UserOp submission failed";
        setError(msg);
        setStatus("error");
        return null;
      }
    },
    [publicClient, account, resolveAccount],
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
