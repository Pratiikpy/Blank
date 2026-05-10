import { useCallback, useState } from "react";
import { parseUnits } from "viem";
import { usePublicClient } from "wagmi";
import toast from "react-hot-toast";

import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useFhePipeline } from "./useFhePipeline";
import { useChain } from "@/providers/ChainProvider";
import { useCofheEncrypt, useCofheConnection, Encryptable } from "@/lib/cofhe-shim";
import { ClaimLinksAbi, FHERC20VaultAbi } from "@/lib/abis";
import { MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { isVaultApproved, markVaultApproved } from "@/lib/approval";
import { extractEventId } from "@/lib/event-parser";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import {
  MODE,
  type LinkMode,
  generateSecret,
  makeBearerHash,
  makeEmailHash,
  makeAddressHash,
  emailDigest,
  buildClaimUrl,
  secretBytes32,
} from "@/lib/claim-links";

// ─── Step Machine — drives FHE-loading-state UI (Wave 4 task #245) ────

export type ClaimLinkStep =
  | "input"
  | "approving"
  | "encrypting"
  | "confirming"
  | "sending"
  | "success"
  | "error";

export interface ClaimLinkState {
  step: ClaimLinkStep;
  isProcessing: boolean;
  error: string | null;
  txHash: `0x${string}` | null;
  /** Populated after createLink succeeds. */
  shareableUrl: string | null;
  /** linkId returned by createLink — kept around for the success screen. */
  linkId: number | null;
}

const initial: ClaimLinkState = {
  step: "input",
  isProcessing: false,
  error: null,
  txHash: null,
  shareableUrl: null,
  linkId: null,
};

// ─── Mode-specific input bag ──────────────────────────────────────────

export type CreateLinkInput =
  | { mode: typeof MODE.Bearer }
  | { mode: typeof MODE.EmailBound; email: string }
  | { mode: typeof MODE.AddressBound; boundAddress: `0x${string}` };

// ─── Hook ─────────────────────────────────────────────────────────────

export function useClaimLinks() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { connected } = useCofheConnection();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();
  // Wave 4 task #245 — drive a real-step FHE progress UI off the SDK's
  // built-in onStep callback. Exposed back to the caller via state.pipeline
  // so screens can render <FhePipelineProgress state={state.pipeline} />.
  const pipeline = useFhePipeline();

  const [state, setState] = useState<ClaimLinkState>(initial);

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
        toast.error("Wallet not connected");
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
            await unifiedWrite({
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

        // Generate secret + compute hash for the chosen mode.
        const secret = generateSecret();
        let secretHash: `0x${string}`;
        let boundAddress: `0x${string}` = "0x0000000000000000000000000000000000000000";
        switch (params.input.mode) {
          case MODE.Bearer:
            secretHash = makeBearerHash(secret);
            break;
          case MODE.EmailBound:
            if (!params.input.email || params.input.email.indexOf("@") < 1) {
              throw new Error("Email is required for EmailBound mode");
            }
            secretHash = makeEmailHash(secret, params.input.email);
            break;
          case MODE.AddressBound:
            if (!params.input.boundAddress) {
              throw new Error("Address is required for AddressBound mode");
            }
            secretHash = makeAddressHash(secret);
            boundAddress = params.input.boundAddress;
            break;
        }

        // Encrypt the amount. The SDK fires step callbacks for each of
        // its 5 internal phases (initTfhe → fetchKeys → pack → prove →
        // verify); the pipeline hook turns those into a live progress UI.
        setState((s) => ({ ...s, step: "encrypting" }));
        const amountUnits = parseUnits(params.amountTokens, params.decimals);
        const [encAmount] = await encryptInputsAsync(
          [Encryptable.uint64(amountUnits)],
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
            encAmount as unknown as EncryptedInput,
            secretHash,
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
        pipeline.markConfirming();
        let receipt: ReceiptShape;
        if (writeResult.receipt) {
          receipt = {
            status: writeResult.receipt.status,
            logs: writeResult.receipt.logs as ReceiptShape["logs"],
          };
        } else {
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

        pipeline.markDone();
        setState({
          step: "success",
          isProcessing: false,
          error: null,
          txHash: writeResult.hash,
          shareableUrl,
          linkId,
        });

        invalidateBalanceQueries();
        return { linkId, shareableUrl, secretHex: secretBytes32(secret) };
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
    [address, connected, contracts.ClaimLinks, publicClient, unifiedWrite, unifiedWriteAndWait, encryptInputsAsync, activeChainId, state.isProcessing, pipeline],
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

      try {
        pipeline.start();
        pipeline.markSubmitting();
        setState((s) => ({ ...s, step: "sending", isProcessing: true, error: null }));
        const secretHex = secretBytes32(params.secret);

        let writeArgs: { functionName: "claimBearer" | "claimEmailBound" | "claimAddressBound"; args: readonly unknown[] };
        switch (params.mode) {
          case MODE.Bearer:
            writeArgs = { functionName: "claimBearer", args: [BigInt(params.linkId), secretHex] };
            break;
          case MODE.EmailBound:
            if (!params.email) throw new Error("Email is required to claim this link");
            writeArgs = {
              functionName: "claimEmailBound",
              args: [BigInt(params.linkId), secretHex, emailDigest(params.email)],
            };
            break;
          case MODE.AddressBound:
            writeArgs = { functionName: "claimAddressBound", args: [BigInt(params.linkId), secretHex] };
            break;
        }

        const writeResult = await unifiedWriteAndWait({
          address: claimLinksAddress,
          abi: ClaimLinksAbi,
          functionName: writeArgs.functionName,
          args: writeArgs.args as never,
          gas: BigInt(5_000_000),
        });

        pipeline.markConfirming();
        pipeline.markDone();
        setState({
          step: "success",
          isProcessing: false,
          error: null,
          txHash: writeResult.hash,
          shareableUrl: null,
          linkId: params.linkId,
        });
        invalidateBalanceQueries();
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pipeline.markFailed(err);
        // §3.11: preserve prev.txHash so the error state still links to the
        // failed tx on the explorer.
        setState((prev) => ({ ...prev, isProcessing: false, step: "error", error: message }));
        toast.error(message);
        return false;
      }
    },
    [contracts.ClaimLinks, unifiedWriteAndWait, pipeline],
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
        const message = err instanceof Error ? err.message : String(err);
        toast.error(message);
        return false;
      }
    },
    [contracts.ClaimLinks, unifiedWriteAndWait],
  );

  const reset = useCallback(() => {
    setState(initial);
    pipeline.reset();
  }, [pipeline]);

  return { state, pipeline: pipeline.state, createLink, claim, refund, reset };
}
