// Wave 4 task #254 — Storefront hook covering all three sale modes.
//
// Exposes: createListing, buyFixed, placeBid, closeAuction, claimAuctionWin,
// refundLoserBid, payPWYW, deactivateListing. Wires the FHE pipeline so
// every flow shows real-step progress.

import { useCallback, useState } from "react";
import { parseUnits } from "viem";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";

import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useFhePipeline } from "./useFhePipeline";
import { useChain } from "@/providers/ChainProvider";
import { useCofheEncrypt, useCofheConnection, Encryptable } from "@/lib/cofhe-shim";
import { StorefrontAbi, FHERC20VaultAbi } from "@/lib/abis";
import { MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { isVaultApproved, markVaultApproved } from "@/lib/approval";
import { extractEventId } from "@/lib/event-parser";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";

// ─── Mode enum mirroring the contract ─────────────────────────────────

export const SALE_MODE = {
  FixedPrice: 0,
  Auction: 1,
  PayWhatYouWant: 2,
} as const;
export type SaleMode = typeof SALE_MODE[keyof typeof SALE_MODE];

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

// ─── State machine ───────────────────────────────────────────────────

export type StorefrontStep = "idle" | "approving" | "encrypting" | "sending" | "success" | "error";

export interface StorefrontState {
  step: StorefrontStep;
  isProcessing: boolean;
  error: string | null;
  txHash: `0x${string}` | null;
  /** Last created listingId (after createListing). */
  lastListingId: number | null;
}

const initial: StorefrontState = {
  step: "idle",
  isProcessing: false,
  error: null,
  txHash: null,
  lastListingId: null,
};

// ─── Hook ────────────────────────────────────────────────────────────

export function useStorefront() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { connected } = useCofheConnection();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();
  const pipeline = useFhePipeline();

  const [state, setState] = useState<StorefrontState>(initial);

  // ─── helpers ────────────────────────────────────────────────────

  const ensureVaultApproval = useCallback(async (vault: `0x${string}`) => {
    const sf = contracts.Storefront as `0x${string}`;
    if (isVaultApproved(sf)) return;
    const toastId = toast.loading("Approving vault...");
    try {
      await unifiedWrite({
        address: vault,
        abi: FHERC20VaultAbi,
        functionName: "approvePlaintext",
        args: [sf, MAX_UINT64],
        gas: BigInt(5_000_000),
      });
      markVaultApproved(sf);
      toast.success("Approval granted", { id: toastId });
    } catch (err) {
      toast.error("Approval failed", { id: toastId });
      throw err;
    }
  }, [contracts.Storefront, unifiedWrite]);

  const guardReady = useCallback((): { sf: `0x${string}` } | null => {
    if (!address || !connected) {
      toast.error("Wallet not connected");
      return null;
    }
    if (state.isProcessing) return null;
    const sf = contracts.Storefront as `0x${string}`;
    if (!sf || sf === ZERO_ADDRESS) {
      toast.error("Storefront not deployed on this chain yet");
      return null;
    }
    if (!publicClient) {
      toast.error("Connection lost. Please refresh.");
      return null;
    }
    return { sf };
  }, [address, connected, contracts.Storefront, publicClient, state.isProcessing]);

  // ─── createListing ─────────────────────────────────────────────

  const createListing = useCallback(
    async (params: {
      mode: SaleMode;
      vault: `0x${string}`;
      /** Decimal price string ("10.00"). For PWYW use "0". */
      priceTokens: string;
      decimals: number;
      /** For Auction only. Seconds until close (e.g. 86400 for 24h). */
      auctionSeconds: number;
      title: string;
      descriptionCidHash: `0x${string}`;
      deliveryChannel: string;
    }) => {
      const ready = guardReady();
      if (!ready) return null;
      const { sf } = ready;

      try {
        pipeline.start();
        setState({ ...initial, step: "approving", isProcessing: true });

        // Vault approval needed for FixedPrice + Auction (buyer/bidders pay)
        // and for the seller too if their PWYW listing receives via vault.
        // approvePlaintext is idempotent; just always run.
        await ensureVaultApproval(params.vault);

        setState((s) => ({ ...s, step: "encrypting" }));
        const priceUnits = parseUnits(params.priceTokens || "0", params.decimals);
        const [encPrice] = await encryptInputsAsync(
          [Encryptable.uint64(priceUnits)],
          pipeline.onEncryptStep,
        );

        pipeline.markSubmitting();
        setState((s) => ({ ...s, step: "sending" }));
        const writeResult = await unifiedWriteAndWait({
          address: sf,
          abi: StorefrontAbi,
          functionName: "createListing",
          args: [
            params.mode,
            params.vault,
            encPrice as unknown as EncryptedInput,
            BigInt(params.auctionSeconds),
            params.title,
            params.descriptionCidHash,
            params.deliveryChannel,
          ],
          gas: BigInt(5_000_000),
        });

        // §3.10 of BEST_VERSION_FULL_PLAN: markConfirming only fires when we
        // actually need to wait. AA path embeds the receipt in writeResult.receipt
        // so no wait is needed; pre-fix code flashed the "confirming" UI for one
        // frame even when the receipt was already in hand. EOA path still waits.
        let logs: ReadonlyArray<{ address: `0x${string}`; topics: readonly `0x${string}`[]; data: `0x${string}` }>;
        if (writeResult.receipt) {
          logs = writeResult.receipt.logs as never;
        } else {
          pipeline.markConfirming();
          const r = await publicClient!.waitForTransactionReceipt({ hash: writeResult.hash, confirmations: 1 });
          if (r.status === "reverted") throw new Error("createListing reverted");
          logs = r.logs as never;
        }
        const listingId = extractEventId(logs, sf);
        if (listingId === null) {
          throw new Error("Tx mined but listingId could not be read; check History tab.");
        }

        pipeline.markDone();
        setState({ step: "success", isProcessing: false, error: null, txHash: writeResult.hash, lastListingId: listingId });
        invalidateBalanceQueries();
        return listingId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pipeline.markFailed(err);
        // §3.11: preserve prev.txHash so the error state still links to the
        // failed tx on the explorer. Pre-fix overwrote with ...initial.
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return null;
      }
    },
    [guardReady, pipeline, ensureVaultApproval, encryptInputsAsync, unifiedWriteAndWait, publicClient],
  );

  // ─── buyFixed ──────────────────────────────────────────────────

  const buyFixed = useCallback(
    async (params: {
      listingId: number;
      vault: `0x${string}`;
      offerTokens: string;
      decimals: number;
      deliveryNoteHash?: `0x${string}`;
    }) => {
      const ready = guardReady();
      if (!ready) return false;
      const { sf } = ready;

      try {
        pipeline.start();
        setState({ ...initial, step: "approving", isProcessing: true });
        await ensureVaultApproval(params.vault);

        setState((s) => ({ ...s, step: "encrypting" }));
        const offerUnits = parseUnits(params.offerTokens, params.decimals);
        const [encOffer] = await encryptInputsAsync(
          [Encryptable.uint64(offerUnits)],
          pipeline.onEncryptStep,
        );

        pipeline.markSubmitting();
        setState((s) => ({ ...s, step: "sending" }));
        const writeResult = await unifiedWriteAndWait({
          address: sf,
          abi: StorefrontAbi,
          functionName: "buyFixed",
          args: [
            BigInt(params.listingId),
            encOffer as unknown as EncryptedInput,
            params.deliveryNoteHash ?? ZERO_BYTES32,
          ],
          gas: BigInt(5_000_000),
        });

        // §3.10: unifiedWriteAndWait already settled the receipt on the AA path;
        // no extra confirm step. Skip directly to markDone.
        pipeline.markDone();
        setState({ step: "success", isProcessing: false, error: null, txHash: writeResult.hash, lastListingId: params.listingId });
        invalidateBalanceQueries();
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pipeline.markFailed(err);
        // §3.11: preserve prev.txHash so the error state still links to the
        // failed tx on the explorer. Pre-fix overwrote with ...initial.
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return false;
      }
    },
    [guardReady, pipeline, ensureVaultApproval, encryptInputsAsync, unifiedWriteAndWait],
  );

  // ─── placeBid ──────────────────────────────────────────────────

  const placeBid = useCallback(
    async (params: {
      listingId: number;
      vault: `0x${string}`;
      bidTokens: string;
      decimals: number;
    }) => {
      const ready = guardReady();
      if (!ready) return false;
      const { sf } = ready;

      try {
        pipeline.start();
        setState({ ...initial, step: "approving", isProcessing: true });
        await ensureVaultApproval(params.vault);

        setState((s) => ({ ...s, step: "encrypting" }));
        const bidUnits = parseUnits(params.bidTokens, params.decimals);
        const [encBid] = await encryptInputsAsync(
          [Encryptable.uint64(bidUnits)],
          pipeline.onEncryptStep,
        );

        pipeline.markSubmitting();
        setState((s) => ({ ...s, step: "sending" }));
        const writeResult = await unifiedWriteAndWait({
          address: sf,
          abi: StorefrontAbi,
          functionName: "placeBid",
          args: [BigInt(params.listingId), encBid as unknown as EncryptedInput],
          gas: BigInt(5_000_000),
        });
        // §3.10: unifiedWriteAndWait settled the receipt; skip confirm flash.
        pipeline.markDone();
        setState({ step: "success", isProcessing: false, error: null, txHash: writeResult.hash, lastListingId: params.listingId });
        invalidateBalanceQueries();
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pipeline.markFailed(err);
        // §3.11: preserve prev.txHash so the error state still links to the
        // failed tx on the explorer. Pre-fix overwrote with ...initial.
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return false;
      }
    },
    [guardReady, pipeline, ensureVaultApproval, encryptInputsAsync, unifiedWriteAndWait],
  );

  // ─── plain on-chain calls (no encryption) ─────────────────────

  const callSimple = useCallback(
    async (functionName: "closeAuction" | "claimAuctionWin" | "refundLoserBid" | "deactivateListing", args: readonly unknown[], gasLimit = 5_000_000) => {
      const ready = guardReady();
      if (!ready) return false;
      const { sf } = ready;
      try {
        // §3.13 of BEST_VERSION_FULL_PLAN: preserve lastListingId across
        // callSimple invocations. Pre-fix, calling closeAuction/refund after
        // a create wiped lastListingId because { ...initial, ... } reset it
        // to null. UI logic that read lastListingId post-callSimple saw null
        // and lost track of which listing the user was working with.
        setState((prev) => ({ ...prev, step: "sending", isProcessing: true, error: null }));
        await unifiedWriteAndWait({
          address: sf,
          abi: StorefrontAbi,
          functionName,
          args: args as never,
          gas: BigInt(gasLimit),
        });
        setState((prev) => ({ ...prev, step: "success", isProcessing: false }));
        invalidateBalanceQueries();
        toast.success(`${functionName} completed`);
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // §3.11: preserve prev.txHash so the error state still links to the
        // failed tx on the explorer. Pre-fix overwrote with ...initial.
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return false;
      }
    },
    [guardReady, unifiedWriteAndWait],
  );

  const closeAuction = useCallback(
    (listingId: number) => callSimple("closeAuction", [BigInt(listingId)]),
    [callSimple],
  );
  const claimAuctionWin = useCallback(
    (listingId: number, deliveryNoteHash: `0x${string}` = ZERO_BYTES32) =>
      callSimple("claimAuctionWin", [BigInt(listingId), deliveryNoteHash]),
    [callSimple],
  );
  const refundLoserBid = useCallback(
    (listingId: number, bidIndex: number) => callSimple("refundLoserBid", [BigInt(listingId), BigInt(bidIndex)]),
    [callSimple],
  );
  const deactivateListing = useCallback(
    (listingId: number) => callSimple("deactivateListing", [BigInt(listingId)]),
    [callSimple],
  );

  // ─── payPWYW (encrypted amount) ───────────────────────────────

  const payPWYW = useCallback(
    async (params: {
      listingId: number;
      vault: `0x${string}`;
      amountTokens: string;
      decimals: number;
      deliveryNoteHash?: `0x${string}`;
    }) => {
      const ready = guardReady();
      if (!ready) return false;
      const { sf } = ready;
      try {
        pipeline.start();
        setState({ ...initial, step: "approving", isProcessing: true });
        await ensureVaultApproval(params.vault);

        setState((s) => ({ ...s, step: "encrypting" }));
        const amountUnits = parseUnits(params.amountTokens, params.decimals);
        const [encAmount] = await encryptInputsAsync(
          [Encryptable.uint64(amountUnits)],
          pipeline.onEncryptStep,
        );

        pipeline.markSubmitting();
        setState((s) => ({ ...s, step: "sending" }));
        const writeResult = await unifiedWriteAndWait({
          address: sf,
          abi: StorefrontAbi,
          functionName: "payPWYW",
          args: [
            BigInt(params.listingId),
            encAmount as unknown as EncryptedInput,
            params.deliveryNoteHash ?? ZERO_BYTES32,
          ],
          gas: BigInt(5_000_000),
        });
        // §3.10: unifiedWriteAndWait settled the receipt; skip confirm flash.
        pipeline.markDone();
        setState({ step: "success", isProcessing: false, error: null, txHash: writeResult.hash, lastListingId: params.listingId });
        invalidateBalanceQueries();
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pipeline.markFailed(err);
        // §3.11: preserve prev.txHash so the error state still links to the
        // failed tx on the explorer. Pre-fix overwrote with ...initial.
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return false;
      }
    },
    [guardReady, pipeline, ensureVaultApproval, encryptInputsAsync, unifiedWriteAndWait],
  );

  const reset = useCallback(() => {
    setState(initial);
    pipeline.reset();
  }, [pipeline]);

  return {
    state,
    pipeline: pipeline.state,
    createListing,
    buyFixed,
    placeBid,
    closeAuction,
    claimAuctionWin,
    refundLoserBid,
    payPWYW,
    deactivateListing,
    reset,
  };
}
