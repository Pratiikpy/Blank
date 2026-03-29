import { useState, useCallback, useRef } from "react";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import { parseUnits, keccak256, encodePacked } from "viem";
import { useCofheEncrypt, useCofheConnection } from "@cofhe/react";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import { CONTRACTS, type EncryptedInput } from "@/lib/constants";
import { StealthPaymentsAbi, TestUSDCAbi } from "@/lib/abis";
import { insertActivity } from "@/lib/supabase";

// ─── Types ──────────────────────────────────────────────────────────

export type StealthStep =
  | "idle"
  | "approving"
  | "encrypting"
  | "sending"
  | "claiming"
  | "finalizing"
  | "success"
  | "error";

export interface StealthPaymentsState {
  step: StealthStep;
  error: string | null;
  txHash: string | null;
}

const initialState: StealthPaymentsState = {
  step: "idle",
  error: null,
  txHash: null,
};

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random 32-byte claim code.
 * Returns a hex string prefixed with 0x (66 chars total).
 */
function generateClaimCode(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}` as `0x${string}`;
}

/**
 * Compute the claim code hash bound to the recipient address.
 * This matches the contract's verification:
 *   keccak256(abi.encodePacked(claimCode, recipientAddress))
 *
 * Binding the claim code to the recipient prevents front-running:
 * even if an attacker intercepts the claimCode, they cannot produce
 * a matching hash because it includes the intended recipient's address.
 */
function computeClaimCodeHash(
  claimCode: `0x${string}`,
  recipientAddress: `0x${string}`
): `0x${string}` {
  return keccak256(
    encodePacked(["bytes32", "address"], [claimCode, recipientAddress])
  );
}

// ─── Hook ───────────────────────────────────────────────────────────

export function useStealthPayments() {
  const { address } = useAccount();
  const { connected } = useCofheConnection();
  const publicClient = usePublicClient();
  const { encryptInputsAsync } = useCofheEncrypt();
  const { writeContractAsync } = useWriteContract();

  const [state, setState] = useState<StealthPaymentsState>(initialState);

  // Double-submit guard: prevents concurrent submissions
  const submittingRef = useRef(false);

  // ─── Send Stealth Payment ──────────────────────────────────────────
  //
  // Flow:
  //   1. Generate random 32-byte claimCode
  //   2. Compute claimCodeHash = keccak256(encodePacked(claimCode, recipientAddress))
  //   3. Approve TestUSDC for StealthPayments contract (plaintext ERC20 deposit)
  //   4. Encrypt the recipient address using FHE
  //   5. Call stealthPayments.sendStealth(plaintextAmount, encRecipient, claimCodeHash, vault, note)
  //   6. Wait for receipt, extract transferId from logs
  //   7. Return { claimCode, transferId } — sender shares claimCode off-chain
  //
  // The deposit amount is public (like shield/unshield), but the recipient
  // identity is FHE-encrypted. Nobody can see who the payment is for until
  // the intended recipient claims it with the correct claim code.

  const sendStealth = useCallback(
    async (
      amount: string,
      recipientAddress: string,
      vault: string,
      note: string
    ): Promise<{ claimCode: string; transferId: number } | null> => {
      if (!address || !connected) {
        toast.error("Please connect your wallet");
        return null;
      }
      if (submittingRef.current) return null;

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return null;
      }

      submittingRef.current = true;

      try {
        // Step 1: Generate claim code and compute bound hash
        const claimCode = generateClaimCode();
        const recipient = recipientAddress as `0x${string}`;
        const claimCodeHash = computeClaimCodeHash(claimCode, recipient);

        // Step 2: Approve underlying ERC20 (TestUSDC) for StealthPayments
        // The contract calls underlying.safeTransferFrom(msg.sender, address(this), amount)
        setState({ step: "approving", error: null, txHash: null });

        const amountWei = parseUnits(amount, 6);
        const stealthAddress = CONTRACTS.StealthPayments as `0x${string}`;

        const approveToastId = toast.loading("Approving USDC for stealth deposit...");
        const approveHash = await writeContractAsync({
          address: CONTRACTS.TestUSDC,
          abi: TestUSDCAbi,
          functionName: "approve",
          args: [stealthAddress, amountWei],
        });
        const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash, confirmations: 1 });
        if (approveReceipt.status === "reverted") {
          throw new Error("Approval transaction reverted on-chain");
        }
        toast.success("Approved!", { id: approveToastId });

        // Step 3: Encrypt the recipient address using FHE
        setState((s) => ({ ...s, step: "encrypting" }));

        const [encRecipient] = await encryptInputsAsync([
          Encryptable.address(recipient),
        ]);

        // Step 4: Send the stealth payment
        setState((s) => ({ ...s, step: "sending" }));

        const sendToastId = toast.loading("Sending stealth payment...");
        const hash = await writeContractAsync({
          address: stealthAddress,
          abi: StealthPaymentsAbi,
          functionName: "sendStealth",
          args: [
            amountWei,
            // Type assertion: cofhe SDK encrypt returns opaque encrypted input objects
            // whose shape doesn't match wagmi's strict ABI-inferred arg types
            encRecipient as unknown as EncryptedInput,
            claimCodeHash,
            vault as `0x${string}`,
            note,
          ],
        });

        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
        });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Extract transferId from StealthSent event log
        // Event signature: StealthSent(uint256 indexed transferId, address indexed sender, ...)
        // The first topic after the event signature is transferId
        let transferId = 0;
        for (const log of receipt.logs) {
          if (
            log.address.toLowerCase() === stealthAddress.toLowerCase() &&
            log.topics.length >= 2
          ) {
            // topics[0] = event signature hash
            // topics[1] = indexed transferId (uint256 as bytes32)
            const rawId = log.topics[1];
            if (rawId) {
              transferId = Number(BigInt(rawId));
              break;
            }
          }
        }

        toast.success("Stealth payment sent!", { id: sendToastId });

        setState({ step: "success", error: null, txHash: hash });

        // Sync to Supabase — note: user_to is address(0) because on-chain
        // the recipient is encrypted. Only the claim reveals the recipient.
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: "0x0000000000000000000000000000000000000000",
          activity_type: "stealth_sent",
          contract_address: stealthAddress,
          note,
          token_address: CONTRACTS.TestUSDC,
          block_number: Number(receipt.blockNumber),
        });

        return { claimCode, transferId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Stealth payment failed";
        setState({ step: "error", error: msg, txHash: null });
        toast.error(msg);
        return null;
      } finally {
        submittingRef.current = false;
      }
    },
    [address, connected, publicClient, encryptInputsAsync, writeContractAsync]
  );

  // ─── Claim Stealth Payment (Phase 1) ──────────────────────────────
  //
  // The claimer reveals the claim code. The contract:
  //   1. Verifies keccak256(abi.encodePacked(claimCode, msg.sender)) == claimCodeHash
  //   2. Uses FHE.eq() to check if msg.sender matches the encrypted recipient
  //   3. Computes conditional amount via FHE.select (full if correct, zero if wrong)
  //   4. Sends conditional amount to async decryption
  //
  // After this, call finalizeClaim() once decryption resolves.

  const claimStealth = useCallback(
    async (transferId: number, claimCode: string): Promise<string | null> => {
      if (!address || !connected) {
        toast.error("Please connect your wallet");
        return null;
      }
      if (submittingRef.current) return null;

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return null;
      }

      submittingRef.current = true;

      try {
        setState({ step: "claiming", error: null, txHash: null });

        const stealthAddress = CONTRACTS.StealthPayments as `0x${string}`;

        const claimToastId = toast.loading("Claiming stealth payment...");
        const hash = await writeContractAsync({
          address: stealthAddress,
          abi: StealthPaymentsAbi,
          functionName: "claimStealth",
          args: [BigInt(transferId), claimCode as `0x${string}`],
        });

        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
        });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        toast.success("Claim initiated! Waiting for decryption...", { id: claimToastId });

        setState({ step: "success", error: null, txHash: hash });

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: "stealth_claim_started",
          contract_address: stealthAddress,
          note: `Claim started for transfer #${transferId}`,
          token_address: CONTRACTS.TestUSDC,
          block_number: Number(receipt.blockNumber),
        });

        return hash;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Claim failed";
        setState({ step: "error", error: msg, txHash: null });
        toast.error(msg);
        return null;
      } finally {
        submittingRef.current = false;
      }
    },
    [address, connected, publicClient, writeContractAsync]
  );

  // ─── Finalize Claim (Phase 2: After Async Decrypt) ────────────────
  //
  // After claimStealth(), the contract async-decrypts the conditional amount.
  // Once decryption resolves, call finalizeClaim() to release funds.
  // If the claimer was the correct recipient, they receive the full amount.
  // If wrong, they receive 0 (privacy-preserving: no revert).

  const finalizeClaim = useCallback(
    async (transferId: number): Promise<string | null> => {
      if (!address) {
        toast.error("Please connect your wallet");
        return null;
      }
      if (submittingRef.current) return null;

      if (!publicClient) {
        toast.error("Connection lost. Please refresh.");
        return null;
      }

      submittingRef.current = true;

      try {
        setState({ step: "finalizing", error: null, txHash: null });

        const stealthAddress = CONTRACTS.StealthPayments as `0x${string}`;

        const finalizeToastId = toast.loading("Finalizing claim...");
        const hash = await writeContractAsync({
          address: stealthAddress,
          abi: StealthPaymentsAbi,
          functionName: "finalizeClaim",
          args: [BigInt(transferId)],
        });

        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
        });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        toast.success("Claim finalized! Funds released.", { id: finalizeToastId });

        setState({ step: "success", error: null, txHash: hash });

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: "stealth_claimed",
          contract_address: stealthAddress,
          note: `Finalized stealth claim #${transferId}`,
          token_address: CONTRACTS.TestUSDC,
          block_number: Number(receipt.blockNumber),
        });

        return hash;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Finalize failed";
        // Check for "decryption not ready yet" specifically
        if (msg.includes("decryption not ready")) {
          toast.error("Decryption not ready yet. Please wait and try again in a few seconds.");
        } else {
          toast.error(msg);
        }
        setState({ step: "error", error: msg, txHash: null });
        return null;
      } finally {
        submittingRef.current = false;
      }
    },
    [address, publicClient, writeContractAsync]
  );

  // ─── Get My Pending Claims ────────────────────────────────────────
  //
  // The frontend provides claim code hashes that the user knows about
  // (from off-chain sharing). The contract returns matching transfer IDs
  // for any that are still unclaimed.

  const getMyPendingClaims = useCallback(
    async (claimCodeHashes: `0x${string}`[]): Promise<number[]> => {
      if (!publicClient || claimCodeHashes.length === 0) return [];

      try {
        const stealthAddress = CONTRACTS.StealthPayments as `0x${string}`;

        const result = await publicClient.readContract({
          address: stealthAddress,
          abi: StealthPaymentsAbi,
          functionName: "getMyPendingClaims",
          args: [claimCodeHashes],
        });

        // result is [transferIds: bigint[], found: boolean[]]
        const [transferIds, found] = result as [bigint[], boolean[]];

        const pending: number[] = [];
        for (let i = 0; i < transferIds.length; i++) {
          if (found[i]) {
            pending.push(Number(transferIds[i]));
          }
        }

        return pending;
      } catch (err) {
        console.warn("getMyPendingClaims failed:", err);
        return [];
      }
    },
    [publicClient]
  );

  // ─── Reset ────────────────────────────────────────────────────────

  const reset = useCallback(() => {
    setState(initialState);
  }, []);

  return {
    // State
    step: state.step,
    error: state.error,
    txHash: state.txHash,

    // Actions
    sendStealth,
    claimStealth,
    finalizeClaim,
    getMyPendingClaims,
    reset,
  };
}
