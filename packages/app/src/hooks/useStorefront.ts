// Wave 4 task #254 — Storefront hook covering all three sale modes.
//
// Exposes: createListing, buyFixed, placeBid, closeAuction, revealWinner,
// claimAuctionWin, refundLoserBid, decryptPaidByBuyer, payPWYW,
// deactivateListing. Wires the FHE pipeline so every flow shows real-step
// progress. Auction order: close, reveal winner, then anyone settles the
// win and losers refund. One bid per address per listing.
//
// Funding gate: on an upgraded Storefront, buyFixed and payPWYW leave a
// Pending purchase. This hook decrypts the public "funded" bit and calls
// confirmFunding before it reports a sale, so a short balance never reads as
// a payment. A check that cannot finish leaves the purchase Pending (and in
// a local retry list), never a fake success. Pre-gate contracts keep the
// single-step behaviour.

import { useCallback, useEffect, useRef, useState } from "react";
import { parseUnits } from "viem";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";

import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useFhePipeline } from "./useFhePipeline";
import { useChain } from "@/providers/ChainProvider";
import {
  useCofheEncrypt,
  useCofheConnection,
  useCofheDecryptForTx,
  useCofheDecryptForView,
  Encryptable,
} from "@/lib/cofhe-shim";
import { StorefrontAbi, FHERC20VaultAbi } from "@/lib/abis";
import { MAX_UINT64, getExplorerTxUrl } from "@/lib/constants";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";
import { extractEventId } from "@/lib/event-parser";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { runFundingGate, supportsFundingGate } from "@/lib/funding-gate";
import {
  addPendingFunding,
  asHandle,
  describeGateFailure,
  findPendingId,
  listPendingFundings,
  removePendingFunding,
  type PendingFundingScope,
} from "@/lib/pending-funding";

// ─── Mode enum mirroring the contract ─────────────────────────────────

export const SALE_MODE = {
  FixedPrice: 0,
  Auction: 1,
  PayWhatYouWant: 2,
} as const;
export type SaleMode = typeof SALE_MODE[keyof typeof SALE_MODE];

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

// Storefront.PurchaseStatus
const PURCHASE_PENDING = 1;
const PURCHASE_SOLD = 2;
const PURCHASE_VOID = 3;

/** Storefront.NO_WINNER: the winner index revealed when no bid was eligible. */
export const NO_WINNER_INDEX = 255;

const CONFIRM_GAS = BigInt(3_000_000);

const NO_WINNER_COPY = "No winning bid: all bids refundable";

export type PendingPurchase = { purchaseId: string; listingId: number; hash: `0x${string}` };

// ─── State machine ───────────────────────────────────────────────────

export type StorefrontStep = "idle" | "approving" | "encrypting" | "sending" | "funding" | "success" | "error";

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

// §3.7 of BEST_VERSION_FULL_PLAN: friendly labels for callSimple toasts.
// Pre-fix, users saw raw function names like "closeAuction completed".
const FRIENDLY_LABEL: Record<string, string> = {
  closeAuction: "Auction closed",
  claimAuctionWin: "Auction settled. Seller paid.",
  refundLoserBid: "Losing bid refunded",
  deactivateListing: "Listing deactivated",
};

/** Map Storefront revert strings to copy a user can act on. */
export function friendlyStorefrontError(raw: string): string {
  if (raw.includes("already bid")) return "You already bid on this auction. Each address gets one bid.";
  if (raw.includes("winner not revealed")) return "The winner is not revealed yet. Reveal the winner first.";
  if (raw.includes("winning bid, use claimAuctionWin")) return "This is the winning bid. Settle the auction to pay the seller.";
  if (raw.includes("vault not allowed")) return "This token vault is not enabled for the storefront on this chain.";
  if (raw.includes("winner already revealed")) return "The winner is already revealed.";
  if (raw.includes("already settled")) return "This auction is already settled.";
  if (raw.includes("purchase not pending")) return "This payment was already settled.";
  if (raw.includes("decryption not ready")) return "The funding check is not ready yet. Try again in a minute.";
  return raw;
}

// ─── Hook ────────────────────────────────────────────────────────────

export function useStorefront() {
  const { effectiveAddress: address, notReadyReason } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { connected } = useCofheConnection();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { decryptForTx } = useCofheDecryptForTx();
  const { decryptForView } = useCofheDecryptForView();
  const { unifiedWriteAndWait } = useUnifiedWrite();
  const pipeline = useFhePipeline();

  const [state, setState] = useState<StorefrontState>(initial);
  const [pendingPurchases, setPendingPurchases] = useState<PendingPurchase[]>([]);
  const gateSupportRef = useRef<{ key: string; value: boolean } | null>(null);
  // Purchases whose second step is running now, so a resume never races the buy that created them.
  const inflightRef = useRef<Set<string>>(new Set());
  const finishingRef = useRef(false);

  // ─── helpers ────────────────────────────────────────────────────

  const pendingScope = useCallback(
    (): PendingFundingScope | null =>
      address ? { kind: "purchase", chainId: activeChainId, contract: contracts.Storefront, account: address } : null,
    [address, activeChainId, contracts.Storefront],
  );

  const refreshPendingPurchases = useCallback(() => {
    const scope = pendingScope();
    setPendingPurchases(
      scope
        ? listPendingFundings(scope).map((e) => ({
            purchaseId: e.id,
            listingId: Number(e.data.listingId),
            hash: e.data.hash as `0x${string}`,
          }))
        : [],
    );
  }, [pendingScope]);

  useEffect(() => {
    refreshPendingPurchases();
  }, [refreshPendingPurchases]);

  // Contracts that predate the funding gate have no nextPurchaseId. Probed once
  // per chain; those contracts keep the single-step buy.
  const isGated = useCallback(
    async (sf: `0x${string}`): Promise<boolean> => {
      const key = `${activeChainId}:${sf}`;
      if (gateSupportRef.current?.key === key) return gateSupportRef.current.value;
      const value = await supportsFundingGate(() =>
        publicClient!.readContract({ address: sf, abi: StorefrontAbi, functionName: "nextPurchaseId" }),
      );
      gateSupportRef.current = { key, value };
      return value;
    },
    [activeChainId, publicClient],
  );

  const readPurchaseStatus = useCallback(
    async (sf: `0x${string}`, purchaseId: bigint): Promise<number> => {
      const p = (await publicClient!.readContract({
        address: sf,
        abi: StorefrontAbi,
        functionName: "getPurchase",
        args: [purchaseId],
      })) as readonly [bigint, string, number | bigint, number | bigint];
      return Number(p[3]);
    },
    [publicClient],
  );

  // Step 2 of a purchase: decrypt the public "funded" bit and publish it with
  // confirmFunding. Throws when the check did not finish; the purchase then
  // stays Pending on-chain.
  const settlePurchase = useCallback(
    async (sf: `0x${string}`, purchaseId: bigint): Promise<"sold" | "void"> => {
      const key = purchaseId.toString();
      inflightRef.current.add(key);
      try {
        let funded: boolean;
        try {
          ({ funded } = await runFundingGate({
            readHandle: async () =>
              asHandle(
                await publicClient!.readContract({
                  address: sf,
                  abi: StorefrontAbi,
                  functionName: "getPurchaseFundedHandle",
                  args: [purchaseId],
                }),
              ),
            decryptForTx,
            confirm: async (verdict, signature) => {
              // Anyone may confirm; if someone already did there is nothing to send.
              if ((await readPurchaseStatus(sf, purchaseId)) !== PURCHASE_PENDING) return;
              const res = await unifiedWriteAndWait({
                address: sf,
                abi: StorefrontAbi,
                functionName: "confirmFunding",
                args: [purchaseId, verdict, signature],
                gas: CONFIRM_GAS,
              });
              const receipt =
                res.receipt ?? (await publicClient!.waitForTransactionReceipt({ hash: res.hash, confirmations: 1, timeout: 300_000 }));
              if (receipt.status === "reverted") throw new Error("Funding confirmation reverted on-chain");
            },
          }));
        } catch (err) {
          const settled = await readPurchaseStatus(sf, purchaseId).catch(() => null);
          if (settled === PURCHASE_SOLD) funded = true;
          else if (settled === PURCHASE_VOID) funded = false;
          else throw err;
        }
        return funded ? "sold" : "void";
      } finally {
        inflightRef.current.delete(key);
      }
    },
    [publicClient, decryptForTx, unifiedWriteAndWait, readPurchaseStatus],
  );

  // Runs after the buyFixed / payPWYW transaction mined. Decides from the
  // receipt which contract version answered: a PurchasePending log means the
  // sale is not real until confirmFunding, whatever the probe said.
  const completePayment = useCallback(
    async (args: {
      sf: `0x${string}`;
      writeResult: { hash: `0x${string}`; receipt?: { logs: ReadonlyArray<{ address: string; topics: readonly string[] }> } };
      listingId: number;
      kind: "fixed" | "pwyw";
      gated: boolean;
    }): Promise<boolean> => {
      const { sf, writeResult, listingId, kind, gated } = args;
      let purchaseId = findPendingId(writeResult.receipt?.logs, sf, "purchase");
      if (purchaseId === null && gated) {
        if (!writeResult.receipt) {
          const mined = await publicClient!.waitForTransactionReceipt({ hash: writeResult.hash, confirmations: 1 });
          if (mined.status === "reverted") throw new Error(`${kind === "fixed" ? "buyFixed" : "payPWYW"} reverted`);
          purchaseId = findPendingId(mined.logs, sf, "purchase");
        }
        if (purchaseId === null) {
          const next = asHandle(
            await publicClient!.readContract({ address: sf, abi: StorefrontAbi, functionName: "nextPurchaseId" }),
          );
          if (next === 0n) throw new Error("Payment sent, but its purchase id could not be read. Check History.");
          purchaseId = next - 1n;
        }
      }

      if (purchaseId === null) {
        // Pre-gate contract: the transaction itself is the sale.
        pipeline.markDone();
        setState({ step: "success", isProcessing: false, error: null, txHash: writeResult.hash, lastListingId: listingId });
        invalidateBalanceQueries();
        return true;
      }

      const scope = pendingScope();
      if (scope) {
        addPendingFunding(scope, purchaseId, { listingId: String(listingId), hash: writeResult.hash, kind });
        refreshPendingPurchases();
      }
      pipeline.markConfirming();
      setState({ step: "funding", isProcessing: true, error: null, txHash: writeResult.hash, lastListingId: listingId });

      let verdict: "sold" | "void";
      try {
        verdict = await settlePurchase(sf, purchaseId);
      } catch (gateErr) {
        const msg = describeGateFailure(
          gateErr,
          "Your payment is on-chain but not confirmed. The seller delivers only after it is. It finishes when you reopen this page.",
        );
        pipeline.markFailed(gateErr);
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return false;
      }

      if (scope) removePendingFunding(scope, purchaseId);
      refreshPendingPurchases();
      invalidateBalanceQueries();
      if (verdict === "void") {
        // A missing allowance moves zero too, so re-approve on the next attempt.
        clearVaultApproval(sf);
        const msg =
          kind === "fixed"
            ? "Nothing was charged. Your private balance was too low, or the amount did not match the price."
            : "Nothing was charged. Your private balance was too low.";
        pipeline.markFailed(new Error(msg));
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return false;
      }
      pipeline.markDone();
      setState({ step: "success", isProcessing: false, error: null, txHash: writeResult.hash, lastListingId: listingId });
      return true;
    },
    [publicClient, pipeline, pendingScope, refreshPendingPurchases, settlePurchase],
  );

  // closeAuction can end with no eligible bid. False on contracts that predate NO_WINNER.
  const fetchAuctionNoWinner = useCallback(
    async (listingId: number): Promise<boolean> => {
      const sf = contracts.Storefront as `0x${string}`;
      if (!publicClient || !sf || sf === ZERO_ADDRESS) return false;
      try {
        return (await publicClient.readContract({
          address: sf,
          abi: StorefrontAbi,
          functionName: "auctionHasNoWinner",
          args: [BigInt(listingId)],
        })) === true;
      } catch {
        return false;
      }
    },
    [publicClient, contracts.Storefront],
  );

  const ensureVaultApproval = useCallback(async (vault: `0x${string}`) => {
    const sf = contracts.Storefront as `0x${string}`;
    if (isVaultApproved(sf)) return;
    const toastId = toast.loading("Approving vault...");
    try {
      // §3.4 of BEST_VERSION_FULL_PLAN: AndWait for approve receipt before
      // markVaultApproved caches. Pre-fix race could leave allowance pending
      // when main tx fired.
      await unifiedWriteAndWait({
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
  }, [contracts.Storefront, unifiedWriteAndWait]);

  const guardReady = useCallback((): { sf: `0x${string}` } | null => {
    if (!address || !connected) {
      toast.error(notReadyReason ?? "Wallet not connected");
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
  }, [address, connected, contracts.Storefront, publicClient, state.isProcessing, notReadyReason]);

  // §3.17 of BEST_VERSION_FULL_PLAN: plaintext-only guard for callSimple.
  // closeAuction / claimAuctionWin / refundLoserBid / deactivateListing don't
  // require cofhe-connected; this lets the user complete those flows even
  // when the cofhe shim hasn't connected.
  const guardWalletReady = useCallback((): { sf: `0x${string}` } | null => {
    if (!address) { toast.error(notReadyReason ?? "Wallet not connected"); return null; }
    if (state.isProcessing) return null;
    const sf = contracts.Storefront as `0x${string}`;
    if (!sf || sf === ZERO_ADDRESS) { toast.error("Storefront not deployed on this chain yet"); return null; }
    if (!publicClient) { toast.error("Connection lost. Please refresh."); return null; }
    return { sf };
  }, [address, contracts.Storefront, publicClient, state.isProcessing, notReadyReason]);

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
        const [encPrice, encPriceProof] = await encryptInputsAsync(
          [Encryptable.uint64(priceUnits)],
          sf,
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
            encPrice,
            encPriceProof,BigInt(params.auctionSeconds),
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
        const msg = friendlyStorefrontError(err instanceof Error ? err.message : String(err));
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
        // §3.8 of BEST_VERSION_FULL_PLAN: seller-self-purchase pre-check.
        // Pre-fix, the contract revert fired AFTER 30s of FHE encryption +
        // UserOp prefund. This client-side check fails fast.
        const listing = await publicClient!.readContract({
          address: sf, abi: StorefrontAbi, functionName: "getListing",
          args: [BigInt(params.listingId)],
        }) as readonly [string, ...unknown[]];
        if (address?.toLowerCase() === (listing[0] as string).toLowerCase()) {
          toast.error("You can't buy your own listing.");
          return false;
        }

        pipeline.start();
        setState({ ...initial, step: "approving", isProcessing: true });
        await ensureVaultApproval(params.vault);
        const gated = await isGated(sf);

        setState((s) => ({ ...s, step: "encrypting" }));
        const offerUnits = parseUnits(params.offerTokens, params.decimals);
        const [encOffer, encOfferProof] = await encryptInputsAsync(
          [Encryptable.uint64(offerUnits)],
          sf,
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
            encOffer,
            encOfferProof,params.deliveryNoteHash ?? ZERO_BYTES32,
          ],
          gas: BigInt(5_000_000),
        });

        // §3.10: unifiedWriteAndWait already settled the receipt on the AA path;
        // no extra confirm step on pre-gate contracts. On the funding gate the
        // sale only counts once confirmFunding lands.
        return await completePayment({ sf, writeResult, listingId: params.listingId, kind: "fixed", gated });
      } catch (err) {
        const msg = friendlyStorefrontError(err instanceof Error ? err.message : String(err));
        pipeline.markFailed(err);
        // §3.11: preserve prev.txHash so the error state still links to the
        // failed tx on the explorer. Pre-fix overwrote with ...initial.
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return false;
      }
    },
    [guardReady, pipeline, ensureVaultApproval, encryptInputsAsync, unifiedWriteAndWait, isGated, completePayment],
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
        // §3.8: seller-self-bid pre-check (fail fast pre-encryption).
        const listing = await publicClient!.readContract({
          address: sf, abi: StorefrontAbi, functionName: "getListing",
          args: [BigInt(params.listingId)],
        }) as readonly [string, ...unknown[]];
        if (address?.toLowerCase() === (listing[0] as string).toLowerCase()) {
          toast.error("You can't bid on your own listing.");
          return false;
        }
        // One bid per address per listing. Check before encrypting.
        const alreadyBid = await publicClient!.readContract({
          address: sf, abi: StorefrontAbi, functionName: "hasBid",
          args: [BigInt(params.listingId), address as `0x${string}`],
        }) as boolean;
        if (alreadyBid === true) {
          toast.error(friendlyStorefrontError("Storefront: already bid"));
          return false;
        }

        pipeline.start();
        setState({ ...initial, step: "approving", isProcessing: true });
        await ensureVaultApproval(params.vault);

        setState((s) => ({ ...s, step: "encrypting" }));
        const bidUnits = parseUnits(params.bidTokens, params.decimals);
        const [encBid, encBidProof] = await encryptInputsAsync(
          [Encryptable.uint64(bidUnits)],
          sf,
          pipeline.onEncryptStep,
        );

        pipeline.markSubmitting();
        setState((s) => ({ ...s, step: "sending" }));
        const writeResult = await unifiedWriteAndWait({
          address: sf,
          abi: StorefrontAbi,
          functionName: "placeBid",
          args: [BigInt(params.listingId), encBid, encBidProof],
          gas: BigInt(5_000_000),
        });
        // §3.10: unifiedWriteAndWait settled the receipt; skip confirm flash.
        pipeline.markDone();
        setState({ step: "success", isProcessing: false, error: null, txHash: writeResult.hash, lastListingId: params.listingId });
        invalidateBalanceQueries();
        return true;
      } catch (err) {
        const msg = friendlyStorefrontError(err instanceof Error ? err.message : String(err));
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
      // §3.17: plaintext-only guard. callSimple ops don't need cofhe.
      const ready = guardWalletReady();
      if (!ready) return false;
      const { sf } = ready;
      try {
        // §3.13 of BEST_VERSION_FULL_PLAN: preserve lastListingId across
        // callSimple invocations. Pre-fix, calling closeAuction/refund after
        // a create wiped lastListingId because { ...initial, ... } reset it
        // to null. UI logic that read lastListingId post-callSimple saw null
        // and lost track of which listing the user was working with.
        setState((prev) => ({ ...prev, step: "sending", isProcessing: true, error: null }));
        const wr = await unifiedWriteAndWait({
          address: sf,
          abi: StorefrontAbi,
          functionName,
          args: args as never,
          gas: BigInt(gasLimit),
        });
        // "idle", not "success": the success step drives the buyer's
        // payment-confirmed screen, which is wrong for close/settle/refund.
        setState((prev) => ({ ...prev, step: "idle", isProcessing: false, txHash: wr.hash }));
        invalidateBalanceQueries();
        toast.success(FRIENDLY_LABEL[functionName] ?? "Submitted");
        return true;
      } catch (err) {
        const msg = friendlyStorefrontError(err instanceof Error ? err.message : String(err));
        // §3.11: preserve prev.txHash so the error state still links to the
        // failed tx on the explorer. Pre-fix overwrote with ...initial.
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return false;
      }
    },
    [guardWalletReady, unifiedWriteAndWait],
  );

  const closeAuction = useCallback(
    (listingId: number) => callSimple("closeAuction", [BigInt(listingId)]),
    [callSimple],
  );
  const claimAuctionWin = useCallback(
    async (listingId: number, deliveryNoteHash: `0x${string}` = ZERO_BYTES32) => {
      // An auction that ended with no eligible bid has nothing to settle; the
      // contract would revert "winner not revealed", which reads as a missing step.
      if (await fetchAuctionNoWinner(listingId)) {
        toast.error(`${NO_WINNER_COPY}. There is nothing to settle.`);
        return false;
      }
      return callSimple("claimAuctionWin", [BigInt(listingId), deliveryNoteHash]);
    },
    [callSimple, fetchAuctionNoWinner],
  );
  // closeAuction leaves the winner encrypted. Decrypt the winner index via
  // the Threshold Network and publish it on-chain. Anyone can call; the
  // signature is the gate. Refunds and settlement open after this.
  const revealWinner = useCallback(
    async (listingId: number) => {
      const ready = guardWalletReady();
      if (!ready) return false;
      const { sf } = ready;
      const toastId = toast.loading("Decrypting the winning bid index…");
      try {
        setState((prev) => ({ ...prev, step: "sending", isProcessing: true, error: null }));
        const handle = (await publicClient!.readContract({
          address: sf,
          abi: StorefrontAbi,
          functionName: "getWinnerIdxHandle",
          args: [BigInt(listingId)],
        })) as bigint;
        if (!handle || handle === 0n) throw new Error("Auction is not closed yet.");

        const startedAt = Date.now();
        let proof: { decryptedValue: bigint | boolean; signature: `0x${string}` } | null = null;
        while (Date.now() - startedAt < 60_000) {
          proof = await decryptForTx(handle, "uint8");
          if (proof) break;
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (!proof) throw new Error("Decryption timed out. Try Reveal again shortly.");
        const idx = typeof proof.decryptedValue === "bigint" ? Number(proof.decryptedValue) : Number(proof.decryptedValue ? 1 : 0);

        toast.loading("Publishing the winner on-chain…", { id: toastId });
        await unifiedWriteAndWait({
          address: sf,
          abi: StorefrontAbi,
          functionName: "revealWinner",
          args: [BigInt(listingId), idx, proof.signature],
          gas: BigInt(3_000_000),
        });
        setState((prev) => ({ ...prev, step: "idle", isProcessing: false }));
        // 255 is Storefront.NO_WINNER: no bid was funded and above the minimum.
        toast.success(idx === NO_WINNER_INDEX ? NO_WINNER_COPY : "Winner revealed", { id: toastId });
        return true;
      } catch (err) {
        const msg = friendlyStorefrontError(err instanceof Error ? err.message : String(err));
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg, { id: toastId });
        return false;
      }
    },
    [guardWalletReady, publicClient, decryptForTx, unifiedWriteAndWait],
  );

  // FixedPrice: decrypt the running total a buyer actually paid on a
  // listing. The vault moves 0 on a short balance or a price mismatch, so
  // the seller checks this before delivering. Buyer and seller can decrypt.
  const decryptPaidByBuyer = useCallback(
    async (listingId: number, buyer: `0x${string}`): Promise<bigint> => {
      const sf = contracts.Storefront as `0x${string}`;
      if (!publicClient || !sf || sf === ZERO_ADDRESS) throw new Error("Storefront not deployed on this chain yet");
      const handle = (await publicClient.readContract({
        address: sf,
        abi: StorefrontAbi,
        functionName: "getPaidByBuyer",
        args: [BigInt(listingId), buyer],
      })) as bigint;
      if (!handle || handle === 0n) return 0n;
      const value = await decryptForView(handle, "uint64");
      if (typeof value !== "bigint") throw new Error("Could not decrypt the paid amount. Check your permit and try again.");
      return value;
    },
    [publicClient, contracts.Storefront, decryptForView],
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
        // §3.8: seller-self-pay pre-check (fail fast pre-encryption).
        const listing = await publicClient!.readContract({
          address: sf, abi: StorefrontAbi, functionName: "getListing",
          args: [BigInt(params.listingId)],
        }) as readonly [string, ...unknown[]];
        if (address?.toLowerCase() === (listing[0] as string).toLowerCase()) {
          toast.error("You can't pay your own listing.");
          return false;
        }

        pipeline.start();
        setState({ ...initial, step: "approving", isProcessing: true });
        await ensureVaultApproval(params.vault);
        const gated = await isGated(sf);

        setState((s) => ({ ...s, step: "encrypting" }));
        const amountUnits = parseUnits(params.amountTokens, params.decimals);
        const [encAmount, encAmountProof] = await encryptInputsAsync(
          [Encryptable.uint64(amountUnits)],
          sf,
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
            encAmount,
            encAmountProof,params.deliveryNoteHash ?? ZERO_BYTES32,
          ],
          gas: BigInt(5_000_000),
        });
        // §3.10: unifiedWriteAndWait settled the receipt; skip confirm flash on
        // pre-gate contracts. On the funding gate the payment counts once
        // confirmFunding lands.
        return await completePayment({ sf, writeResult, listingId: params.listingId, kind: "pwyw", gated });
      } catch (err) {
        const msg = friendlyStorefrontError(err instanceof Error ? err.message : String(err));
        pipeline.markFailed(err);
        // §3.11: preserve prev.txHash so the error state still links to the
        // failed tx on the explorer. Pre-fix overwrote with ...initial.
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: msg }));
        toast.error(msg);
        return false;
      }
    },
    [guardReady, pipeline, ensureVaultApproval, encryptInputsAsync, unifiedWriteAndWait, isGated, completePayment],
  );

  /**
   * Finish purchases whose funding check did not complete (tab closed, slow
   * Threshold Network). Safe to call repeatedly. A purchase that turns out Sold
   * puts the hook in the success state so the buyer sees the confirmation.
   */
  const finishPendingPurchases = useCallback(
    async (onlyListingId?: number): Promise<{ sold: number; voided: number; pending: number }> => {
      const out = { sold: 0, voided: 0, pending: 0 };
      const scope = pendingScope();
      const sf = contracts.Storefront as `0x${string}`;
      if (!scope || !publicClient || !connected || !sf || sf === ZERO_ADDRESS || finishingRef.current) return out;
      const entries = listPendingFundings(scope).filter(
        (e) => onlyListingId === undefined || Number(e.data.listingId) === onlyListingId,
      );
      if (entries.length === 0) return out;
      finishingRef.current = true;
      try {
        for (const entry of entries) {
          if (inflightRef.current.has(entry.id)) continue;
          const purchaseId = BigInt(entry.id);
          const listingId = Number(entry.data.listingId);
          try {
            let status = await readPurchaseStatus(sf, purchaseId);
            if (status === PURCHASE_PENDING) {
              setState((prev) => ({ ...prev, step: "funding", isProcessing: true, error: null }));
              status = (await settlePurchase(sf, purchaseId)) === "sold" ? PURCHASE_SOLD : PURCHASE_VOID;
            }
            removePendingFunding(scope, purchaseId);
            if (status === PURCHASE_SOLD) {
              out.sold++;
              setState({
                step: "success",
                isProcessing: false,
                error: null,
                txHash: entry.data.hash as `0x${string}`,
                lastListingId: listingId,
              });
              toast.success("Payment confirmed");
            } else {
              out.voided++;
              clearVaultApproval(sf);
              setState((prev) => ({ ...prev, step: "idle", isProcessing: false }));
              toast.error("A payment did not go through: nothing was charged.");
            }
          } catch (err) {
            out.pending++;
            const msg = describeGateFailure(err, "It stays pending; try again in a minute.");
            setState((prev) => ({ ...prev, step: "error", isProcessing: false, error: msg }));
            toast.error(msg);
          }
        }
        invalidateBalanceQueries();
      } finally {
        finishingRef.current = false;
        refreshPendingPurchases();
      }
      return out;
    },
    [pendingScope, publicClient, connected, contracts.Storefront, readPurchaseStatus, settlePurchase, refreshPendingPurchases],
  );

  const reset = useCallback(() => {
    setState(initial);
    pipeline.reset();
  }, [pipeline]);

  // §3.12 of BEST_VERSION_FULL_PLAN: derived txExplorerUrl. Screens can render
  // it directly without having to know the chain → explorer mapping.
  const txExplorerUrl = state.txHash ? getExplorerTxUrl(state.txHash, activeChainId) : null;

  // §1.15 B4a — seller-side reads. Closes the "no UI to deactivate
  // your own listings" gap (audit B4).
  const fetchSellerListings = useCallback(
    async (seller: `0x${string}`): Promise<bigint[]> => {
      const sfAddr = contracts.Storefront as `0x${string}`;
      if (!publicClient || !sfAddr || sfAddr === "0x0000000000000000000000000000000000000000") {
        return [];
      }
      try {
        const ids = (await publicClient.readContract({
          address: sfAddr,
          abi: StorefrontAbi,
          functionName: "getSellerListings",
          args: [seller],
        })) as readonly bigint[];
        return [...ids];
      } catch {
        return [];
      }
    },
    [publicClient, contracts.Storefront],
  );

  const fetchListing = useCallback(
    async (listingId: bigint) => {
      const sfAddr = contracts.Storefront as `0x${string}`;
      if (!publicClient || !sfAddr) return null;
      try {
        const result = (await publicClient.readContract({
          address: sfAddr,
          abi: StorefrontAbi,
          functionName: "getListing",
          args: [listingId],
        })) as readonly [
          `0x${string}`, `0x${string}`, number, bigint, `0x${string}`,
          boolean, boolean, string, `0x${string}`, string, bigint,
        ];
        const [
          seller, vault, mode, closesAt, winner, active, closed,
          title, descriptionCidHash, deliveryChannel, createdAt,
        ] = result;
        if (seller === "0x0000000000000000000000000000000000000000") return null;
        return {
          id: listingId,
          seller,
          vault,
          mode,
          closesAt,
          winner,
          active,
          closed,
          title,
          descriptionCidHash,
          deliveryChannel,
          createdAt,
        };
      } catch {
        return null;
      }
    },
    [publicClient, contracts.Storefront],
  );

  return {
    state,
    txExplorerUrl,
    pipeline: pipeline.state,
    createListing,
    buyFixed,
    placeBid,
    closeAuction,
    claimAuctionWin,
    revealWinner,
    refundLoserBid,
    decryptPaidByBuyer,
    payPWYW,
    deactivateListing,
    fetchSellerListings,
    fetchListing,
    pendingPurchases,
    finishPendingPurchases,
    fheReady: connected,
    reset,
  };
}
