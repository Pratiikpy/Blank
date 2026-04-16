import { useState, useCallback, useRef, useEffect } from "react";
import { usePublicClient } from "wagmi";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { parseUnits, keccak256, encodePacked } from "viem";
import { useCofheEncrypt, useCofheConnection } from "@cofhe/react";
import { useCofheDecryptForTx } from "@/lib/cofhe-shim";
import { Encryptable } from "@cofhe/sdk";
import toast from "react-hot-toast";
import { type EncryptedInput } from "@/lib/constants";
import { useChain } from "@/providers/ChainProvider";
import { StealthPaymentsAbi, TestUSDCAbi } from "@/lib/abis";
import { insertActivity } from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { STORAGE_KEYS, getStoredJson, setStoredJson } from "@/lib/storage";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";

// ─── Types ──────────────────────────────────────────────────────────

export type StealthStep =
  | "idle"
  | "approving"
  | "encrypting"
  | "sending"
  | "claiming"
  | "waiting_for_decryption"
  | "finalizing"
  | "success"
  | "error";

export interface StealthPaymentsState {
  step: StealthStep;
  error: string | null;
  txHash: string | null;
  isWaitingForDecryption: boolean;
  decryptionProgress: string;
}

/**
 * A claim that made it on-chain but whose async FHE decryption was not
 * observed to finalize in this browser session. Persisted to localStorage
 * so a user who navigates away (or whose 60s decrypt poll times out) can
 * come back and resume via `resumePendingClaim`.
 */
export interface PendingStealthClaim {
  transferId: number;
  claimCode: string;
  claimCodeHash: `0x${string}`;
  startedAt: number;
  txHash: string;
}

/**
 * An incoming stealth payment claim code received via deep link. Persisted
 * to localStorage so the recipient sees it in their Stealth Inbox tab without
 * having to copy/paste the code manually. The transferId is NOT known yet —
 * it's only surfaced by the contract once `claimStealth` is called.
 */
export interface StealthInboxEntry {
  claimCode: string;
  claimCodeHash: `0x${string}`;
  fromHint?: string; // sender short address (optional)
  receivedAt: number; // epoch ms
  status: "new" | "claiming" | "claimed";
}

// ─── Stealth Inbox Helpers ─────────────────────────────────────────
//
// The Inbox lets deep-link recipients see incoming stealth payments
// without manually pasting the claim code. See also the `?inbox=...`
// query-param handler in Stealth.tsx.

export function getStealthInbox(
  address: string,
  chainId: number,
): StealthInboxEntry[] {
  return getStoredJson<StealthInboxEntry[]>(
    STORAGE_KEYS.stealthInbox(address, chainId),
    [],
  );
}

export function addToStealthInbox(
  address: string,
  chainId: number,
  entry: Omit<StealthInboxEntry, "receivedAt" | "status">,
): boolean {
  const inbox = getStealthInbox(address, chainId);
  // #227: smarter dedup. Plain hash-equality silently dropped any second
  // arrival of the same hash — fine for the "user clicked their own link
  // twice" case, but a hazard when a phishing link recycles a hash from
  // a different sender. Distinguish three cases:
  //   1. Same hash, already-claimed  → silently no-op (debug log)
  //   2. Same hash, different sender → keep first, warn user via toast
  //   3. Same hash, same/no sender, not-yet-claimed → silently no-op
  const existing = inbox.find((e) => e.claimCodeHash === entry.claimCodeHash);
  if (existing) {
    if (existing.status === "claimed") {
      if (import.meta.env.DEV) {
        console.debug(
          "[stealth-inbox] dropping duplicate claim code that was already claimed",
          { claimCodeHash: entry.claimCodeHash },
        );
      }
      return false;
    }
    // Compare sender hints, treating undefined as a wildcard. Only warn if
    // BOTH sides supplied a `fromHint` and they disagree — that's the only
    // case where a user could be tricked by a recycled hash from a fresh
    // sender.
    if (
      entry.fromHint &&
      existing.fromHint &&
      entry.fromHint.toLowerCase() !== existing.fromHint.toLowerCase()
    ) {
      toast(
        "You received another link with the same claim code from a different sender. The first instance is shown below.",
        { icon: "\u26A0\uFE0F", duration: 8000 },
      );
    }
    return false;
  }
  inbox.unshift({ ...entry, receivedAt: Date.now(), status: "new" });
  setStoredJson(
    STORAGE_KEYS.stealthInbox(address, chainId),
    inbox.slice(0, 100),
  );
  // #218/#219: let sibling tabs refresh their Inbox list without a reload.
  broadcastAction("stealth_inbox_changed", {
    action: "added",
    claimCodeHash: entry.claimCodeHash,
    address,
    chainId,
  });
  return true;
}

export function markInboxEntryStatus(
  address: string,
  chainId: number,
  claimCodeHash: `0x${string}`,
  status: StealthInboxEntry["status"],
): void {
  const inbox = getStealthInbox(address, chainId);
  const updated = inbox.map((e) =>
    e.claimCodeHash === claimCodeHash ? { ...e, status } : e,
  );
  setStoredJson(STORAGE_KEYS.stealthInbox(address, chainId), updated);
  // #218/#219: sibling tabs need the new status (new → claiming → claimed)
  // reflected immediately so a tab that wasn't the one clicking "Claim"
  // still shows the correct pill.
  broadcastAction("stealth_inbox_changed", {
    claimCodeHash,
    status,
    address,
    chainId,
  });
}

// ─── Pending Claim Persistence Helpers ─────────────────────────────
// chainId is passed in from the hook body (sourced from useChain()) so
// these helpers remain callable across reload-free chain switches and
// never silently read/write against the wrong network's storage slot.

function readPendingClaims(address: string, chainId: number): PendingStealthClaim[] {
  const key = STORAGE_KEYS.pendingStealthClaims(address, chainId);
  return getStoredJson<PendingStealthClaim[]>(key, []);
}

function writePendingClaims(address: string, chainId: number, claims: PendingStealthClaim[]): void {
  const key = STORAGE_KEYS.pendingStealthClaims(address, chainId);
  setStoredJson(key, claims);
}

function upsertPendingClaim(address: string, chainId: number, claim: PendingStealthClaim): void {
  const existing = readPendingClaims(address, chainId);
  // Replace if same transferId already present, else append
  const idx = existing.findIndex((c) => c.transferId === claim.transferId);
  if (idx >= 0) {
    existing[idx] = claim;
  } else {
    existing.push(claim);
  }
  writePendingClaims(address, chainId, existing);
}

function removePendingClaim(address: string, chainId: number, transferId: number): void {
  const existing = readPendingClaims(address, chainId);
  const next = existing.filter((c) => c.transferId !== transferId);
  if (next.length !== existing.length) {
    writePendingClaims(address, chainId, next);
    // #225: sibling tabs should drop the just-finalized entry from their
    // "Resume Pending Claims" list without needing a full refresh.
    broadcastAction("pending_claim_removed", {
      transferId,
      address,
      chainId,
    });
  }
}

const initialState: StealthPaymentsState = {
  step: "idle",
  error: null,
  txHash: null,
  isWaitingForDecryption: false,
  decryptionProgress: "",
};

// ─── Polling Constants ─────────────────────────────────────────────

const DECRYPTION_POLL_INTERVAL_MS = 3_000;
const DECRYPTION_TIMEOUT_MS = 60_000;

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
  const { effectiveAddress: address } = useEffectiveAddress();
  const { connected } = useCofheConnection();
  const { contracts, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { encryptInputsAsync } = useCofheEncrypt();
  const { unifiedWriteAndWait } = useUnifiedWrite();
  const { decryptForTx } = useCofheDecryptForTx();

  const [state, setState] = useState<StealthPaymentsState>(initialState);

  // Double-submit guard: prevents concurrent submissions
  const submittingRef = useRef(false);

  // Polling refs for async FHE decryption
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingStartTimeRef = useRef<number>(0);

  /** Stop any active decryption polling interval. */
  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current !== null) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    pollingStartTimeRef.current = 0;
  }, []);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current !== null) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, []);

  // Stop any active polling when the user disconnects or switches accounts.
  // Without this, a polling loop started under address A would keep firing
  // after the user connects address B (or disconnects entirely), leaking
  // state and potentially calling finalizeClaim for the wrong signer.
  useEffect(() => {
    if (!address) {
      stopPolling();
      setState((s) =>
        s.step === "waiting_for_decryption" || s.step === "finalizing"
          ? initialState
          : s,
      );
    }
  }, [address, stopPolling]);

  // Also stop polling when the flow returns to idle / error, so a stale
  // interval can't outlive the state it was tracking.
  useEffect(() => {
    if (state.step === "idle" || state.step === "error") {
      if (pollingIntervalRef.current !== null) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
        pollingStartTimeRef.current = 0;
      }
    }
  }, [state.step]);

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
        setState({ step: "approving", error: null, txHash: null, isWaitingForDecryption: false, decryptionProgress: "" });

        const amountWei = parseUnits(amount, 6);
        const stealthAddress = contracts.StealthPayments as `0x${string}`;

        const approveToastId = toast.loading("Approving USDC for stealth deposit...");
        // unifiedWriteAndWait: AA path returns the relayer's pre-confirmed
        // receipt directly. EOA path returns just the hash and we still poll.
        // See useGiftMoney for context on why we don't re-poll on AA.
        const approveResult = await unifiedWriteAndWait({
          address: contracts.TestUSDC,
          abi: TestUSDCAbi,
          functionName: "approve",
          args: [stealthAddress, amountWei],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });
        const approveStatus =
          approveResult.receipt?.status ??
          (await publicClient.waitForTransactionReceipt({ hash: approveResult.hash, confirmations: 1, timeout: 300_000 })).status;
        if (approveStatus === "reverted") {
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
        const sendResult = await unifiedWriteAndWait({
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
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });
        const hash = sendResult.hash;

        type StealthReceipt = {
          status: "success" | "reverted";
          blockNumber: bigint;
          logs: ReadonlyArray<{ address: `0x${string}`; topics: readonly `0x${string}`[]; data: `0x${string}` }>;
        };
        let receipt: StealthReceipt;
        if (sendResult.receipt) {
          receipt = {
            status: sendResult.receipt.status,
            blockNumber: sendResult.receipt.blockNumber,
            logs: sendResult.receipt.logs as StealthReceipt["logs"],
          };
        } else {
          const r = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
          receipt = { status: r.status, blockNumber: r.blockNumber, logs: r.logs as StealthReceipt["logs"] };
        }
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

        setState({ step: "success", error: null, txHash: hash, isWaitingForDecryption: false, decryptionProgress: "" });

        // Sync to Supabase — note: user_to is address(0) because on-chain
        // the recipient is encrypted. Only the claim reveals the recipient.
        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: "0x0000000000000000000000000000000000000000",
          activity_type: ACTIVITY_TYPES.STEALTH_SENT,
          contract_address: stealthAddress,
          note,
          token_address: contracts.TestUSDC,
          block_number: Number(receipt.blockNumber),
        });
        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        return { claimCode, transferId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Stealth payment failed";
        setState({ step: "error", error: msg, txHash: null, isWaitingForDecryption: false, decryptionProgress: "" });
        toast.error(msg);
        return null;
      } finally {
        submittingRef.current = false;
      }
    },
    [address, connected, publicClient, encryptInputsAsync, unifiedWriteAndWait, contracts]
  );

  // ─── Async Decryption Polling ──────────────────────────────────────
  //
  // After claimStealth() triggers async FHE decryption, poll by simulating
  // the finalizeClaim() call every DECRYPTION_POLL_INTERVAL_MS seconds.
  // When the simulation succeeds (decryption ready), send the real tx.
  // Timeout after DECRYPTION_TIMEOUT_MS with a user-facing message.

  const startDecryptionPolling = useCallback(
    (transferId: number) => {
      // Prevent stacking multiple polling loops
      stopPolling();

      pollingStartTimeRef.current = Date.now();

      setState((s) => ({
        ...s,
        step: "waiting_for_decryption",
        isWaitingForDecryption: true,
        decryptionProgress: "Waiting for FHE decryption (0s)...",
      }));

      const decryptToastId = toast.loading("Decrypting... This may take up to 60 seconds.");

      pollingIntervalRef.current = setInterval(async () => {
        const elapsed = Date.now() - pollingStartTimeRef.current;
        const elapsedSec = Math.round(elapsed / 1_000);

        // ── Timeout check ──
        if (elapsed >= DECRYPTION_TIMEOUT_MS) {
          stopPolling();
          toast.error("Decryption timed out. You can try finalizing manually later.", {
            id: decryptToastId,
          });
          setState((s) => ({
            ...s,
            step: "error",
            error: "Decryption timed out after 60 seconds. Try finalizing manually.",
            isWaitingForDecryption: false,
            decryptionProgress: "",
          }));
          return;
        }

        // ── Progress update ──
        setState((s) => ({
          ...s,
          decryptionProgress: `Waiting for FHE decryption (${elapsedSec}s)...`,
        }));

        // ── v0.1.3: probe Threshold Network for the decryption proof ──
        if (!publicClient || !address) return;

        const stealthAddress = contracts.StealthPayments as `0x${string}`;

        try {
          // Read the conditional-amount handle then ask the Threshold Network
          // for (plaintext, signature). decryptForTx returns null until ready.
          const handle = (await publicClient.readContract({
            address: stealthAddress,
            abi: StealthPaymentsAbi,
            functionName: "getPendingClaimHandle",
            args: [BigInt(transferId)],
          })) as bigint;
          if (!handle || handle === 0n) {
            // No pending decryption — claim was already finalized (or never started)
            stopPolling();
            return;
          }

          const proof = await decryptForTx(handle, "uint64");
          if (!proof) {
            // Not ready yet — stay in the polling loop
            return;
          }

          // Decryption ready — stop polling and submit the finalize tx with proof.
          stopPolling();

          const decryptedAmount =
            typeof proof.decryptedValue === "bigint"
              ? proof.decryptedValue
              : BigInt(proof.decryptedValue ? 1 : 0);

          setState((s) => ({
            ...s,
            step: "finalizing",
            decryptionProgress: "Decryption complete! Finalizing...",
          }));
          toast.loading("Decryption complete! Sending finalize transaction...", {
            id: decryptToastId,
          });

          try {
            const finalizeResult = await unifiedWriteAndWait({
              address: stealthAddress,
              abi: StealthPaymentsAbi,
              functionName: "finalizeClaim",
              args: [BigInt(transferId), decryptedAmount, proof.signature],
              gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
            });
            const hash = finalizeResult.hash;
            const receipt = finalizeResult.receipt
              ? finalizeResult.receipt
              : await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });

            if (receipt.status === "reverted") {
              throw new Error("Finalize transaction reverted on-chain");
            }

            // Finalize succeeded — drop the persisted pending-claim entry
            // regardless of the decrypted-amount outcome (the chain has
            // recorded the attempt; nothing more to resume).
            removePendingClaim(address.toLowerCase(), activeChainId, transferId);

            if (decryptedAmount === 0n) {
              // Privacy-preserving contract path: wrong claim code for this
              // caller, so FHE.select returned 0. This is NOT a success —
              // no tokens were received. Show an error toast and land on
              // the error state so the UI doesn't render a green checkmark.
              toast.error(
                "This stealth transfer wasn't intended for your claim code — no tokens received.",
                { id: decryptToastId },
              );
              setState({
                step: "error",
                error: "Claim code did not match — no tokens were received.",
                txHash: hash,
                isWaitingForDecryption: false,
                decryptionProgress: "",
              });
              // No activity insert / no balance broadcast — nothing changed.
              return;
            }

            toast.success("Claim finalized! Funds released.", { id: decryptToastId });

            setState({
              step: "success",
              error: null,
              txHash: hash,
              isWaitingForDecryption: false,
              decryptionProgress: "",
            });

            await insertActivity({
              tx_hash: hash,
              user_from: address.toLowerCase(),
              user_to: address.toLowerCase(),
              activity_type: ACTIVITY_TYPES.STEALTH_CLAIMED,
              contract_address: stealthAddress,
              note: `Finalized stealth claim #${transferId}`,
              token_address: contracts.TestUSDC,
              block_number: Number(receipt.blockNumber),
            });
            broadcastAction("balance_changed");
            broadcastAction("activity_added");
            invalidateBalanceQueries();
          } catch (finalizeErr) {
            const msg =
              finalizeErr instanceof Error
                ? finalizeErr.message
                : "Finalize transaction failed";
            toast.error(msg, { id: decryptToastId });
            setState({
              step: "error",
              error: msg,
              txHash: null,
              isWaitingForDecryption: false,
              decryptionProgress: "",
            });
          }
        } catch {
          // Probe failed — decryption not ready yet, keep polling
        }
      }, DECRYPTION_POLL_INTERVAL_MS);
    },
    [address, publicClient, unifiedWriteAndWait, stopPolling, decryptForTx, contracts, activeChainId]
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
        setState({
          step: "claiming",
          error: null,
          txHash: null,
          isWaitingForDecryption: false,
          decryptionProgress: "",
        });

        const stealthAddress = contracts.StealthPayments as `0x${string}`;

        const claimToastId = toast.loading("Claiming stealth payment...");
        const claimResult = await unifiedWriteAndWait({
          address: stealthAddress,
          abi: StealthPaymentsAbi,
          functionName: "claimStealth",
          args: [BigInt(transferId), claimCode as `0x${string}`],
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });
        const hash = claimResult.hash;
        const receipt = claimResult.receipt
          ? claimResult.receipt
          : await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        toast.success("Claim initiated! Polling for decryption...", { id: claimToastId });

        // Persist the pending claim so the user can resume from the Stealth
        // screen if the 60s decrypt poll times out or they navigate away.
        // Entry is removed once finalizeClaim succeeds.
        const claimCodeHash = computeClaimCodeHash(
          claimCode as `0x${string}`,
          address as `0x${string}`,
        );
        upsertPendingClaim(address.toLowerCase(), activeChainId, {
          transferId,
          claimCode,
          claimCodeHash,
          startedAt: Date.now(),
          txHash: hash,
        });

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.STEALTH_CLAIM_STARTED,
          contract_address: stealthAddress,
          note: `Claim started for transfer #${transferId}`,
          token_address: contracts.TestUSDC,
          block_number: Number(receipt.blockNumber),
        });
        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        // Start automatic polling for decryption readiness.
        // Once decryption completes, finalizeClaim() is called automatically.
        startDecryptionPolling(transferId);

        return hash;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Claim failed";
        setState({
          step: "error",
          error: msg,
          txHash: null,
          isWaitingForDecryption: false,
          decryptionProgress: "",
        });
        toast.error(msg);
        return null;
      } finally {
        submittingRef.current = false;
      }
    },
    [address, connected, publicClient, unifiedWriteAndWait, startDecryptionPolling, contracts, activeChainId]
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
        setState({ step: "finalizing", error: null, txHash: null, isWaitingForDecryption: false, decryptionProgress: "" });

        const stealthAddress = contracts.StealthPayments as `0x${string}`;

        const finalizeToastId = toast.loading("Fetching decryption proof...");

        // v0.1.3: fetch the conditional-amount handle, then the off-chain proof
        const handle = (await publicClient.readContract({
          address: stealthAddress,
          abi: StealthPaymentsAbi,
          functionName: "getPendingClaimHandle",
          args: [BigInt(transferId)],
        })) as bigint;
        if (!handle || handle === 0n) {
          throw new Error("No pending claim — already finalized or never started");
        }

        const proof = await decryptForTx(handle, "uint64");
        if (!proof) {
          throw new Error("Decryption not ready yet. Wait a few seconds and try again.");
        }
        const decryptedAmount =
          typeof proof.decryptedValue === "bigint"
            ? proof.decryptedValue
            : BigInt(proof.decryptedValue ? 1 : 0);

        toast.loading("Finalizing claim...", { id: finalizeToastId });
        const finalizeResult = await unifiedWriteAndWait({
          address: stealthAddress,
          abi: StealthPaymentsAbi,
          functionName: "finalizeClaim",
          args: [BigInt(transferId), decryptedAmount, proof.signature],
          gas: BigInt(5_000_000), // FHE: manual gas limit (precompile can't be estimated)
        });
        const hash = finalizeResult.hash;
        const receipt = finalizeResult.receipt
          ? finalizeResult.receipt
          : await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 300_000 });
        if (receipt.status === "reverted") {
          throw new Error("Transaction reverted on-chain");
        }

        // Finalize succeeded — drop the persisted pending-claim entry
        // regardless of the decrypted-amount outcome.
        removePendingClaim(address.toLowerCase(), activeChainId, transferId);

        if (decryptedAmount === 0n) {
          // Privacy-preserving contract path: FHE.select returned 0 because
          // this caller's claim code didn't match the intended recipient.
          // This is NOT a success — surface it as an error so the UI doesn't
          // pretend funds were received.
          toast.error(
            "This stealth transfer wasn't intended for your claim code — no tokens received.",
            { id: finalizeToastId },
          );
          setState({
            step: "error",
            error: "Claim code did not match — no tokens were received.",
            txHash: hash,
            isWaitingForDecryption: false,
            decryptionProgress: "",
          });
          // No activity insert / no balance broadcast — nothing changed.
          return hash;
        }

        toast.success("Claim finalized! Funds released.", { id: finalizeToastId });

        setState({ step: "success", error: null, txHash: hash, isWaitingForDecryption: false, decryptionProgress: "" });

        await insertActivity({
          tx_hash: hash,
          user_from: address.toLowerCase(),
          user_to: address.toLowerCase(),
          activity_type: ACTIVITY_TYPES.STEALTH_CLAIMED,
          contract_address: stealthAddress,
          note: `Finalized stealth claim #${transferId}`,
          token_address: contracts.TestUSDC,
          block_number: Number(receipt.blockNumber),
        });
        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();

        return hash;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Finalize failed";
        // Check for "decryption not ready yet" specifically
        if (msg.includes("decryption not ready")) {
          toast.error("Decryption not ready yet. Please wait and try again in a few seconds.");
        } else {
          toast.error(msg);
        }
        setState({ step: "error", error: msg, txHash: null, isWaitingForDecryption: false, decryptionProgress: "" });
        return null;
      } finally {
        submittingRef.current = false;
      }
    },
    [address, publicClient, unifiedWriteAndWait, decryptForTx, contracts, activeChainId]
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
        const stealthAddress = contracts.StealthPayments as `0x${string}`;

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
    [publicClient, contracts]
  );

  // ─── Persisted Pending Claims (Resume UI) ─────────────────────────
  //
  // Any claimStealth() call that successfully submits on-chain but whose
  // async FHE decryption didn't observably finalize in this session is
  // persisted in localStorage so the user can resume it later.

  const getPendingClaims = useCallback((): PendingStealthClaim[] => {
    if (!address) return [];
    return readPendingClaims(address.toLowerCase(), activeChainId);
  }, [address, activeChainId]);

  const resumePendingClaim = useCallback(
    async (transferId: bigint, _claimCode: string): Promise<string | null> => {
      // The claim was already submitted on-chain (that's when it was
      // persisted), and the contract bound verification to the caller
      // address at claim time. Finalize only needs the transferId — it
      // fetches the handle, resolves the decryption proof, and writes
      // the finalizing tx. The claimCode is retained in the persisted
      // record for UI display and future diagnostics.
      return finalizeClaim(Number(transferId));
    },
    [finalizeClaim]
  );

  // ─── Reset ────────────────────────────────────────────────────────

  const reset = useCallback(() => {
    stopPolling();
    setState(initialState);
  }, [stopPolling]);

  return {
    // State
    step: state.step,
    error: state.error,
    txHash: state.txHash,
    isWaitingForDecryption: state.isWaitingForDecryption,
    decryptionProgress: state.decryptionProgress,

    // Actions
    sendStealth,
    claimStealth,
    finalizeClaim,
    getMyPendingClaims,
    getPendingClaims,
    resumePendingClaim,
    stopPolling,
    reset,
  };
}
