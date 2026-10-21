import { useCallback, useRef, useState } from "react";
import { parseUnits } from "viem";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";

import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useFhePipeline } from "./useFhePipeline";
import { useChain } from "@/providers/ChainProvider";
import { useCofheEncrypt, useCofheConnection, useCofheDecryptForTx, Encryptable } from "@/lib/cofhe-shim";
import { runFundingGate, supportsFundingGate, FundingGateTimeout } from "@/lib/funding-gate";
import { ClaimLinksAbi, FHERC20VaultAbi } from "@/lib/abis";
import { MAX_UINT64, getExplorerTxUrl } from "@/lib/constants";
import { isVaultApproved, markVaultApproved } from "@/lib/approval";
import { extractEventId } from "@/lib/event-parser";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import {
  MODE,
  type LinkMode,
  generateClaimKey,
  deriveClaimKeyPriv,
  claimKeyAddress,
  signClaimDigest,
  buildClaimUrl,
  secretBytes32,
} from "@/lib/claim-links";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Thrown for a pre-upgrade Bearer/EmailBound link: those claim paths were
 *  removed on-chain, so only the sender's refund after expiry remains. */
export const LEGACY_LINK_MESSAGE =
  "This link was created before the claim upgrade and can no longer be claimed. The sender can refund it after it expires.";

// ─── Step Machine — drives FHE-loading-state UI (Wave 4 task #245) ────

export type ClaimLinkStep =
  | "input"
  | "approving"
  | "encrypting"
  | "confirming"
  | "sending"
  | "funding"
  | "success"
  | "error";

/** ClaimLinks.FundingStatus, by name. Links created before the funding gate read as "active". */
export type ClaimLinkFunding = "active" | "pending" | "void";
const FUNDING_BY_CODE: readonly ClaimLinkFunding[] = ["active", "pending", "void"];
const FUNDING_PENDING = 1;

export const CLAIM_LINK_UNFUNDED_MESSAGE =
  "The link was not funded: your private balance was too low. Nothing was locked.";

function pendingFundingMessage(linkId: number, err: unknown): string {
  const reason = err instanceof FundingGateTimeout ? "the funding check is not ready yet" : err instanceof Error ? err.message : String(err);
  return `Link #${linkId} was created but its funding is not confirmed (${reason}). It cannot be claimed until it is. Press Finish funding to retry.`;
}

/** Turns the contract's funding-gate reverts into something a recipient can act on. */
export function friendlyClaimError(message: string): string {
  if (message.includes("funding pending")) return "This link is still being funded. Try again in a minute.";
  if (message.includes("link unfunded")) return "This link was never funded, so there is nothing to claim.";
  return message;
}

export interface ClaimLinkState {
  step: ClaimLinkStep;
  isProcessing: boolean;
  error: string | null;
  txHash: `0x${string}` | null;
  /** Populated after createLink succeeds. */
  shareableUrl: string | null;
  /** linkId returned by createLink — kept around for the success screen. */
  linkId: number | null;
  /** Funding verdict for linkId. Null on a contract that predates the funding gate. */
  funding: ClaimLinkFunding | null;
}

const initial: ClaimLinkState = {
  step: "input",
  isProcessing: false,
  error: null,
  txHash: null,
  shareableUrl: null,
  linkId: null,
  funding: null,
};

// ─── Mode-specific input bag ──────────────────────────────────────────

export type CreateLinkInput =
  | { mode: typeof MODE.Bearer }
  | { mode: typeof MODE.EmailBound; email: string }
  | { mode: typeof MODE.AddressBound; boundAddress: `0x${string}` };

// ─── Hook ─────────────────────────────────────────────────────────────

export function useClaimLinks() {
  const { effectiveAddress: address, notReadyReason } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { connected } = useCofheConnection();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();
  // Wave 4 task #245 — drive a real-step FHE progress UI off the SDK's
  // built-in onStep callback. Exposed back to the caller via state.pipeline
  // so screens can render <FhePipelineProgress state={state.pipeline} />.
  const pipeline = useFhePipeline();
  const { decryptForTx } = useCofheDecryptForTx();

  const [state, setState] = useState<ClaimLinkState>(initial);

  // Chains whose ClaimLinks has the funding gate. Only a positive probe is
  // kept: a failed probe may be a flaky RPC, so the next call asks again.
  const gateSupport = useRef(new Set<string>());
  const gateSupported = useCallback(
    async (cl: `0x${string}`): Promise<boolean> => {
      const key = `${activeChainId}:${cl.toLowerCase()}`;
      if (gateSupport.current.has(key)) return true;
      if (!publicClient) return false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const ok = await supportsFundingGate(() =>
          publicClient.readContract({ address: cl, abi: ClaimLinksAbi, functionName: "getFundingCheck", args: [0n] }),
        );
        if (ok) {
          gateSupport.current.add(key);
          return true;
        }
      }
      return false;
    },
    [activeChainId, publicClient],
  );

  // Decrypts "funded" for a PendingFunding link and publishes it. Anyone can
  // run it, so a link another tab or user already settled is a no-op.
  const runGate = useCallback(
    async (cl: `0x${string}`, linkId: number): Promise<boolean> => {
      const client = publicClient!;
      const { funded } = await runFundingGate({
        readHandle: async () =>
          BigInt(
            (await client.readContract({
              address: cl,
              abi: ClaimLinksAbi,
              functionName: "getFundingCheck",
              args: [BigInt(linkId)],
            })) as bigint | `0x${string}`,
          ),
        decryptForTx,
        confirm: async (verdict, signature) => {
          try {
            const status = await client.readContract({
              address: cl,
              abi: ClaimLinksAbi,
              functionName: "fundingStatus",
              args: [BigInt(linkId)],
            });
            if (Number(status) !== FUNDING_PENDING) return;
          } catch {
            // Status unreadable: let the write decide.
          }
          const r = await unifiedWriteAndWait({
            address: cl,
            abi: ClaimLinksAbi,
            functionName: "confirmFunding",
            args: [BigInt(linkId), verdict, signature],
            gas: BigInt(5_000_000),
          });
          if (r.receipt?.status === "reverted") throw new Error("confirmFunding reverted on-chain");
        },
      });
      return funded;
    },
    [publicClient, decryptForTx, unifiedWriteAndWait],
  );

  // ─── createLink ────────────────────────────────────────────────────

  const createLink = useCallback(
    async (params: {
      vault: `0x${string}`;
      amountTokens: string; // human-readable, e.g. "10.50"
      decimals: number;     // typically 6 for USDC
      note: string;
      expirySeconds: number; // 0 = use contract default (7 days)
      input: CreateLinkInput;
    }) => {
      if (!address || !connected) {
        toast.error(notReadyReason ?? "Wallet not connected");
        return null;
      }
      if (state.isProcessing) return null;

      const claimLinksAddress = contracts.ClaimLinks as `0x${string}`;
      if (!claimLinksAddress || claimLinksAddress === "0x0000000000000000000000000000000000000000") {
        toast.error("ClaimLinks not deployed on this chain yet");
        return null;
      }
      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return null;
      }

      try {
        pipeline.start();
        setState((s) => ({ ...s, step: "approving", isProcessing: true, error: null, shareableUrl: null, linkId: null }));

        // Ensure the ClaimLinks contract has plaintext-MAX allowance on the vault.
        if (!isVaultApproved(claimLinksAddress)) {
          const toastId = toast.loading("Approving encrypted transfers...");
          try {
            // §3.4 of BEST_VERSION_FULL_PLAN: AndWait so the receipt confirms
            // before we mark the approval cached. Pre-fix used unifiedWrite
            // (no wait) and markVaultApproved fired before the approve tx
            // mined. If the main tx ran first, transferFromVerified reverted
            // with "insufficient allowance" and the localStorage flag was
            // still set, so retry skipped re-approve and the user was locked.
            await unifiedWriteAndWait({
              address: params.vault,
              abi: FHERC20VaultAbi,
              functionName: "approvePlaintext",
              args: [claimLinksAddress, MAX_UINT64],
              gas: BigInt(5_000_000),
            });
            markVaultApproved(claimLinksAddress);
            toast.success("Approval granted", { id: toastId });
          } catch (err) {
            toast.error("Approval failed", { id: toastId });
            throw err;
          }
        }

        const gated = await gateSupported(claimLinksAddress);

        // Generate the secret and the one-time claim key it derives. Only the
        // key's address goes on-chain; the secret stays in the URL fragment.
        let email: string | undefined;
        let boundAddress: `0x${string}` = "0x0000000000000000000000000000000000000000";
        switch (params.input.mode) {
          case MODE.Bearer:
            break;
          case MODE.EmailBound:
            if (!params.input.email || params.input.email.indexOf("@") < 1) {
              throw new Error("Email is required for EmailBound mode");
            }
            email = params.input.email;
            break;
          case MODE.AddressBound:
            if (!params.input.boundAddress) {
              throw new Error("Address is required for AddressBound mode");
            }
            boundAddress = params.input.boundAddress;
            break;
        }
        const { secret, claimKey } = generateClaimKey(params.input.mode, email);

        // Encrypt the amount. The SDK fires step callbacks for each of
        // its 5 internal phases (initTfhe → fetchKeys → pack → prove →
        // verify); the pipeline hook turns those into a live progress UI.
        setState((s) => ({ ...s, step: "encrypting" }));
        const amountUnits = parseUnits(params.amountTokens, params.decimals);
        const [encAmount, encAmountProof] = await encryptInputsAsync(
          [Encryptable.uint64(amountUnits)],
          claimLinksAddress,
          pipeline.onEncryptStep,
        );

        // Submit createLink.
        pipeline.markSubmitting();
        setState((s) => ({ ...s, step: "sending" }));
        const writeResult = await unifiedWriteAndWait({
          address: claimLinksAddress,
          abi: ClaimLinksAbi,
          functionName: "createLink",
          args: [
            params.vault,
            encAmount,
            encAmountProof,
            claimKey,
            params.input.mode,
            boundAddress,
            BigInt(params.expirySeconds),
            params.note,
          ],
          gas: BigInt(5_000_000),
        });

        // Get the receipt + extract linkId from LinkCreated event.
        type ReceiptShape = {
          status: "success" | "reverted";
          logs: ReadonlyArray<{ address: `0x${string}`; topics: readonly `0x${string}`[]; data: `0x${string}` }>;
        };
        // §3.10: markConfirming only fires on the EOA path that actually waits.
        // AA path embeds the receipt in writeResult.receipt; no wait, no flash.
        let receipt: ReceiptShape;
        if (writeResult.receipt) {
          receipt = {
            status: writeResult.receipt.status,
            logs: writeResult.receipt.logs as ReceiptShape["logs"],
          };
        } else {
          pipeline.markConfirming();
          const r = await publicClient.waitForTransactionReceipt({ hash: writeResult.hash, confirmations: 1 });
          receipt = { status: r.status, logs: r.logs as ReceiptShape["logs"] };
        }
        if (receipt.status === "reverted") throw new Error("createLink reverted on-chain");

        // LinkCreated has linkId as first indexed param → topics[1].
        // §1.7 of BEST_VERSION_FULL_PLAN: extractEventId now returns null
        // on miss instead of 0 (which previously routed share-links at id=0,
        // potentially someone else's first link).
        const linkId = extractEventId(receipt.logs, claimLinksAddress);
        if (linkId === null) {
          throw new Error("Tx mined but linkId could not be read; check History tab.");
        }

        const shareableUrl = buildClaimUrl(activeChainId, linkId, params.input.mode, secret);

        // The link is only claimable once the funding check is published. Until
        // then the URL is kept in state but the screen must not offer it.
        let funding: ClaimLinkFunding | null = null;
        let pendingNote: string | null = null;
        if (gated) {
          setState((s) => ({ ...s, step: "funding" }));
          try {
            funding = (await runGate(claimLinksAddress, linkId)) ? "active" : "void";
          } catch (gateErr) {
            funding = "pending";
            pendingNote = pendingFundingMessage(linkId, gateErr);
          }
        }
        invalidateBalanceQueries();

        if (funding === "void") {
          pipeline.markFailed(new Error(CLAIM_LINK_UNFUNDED_MESSAGE));
          setState({
            step: "error",
            isProcessing: false,
            error: CLAIM_LINK_UNFUNDED_MESSAGE,
            txHash: writeResult.hash,
            shareableUrl: null,
            linkId,
            funding,
          });
          toast.error(CLAIM_LINK_UNFUNDED_MESSAGE);
          return null;
        }

        pipeline.markDone();
        setState({
          step: "success",
          isProcessing: false,
          error: null,
          txHash: writeResult.hash,
          shareableUrl,
          linkId,
          funding,
        });
        if (pendingNote) toast.error(pendingNote);
        return { linkId, shareableUrl, secretHex: secretBytes32(secret), funding };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pipeline.markFailed(err);
        // §3.11: preserve prev.txHash so the error state still links to the
        // failed tx on the explorer.
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: message }));
        toast.error(message);
        return null;
      }
    },
    [address, connected, contracts.ClaimLinks, publicClient, unifiedWrite, unifiedWriteAndWait, encryptInputsAsync, activeChainId, state.isProcessing, pipeline, gateSupported, runGate],
  );

  // ─── claim ─────────────────────────────────────────────────────────

  const claim = useCallback(
    async (params: {
      linkId: number;
      mode: LinkMode;
      secret: Uint8Array;
      email?: string; // required for EmailBound
    }) => {
      const claimLinksAddress = contracts.ClaimLinks as `0x${string}`;
      if (!claimLinksAddress || claimLinksAddress === "0x0000000000000000000000000000000000000000") {
        toast.error("ClaimLinks not deployed on this chain");
        return false;
      }

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return false;
      }
      if (!address) {
        toast.error(notReadyReason ?? "Wallet not connected");
        return false;
      }

      try {
        pipeline.start();
        pipeline.markSubmitting();
        setState((s) => ({ ...s, step: "sending", isProcessing: true, error: null }));
        const linkIdBig = BigInt(params.linkId);

        const registeredKey = (await publicClient.readContract({
          address: claimLinksAddress,
          abi: ClaimLinksAbi,
          functionName: "claimKeyOf",
          args: [linkIdBig],
        })) as `0x${string}`;

        let writeArgs: { functionName: "claim" | "claimAddressBound"; args: readonly unknown[] };
        if (registeredKey.toLowerCase() !== ZERO_ADDRESS) {
          // v2: derive the claim key from the secret, check it matches, and
          // sign the digest bound to the address that will send the tx.
          if (params.mode === MODE.EmailBound && !params.email) {
            throw new Error("Email is required to claim this link");
          }
          const priv = deriveClaimKeyPriv(params.mode, params.secret, params.email);
          if (!priv) throw new Error("This claim link is malformed");
          if (claimKeyAddress(priv).toLowerCase() !== registeredKey.toLowerCase()) {
            throw new Error(
              params.mode === MODE.EmailBound
                ? "That email does not match this link"
                : "This claim link is invalid or was copied incorrectly",
            );
          }
          const digest = (await publicClient.readContract({
            address: claimLinksAddress,
            abi: ClaimLinksAbi,
            functionName: "claimDigest",
            args: [linkIdBig, address],
          })) as `0x${string}`;
          const signature = await signClaimDigest(priv, digest);
          writeArgs = { functionName: "claim", args: [linkIdBig, signature] };
        } else if (params.mode === MODE.AddressBound) {
          // Legacy AddressBound links still claim with the secret; only the
          // bound address can call, so it is not front-runnable.
          writeArgs = { functionName: "claimAddressBound", args: [linkIdBig, secretBytes32(params.secret)] };
        } else {
          throw new Error(LEGACY_LINK_MESSAGE);
        }

        const writeResult = await unifiedWriteAndWait({
          address: claimLinksAddress,
          abi: ClaimLinksAbi,
          functionName: writeArgs.functionName,
          args: writeArgs.args as never,
          gas: BigInt(5_000_000),
        });

        // §3.10: unifiedWriteAndWait already settled the receipt; skip flash.
        pipeline.markDone();
        setState({
          step: "success",
          isProcessing: false,
          error: null,
          txHash: writeResult.hash,
          shareableUrl: null,
          linkId: params.linkId,
          funding: null,
        });
        invalidateBalanceQueries();
        return true;
      } catch (err) {
        const message = friendlyClaimError(err instanceof Error ? err.message : String(err));
        pipeline.markFailed(err);
        // §3.11: preserve prev.txHash so the error state still links to the
        // failed tx on the explorer.
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: message }));
        toast.error(message);
        return false;
      }
    },
    [contracts.ClaimLinks, publicClient, address, notReadyReason, unifiedWriteAndWait, pipeline],
  );

  // ─── refund ────────────────────────────────────────────────────────

  const refund = useCallback(
    async (linkId: number) => {
      const claimLinksAddress = contracts.ClaimLinks as `0x${string}`;
      if (!claimLinksAddress || claimLinksAddress === "0x0000000000000000000000000000000000000000") return false;
      try {
        await unifiedWriteAndWait({
          address: claimLinksAddress,
          abi: ClaimLinksAbi,
          functionName: "refundLink",
          args: [BigInt(linkId)],
          gas: BigInt(2_000_000),
        });
        invalidateBalanceQueries();
        toast.success("Refund completed");
        return true;
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const message = raw.includes("funding pending")
          ? "This link is still waiting for its funding check. Finish or cancel it instead."
          : raw.includes("link unfunded")
            ? "This link was never funded, so there is nothing to refund."
            : raw;
        toast.error(message);
        return false;
      }
    },
    [contracts.ClaimLinks, unifiedWriteAndWait],
  );

  /**
   * Finish a link left PendingFunding (the funding check timed out, or the tab
   * closed). Anyone can run it. Returns the verdict, or null when it could not
   * be completed; the link then stays pending and can be retried. When the link
   * is the one just created, the hook state follows the verdict.
   */
  const finishFunding = useCallback(
    async (linkId: number): Promise<"funded" | "unfunded" | null> => {
      const cl = contracts.ClaimLinks as `0x${string}`;
      if (!cl || cl === ZERO_ADDRESS) return null;
      if (!address) {
        toast.error(notReadyReason ?? "Wallet not connected");
        return null;
      }
      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return null;
      }
      if (state.isProcessing) return null;
      if (!(await gateSupported(cl))) {
        toast.error("This claim link contract has no funding check to finish.");
        return null;
      }
      const isCurrent = state.linkId === linkId;
      setState((prev) => ({ ...prev, step: "funding", isProcessing: true, error: null }));
      const toastId = toast.loading("Confirming funding...");
      try {
        const funded = await runGate(cl, linkId);
        invalidateBalanceQueries();
        setState((prev) =>
          isCurrent
            ? funded
              ? { ...prev, step: "success", isProcessing: false, funding: "active" }
              : { ...prev, step: "error", isProcessing: false, error: CLAIM_LINK_UNFUNDED_MESSAGE, shareableUrl: null, funding: "void" }
            : { ...prev, step: "input", isProcessing: false },
        );
        if (funded) toast.success("Link funded", { id: toastId });
        else toast.error(CLAIM_LINK_UNFUNDED_MESSAGE, { id: toastId });
        return funded ? "funded" : "unfunded";
      } catch (err) {
        const msg = pendingFundingMessage(linkId, err);
        setState((prev) => ({ ...prev, isProcessing: false, step: isCurrent ? "success" : "error", error: msg }));
        toast.error(msg, { id: toastId });
        return null;
      }
    },
    [contracts.ClaimLinks, address, notReadyReason, publicClient, state.isProcessing, state.linkId, gateSupported, runGate],
  );

  /** Sender abandons a link still waiting for its funding check. Nothing is shareable afterwards. */
  const cancelPending = useCallback(
    async (linkId: number) => {
      const cl = contracts.ClaimLinks as `0x${string}`;
      if (!cl || cl === ZERO_ADDRESS) return false;
      try {
        await unifiedWriteAndWait({
          address: cl,
          abi: ClaimLinksAbi,
          functionName: "cancelPendingLink",
          args: [BigInt(linkId)],
          gas: BigInt(5_000_000),
        });
        invalidateBalanceQueries();
        toast.success("Link cancelled");
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [contracts.ClaimLinks, unifiedWriteAndWait],
  );

  const reset = useCallback(() => {
    setState(initial);
    pipeline.reset();
  }, [pipeline]);

  // §1.15 B3 — sender-side reads. Closes the "you can refund from the
  // Claim Links tab" promise at CreateClaimLink.tsx:92 that previously
  // pointed at a tab that didn't exist. Returns the user's sent linkIds
  // (cheap call: just reads _sentLinks[user]).
  const fetchSentLinks = useCallback(
    async (user: `0x${string}`): Promise<bigint[]> => {
      const claimLinksAddress = contracts.ClaimLinks as `0x${string}`;
      if (!publicClient || !claimLinksAddress || claimLinksAddress === "0x0000000000000000000000000000000000000000") {
        return [];
      }
      try {
        const ids = (await publicClient.readContract({
          address: claimLinksAddress,
          abi: ClaimLinksAbi,
          functionName: "getSentLinks",
          args: [user],
        })) as readonly bigint[];
        return [...ids];
      } catch {
        return [];
      }
    },
    [publicClient, contracts.ClaimLinks],
  );

  /** Read a single link's on-chain state. Returns null on miss. */
  const fetchLink = useCallback(
    async (linkId: bigint) => {
      const claimLinksAddress = contracts.ClaimLinks as `0x${string}`;
      if (!publicClient || !claimLinksAddress || claimLinksAddress === "0x0000000000000000000000000000000000000000") {
        return null;
      }
      try {
        const result = (await publicClient.readContract({
          address: claimLinksAddress,
          abi: ClaimLinksAbi,
          functionName: "getLink",
          args: [linkId],
        })) as readonly [
          `0x${string}`, `0x${string}`, number, `0x${string}`, bigint, bigint,
          boolean, boolean, string, `0x${string}`, bigint,
        ];
        const [
          sender, vault, mode, boundAddress, createdAt, expiryTimestamp,
          claimed, refunded, note, claimer, claimedAt,
        ] = result;
        if (sender === "0x0000000000000000000000000000000000000000") return null;
        // claimKeyOf is zero for links created before the v2 upgrade (and
        // on a pre-upgrade deployment, where the view does not exist).
        let claimKey: `0x${string}` = ZERO_ADDRESS;
        try {
          claimKey = (await publicClient.readContract({
            address: claimLinksAddress,
            abi: ClaimLinksAbi,
            functionName: "claimKeyOf",
            args: [linkId],
          })) as `0x${string}`;
        } catch {
          claimKey = ZERO_ADDRESS;
        }
        const legacy = claimKey.toLowerCase() === ZERO_ADDRESS;
        // Missing on a contract that predates the funding gate: those links are Active.
        let funding: ClaimLinkFunding = "active";
        try {
          const code = Number(
            await publicClient.readContract({
              address: claimLinksAddress,
              abi: ClaimLinksAbi,
              functionName: "fundingStatus",
              args: [linkId],
            }),
          );
          funding = FUNDING_BY_CODE[code] ?? "active";
        } catch {
          funding = "active";
        }
        return {
          funding,
          legacy,
          /** Legacy Bearer/EmailBound links can only be refunded. */
          legacyRefundOnly: legacy && mode !== MODE.AddressBound,
          id: linkId,
          sender,
          vault,
          mode,
          boundAddress,
          createdAt,
          expiryTimestamp,
          claimed,
          refunded,
          note,
          claimer,
          claimedAt,
        };
      } catch {
        return null;
      }
    },
    [publicClient, contracts.ClaimLinks],
  );

  // §3.12 of BEST_VERSION_FULL_PLAN: derived txExplorerUrl.
  const txExplorerUrl = state.txHash ? getExplorerTxUrl(state.txHash, activeChainId) : null;

  return {
    state,
    txExplorerUrl,
    pipeline: pipeline.state,
    createLink,
    claim,
    refund,
    finishFunding,
    cancelPending,
    fetchSentLinks,
    fetchLink,
    reset,
  };
}
