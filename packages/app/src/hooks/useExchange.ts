import { useState, useCallback, useEffect } from "react";
import { usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useCofheDecryptForTx } from "@/lib/cofhe-shim";
import { P2PExchangeAbi } from "@/lib/abis";
import { useChain } from "@/providers/ChainProvider";
import {
  supabase,
  fetchActiveOffers,
  fetchFilledOffersForUser,
  updateOfferStatus,
  insertActivity,
  type ExchangeOfferRow,
} from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";
import toast from "react-hot-toast";
import { toastMappedError } from "@/lib/error-messages";

// P2PExchange is retired on-chain: createOffer and fillOffer revert
// "P2PExchange: retired". This hook keeps what still works: read the
// existing book, cancel your own open offers, and publish the
// trade-validity verdict for past fills. Fiat P2P lives in useP2POfframp.

export function useExchange() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { unifiedWrite, unifiedWriteAndWait } = useUnifiedWrite();
  const { decryptForTx } = useCofheDecryptForTx();
  const [verifyingOfferId, setVerifyingOfferId] = useState<number | null>(null);
  const [offers, setOffers] = useState<ExchangeOfferRow[]>([]);
  const [filledOffers, setFilledOffers] = useState<ExchangeOfferRow[]>([]);
  const [isLoadingOffers, setIsLoadingOffers] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

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

  useEffect(() => {
    if (!supabase) return;
    const channel = supabase
      .channel("exchange_offers_realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "exchange_offers" }, () => {
        loadOffers();
      })
      .subscribe();
    return () => { supabase!.removeChannel(channel); };
  }, [loadOffers]);

  // Cancel one of your own open offers. Still supported on-chain.
  const cancelOffer = useCallback(
    async (offerId: number) => {
      if (!address || !publicClient) return;
      if (isCancelling) return;

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
        if (/not available|not active|cancelled|expired|already filled/i.test(msg)) {
          toast.error("This offer is no longer open. It was cancelled or filled.");
        } else if (/not maker/i.test(msg)) {
          toast.error("Only the maker can cancel this offer.");
        } else {
          toast.error("Transaction failed: " + msg.slice(0, 100));
        }
      } finally {
        setIsCancelling(false);
      }
    },
    [address, publicClient, isCancelling, unifiedWriteAndWait, loadOffers, contracts]
  );

  // After a past fill, either side can publish the trade-validity verdict
  // so anyone can read it. Read the handle, fetch (plaintext, signature)
  // from the Threshold Network, then publish.
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
          throw new Error("No validation handle. This offer was never filled.");
        }

        const TIMEOUT_MS = 60_000;
        const startedAt = Date.now();
        let proof: { decryptedValue: bigint | boolean; signature: `0x${string}` } | null = null;
        while (Date.now() - startedAt < TIMEOUT_MS) {
          proof = await decryptForTx(handle, "ebool");
          if (proof) break;
          await new Promise((r) => setTimeout(r, 5000));
        }
        if (!proof) throw new Error("Decryption timed out. Try Verify again shortly.");

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
          validPlaintext ? "Trade verified. Amounts matched." : "Trade flagged. Amounts did not match.",
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
            : `Flagged trade #${offerId}: amount mismatch`,
          token_address: contracts.FHERC20Vault_USDC,
          block_number: Number(receipt.blockNumber),
        });

        broadcastAction("activity_added");

        return validPlaintext;
      } catch (err) {
        toastMappedError(err, toastId);
        return null;
      } finally {
        setVerifyingOfferId(null);
      }
    },
    [address, publicClient, unifiedWrite, decryptForTx, verifyingOfferId, contracts]
  );

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

  return {
    offers,
    filledOffers,
    isLoadingOffers,
    isCancelling,
    cancelOffer,
    verifyTrade,
    getTradeValidation,
    verifyingOfferId,
    loadOffers,
  };
}
