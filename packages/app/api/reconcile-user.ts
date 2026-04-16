/**
 * /api/reconcile-user — chain-log back-fill for the activity feed
 *
 * Every write hook in the app is a two-phase commit:
 *   1. Submit tx, wait for receipt
 *   2. insertActivity(...) — write a row to Supabase so the feed renders
 *
 * If step 2 fails (frontend crash mid-flight, browser closed, Supabase
 * timeout), the tx succeeded on-chain but nobody sees it in the UI. This
 * endpoint is called on app mount to close the gap: we scan recent logs
 * for user-relevant events and upsert missing rows with the service-role
 * Supabase client (bypasses RLS for back-fill writes).
 *
 * Flow:
 *   POST { address, chainId, sinceBlock? }
 *
 *   1. Validate input, rate-limit (10 req/ip/min keyed "reconcile")
 *   2. Compute fromBlock = sinceBlock ?? (latest - 10_000)
 *   3. For each contract+event combo cheap to filter by user topic, pull
 *      logs and upsert onto `activities` with onConflict:"tx_hash"
 *   4. Persist the highest block seen into `indexer_state` so repeat
 *      calls resume from there
 *   5. Return { indexed, lastBlock, events: [tx_hashes] }
 *
 * Degradation: if SUPABASE_SERVICE_ROLE_KEY is missing we return
 * { status: "no-db", indexed: 0 } — the app boot path still succeeds,
 * it just doesn't back-fill. Better than a 500 that breaks the whole UI.
 */

import { ethers } from "ethers";
import { checkRateLimit, writeRateLimitHeaders } from "./_lib/rate-limit";
import { getSupabaseAdmin } from "./_lib/supabase-admin";
import {
  ETH_SEPOLIA_ID,
  BASE_SEPOLIA_ID,
  CONTRACTS_BY_CHAIN,
  RPC_URLS,
} from "./_lib/addresses";

// ─── Config ───────────────────────────────────────────────────────────
// Addresses are pulled from the shared server-side module at
// ./_lib/addresses.ts which itself reads env vars with literal fallbacks.
// Keeps address drift contained to a single file after UUPS upgrades
// (#282: previously the addresses were duplicated inline here and in the
// frontend's constants.ts, requiring a manual edit in two places).

const SUPPORTED_CHAINS: Record<number, { rpcUrl: string; contracts: (typeof CONTRACTS_BY_CHAIN)[number] }> = {
  [ETH_SEPOLIA_ID]: {
    rpcUrl: RPC_URLS[ETH_SEPOLIA_ID],
    contracts: CONTRACTS_BY_CHAIN[ETH_SEPOLIA_ID],
  },
  [BASE_SEPOLIA_ID]: {
    rpcUrl: RPC_URLS[BASE_SEPOLIA_ID],
    contracts: CONTRACTS_BY_CHAIN[BASE_SEPOLIA_ID],
  },
};

// ─── Event ABIs + topic hashes ────────────────────────────────────────
// Only events where we can filter by user address via an indexed topic —
// otherwise we'd pull every log and iterate. Prioritized by volume:
// PaymentSent > EnvelopeCreated > Shielded.

const EVENT_ABIS = [
  "event PaymentSent(address indexed from, address indexed to, address vault, string note, uint256 timestamp)",
  "event EnvelopeCreated(uint256 indexed envelopeId, address indexed sender, address vault, uint256 recipientCount, string note, uint256 timestamp)",
  "event Shielded(address indexed user, address indexed token, uint256 timestamp)",
];

const iface = new ethers.Interface(EVENT_ABIS);

const TOPIC_PAYMENT_SENT = iface.getEvent("PaymentSent")!.topicHash;
const TOPIC_ENVELOPE_CREATED = iface.getEvent("EnvelopeCreated")!.topicHash;
const TOPIC_SHIELDED = iface.getEvent("Shielded")!.topicHash;

// Hardcoded so we don't need to import ACTIVITY_TYPES from the frontend
// module (which pulls in import.meta.env constants — incompatible with
// serverless bundling). Kept in sync with src/lib/activity-types.ts.
const ACTIVITY_TYPES = {
  PAYMENT: "payment",
  GIFT_CREATED: "gift_created",
  SHIELD: "shield",
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────

function ipFromHeaders(headers: Record<string, string | string[] | undefined>): string {
  const fwd = headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0].trim();
  if (Array.isArray(fwd)) return fwd[0].split(",")[0].trim();
  return "unknown";
}

/** pad a checksummed address to the 32-byte topic encoding */
function addressTopic(addr: string): string {
  return ethers.zeroPadValue(ethers.getAddress(addr), 32);
}

interface ReconciledRow {
  tx_hash: string;
  user_from: string;
  user_to: string;
  activity_type: string;
  contract_address: string;
  note: string;
  token_address: string;
  block_number: number;
  chain_id: number;
}

// ─── Handler ──────────────────────────────────────────────────────────

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const ip = ipFromHeaders(req.headers ?? {});
  const rl = await checkRateLimit({ ip, key: "reconcile", windowMs: 60_000, max: 10 });
  writeRateLimitHeaders(res, rl);
  if (!rl.ok) {
    res.status(429).json({ error: `Rate limit exceeded — try again in ${rl.resetSeconds}s` });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch {
      res.status(400).json({ error: "invalid JSON body" });
      return;
    }
  }
  const { address, chainId, sinceBlock } = body ?? {};

  if (!address || typeof address !== "string" || !ethers.isAddress(address)) {
    res.status(400).json({ error: "invalid address" });
    return;
  }
  if (typeof chainId !== "number" || chainId <= 0) {
    res.status(400).json({ error: "invalid chainId" });
    return;
  }
  const chainCfg = SUPPORTED_CHAINS[chainId];
  if (!chainCfg) {
    res.status(400).json({ error: `unsupported chainId — must be one of ${Object.keys(SUPPORTED_CHAINS).join(", ")}` });
    return;
  }

  // No DB configured? Return a no-op so the frontend's mount-time call
  // succeeds without surfacing a 500 banner. Back-fill is a "nice to have"
  // layer on top of the primary insertActivity path; losing it shouldn't
  // break the app.
  const admin = getSupabaseAdmin();
  if (!admin) {
    res.status(200).json({ status: "no-db", indexed: 0, lastBlock: null, events: [] });
    return;
  }

  try {
    const userAddr = ethers.getAddress(address);
    const userTopic = addressTopic(userAddr);
    const provider = new ethers.JsonRpcProvider(chainCfg.rpcUrl);

    const latest = await provider.getBlockNumber();

    // Resume from the last indexed block if we have one — cuts RPC load
    // dramatically after the first call. Clamp sinceBlock to not exceed
    // latest so a bad input doesn't cause empty scans.
    let fromBlock: number;
    if (typeof sinceBlock === "number" && sinceBlock >= 0 && sinceBlock <= latest) {
      fromBlock = sinceBlock;
    } else {
      // Look up cursor. Missing row = default to latest - 10k.
      const { data: cursor } = await admin
        .from("indexer_state")
        .select("last_block")
        .eq("address", userAddr.toLowerCase())
        .eq("chain_id", chainId)
        .maybeSingle();
      const cursorBlock = cursor?.last_block ? Number(cursor.last_block) : 0;
      fromBlock = cursorBlock > 0 ? cursorBlock + 1 : Math.max(0, latest - 10_000);
    }

    // Cap range so getLogs doesn't time out. 10k blocks ≈ 33 hours on 12s
    // block time, 5.5 hours on Base's 2s.
    if (latest - fromBlock > 10_000) fromBlock = latest - 10_000;

    // ─── Query events in parallel (at most 5 per call) ────────────────
    // Each filter has an indexed user topic so RPCs can server-side
    // filter instead of returning every event of that type.

    const queries: Array<{
      address: string;
      topics: Array<string | string[] | null>;
      activity_type: string;
      role: "from" | "to" | "user";
    }> = [
      // PaymentSent where user is the sender
      {
        address: chainCfg.contracts.PaymentHub,
        topics: [TOPIC_PAYMENT_SENT, userTopic, null],
        activity_type: ACTIVITY_TYPES.PAYMENT,
        role: "from",
      },
      // PaymentSent where user is the recipient
      {
        address: chainCfg.contracts.PaymentHub,
        topics: [TOPIC_PAYMENT_SENT, null, userTopic],
        activity_type: ACTIVITY_TYPES.PAYMENT,
        role: "to",
      },
      // GiftMoney: envelopes sent by user
      {
        address: chainCfg.contracts.GiftMoney,
        topics: [TOPIC_ENVELOPE_CREATED, null, userTopic],
        activity_type: ACTIVITY_TYPES.GIFT_CREATED,
        role: "from",
      },
      // FHERC20Vault: shield events for user
      {
        address: chainCfg.contracts.FHERC20Vault_USDC,
        topics: [TOPIC_SHIELDED, userTopic, null],
        activity_type: ACTIVITY_TYPES.SHIELD,
        role: "user",
      },
    ];

    const MAX_LOGS = 500;
    const rows: ReconciledRow[] = [];
    let highestBlock = fromBlock;

    const results = await Promise.all(
      queries.map((q) =>
        provider.getLogs({
          address: q.address,
          topics: q.topics,
          fromBlock,
          toBlock: "latest",
        }).then((logs) => ({ q, logs })).catch((err) => {
          // One failed query shouldn't kill the whole reconcile —
          // log and continue. Common cause: RPC rate limit.
          console.warn(`[reconcile] getLogs failed for ${q.activity_type}/${q.role}:`, err?.message ?? err);
          return { q, logs: [] as ethers.Log[] };
        })
      )
    );

    let totalLogs = 0;
    for (const { q, logs } of results) {
      for (const log of logs) {
        if (totalLogs >= MAX_LOGS) break;
        totalLogs++;

        let parsed: ethers.LogDescription | null = null;
        try {
          parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        } catch {
          continue;
        }
        if (!parsed) continue;

        let userFrom = "";
        let userTo = "";
        let note = "";

        if (parsed.name === "PaymentSent") {
          userFrom = String(parsed.args.from).toLowerCase();
          userTo = String(parsed.args.to).toLowerCase();
          note = typeof parsed.args.note === "string" ? parsed.args.note : "";
        } else if (parsed.name === "EnvelopeCreated") {
          userFrom = String(parsed.args.sender).toLowerCase();
          userTo = ""; // recipients are off-topic for the sender-side row
          note = typeof parsed.args.note === "string" ? parsed.args.note : "";
        } else if (parsed.name === "Shielded") {
          userFrom = String(parsed.args.user).toLowerCase();
          userTo = String(parsed.args.user).toLowerCase();
        } else {
          continue;
        }

        if (log.blockNumber > highestBlock) highestBlock = log.blockNumber;

        // #244: chain_id MUST come from the request's `chainId` param —
        // never default to a module-level ref. The cron in
        // /api/cron/reconcile-tick.ts fans out the same address across
        // BOTH chains in sequence; if we defaulted to a stale module ref
        // here, half the back-fill rows would land on the wrong chain.
        // Direct upsert via the admin client (NOT the insertActivity
        // wrapper) keeps this guarantee. If you ever switch this path
        // to the wrapper, pass `chain_id: chainId` explicitly in the
        // payload — do NOT rely on the wrapper's default.
        rows.push({
          tx_hash: log.transactionHash,
          user_from: userFrom,
          user_to: userTo,
          activity_type: q.activity_type,
          contract_address: log.address.toLowerCase(),
          note,
          token_address: "",
          block_number: log.blockNumber,
          chain_id: chainId,
        });
      }
      if (totalLogs >= MAX_LOGS) break;
    }

    // ─── Upsert onto activities (idempotent via tx_hash unique index) ─
    let indexed = 0;
    const txHashes: string[] = [];
    if (rows.length > 0) {
      const { error } = await admin
        .from("activities")
        .upsert(rows, { onConflict: "tx_hash" });
      if (error) {
        console.warn("[reconcile] activities upsert failed:", error.message);
      } else {
        indexed = rows.length;
        for (const r of rows) txHashes.push(r.tx_hash);
      }
    }

    // ─── Persist cursor ──────────────────────────────────────────────
    // Save the highest block we've seen (or `latest` if we saw nothing
    // new) so the next call resumes from there instead of scanning the
    // same ~10k window again.
    const newLastBlock = Math.max(highestBlock, latest);
    const { error: cursorError } = await admin
      .from("indexer_state")
      .upsert({
        address: userAddr.toLowerCase(),
        chain_id: chainId,
        last_block: newLastBlock,
        updated_at: new Date().toISOString(),
      }, { onConflict: "address,chain_id" });
    if (cursorError) {
      console.warn("[reconcile] cursor upsert failed:", cursorError.message);
    }

    res.status(200).json({
      indexed,
      lastBlock: newLastBlock,
      events: txHashes,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[reconcile] fatal:", msg);
    res.status(500).json({ error: `reconcile failed: ${msg}` });
  }
}
