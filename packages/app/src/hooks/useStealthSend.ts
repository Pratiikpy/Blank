/**
 * Phase 9.3 — ERC-5564 stealth-send sender flow.
 *
 * Two responsibilities:
 *
 *   1. `useStealthMetaAddressLookup(addr)` — non-mutating read of the
 *      ERC-6538 Registry's `stealthMetaAddressOf(addr, schemeId=1)`. If
 *      the recipient has registered a meta-address, we surface it to the
 *      Send UI so the user can opt into a stealth send.
 *
 *   2. `useStealthSend()` — `sendStealthPayment(...)` derives a fresh
 *      stealth address from the recipient's meta-address (per `lib/stealth.ts`),
 *      then submits an atomic batch UserOp containing:
 *        a. `ERC20.transfer(stealthAddr, amount)` — funds land at the EOA
 *           the recipient will sweep from
 *        b. `ERC5564Announcer.announce(1, stealthAddr, ephemeralPubKey,
 *           metadata)` — bulletin-board emit that the recipient scans
 *
 *      Atomicity matters: if the announce fails after the transfer, the
 *      recipient never finds the funds and they're stranded at the
 *      one-time-use stealth address. AA executeBatch ensures both succeed
 *      or neither.
 *
 * Privacy note: the SENDER address is recorded as the indexed `caller`
 * field of the Announcement event (per the canonical EIP-5564 contract).
 * That's a deliberate spec choice — full sender unlinkability would
 * defeat basic auditability needs (tax reports, dispute resolution).
 * Recipients ARE unlinkable from outside observers without one of their
 * keys.
 */
import { useCallback } from "react";
import { useReadContract, usePublicClient } from "wagmi";
import { type Address, type Hex } from "viem";
import { erc20Abi } from "viem";
import { log } from "@/lib/log";

import { ERC5564AnnouncerAbi, ERC6538RegistryAbi } from "@/lib/abis";
import {
  encodeAnnouncementMetadata,
  formatMetaAddress,
  generateStealthAddress,
  type StealthMetaAddress,
} from "@/lib/stealth";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { useChain } from "@/providers/ChainProvider";
import { insertActivity } from "@/lib/supabase";
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import { broadcastAction } from "@/lib/cross-tab";
import { invalidateBalanceQueries } from "@/lib/query-invalidation";

/** Scheme 1 = secp256k1 + view tag (the only one currently defined). */
const SCHEME_ID = 1n;

/** Empty bytes returned by the registry when no meta-address is set. */
const EMPTY_BYTES: Hex = "0x";

/**
 * Decode the registry's raw 66-byte `stealthMetaAddress` blob into the
 * canonical `st:eth:0x…` string consumed by `lib/stealth.ts`. Returns
 * null when no meta-address is registered, or when the blob has the
 * wrong length (defensive — the canonical contract enforces no length,
 * so a malformed registration is possible).
 */
function decodeRegistryBlob(blob: Hex): StealthMetaAddress | null {
  if (!blob || blob === EMPTY_BYTES || blob.length === 0) return null;
  // 66 bytes = 132 hex chars + "0x" prefix = 134 chars.
  if (blob.length !== 134) return null;
  const hex = blob.slice(2);
  const spendingHex = hex.slice(0, 66);
  const viewingHex = hex.slice(66);
  // Validate prefix bytes — 0x02 / 0x03 only.
  const spendPrefix = parseInt(spendingHex.slice(0, 2), 16);
  const viewPrefix = parseInt(viewingHex.slice(0, 2), 16);
  if (spendPrefix !== 0x02 && spendPrefix !== 0x03) return null;
  if (viewPrefix !== 0x02 && viewPrefix !== 0x03) return null;
  try {
    return formatMetaAddress({
      spendingPubKey: `0x${spendingHex}` as `0x${string}`,
      viewingPubKey: `0x${viewingHex}` as `0x${string}`,
    });
  } catch {
    return null;
  }
}

/**
 * Hook that reads the ERC-6538 Registry to learn whether a given
 * recipient has published a stealth meta-address. Non-mutating.
 *
 * `metaAddress` is null when the recipient has never registered (the
 * common case — most wallet addresses don't publish stealth keys).
 */
export function useStealthMetaAddressLookup(recipient: Address | undefined | null): {
  metaAddress: StealthMetaAddress | null;
  isLoading: boolean;
  isFetched: boolean;
  registryAddress: Address;
} {
  // Audit Top-28 #11: read from useChain().contracts so a reload-free
  // chain switch reaches the new chain's registry. ERC-6538 is a canonical
  // singleton so values are identical across chains today, but consistency
  // matters and shields us from any per-chain override later.
  const { contracts } = useChain();
  const registry = contracts.ERC6538Registry as Address;
  const enabled = Boolean(recipient && registry && registry !== "0x0000000000000000000000000000000000000000");
  const { data, isLoading, isFetched } = useReadContract({
    address: registry,
    abi: ERC6538RegistryAbi,
    functionName: "stealthMetaAddressOf",
    args: enabled ? [recipient as Address, SCHEME_ID] : undefined,
    query: { enabled },
  });
  const metaAddress = data ? decodeRegistryBlob(data as Hex) : null;
  return { metaAddress, isLoading, isFetched, registryAddress: registry };
}

export interface SendStealthPaymentArgs {
  /** ERC-20 to transfer. Must be a public token; FHE-encrypted vaults
   *  CANNOT be sent to a stealth EOA because the EOA can't decrypt. */
  token: Address;
  /** Token amount in smallest unit (e.g. 100_000000n for 100 USDC at 6 dp). */
  amount: bigint;
  /** Recipient's stealth meta-address (from `useStealthMetaAddressLookup`). */
  metaAddress: StealthMetaAddress;
}

export interface SendStealthPaymentResult {
  /** Tx hash of the batched UserOp (transfer + announce in one tx). */
  txHash: Hex;
  /** The fresh stealth address that received the funds. */
  stealthAddress: Address;
  /** Ephemeral public key emitted in the announcement. */
  ephemeralPublicKey: Hex;
  /** First byte of the shared-secret hash; recipient short-circuit. */
  viewTag: number;
}

/** Sender-side stealth flow. Returns `sendStealthPayment` callable. */
export function useStealthSend() {
  const { unifiedWriteBatch, senderAddress } = useUnifiedWrite();
  const { activeChainId, contracts } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  // Audit Top-28 #11: read announcer from useChain() so a reload-free
  // chain switch picks up the right address. The ERC-5564 singleton is
  // canonical (same on every chain) so this is belt-and-suspenders, but
  // it future-proofs against any chain-specific override + matches the
  // pattern used by chain-aware callers below.
  const announcer = contracts.ERC5564Announcer as Address;

  const sendStealthPayment = useCallback(
    async (args: SendStealthPaymentArgs): Promise<SendStealthPaymentResult> => {
      if (!senderAddress) {
        throw new Error("Wallet not connected");
      }
      if (!announcer || announcer === "0x0000000000000000000000000000000000000000") {
        throw new Error("ERC-5564 Announcer not configured for this chain");
      }
      if (args.amount <= 0n) {
        throw new Error("Stealth send amount must be positive");
      }

      // 1. Derive a fresh stealth address from the recipient's meta-address.
      //    `generateStealthAddress` uses a cryptographically random
      //    ephemeral private key by default — we never persist it, so
      //    even our own logs can't link sender to stealth recipient.
      const { stealthAddress, ephemeralPublicKey, viewTag } = generateStealthAddress({
        metaAddress: args.metaAddress,
      });

      // 2. Build the EIP-5564 metadata payload (57 bytes):
      //    [viewTag | transfer-selector | token | amount].
      const metadata = encodeAnnouncementMetadata({
        viewTag,
        token: args.token,
        amount: args.amount,
      });

      // 3. Submit one atomic UserOp that does BOTH:
      //    a) ERC-20 transfer to the stealth address
      //    b) Announcer.announce(...) — public bulletin-board emit
      //
      //    AA executeBatch makes this all-or-nothing: if the announce
      //    reverts (it won't — the contract is stateless), the transfer
      //    rolls back too. Funds never get stranded at an unannounced
      //    stealth address.
      const txHash = await unifiedWriteBatch(
        [
          {
            address: args.token,
            abi: erc20Abi,
            functionName: "transfer",
            args: [stealthAddress, args.amount],
          },
          {
            address: announcer,
            abi: ERC5564AnnouncerAbi,
            functionName: "announce",
            args: [SCHEME_ID, stealthAddress, ephemeralPublicKey, metadata],
          },
        ],
        {
          title: "Sending stealth payment",
          subtitle: "Transferring funds and emitting announcement",
        },
      );

      // Audit Top-28 #7 (Wave 2 A25 critical): without these calls the
      // sender's balance stays stale 5–10s after a stealth send and the
      // activity feed never reflects the stealth-send for the sender. We
      // mirror the legacy useStealthPayments path: wait for receipt to
      // capture block_number, write a STEALTH_SENT row (user_to=address(0)
      // because the on-chain recipient is encrypted), broadcast cross-tab,
      // then invalidate balance queries so the next read shows the debit.
      try {
        let blockNumber = 0;
        if (publicClient) {
          try {
            const receipt = await publicClient.waitForTransactionReceipt({
              hash: txHash,
              confirmations: 1,
            });
            blockNumber = receipt?.blockNumber !== undefined
              ? Number(receipt.blockNumber)
              : 0;
          } catch {
            // Receipt poll failed (RPC timeout, replaced tx, etc.) — fall
            // through with blockNumber=0; the activity row is still useful
            // and the explorer link uses tx_hash anyway.
          }
        }
        await insertActivity({
          tx_hash: txHash,
          user_from: senderAddress.toLowerCase(),
          user_to: "0x0000000000000000000000000000000000000000",
          activity_type: ACTIVITY_TYPES.STEALTH_SENT,
          contract_address: stealthAddress,
          token_address: args.token,
          note: "",
          block_number: blockNumber,
          chain_id: activeChainId,
        });
        broadcastAction("balance_changed");
        broadcastAction("activity_added");
        invalidateBalanceQueries();
      } catch (err) {
        // Post-confirm bookkeeping failure must NOT mask a successful tx.
        // The on-chain send already happened; surface the error to console
        // for debugging but return success so the UI advances.
        log.warn("useStealthSend.postConfirmBookkeeping.failed", err instanceof Error ? err : new Error(String(err)));
      }

      return {
        txHash,
        stealthAddress,
        ephemeralPublicKey,
        viewTag,
      };
    },
    [unifiedWriteBatch, senderAddress, announcer, publicClient, activeChainId],
  );

  return { sendStealthPayment };
}
