import { useCallback, useEffect, useMemo, useState } from "react";
import { parseUnits, keccak256, toBytes, type Hex } from "viem";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";

import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useFhePipeline } from "./useFhePipeline";
import { useChain } from "@/providers/ChainProvider";
import { useCofheEncrypt, useCofheConnection, Encryptable } from "@/lib/cofhe-shim";
import { P2POfframpAbi, FHERC20VaultAbi } from "@/lib/abis";
import { type EncryptedInput } from "@/lib/constants";
import { isVaultApproved, markVaultApproved } from "@/lib/approval";
import { extractEventId } from "@/lib/event-parser";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { type RailId } from "@/lib/reclaim-providers";

// Wave 5 Block 1 — encrypted P2P offramp hook.
//
// Mirrors useClaimLinks / useEncryptedEscrow shape:
//   1. Pre-flight (vault approval if needed)
//   2. Encrypt FHE inputs via the cofhe shim
//   3. Submit UserOp via unifiedWriteAndWait
//   4. Parse OfferCreated / FillLocked event for the id
//   5. Expose state machine to the screen for progress UI
//
// All wallet-side operations route through `useUnifiedWrite` so the
// caller doesn't need to know whether they're on the EOA path or the
// passkey-AA path. Same pattern as the rest of the Wave 4 hooks.

export type OfframpStep =
  | "input"
  | "approving"
  | "encrypting"
  | "submitting"
  | "confirming"
  | "success"
  | "error";

export interface OfframpState {
  step: OfframpStep;
  isProcessing: boolean;
  error: string | null;
  txHash: `0x${string}` | null;
  lastOfferId: bigint | null;
  lastFillId: bigint | null;
}

const initial: OfframpState = {
  step: "input",
  isProcessing: false,
  error: null,
  txHash: null,
  lastOfferId: null,
  lastFillId: null,
};

export type OfframpDeployStatus = "live" | "not-deployed";

export interface OfframpDeployInfo {
  status: OfframpDeployStatus;
  address: `0x${string}` | null;
  reason: string | null;
}

export interface OfferRow {
  offerId: bigint;
  maker: `0x${string}`;
  vault: `0x${string}`;
  fiatAmountMicroUSD: bigint;
  fiatRateMicroUSD: bigint;
  fiatRail: number;
  makerHandleHash: `0x${string}`;
  expiry: number;
  state: number; // 0 Open / 1 Cancelled / 2 Filled
}

export interface FillRow {
  fillId: bigint;
  offerId: bigint;
  taker: `0x${string}`;
  fiatAmountAtLockMicroUSD: bigint;
  lockedAt: number;
  proofSubmittedAt: number;
  reclaimProofHash: `0x${string}`;
  state: number;
}

// ─── Hook ─────────────────────────────────────────────────────────────

export function useP2POfframp() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { connected } = useCofheConnection();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { unifiedWriteAndWait } = useUnifiedWrite();
  const pipeline = useFhePipeline();

  const [state, setState] = useState<OfframpState>(initial);

  const deploy: OfframpDeployInfo = useMemo(() => {
    const addr = contracts.P2POfframp;
    if (!addr || addr === "0x0000000000000000000000000000000000000000") {
      return {
        status: "not-deployed",
        address: null,
        reason:
          "P2P offramp contracts are not yet deployed on this chain. " +
          "Operator must run pnpm hardhat deploy-p2p-offramp --network <chain>.",
      };
    }
    return { status: "live", address: addr, reason: null };
  }, [contracts.P2POfframp]);

  // ─── Helpers ────────────────────────────────────────────────────────

  const guardReady = useCallback((): { offramp: `0x${string}` } | null => {
    if (deploy.status !== "live" || !deploy.address) {
      setState({ ...initial, step: "error", error: deploy.reason });
      return null;
    }
    if (!address) {
      setState({ ...initial, step: "error", error: "Connect a wallet first." });
      return null;
    }
    if (!connected) {
      setState({ ...initial, step: "error", error: "FHE network connecting; try again in a moment." });
      return null;
    }
    return { offramp: deploy.address };
  }, [deploy, address, connected]);

  const ensureVaultApproval = useCallback(
    async (vault: `0x${string}`) => {
      if (!address || !deploy.address) return;
      if (isVaultApproved(deploy.address)) return;
      const toastId = toast.loading("Approving vault to offramp …");
      try {
        await unifiedWriteAndWait({
          address: vault,
          abi: FHERC20VaultAbi,
          functionName: "approvePlaintext",
          args: [deploy.address, BigInt("18446744073709551615")], // MAX_UINT64
        });
        markVaultApproved(deploy.address);
        toast.success("Approval granted", { id: toastId });
      } catch (err) {
        toast.error("Approval failed", { id: toastId });
        throw err;
      }
    },
    [address, deploy.address, unifiedWriteAndWait],
  );

  // ─── Create offer ───────────────────────────────────────────────────

  const createOffer = useCallback(
    async (params: {
      vault: `0x${string}`;
      usdcAmountTokens: string; // human-typed
      decimals: number;
      minFillUsdcTokens: string;
      fiatRail: RailId;
      makerHandle: string;        // raw rail-side handle (e.g. UPI VPA)
      fiatAmountMicroUSD: bigint; // total fiat for the full offer
      fiatRateMicroUSD: bigint;   // 1 USDC = N microUSD (for sort)
      expirySeconds: number;
    }) => {
      const ready = guardReady();
      if (!ready) return null;
      const { offramp } = ready;

      try {
        pipeline.start();
        setState({ ...initial, step: "approving", isProcessing: true });
        await ensureVaultApproval(params.vault);

        setState((s) => ({ ...s, step: "encrypting" }));
        const usdcUnits = parseUnits(params.usdcAmountTokens, params.decimals);
        const minFillUnits = parseUnits(params.minFillUsdcTokens || params.usdcAmountTokens, params.decimals);

        const [encAmount, encMin] = await encryptInputsAsync(
          [Encryptable.uint64(usdcUnits), Encryptable.uint64(minFillUnits)],
          pipeline.onEncryptStep,
        );

        const handleHash: Hex = keccak256(toBytes(params.makerHandle));

        pipeline.markSubmitting();
        setState((s) => ({ ...s, step: "submitting" }));
        const wr = await unifiedWriteAndWait({
          address: offramp,
          abi: P2POfframpAbi,
          functionName: "createOffer",
          args: [
            params.vault,
            encAmount as unknown as EncryptedInput,
            encMin as unknown as EncryptedInput,
            params.fiatRail,
            handleHash,
            params.fiatAmountMicroUSD,
            params.fiatRateMicroUSD,
            params.expirySeconds,
          ],
          gas: BigInt(5_000_000),
        });

        let logs: ReadonlyArray<{ address: `0x${string}`; topics: readonly `0x${string}`[]; data: `0x${string}` }>;
        if (wr.receipt) logs = wr.receipt.logs as never;
        else {
          pipeline.markConfirming();
          setState((s) => ({ ...s, step: "confirming" }));
          const r = await publicClient!.waitForTransactionReceipt({ hash: wr.hash, confirmations: 1 });
          if (r.status === "reverted") throw new Error("createOffer reverted");
          logs = r.logs as never;
        }
        const offerId = extractEventId(logs, offramp);
        if (offerId === null) throw new Error("Tx mined but offerId could not be parsed.");

        pipeline.markDone();
        setState({
          step: "success",
          isProcessing: false,
          error: null,
          txHash: wr.hash,
          lastOfferId: BigInt(offerId),
          lastFillId: null,
        });
        invalidateBalanceQueries();
        return { txHash: wr.hash, offerId: BigInt(offerId) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pipeline.markFailed(err);
        setState((prev) => ({ ...initial, step: "error", error: msg, txHash: prev.txHash }));
        throw err;
      }
    },
    [guardReady, ensureVaultApproval, encryptInputsAsync, pipeline, unifiedWriteAndWait, publicClient],
  );

  // ─── Take offer ─────────────────────────────────────────────────────

  const takeOffer = useCallback(
    async (offerId: bigint) => {
      const ready = guardReady();
      if (!ready) return null;
      const { offramp } = ready;
      try {
        setState({ ...initial, step: "submitting", isProcessing: true });
        const wr = await unifiedWriteAndWait({
          address: offramp,
          abi: P2POfframpAbi,
          functionName: "takeOffer",
          args: [offerId],
          gas: BigInt(3_000_000),
        });

        let logs: ReadonlyArray<{ address: `0x${string}`; topics: readonly `0x${string}`[]; data: `0x${string}` }>;
        if (wr.receipt) logs = wr.receipt.logs as never;
        else {
          setState((s) => ({ ...s, step: "confirming" }));
          const r = await publicClient!.waitForTransactionReceipt({ hash: wr.hash, confirmations: 1 });
          if (r.status === "reverted") throw new Error("takeOffer reverted");
          logs = r.logs as never;
        }
        const fillId = extractEventId(logs, offramp);
        if (fillId === null) throw new Error("Tx mined but fillId could not be parsed.");

        setState({
          step: "success",
          isProcessing: false,
          error: null,
          txHash: wr.hash,
          lastOfferId: offerId,
          lastFillId: BigInt(fillId),
        });
        invalidateBalanceQueries();
        return { txHash: wr.hash, fillId: BigInt(fillId) };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...initial, step: "error", error: msg, txHash: prev.txHash }));
        throw err;
      }
    },
    [guardReady, unifiedWriteAndWait, publicClient],
  );

  // ─── Submit proof ───────────────────────────────────────────────────

  const submitProof = useCallback(
    async (args: { fillId: bigint; reclaimProof: Hex; providerId: number }) => {
      const ready = guardReady();
      if (!ready) return null;
      const { offramp } = ready;
      try {
        setState((s) => ({ ...s, step: "submitting", isProcessing: true, error: null }));
        const wr = await unifiedWriteAndWait({
          address: offramp,
          abi: P2POfframpAbi,
          functionName: "submitProof",
          args: [args.fillId, args.reclaimProof, args.providerId],
          gas: BigInt(1_500_000),
        });
        setState({
          step: "success",
          isProcessing: false,
          error: null,
          txHash: wr.hash,
          lastOfferId: null,
          lastFillId: args.fillId,
        });
        return { txHash: wr.hash };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...initial, step: "error", error: msg, txHash: prev.txHash }));
        throw err;
      }
    },
    [guardReady, unifiedWriteAndWait],
  );

  // ─── Lifecycle: release / dispute / cancel / expire ────────────────

  const callSimple = useCallback(
    async (functionName: "releaseFill" | "cancelOffer" | "expireFill", id: bigint) => {
      const ready = guardReady();
      if (!ready) return null;
      const { offramp } = ready;
      try {
        setState({ ...initial, step: "submitting", isProcessing: true });
        const wr = await unifiedWriteAndWait({
          address: offramp,
          abi: P2POfframpAbi,
          functionName,
          args: [id],
          gas: BigInt(1_500_000),
        });
        setState({
          step: "success",
          isProcessing: false,
          error: null,
          txHash: wr.hash,
          lastOfferId: functionName === "cancelOffer" ? id : null,
          lastFillId: functionName !== "cancelOffer" ? id : null,
        });
        invalidateBalanceQueries();
        return { txHash: wr.hash };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...initial, step: "error", error: msg, txHash: prev.txHash }));
        throw err;
      }
    },
    [guardReady, unifiedWriteAndWait],
  );

  const releaseFill = useCallback((fillId: bigint) => callSimple("releaseFill", fillId), [callSimple]);
  const cancelOffer = useCallback((offerId: bigint) => callSimple("cancelOffer", offerId), [callSimple]);
  const expireFill  = useCallback((fillId: bigint) => callSimple("expireFill", fillId), [callSimple]);

  const disputeFill = useCallback(
    async (fillId: bigint, reason: string) => {
      const ready = guardReady();
      if (!ready) return null;
      const { offramp } = ready;
      try {
        setState({ ...initial, step: "submitting", isProcessing: true });
        const wr = await unifiedWriteAndWait({
          address: offramp,
          abi: P2POfframpAbi,
          functionName: "disputeFill",
          args: [fillId, reason],
          gas: BigInt(1_500_000),
        });
        setState({
          step: "success",
          isProcessing: false,
          error: null,
          txHash: wr.hash,
          lastOfferId: null,
          lastFillId: fillId,
        });
        return { txHash: wr.hash };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...initial, step: "error", error: msg, txHash: prev.txHash }));
        throw err;
      }
    },
    [guardReady, unifiedWriteAndWait],
  );

  // ─── Reads: order book + my offers + my fills ──────────────────────

  const [openOffers, setOpenOffers] = useState<OfferRow[]>([]);
  const [myOffers, setMyOffers] = useState<OfferRow[]>([]);
  const [myFills, setMyFills] = useState<FillRow[]>([]);
  const [loadingBook, setLoadingBook] = useState(false);

  const refreshBook = useCallback(async () => {
    if (deploy.status !== "live" || !deploy.address || !publicClient) {
      setOpenOffers([]);
      setMyOffers([]);
      setMyFills([]);
      return;
    }
    setLoadingBook(true);
    try {
      const offramp = deploy.address;
      const nextOfferId = (await publicClient.readContract({
        address: offramp,
        abi: P2POfframpAbi,
        functionName: "nextOfferId",
      })) as bigint;

      // v1 read pattern: pull the most-recent 50 offers.
      const start = nextOfferId > 50n ? nextOfferId - 50n : 0n;
      const ids: bigint[] = [];
      for (let i = start; i < nextOfferId; i++) ids.push(i);

      const offers = await Promise.all(
        ids.map(async (id) => {
          const o = (await publicClient.readContract({
            address: offramp,
            abi: P2POfframpAbi,
            functionName: "getOffer",
            args: [id],
          })) as readonly [
            `0x${string}`, `0x${string}`, bigint, bigint, number, `0x${string}`, number, number,
          ];
          return {
            offerId: id,
            maker: o[0],
            vault: o[1],
            fiatAmountMicroUSD: o[2],
            fiatRateMicroUSD: o[3],
            fiatRail: o[4],
            makerHandleHash: o[5],
            expiry: o[6],
            state: o[7],
          } as OfferRow;
        }),
      );

      const isMine = (o: OfferRow) =>
        address && o.maker.toLowerCase() === address.toLowerCase();
      setOpenOffers(offers.filter((o) => o.state === 0).reverse());
      setMyOffers(offers.filter(isMine).reverse());

      const nextFillId = (await publicClient.readContract({
        address: offramp,
        abi: P2POfframpAbi,
        functionName: "nextFillId",
      })) as bigint;
      const fillStart = nextFillId > 50n ? nextFillId - 50n : 0n;
      const fillIds: bigint[] = [];
      for (let i = fillStart; i < nextFillId; i++) fillIds.push(i);

      const fills = await Promise.all(
        fillIds.map(async (id) => {
          const f = (await publicClient.readContract({
            address: offramp,
            abi: P2POfframpAbi,
            functionName: "getFill",
            args: [id],
          })) as readonly [
            bigint, `0x${string}`, bigint, number, number, `0x${string}`, number,
          ];
          return {
            fillId: id,
            offerId: f[0],
            taker: f[1],
            fiatAmountAtLockMicroUSD: f[2],
            lockedAt: f[3],
            proofSubmittedAt: f[4],
            reclaimProofHash: f[5],
            state: f[6],
          } as FillRow;
        }),
      );

      setMyFills(
        fills
          .filter((f) => address && f.taker.toLowerCase() === address.toLowerCase())
          .reverse(),
      );
    } catch (err) {
      console.warn("[useP2POfframp] refreshBook failed", err);
    } finally {
      setLoadingBook(false);
    }
  }, [address, deploy.status, deploy.address, publicClient]);

  useEffect(() => {
    refreshBook();
  }, [refreshBook]);

  const reset = useCallback(() => setState(initial), []);

  return {
    deploy,
    state,
    createOffer,
    takeOffer,
    submitProof,
    releaseFill,
    disputeFill,
    cancelOffer,
    expireFill,
    openOffers,
    myOffers,
    myFills,
    loadingBook,
    refreshBook,
    reset,
    pipeline,
  };
}
