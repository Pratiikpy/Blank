import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parseUnits, keccak256, toBytes, type Hex } from "viem";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";

import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useFhePipeline } from "./useFhePipeline";
import { useChain } from "@/providers/ChainProvider";
import { useCofheEncrypt, useCofheConnection, useCofheDecryptForView, useCofheDecryptForTx, Encryptable } from "@/lib/cofhe-shim";
import { P2POfframpAbi, FHERC20VaultAbi } from "@/lib/abis";
import { isVaultApproved, markVaultApproved } from "@/lib/approval";
import { extractEventId } from "@/lib/event-parser";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import { type RailId } from "@/lib/reclaim-providers";
import { runFundingGate, supportsFundingGate } from "@/lib/funding-gate";
import { asHandle, describeGateFailure, findPendingId } from "@/lib/pending-funding";
import { FILL_STATE } from "@/lib/offramp-fill-state";

export { FILL_STATE, FILL_STATE_LABEL } from "@/lib/offramp-fill-state";

// Wave 5 Block 1 — encrypted P2P offramp hook.
//
// Mirrors useClaimLinks / useEncryptedEscrow shape:
//   1. Pre-flight (vault approval if needed)
//   2. Encrypt FHE inputs via the cofhe shim
//   3. Submit UserOp via unifiedWriteAndWait
//   4. Parse OfferCreated / FillPending event for the id (FillLocked on pre-gate contracts)
//   5. takeOffer only: confirm the maker's escrow (funding gate) before the fiat leg opens
//   6. Expose state machine to the screen for progress UI
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
  // takeOffer mined; waiting for the funding check of the maker's escrow.
  | "funding"
  | "success"
  | "error";

export type TakeOfferStatus = "locked" | "pending";

const CONFIRM_GAS = BigInt(3_000_000);
// FHERC20Vault.tokenDecimals() is public on-chain but not in the shared vault ABI.
const VAULT_DECIMALS_ABI = [
  { type: "function", name: "tokenDecimals", inputs: [], outputs: [{ name: "", type: "uint8" }], stateMutability: "view" },
] as const;
const UINT64_MAX = BigInt("18446744073709551615");

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

/**
 * Map contract revert strings to copy a user can act on. Unknown errors
 * pass through unchanged.
 */
export function friendlyOfframpError(raw: string): string {
  if (raw.includes("too many open locks")) {
    return "You already have an open fill. Submit its payment proof (or wait for it to expire) before taking another offer.";
  }
  if (raw.includes("provider/rail mismatch")) {
    return "The payment proof is for a different rail than this offer.";
  }
  if (raw.includes("vault not allowed")) {
    return "This token vault is not enabled for the offramp on this chain.";
  }
  if (raw.includes("arbiter window open")) {
    return "The arbiter still has time to rule on this dispute.";
  }
  if (raw.includes("legacy dispute, arbiter only")) {
    return "This dispute predates the timeout rule. Only the arbiter can resolve it.";
  }
  if (raw.includes("maker cannot self-take")) return "You cannot take your own offer.";
  if (raw.includes("offer expired")) return "This offer has expired.";
  if (raw.includes("offer not open")) return "This offer is no longer open.";
  if (raw.includes("proof window open")) return "The taker still has time to submit a proof.";
  if (raw.includes("fill not pending")) return "This fill was already settled.";
  if (raw.includes("decryption not ready")) return "The funding check is not ready yet. Try again in a minute.";
  return raw;
}

// ─── Hook ─────────────────────────────────────────────────────────────

export function useP2POfframp() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { connected } = useCofheConnection();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { decryptForView } = useCofheDecryptForView();
  const { decryptForTx } = useCofheDecryptForTx();
  const { unifiedWriteAndWait } = useUnifiedWrite();
  const pipeline = useFhePipeline();

  const [state, setState] = useState<OfframpState>(initial);
  const gateSupportRef = useRef<{ key: string; value: boolean } | null>(null);

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

        // createOffer verifies both amounts under ONE batch signature.
        const [encAmount, encMin, offerProof] = await encryptInputsAsync(
          [Encryptable.uint64(usdcUnits), Encryptable.uint64(minFillUnits)],
          offramp,
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
            encAmount,
            encMin,
            offerProof,
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
        const msg = friendlyOfframpError(err instanceof Error ? err.message : String(err));
        pipeline.markFailed(err);
        setState((prev) => ({ ...initial, step: "error", error: msg, txHash: prev.txHash }));
        throw new Error(msg);
      }
    },
    [guardReady, ensureVaultApproval, encryptInputsAsync, pipeline, unifiedWriteAndWait, publicClient],
  );

  // ─── Funding gate (second step of takeOffer) ───────────────────────

  // Contracts that predate the funding gate have no fillFunded. Probed once per
  // chain; those contracts keep the single-step takeOffer.
  const isGated = useCallback(
    async (offramp: `0x${string}`): Promise<boolean> => {
      const key = `${activeChainId}:${offramp}`;
      if (gateSupportRef.current?.key === key) return gateSupportRef.current.value;
      const value = await supportsFundingGate(() =>
        publicClient!.readContract({ address: offramp, abi: P2POfframpAbi, functionName: "fillFunded", args: [0n] }),
      );
      gateSupportRef.current = { key, value };
      return value;
    },
    [activeChainId, publicClient],
  );

  const readFillState = useCallback(
    async (offramp: `0x${string}`, fillId: bigint): Promise<number> => {
      const f = (await publicClient!.readContract({
        address: offramp,
        abi: P2POfframpAbi,
        functionName: "getFill",
        args: [fillId],
      })) as readonly [bigint, `0x${string}`, bigint, number, number, `0x${string}`, number];
      return Number(f[6]);
    },
    [publicClient],
  );

  // Decrypt the public "escrow is non-zero and covers the taker's minimum" bit
  // and publish it with confirmFunding. Locked: the fiat leg may start. Voided:
  // the maker's escrow was empty or short, the offer is open again. Throws when
  // the check did not finish; the fill then stays Pending on-chain.
  const settleFill = useCallback(
    async (offramp: `0x${string}`, fillId: bigint): Promise<"locked" | "voided"> => {
      let funded: boolean;
      try {
        ({ funded } = await runFundingGate({
          readHandle: async () =>
            asHandle(
              await publicClient!.readContract({
                address: offramp,
                abi: P2POfframpAbi,
                functionName: "fillFunded",
                args: [fillId],
              }),
            ),
          decryptForTx,
          confirm: async (verdict, signature) => {
            // Anyone may confirm; if someone already did there is nothing to send.
            if ((await readFillState(offramp, fillId)) !== FILL_STATE.Pending) return;
            const res = await unifiedWriteAndWait({
              address: offramp,
              abi: P2POfframpAbi,
              functionName: "confirmFunding",
              args: [fillId, verdict, signature],
              gas: CONFIRM_GAS,
            });
            const receipt =
              res.receipt ?? (await publicClient!.waitForTransactionReceipt({ hash: res.hash, confirmations: 1, timeout: 300_000 }));
            if (receipt.status === "reverted") throw new Error("Funding confirmation reverted on-chain");
          },
        }));
      } catch (err) {
        const settled = await readFillState(offramp, fillId).catch(() => null);
        if (settled === null || settled === FILL_STATE.Pending) throw err;
        funded = settled !== FILL_STATE.Voided;
      }
      return funded ? "locked" : "voided";
    },
    [publicClient, decryptForTx, unifiedWriteAndWait, readFillState],
  );

  /**
   * Finish a fill left Pending (tab closed, slow Threshold Network). Anyone can
   * call it. Resolves with the on-chain verdict; throws with the real reason when
   * the check still cannot finish.
   */
  const confirmPendingFill = useCallback(
    async (fillId: bigint): Promise<"locked" | "voided"> => {
      if (deploy.status !== "live" || !deploy.address || !publicClient) {
        throw new Error(deploy.reason ?? "Offramp not available on this chain.");
      }
      if (!connected) throw new Error("FHE network connecting; try again in a moment.");
      const offramp = deploy.address;
      const current = await readFillState(offramp, fillId);
      if (current !== FILL_STATE.Pending) return current === FILL_STATE.Voided ? "voided" : "locked";
      setState({ ...initial, step: "funding", isProcessing: true, lastFillId: fillId });
      try {
        const verdict = await settleFill(offramp, fillId);
        setState({ ...initial, step: "success", lastFillId: fillId });
        invalidateBalanceQueries();
        return verdict;
      } catch (err) {
        const msg = friendlyOfframpError(
          describeGateFailure(err, "The fill is still pending on-chain; anyone can finish it later."),
        );
        setState({ ...initial, step: "error", error: msg, lastFillId: fillId });
        throw new Error(msg);
      }
    },
    [deploy, publicClient, connected, readFillState, settleFill],
  );

  // ─── Take offer ─────────────────────────────────────────────────────

  // Least USDC (base units) the taker accepts for the fiat price on the offer:
  // fiat * 10^decimals / rate. The contract voids a fill whose escrow is below it.
  const minUsdcFor = useCallback(
    async (offramp: `0x${string}`, offerId: bigint): Promise<bigint> => {
      const o = (await publicClient!.readContract({
        address: offramp,
        abi: P2POfframpAbi,
        functionName: "getOffer",
        args: [offerId],
      })) as readonly [`0x${string}`, `0x${string}`, bigint, bigint, number, `0x${string}`, number, number];
      const [, vault, fiatMicroUsd, rateMicroUsd] = o;
      if (rateMicroUsd === 0n) throw new Error("This offer has no price set.");
      let decimals = 6;
      try {
        decimals = Number(
          await publicClient!.readContract({ address: vault, abi: VAULT_DECIMALS_ABI, functionName: "tokenDecimals" }),
        );
      } catch {
        // Every offramp screen prices in a 6-decimal USDC vault.
      }
      const min = (fiatMicroUsd * 10n ** BigInt(decimals)) / rateMicroUsd;
      if (min > UINT64_MAX) throw new Error("This offer's price is out of range.");
      return min;
    },
    [publicClient],
  );

  const takeOffer = useCallback(
    async (offerId: bigint): Promise<{ txHash: `0x${string}`; fillId: bigint; status: TakeOfferStatus } | null> => {
      const ready = guardReady();
      if (!ready) return null;
      const { offramp } = ready;
      try {
        setState({ ...initial, step: "submitting", isProcessing: true });
        const gated = await isGated(offramp);
        const wr = gated
          ? await unifiedWriteAndWait({
              address: offramp,
              abi: P2POfframpAbi,
              functionName: "takeOfferExpecting",
              args: [offerId, await minUsdcFor(offramp, offerId)],
              gas: BigInt(3_000_000),
            })
          : await unifiedWriteAndWait({
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
        // The receipt is the authority on which contract version answered: a
        // FillPending log means the fiat leg must wait, whatever the probe said.
        const pendingFillId = findPendingId(logs, offramp, "fill");
        const fillId = pendingFillId !== null ? Number(pendingFillId) : extractEventId(logs, offramp);
        if (fillId === null) throw new Error("Tx mined but fillId could not be parsed.");

        if (pendingFillId === null) {
          setState({
            step: "success",
            isProcessing: false,
            error: null,
            txHash: wr.hash,
            lastOfferId: offerId,
            lastFillId: BigInt(fillId),
          });
          invalidateBalanceQueries();
          return { txHash: wr.hash, fillId: BigInt(fillId), status: "locked" };
        }

        setState({
          step: "funding",
          isProcessing: true,
          error: null,
          txHash: wr.hash,
          lastOfferId: offerId,
          lastFillId: pendingFillId,
        });
        let verdict: "locked" | "voided";
        try {
          verdict = await settleFill(offramp, pendingFillId);
        } catch (gateErr) {
          const msg = friendlyOfframpError(
            describeGateFailure(
              gateErr,
              "The fill exists but is not locked yet. Do not send fiat until it is; open the fill to finish the check.",
            ),
          );
          setState({
            step: "error",
            isProcessing: false,
            error: msg,
            txHash: wr.hash,
            lastOfferId: offerId,
            lastFillId: pendingFillId,
          });
          invalidateBalanceQueries();
          return { txHash: wr.hash, fillId: pendingFillId, status: "pending" };
        }
        invalidateBalanceQueries();
        if (verdict === "voided") {
          throw new Error("The maker's balance was too low; the offer is open again.");
        }
        setState({
          step: "success",
          isProcessing: false,
          error: null,
          txHash: wr.hash,
          lastOfferId: offerId,
          lastFillId: pendingFillId,
        });
        return { txHash: wr.hash, fillId: pendingFillId, status: "locked" };
      } catch (err) {
        const msg = friendlyOfframpError(err instanceof Error ? err.message : String(err));
        setState((prev) => ({ ...initial, step: "error", error: msg, txHash: prev.txHash }));
        throw new Error(msg);
      }
    },
    [guardReady, unifiedWriteAndWait, publicClient, isGated, minUsdcFor, settleFill],
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
        const msg = friendlyOfframpError(err instanceof Error ? err.message : String(err));
        setState((prev) => ({ ...initial, step: "error", error: msg, txHash: prev.txHash }));
        throw new Error(msg);
      }
    },
    [guardReady, unifiedWriteAndWait],
  );

  // ─── Lifecycle: release / dispute / cancel / expire ────────────────

  const callSimple = useCallback(
    async (functionName: "releaseFill" | "cancelOffer" | "expireFill" | "resolveStaleDispute", id: bigint) => {
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
        const msg = friendlyOfframpError(err instanceof Error ? err.message : String(err));
        setState((prev) => ({ ...initial, step: "error", error: msg, txHash: prev.txHash }));
        throw new Error(msg);
      }
    },
    [guardReady, unifiedWriteAndWait],
  );

  const releaseFill = useCallback((fillId: bigint) => callSimple("releaseFill", fillId), [callSimple]);
  const cancelOffer = useCallback((offerId: bigint) => callSimple("cancelOffer", offerId), [callSimple]);
  const expireFill  = useCallback((fillId: bigint) => callSimple("expireFill", fillId), [callSimple]);
  const resolveStaleDispute = useCallback(
    (fillId: bigint) => callSimple("resolveStaleDispute", fillId),
    [callSimple],
  );

  /**
   * Decrypt what the vault actually moved into escrow for a fill. The
   * vault moves 0 when the maker is short, so the taker must see this
   * before sending fiat. Only the taker and maker hold decrypt access.
   * Returns the amount in vault base units; throws on any failure so the
   * screen never treats "unknown" as "funded".
   */
  const decryptEscrowedAmount = useCallback(
    async (fillId: bigint): Promise<bigint> => {
      if (deploy.status !== "live" || !deploy.address || !publicClient) {
        throw new Error(deploy.reason ?? "Offramp not available on this chain.");
      }
      const handle = (await publicClient.readContract({
        address: deploy.address,
        abi: P2POfframpAbi,
        functionName: "getEscrowedAmount",
        args: [fillId],
      })) as bigint;
      if (handle === 0n) throw new Error("No escrow handle recorded for this fill.");
      const value = await decryptForView(handle, "uint64");
      if (typeof value !== "bigint") {
        throw new Error("Could not decrypt the escrowed amount. Check your permit and try again.");
      }
      return value;
    },
    [deploy.status, deploy.address, deploy.reason, publicClient, decryptForView],
  );

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
        const msg = friendlyOfframpError(err instanceof Error ? err.message : String(err));
        setState((prev) => ({ ...initial, step: "error", error: msg, txHash: prev.txHash }));
        throw new Error(msg);
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
    confirmPendingFill,
    fheReady: connected,
    submitProof,
    releaseFill,
    disputeFill,
    cancelOffer,
    expireFill,
    resolveStaleDispute,
    decryptEscrowedAmount,
    openOffers,
    myOffers,
    myFills,
    loadingBook,
    refreshBook,
    reset,
    pipeline,
  };
}
