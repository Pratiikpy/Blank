import { useState, useCallback, useEffect } from "react";
import { usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { parseUnits } from "viem";
import { useCofheEncrypt } from "@cofhe/react";
import { useCofheDecryptForTx } from "@/lib/cofhe-shim";
import { Encryptable } from "@cofhe/sdk";
import { P2PExchangeAbi, FHERC20VaultAbi } from "@/lib/abis";
import { MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import { useChain } from "@/providers/ChainProvider";
import {
  supabase,
  insertExchangeOffer,
  fetchActiveOffers,
  fetchFilledOffersForUser,
  updateOfferStatus,
  insertActivity,
  type ExchangeOfferRow,
} from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { extractEventId } from "@/lib/event-parser";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import toast from "react-hot-toast";
import { isVaultApproved, markVaultApproved, clearVaultApproval, verifyVaultApproved } from "@/lib/approval";

type Step = "idle" | "approving" | "sending" | "success" | "error";

export function useExchange() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { decryptForTx } = useCofheDecryptForTx();
  const [step, setStep] = useState<Step>("idle");
  const [verifyingOfferId, setVerifyingOfferId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offers, setOffers] = useState<ExchangeOfferRow[]>([]);
  const [filledOffers, setFilledOffers] = useState<ExchangeOfferRow[]>([]);
  const [isLoadingOffers, setIsLoadingOffers] = useState(false);

  // Load offers from Supabase
  const loadOffers = useCallback(async () => {
    setIsLoadingOffers(true);
    const data = await fetchActiveOffers();
    setOffers(data);
    if (address) {
      const filled = await fetchFilledOffersForUser(address);
      setFilledOffers(filled);
    } else {
      setFilledOffers([]);
    }
    setIsLoadingOffers(false);
  }, [address]);

  useEffect(() => {
    loadOffers();
  }, [loadOffers]);

  // Realtime subscription for exchange offers
  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel('exchange_offers_realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'exchange_offers' }, () => {
        loadOffers();
      })
      .subscribe();
    return () => { supabase!.removeChannel(channel); };
  }, [loadOffers]);

  // Create a new swap offer
  const createOffer = useCallback(
    async (
      amountGive: string,
      amountWant: string,
      expiryDate: string
    ) => {
      if (!address || !publicClient) return;
      if (step === "approving" || step === "sending") return; // Already submitting

      setStep("approving");
      setError(null);

      try {
        // Approve the P2PExchange contract to spend from vault
        if (!isVaultApproved(contracts.P2PExchange)) {
          const approveResult = await unifiedWriteAndWait({
            address: contracts.FHERC20Vault_USDC,
            abi: FHERC20VaultAbi,
            functionName: "approvePlaintext",
            args: [contracts.P2PExchange, MAX_UINT64],
            gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
          });
          const approveStatus =
            approveResult.receipt?.status ??
            (await publicClient.waitForTransactionReceipt({ hash: approveResult.hash, confirmations: 1 })).status;
          if (approveStatus === "reverted") {
            throw new Error("Approval transaction reverted on-chain");
          }
          markVaultApproved(contracts.P2PExchange);
        }

        if (!amountGive || amountGive.trim() === "") {
          toast.error("Enter an amount to give");
          setStep("idle");
          return;
        }
        if (!amountWant || amountWant.trim() === "") {
          toast.error("Enter an amount to receive");
          setStep("idle");
          return;
        }

        const parsedGive = parseFloat(amountGive);
        const parsedWant = parseFloat(amountWant);
        if (isNaN(parsedGive) || parsedGive <= 0) {
          toast.error("Enter a valid amount to give");
          setStep("idle");
          return;
        }
        if (isNaN(parsedWant) || parsedWant <= 0) {
          toast.error("Enter a valid amount to receive");
          setStep("idle");
          return;
        }

        setStep("sending");

        // Convert amounts to uint256 (6 decimals for USDC)
        const giveWei = parseUnits(amountGive, 6);
        const wantWei = parseUnits(amountWant, 6);
        const expiryTimestamp = BigInt(Math.floor(new Date(expiryDate).getTime() / 1000));

        const writeResult = await unifiedWriteAndWait({
          address: contracts.P2PExchange,
          abi: P2PExchangeAbi,
          functionName: "createOffer",
          args: [
            contracts.FHERC20Vault_USDC, // tokenGive (vault A)
            // tokenWant (vault B) — the contract requires ≠ tokenGive. On
            // chains without a 2nd vault we fall back to USDC; that path
            // will revert ("same token") but at least surfaces the missing-
            // deployment as an actionable error rather than silent UI hang.
            (contracts.FHERC20Vault_USDT ?? contracts.FHERC20Vault_USDC) as `0x${string}`,
            giveWei,
            wantWei,
            expiryTimestamp,
          ],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = writeResult.hash;

        const receipt =
          writeResult.receipt ??
          (await publicClient.waitForTransactionReceipt({
            hash,
            confirmations: 1,
            timeout: 90_000,
          }));
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Write to Supabase
        // Exchange offer amounts are intentionally public for discovery
        // (matches P2PExchange.sol which uses public uint256 amounts for order matching)
        // Extract offer ID from OfferCreated event in receipt logs
        const offerId = extractEventId(receipt.logs, contracts.P2PExchange);

        await insertExchangeOffer({
          offer_id: offerId,
          maker_address: address.toLowerCase(),
          token_give: contracts.FHERC20Vault_USDC,
          token_want: contracts.FHERC20Vault_USDC,
          amount_give: parsedGive,
          amount_want: parsedWant,
          expiry: expiryDate,
          status: "active",
          taker_address: "",
          tx_hash: hash,
        });

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.OFFER_CREATED,
          contract_address: contracts.P2PExchange,
          note: `Listed ${amountGive} USDC swap offer`,
          token_address: contracts.FHERC20Vault_USDC,
          // Safe: Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        setStep("success");
        toast.success("Swap offer created!");
        await loadOffers();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create offer";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(contracts.P2PExchange);
        }
        setStep("error");
        setError(msg);
        toast.error("Failed to create offer");
      }
    },
    [address, publicClient, step, unifiedWrite, unifiedWriteAndWait, loadOffers, contracts]
  );

  // Fill (accept) an offer
  const fillOffer = useCallback(
    async (offerId: number) => {
      if (!address || !publicClient) {
        toast.error("Connection lost");
        return;
      }
      if (step === "sending") return;

      setStep("sending");
      setError(null);

      try {
        const offer = offers.find((o) => o.offer_id === offerId);
        if (!offer) throw new Error("Offer not found");

        // Approve vault for P2PExchange — skip if allowance already on-chain
        // from a prior session (cross-device recovery / fresh localStorage).
        const alreadyApproved = await verifyVaultApproved(
          contracts.P2PExchange as `0x${string}`,
          address as `0x${string}`,
          contracts.FHERC20Vault_USDC as `0x${string}`,
          publicClient,
        );
        if (!alreadyApproved) {
          // Use unifiedWriteAndWait — the relay already confirmed the tx
          // server-side, so we skip the unreliable public-RPC poll.
          const approveResult = await unifiedWriteAndWait({
            address: contracts.FHERC20Vault_USDC,
            abi: FHERC20VaultAbi,
            functionName: "approvePlaintext",
            args: [contracts.P2PExchange, MAX_UINT64],
            gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
          });
          const approveStatus = approveResult.receipt?.status
            ?? (await publicClient.waitForTransactionReceipt({
              hash: approveResult.hash, confirmations: 1, timeout: 300_000,
            })).status;
          if (approveStatus === "reverted") {
            throw new Error("Approval transaction reverted on-chain");
          }
          markVaultApproved(contracts.P2PExchange);
        }

        // Encrypt both amounts for the fill
        const takerAmount = parseUnits(String(offer.amount_want), 6);
        const makerAmount = parseUnits(String(offer.amount_give), 6);

        const [encTakerPayment, encMakerPayment] = await encryptInputsAsync([
          Encryptable.uint64(takerAmount),
          Encryptable.uint64(makerAmount),
        ]);

        const fillResult = await unifiedWriteAndWait({
          address: contracts.P2PExchange,
          abi: P2PExchangeAbi,
          functionName: "fillOffer",
          // Type assertion: cofhe SDK encrypt returns opaque encrypted input objects
          // whose shape doesn't match wagmi's strict ABI-inferred arg types
          args: [BigInt(offerId), encTakerPayment as unknown as EncryptedInput, encMakerPayment as unknown as EncryptedInput],
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });
        const hash = fillResult.hash;
        const receipt = fillResult.receipt
          ? fillResult.receipt
          : await publicClient.waitForTransactionReceipt({
              hash, confirmations: 1, timeout: 300_000,
            });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }
        await updateOfferStatus(offerId, "filled", address.toLowerCase());

        // Maker-side feed row: taker → maker (maker gets the "your offer was filled" notif)
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: offer.maker_address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.OFFER_FILLED,
          contract_address: contracts.P2PExchange,
          note: `Accepted swap offer #${offerId}`,
          token_address: contracts.FHERC20Vault_USDC,
          // Safe: Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
          block_number: Number(receipt.blockNumber),
        });

        // Taker-side feed row: so the taker sees "you filled offer #N" in their feed.
        // Only inserted when taker != maker (otherwise dupes the row above).
        if (offer.maker_address.toLowerCase() !== address.toLowerCase()) {
          await insertActivity({
            tx_hash: `${hash}:taker`,
            user_from: address.toLowerCase(),
            user_to: address.toLowerCase(),
            activity_type: ACTIVITY_TYPES.OFFER_FILLED,
            contract_address: contracts.P2PExchange,
            note: `Filled swap offer #${offerId}`,
            token_address: contracts.FHERC20Vault_USDC,
            block_number: Number(receipt.blockNumber),
          });
        }

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success("Offer accepted!");
        setStep("success");
        await loadOffers();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to accept offer";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(contracts.P2PExchange);
        }
        setStep("error");
        setError(msg);
        if (/not active|cancelled|expired|already filled/i.test(msg)) {
          toast.error("This offer is no longer available — it was cancelled or filled by another user");
        } else {
          toast.error("Transaction failed: " + msg.slice(0, 100));
        }
      }
    },
    [address, publicClient, unifiedWrite, offers, encryptInputsAsync, loadOffers, step, contracts]
  );

  // Cancel an offer
  const [isCancelling, setIsCancelling] = useState(false);

  const cancelOffer = useCallback(
    async (offerId: number) => {
      if (!address || !publicClient) return;
      if (isCancelling) return; // Already cancelling

      setIsCancelling(true);
      try {
        const cancelResult = await unifiedWriteAndWait({
          address: contracts.P2PExchange,
          abi: P2PExchangeAbi,
          functionName: "cancelOffer",
          args: [BigInt(offerId)],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const hash = cancelResult.hash;
        const cancelReceipt = cancelResult.receipt
          ? cancelResult.receipt
          : await publicClient.waitForTransactionReceipt({
              hash, confirmations: 1, timeout: 300_000,
            });
        if (cancelReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }
        await updateOfferStatus(offerId, "cancelled");

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.OFFER_CANCELLED,
          contract_address: contracts.P2PExchange,
          note: `Cancelled swap offer #${offerId}`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(cancelReceipt.blockNumber),
        });

        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        toast.success("Offer cancelled");
        await loadOffers();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not active|cancelled|expired|already filled/i.test(msg)) {
          toast.error("This offer is no longer available — it was cancelled or filled by another user");
        } else {
          toast.error("Transaction failed: " + msg.slice(0, 100));
        }
      } finally {
        setIsCancelling(false);
      }
    },
    [address, publicClient, isCancelling, unifiedWrite, unifiedWriteAndWait, loadOffers, contracts]
  );

  // ─── Verify trade (v0.1.3) ────────────────────────────────────────
  // After a fill, both sides can publish the trade-validity proof on-chain
  // so anyone can read the public verdict. Read the validation handle, ask
  // the Threshold Network for (plaintext, signature), then publish.
  const verifyTrade = useCallback(
    async (offerId: number): Promise<boolean | null> => {
      if (!address || !publicClient) {
        toast.error("Connection lost");
        return null;
      }
      if (verifyingOfferId !== null) return null;

      setVerifyingOfferId(offerId);
      const toastId = toast.loading("Fetching trade-validity proof...");
      try {
        const handle = (await publicClient.readContract({
          address: contracts.P2PExchange,
          abi: P2PExchangeAbi,
          functionName: "getValidationHandle",
          args: [BigInt(offerId)],
        })) as bigint;
        if (!handle || handle === 0n) {
          throw new Error("No validation handle — offer not filled yet");
        }

        // Poll Threshold Network briefly (decrypt typically resolves in ~10s)
        const TIMEOUT_MS = 60_000;
        const startedAt = Date.now();
        let proof: { decryptedValue: bigint | boolean; signature: `0x${string}` } | null = null;
        while (Date.now() - startedAt < TIMEOUT_MS) {
          proof = await decryptForTx(handle, "ebool");
          if (proof) break;
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (!proof) throw new Error("Decryption timed out — try Verify again shortly");

        const validPlaintext =
          typeof proof.decryptedValue === "boolean"
            ? proof.decryptedValue
            : proof.decryptedValue !== 0n;

        toast.loading("Publishing verdict on-chain...", { id: toastId });
        const hash = await unifiedWrite({
          address: contracts.P2PExchange,
          abi: P2PExchangeAbi,
          functionName: "publishTradeValidation",
          args: [BigInt(offerId), validPlaintext, proof.signature],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "reverted") throw new Error("Publish reverted on-chain");

        toast.success(
          validPlaintext ? "Trade verified — amounts matched" : "Trade flagged — amounts mismatched",
          { id: toastId },
        );

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: validPlaintext
            ? ACTIVITY_TYPES.EXCHANGE_VERIFIED
            : ACTIVITY_TYPES.EXCHANGE_INVALID,
          contract_address: contracts.P2PExchange,
          note: validPlaintext
            ? `Verified trade #${offerId}`
            : `Flagged trade #${offerId} — amount mismatch`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("activity_added");

        return validPlaintext;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Verify failed", { id: toastId });
        return null;
      } finally {
        setVerifyingOfferId(null);
      }
    },
    [address, publicClient, unifiedWrite, decryptForTx, verifyingOfferId, contracts]
  );

  // Read the on-chain verdict for an offer. Returns (isValid, isReady).
  const getTradeValidation = useCallback(
    async (offerId: number): Promise<{ isValid: boolean; isReady: boolean } | null> => {
      if (!publicClient) return null;
      try {
        const [isValid, isReady] = (await publicClient.readContract({
          address: contracts.P2PExchange,
          abi: P2PExchangeAbi,
          functionName: "getTradeValidation",
          args: [BigInt(offerId)],
        })) as [boolean, boolean];
        return { isValid, isReady };
      } catch {
        return null;
      }
    },
    [publicClient, contracts]
  );

  const reset = useCallback(() => {
    setStep("idle");
    setError(null);
  }, []);

  return {
    step,
    error,
    offers,
    filledOffers,
    isLoadingOffers,
    createOffer,
    fillOffer,
    cancelOffer,
    verifyTrade,
    getTradeValidation,
    verifyingOfferId,
    loadOffers,
    reset,
  };
}
