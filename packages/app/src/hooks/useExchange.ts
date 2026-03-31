import { useState, useCallback, useEffect } from "react";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import { parseUnits } from "viem";
import { useCofheEncrypt } from "@cofhe/react";
import { Encryptable } from "@cofhe/sdk";
import { P2PExchangeAbi, FHERC20VaultAbi } from "@/lib/abis";
import { CONTRACTS, MAX_UINT64, type EncryptedInput } from "@/lib/constants";
import {
  supabase,
  insertExchangeOffer,
  fetchActiveOffers,
  updateOfferStatus,
  insertActivity,
  type ExchangeOfferRow,
} from "@/lib/supabase";
import { extractEventId } from "@/lib/event-parser";
import toast from "react-hot-toast";
import { isVaultApproved, markVaultApproved, clearVaultApproval } from "@/lib/approval";

type Step = "idle" | "approving" | "sending" | "success" | "error";

export function useExchange() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { encryptInputsAsync } = useCofheEncrypt();
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [offers, setOffers] = useState<ExchangeOfferRow[]>([]);
  const [isLoadingOffers, setIsLoadingOffers] = useState(false);

  // Load offers from Supabase
  const loadOffers = useCallback(async () => {
    setIsLoadingOffers(true);
    const data = await fetchActiveOffers();
    setOffers(data);
    setIsLoadingOffers(false);
  }, []);

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
        if (!isVaultApproved(CONTRACTS.P2PExchange)) {
          const approveHash = await writeContractAsync({
            address: CONTRACTS.FHERC20Vault_USDC,
            abi: FHERC20VaultAbi,
            functionName: "approvePlaintext",
            args: [CONTRACTS.P2PExchange, MAX_UINT64],
            gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
          });
          const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash, confirmations: 1 });
          if (approveReceipt.status === "reverted") {
            throw new Error("Approval transaction reverted on-chain");
          }
          markVaultApproved(CONTRACTS.P2PExchange);
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

        const hash = await writeContractAsync({
          address: CONTRACTS.P2PExchange,
          abi: P2PExchangeAbi,
          functionName: "createOffer",
          args: [
            CONTRACTS.FHERC20Vault_USDC, // tokenGive
            CONTRACTS.FHERC20Vault_USDC, // tokenWant (same vault for now)
            giveWei,
            wantWei,
            expiryTimestamp,
          ],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Write to Supabase
        // Exchange offer amounts are intentionally public for discovery
        // (matches P2PExchange.sol which uses public uint256 amounts for order matching)
        // Extract offer ID from OfferCreated event in receipt logs
        const offerId = extractEventId(receipt.logs, CONTRACTS.P2PExchange);

        await insertExchangeOffer({
          offer_id: offerId,
          maker_address: address.toLowerCase(),
          token_give: CONTRACTS.FHERC20Vault_USDC,
          token_want: CONTRACTS.FHERC20Vault_USDC,
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
          activity_type: "exchange_created",
          contract_address: CONTRACTS.P2PExchange,
          note: `Listed ${amountGive} USDC swap offer`,
          token_address: CONTRACTS.FHERC20Vault_USDC,
          // Safe: Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
          block_number: Number(receipt.blockNumber),
        });

        setStep("success");
        toast.success("Swap offer created!");
        await loadOffers();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to create offer";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(CONTRACTS.P2PExchange);
        }
        setStep("error");
        setError(msg);
        toast.error("Failed to create offer");
      }
    },
    [address, publicClient, step, writeContractAsync, loadOffers]
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

        // Approve vault for P2PExchange
        if (!isVaultApproved(CONTRACTS.P2PExchange)) {
          const approveHash = await writeContractAsync({
            address: CONTRACTS.FHERC20Vault_USDC,
            abi: FHERC20VaultAbi,
            functionName: "approvePlaintext",
            args: [CONTRACTS.P2PExchange, MAX_UINT64],
            gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
          });
          const fillApproveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash, confirmations: 1 });
          if (fillApproveReceipt.status === "reverted") {
            throw new Error("Approval transaction reverted on-chain");
          }
          markVaultApproved(CONTRACTS.P2PExchange);
        }

        // Encrypt both amounts for the fill
        const takerAmount = parseUnits(String(offer.amount_want), 6);
        const makerAmount = parseUnits(String(offer.amount_give), 6);

        const [encTakerPayment, encMakerPayment] = await encryptInputsAsync([
          Encryptable.uint64(takerAmount),
          Encryptable.uint64(makerAmount),
        ]);

        const hash = await writeContractAsync({
          address: CONTRACTS.P2PExchange,
          abi: P2PExchangeAbi,
          functionName: "fillOffer",
          // Type assertion: cofhe SDK encrypt returns opaque encrypted input objects
          // whose shape doesn't match wagmi's strict ABI-inferred arg types
          args: [BigInt(offerId), encTakerPayment as unknown as EncryptedInput, encMakerPayment as unknown as EncryptedInput],
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }
        await updateOfferStatus(offerId, "filled", address.toLowerCase());

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: offer.maker_address.toLowerCase(),
          activity_type: "exchange_filled",
          contract_address: CONTRACTS.P2PExchange,
          note: `Accepted swap offer #${offerId}`,
          token_address: CONTRACTS.FHERC20Vault_USDC,
          // Safe: Sepolia block numbers fit in Number.MAX_SAFE_INTEGER for the foreseeable future
          block_number: Number(receipt.blockNumber),
        });

        toast.success("Offer accepted!");
        setStep("success");
        await loadOffers();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to accept offer";
        if (msg.includes("allowance") || msg.includes("approve") || msg.includes("insufficient") || msg.includes("transfer amount exceeds")) {
          clearVaultApproval(CONTRACTS.P2PExchange);
        }
        setStep("error");
        setError(msg);
        toast.error("Failed to accept offer");
      }
    },
    [address, publicClient, writeContractAsync, offers, encryptInputsAsync, loadOffers, step]
  );

  // Cancel an offer
  const [isCancelling, setIsCancelling] = useState(false);

  const cancelOffer = useCallback(
    async (offerId: number) => {
      if (!address || !publicClient) return;
      if (isCancelling) return; // Already cancelling

      setIsCancelling(true);
      try {
        const hash = await writeContractAsync({
          address: CONTRACTS.P2PExchange,
          abi: P2PExchangeAbi,
          functionName: "cancelOffer",
          args: [BigInt(offerId)],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });

        const cancelReceipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        if (cancelReceipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }
        await updateOfferStatus(offerId, "cancelled");

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: "exchange_cancelled",
          contract_address: CONTRACTS.P2PExchange,
          note: `Cancelled swap offer #${offerId}`,
          token_address: CONTRACTS.FHERC20Vault_USDC,
          block_number: Number(cancelReceipt.blockNumber),
        });

        toast.success("Offer cancelled");
        await loadOffers();
      } catch (err) {
        toast.error("Failed to cancel offer");
      } finally {
        setIsCancelling(false);
      }
    },
    [address, publicClient, isCancelling, writeContractAsync, loadOffers]
  );

  const reset = useCallback(() => {
    setStep("idle");
    setError(null);
  }, []);

  return {
    step,
    error,
    offers,
    isLoadingOffers,
    createOffer,
    fillOffer,
    cancelOffer,
    loadOffers,
    reset,
  };
}
