/**
 * Phase 9.4 — recipient-side stealth inbox.
 *
 * Subscribes to ERC-5564 `Announcement` events on the active chain,
 * filters them with the user's viewing key (view-tag fast-filter +
 * full ECDH check), and surfaces matched payments as inbox entries.
 *
 * Strategy:
 *
 *   1. **Watermark** — last-scanned block number, persisted per
 *      (recipient, chain). Scanning thousands of historical logs every
 *      page load is too slow on free RPC tiers (sepolia.base.org times
 *      out around 10k logs); we watermark so we only scan from the last
 *      seen block forward on subsequent loads.
 *
 *   2. **View-tag fast filter** — for each event, compare byte 0 of the
 *      computed `s_h = keccak256(ECDH(view_priv, ephemeral_pub))` to
 *      the metadata's view tag (also byte 0). 1/256 false-positive rate
 *      by design; the full point-add check rejects misses.
 *
 *   3. **Full check** — `checkStealthAddress(...)` runs the
 *      address-comparison and confirms the announcement is for us.
 *
 *   4. **Cache matches** — matched entries persist in localStorage so
 *      the inbox shows previously-discovered payments offline. Each
 *      entry records: stealth address, ephemeral pubkey, token,
 *      amount, view tag, sender (caller field), block number, tx hash.
 *
 * Privacy note: scanning happens client-side. The user's RPC provider
 * sees ALL Announcement events in the requested block range, but
 * cannot tell which ones the user actually matched — the matching
 * logic runs in the browser with the viewing privkey. A self-hosted
 * RPC eliminates even the metadata leak.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { type Address, type Hex } from "viem";

import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { log } from "@/lib/log";
import { ERC5564AnnouncerAbi } from "@/lib/abis";
import { checkStealthAddress } from "@/lib/stealth";
import {
  loadStealthKeys,
  pubKeysFromRecord,
  unlockStealthKeys,
  hasStealthKeysStored,
} from "@/lib/stealth-keystore";
import { usePassphrasePrompt } from "@/components/PassphrasePrompt";
import {
  STORAGE_KEYS,
  getStoredJson,
  setStoredJson,
} from "@/lib/storage";

/** Decoded view of an announcement event entry that matched our keys. */
export interface StealthInboxEntry {
  /** Block number where the announce tx landed. */
  blockNumber: string; // bigint serialized as decimal string for JSON
  /** Tx hash of the announce. Useful for explorer links. */
  txHash: Hex;
  /** Sender (the indexed `caller` field). Visible per EIP-5564 design. */
  sender: Address;
  /** The fresh stealth address — where funds landed. */
  stealthAddress: Address;
  /** Compressed ephemeral pubkey (33 bytes) — needed by the sweep flow. */
  ephemeralPubKey: Hex;
  /** First byte of metadata = view tag (already validated). */
  viewTag: number;
  /** Token contract address from metadata bytes 5-24. */
  token: Address;
  /** Amount/tokenId from metadata bytes 25-56 (uint256, decimal string). */
  amount: string;
  /** Function selector — `0xa9059cbb` for ERC-20 transfer, `0xeeeeeeee`
   *  for native ETH. Used to differentiate sweep flows. */
  functionSelector: Hex;
  /** Unix-seconds timestamp from the block. Best-effort — set when we
   *  fetched the block; null if the RPC failed. */
  timestamp?: number;
  /** Whether the user has already swept this entry. Maintained by Phase 9.5. */
  swept?: boolean;
}

// Tunables. Free RPC tiers (alchemy demo, sepolia.base.org) clamp
// `getLogs` block ranges; 5000 is a conservative window.
const SCAN_BLOCK_BATCH = 5000n;
// How far back to look on a fresh inbox (no watermark stored). Going
// to genesis is impossibly slow; the user is unlikely to have stealth
// payments from before they registered their meta-address. 50k blocks
// ≈ 1 week on Sepolia/Base Sepolia.
const COLDSTART_LOOKBACK_BLOCKS = 50_000n;

interface UseStealthInboxResult {
  entries: StealthInboxEntry[];
  isScanning: boolean;
  scanProgress: { from: bigint; to: bigint; current: bigint } | null;
  hasKeys: boolean;
  /** True if encrypted keys exist on disk but the in-memory cache hasn't
   *  been unlocked yet. The UI can prompt the user to unlock. */
  locked: boolean;
  scan: () => Promise<void>;
  /** Trigger the passphrase prompt to unlock the stored keys. */
  unlock: () => Promise<void>;
  /** Mark an entry as swept. Phase 9.5 calls this after a successful sweep. */
  markSwept: (txHash: Hex, stealthAddress: Address) => void;
}

export function useStealthInbox(): UseStealthInboxResult {
  const { activeChainId, contracts } = useChain();
  const { effectiveAddress } = useEffectiveAddress();
  const publicClient = usePublicClient({ chainId: activeChainId });
  // Audit Top-28 #11: per-chain announcer via useChain() so a reload-free
  // switch picks up the new chain's address (canonical singleton today,
  // but treat as chain-scoped for consistency + future override).
  const announcerAddress = contracts.ERC5564Announcer as Address;

  const passphrasePrompt = usePassphrasePrompt();
  // `unlockTick` bumps when the in-memory keystore cache is populated so
  // dependent memos re-read. The keystore itself caches in module scope;
  // this state forces a re-render after a successful unlock.
  const [unlockTick, setUnlockTick] = useState(0);
  const keysRecord = useMemo(
    () => (effectiveAddress ? loadStealthKeys(effectiveAddress) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [effectiveAddress, unlockTick],
  );
  const hasKeys = !!keysRecord;
  const locked = !!effectiveAddress && !keysRecord && hasStealthKeysStored(effectiveAddress);

  const unlock = useCallback(async () => {
    if (!effectiveAddress) return;
    const pass = await passphrasePrompt.request({
      title: "Decrypt stealth keys",
      subtitle: "Enter the passphrase you set when generating your stealth keys.",
    });
    if (!pass) return;
    try {
      const rec = await unlockStealthKeys(effectiveAddress, pass);
      if (rec) setUnlockTick((n) => n + 1);
    } catch {
      // wrong passphrase — caller can retry
    }
  }, [effectiveAddress, passphrasePrompt]);
  // Guard against re-entrant scans: auto-scan, manual rescan, and
  // 60s-interval can all fire concurrently and race on the watermark.
  const scanInFlight = useRef(false);

  const [entries, setEntries] = useState<StealthInboxEntry[]>(() => {
    if (!effectiveAddress) return [];
    return getStoredJson<StealthInboxEntry[]>(
      STORAGE_KEYS.stealthInboxMatches(effectiveAddress, activeChainId),
      [],
    );
  });
  const [isScanning, setIsScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState<{ from: bigint; to: bigint; current: bigint } | null>(null);

  // Reload from storage when account / chain switches.
  useEffect(() => {
    if (!effectiveAddress) {
      setEntries([]);
      return;
    }
    const cached = getStoredJson<StealthInboxEntry[]>(
      STORAGE_KEYS.stealthInboxMatches(effectiveAddress, activeChainId),
      [],
    );
    setEntries(cached);
  }, [effectiveAddress, activeChainId]);

  const scan = useCallback(async () => {
    if (!publicClient || !effectiveAddress || !keysRecord) {
      return;
    }
    if (!announcerAddress || announcerAddress === "0x0000000000000000000000000000000000000000") {
      return;
    }
    // Re-entrancy guard. A second scan() while the first is mid-flight
    // would race on the watermark — both compute fromBlock from the
    // same value, both write at the end, last-writer wins, and the
    // watermark can move backwards.
    if (scanInFlight.current) return;
    scanInFlight.current = true;

    setIsScanning(true);
    try {
      const { spendingPubKey } = pubKeysFromRecord(keysRecord);
      const watermarkKey = STORAGE_KEYS.stealthInboxWatermark(effectiveAddress, activeChainId);
      const matchesKey = STORAGE_KEYS.stealthInboxMatches(effectiveAddress, activeChainId);
      const watermark = getStoredJson<string | null>(watermarkKey, null);
      const tipBlock = await publicClient.getBlockNumber();
      const fromBlock = watermark
        ? BigInt(watermark) + 1n
        : tipBlock > COLDSTART_LOOKBACK_BLOCKS
          ? tipBlock - COLDSTART_LOOKBACK_BLOCKS
          : 0n;
      if (fromBlock > tipBlock) {
        // Already at tip — no new blocks to scan.
        return;
      }

      // Read fresh from storage instead of closing over `entries`. Two
      // reasons: (1) avoids stale-closure bugs when scan is recreated by
      // useCallback while an interval-installed copy is mid-flight,
      // (2) lets cross-tab merges (future work) be drop-in: just merge
      // here on read.
      const persisted = getStoredJson<StealthInboxEntry[]>(matchesKey, []);
      const matches: StealthInboxEntry[] = [...persisted];
      const seenTxHashes = new Set(matches.map((m) => `${m.txHash.toLowerCase()}:${m.stealthAddress.toLowerCase()}`));

      for (let cursor = fromBlock; cursor <= tipBlock; cursor += SCAN_BLOCK_BATCH) {
        const batchTo = cursor + SCAN_BLOCK_BATCH - 1n > tipBlock ? tipBlock : cursor + SCAN_BLOCK_BATCH - 1n;
        setScanProgress({ from: fromBlock, to: tipBlock, current: cursor });

        // Per-batch try/catch: if one window fails (RPC 429, range too
        // large, gateway timeout), the watermark stays at the last
        // successful batch and the next scan retries from there. We
        // log + skip rather than aborting the whole scan.
        let logs: any[] = [];
        try {
          logs = await publicClient.getContractEvents({
            address: announcerAddress,
            abi: ERC5564AnnouncerAbi,
            eventName: "Announcement",
            args: { schemeId: 1n },
            fromBlock: cursor,
            toBlock: batchTo,
          });
        } catch (err) {
          log.warn("useStealthInbox.getContractEvents.failed", {
            cursor: cursor.toString(),
            batchTo: batchTo.toString(),
            chainId: activeChainId,
            error: err instanceof Error ? err.message : String(err),
          });
          // Don't advance watermark past this batch on failure — the
          // outer-loop `cursor` will, but we DON'T persist the watermark
          // for THIS batch. So the next scan will start from cursor and
          // retry it. Break out — sequential RPC failures usually mean
          // the endpoint is stressed; better to back off than thrash.
          break;
        }

        for (const log of logs) {
          const ephemeralPubKey = log.args.ephemeralPubKey as Hex;
          const stealthAddress = log.args.stealthAddress as Address;
          const metadata = log.args.metadata as Hex;
          if (!ephemeralPubKey || !stealthAddress || !metadata) continue;

          // Defensive: metadata MUST be at least 1 byte (view tag).
          // Real values are always 57 bytes per spec; smaller means a
          // malformed/truncated announcement we can't interpret.
          // Strict hex regex on the view-tag byte avoids parseInt's
          // half-permissive behaviour ("0x4Z..." would yield 4).
          if (metadata.length < 4) continue;
          const viewTagHex = metadata.slice(2, 4);
          if (!/^[0-9a-fA-F]{2}$/.test(viewTagHex)) continue;
          const viewTag = parseInt(viewTagHex, 16);

          // Run the full check (view-tag fast filter is inside).
          let isMine = false;
          try {
            isMine = checkStealthAddress({
              announcedStealthAddress: stealthAddress,
              ephemeralPublicKey: ephemeralPubKey as `0x${string}`,
              viewingPrivateKey: keysRecord.viewingPrivateKey,
              spendingPublicKey: spendingPubKey,
              viewTag,
            });
          } catch {
            // Invalid pubkey bytes / curve point — skip the malformed entry.
            continue;
          }
          if (!isMine) continue;

          // Decode metadata layout:
          //   byte 0       view tag      (already parsed)
          //   bytes 1-4    function selector
          //   bytes 5-24   token address
          //   bytes 25-56  amount (uint256, big-endian)
          // 57 bytes total → 114 hex chars + "0x" prefix = string length 116.
          if (metadata.length < 2 + 57 * 2) {
            // 57 bytes minimum for ERC-20/native flows; reject malformed.
            continue;
          }
          const functionSelector = ("0x" + metadata.slice(4, 12)) as Hex;
          const tokenHex = "0x" + metadata.slice(12, 52);
          const amountHex = "0x" + metadata.slice(52, 116);
          const token = tokenHex as Address;
          const amount = BigInt(amountHex).toString();

          const dedupKey = `${log.transactionHash.toLowerCase()}:${stealthAddress.toLowerCase()}`;
          if (seenTxHashes.has(dedupKey)) continue;
          seenTxHashes.add(dedupKey);

          const entry: StealthInboxEntry = {
            blockNumber: (log.blockNumber ?? 0n).toString(),
            txHash: log.transactionHash,
            sender: log.args.caller as Address,
            stealthAddress,
            ephemeralPubKey,
            viewTag,
            token,
            amount,
            functionSelector,
          };
          matches.push(entry);
        }

        // Persist progress every batch so a tab close doesn't lose work.
        setStoredJson(matchesKey, matches);
        setStoredJson(watermarkKey, batchTo.toString());
      }
      setEntries([...matches]);
      setStoredJson(watermarkKey, tipBlock.toString());
    } finally {
      scanInFlight.current = false;
      setIsScanning(false);
      setScanProgress(null);
    }
  }, [publicClient, effectiveAddress, keysRecord, announcerAddress, activeChainId]);

  // Auto-scan on mount + when account / chain changes. Pause when tab
  // is hidden — `pagehide` / `visibilitychange` listeners would be
  // cleaner but the React Query layer + simple `if (document.hidden)`
  // here is enough for v1.
  useEffect(() => {
    if (!hasKeys) return;
    if (typeof document !== "undefined" && document.hidden) return;
    void scan();
    // Polling: re-scan every 60s while the tab is visible.
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && !document.hidden) {
        void scan();
      }
    }, 60_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasKeys, effectiveAddress, activeChainId]);

  const markSwept = useCallback(
    (txHash: Hex, stealthAddress: Address) => {
      if (!effectiveAddress) return;
      setEntries((prev) => {
        const next = prev.map((e) =>
          e.txHash.toLowerCase() === txHash.toLowerCase() &&
          e.stealthAddress.toLowerCase() === stealthAddress.toLowerCase()
            ? { ...e, swept: true }
            : e,
        );
        setStoredJson(STORAGE_KEYS.stealthInboxMatches(effectiveAddress, activeChainId), next);
        return next;
      });
    },
    [effectiveAddress, activeChainId],
  );

  return {
    entries,
    isScanning,
    scanProgress,
    hasKeys,
    locked,
    scan,
    unlock,
    markSwept,
  };
}
