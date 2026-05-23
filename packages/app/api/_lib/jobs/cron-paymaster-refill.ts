/**
 * /api/cron/paymaster-refill — every 6h auto-refill of BlankPaymaster
 *
 * Reads EntryPoint.balanceOf(BlankPaymaster) per chain. If a chain dips
 * below PAYMASTER_REFILL_THRESHOLD_WEI (default 0.5 ETH), calls
 * EntryPoint.depositTo(paymaster, {value: PAYMASTER_REFILL_AMOUNT_WEI})
 * from a dedicated topup-only signer.
 *
 * Key custody: PAYMASTER_TOPUP_PRIVATE_KEY is a separate hot key, NOT
 * the deployer. Operator funds it with at most ~1 ETH at a time. If the
 * key leaks, the attacker drains at most that float and the deployer
 * stays untouched. Pair with the daily rate cap below.
 *
 * Daily rate cap: PAYMASTER_REFILL_DAILY_CAP_WEI (default 2 ETH). Refills
 * accumulate per chain per UTC day in Supabase; once a chain hits the
 * cap the function skips + emails the operator. Guards against a
 * compromised key being drained in one cron tick.
 *
 * Idempotency: the rate-cap counter doubles as a dedupe. Same 6h tick
 * fires once, refill amount recorded, counter updated.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Same
 * secret as cron-paymaster-monitor.
 */

import { ethers } from "ethers";
import {
  getContracts,
  RPC_URLS,
  ETH_SEPOLIA_ID,
  BASE_SEPOLIA_ID,
} from "../addresses.js";
import { sendEmail, emailEnabled } from "../resend.js";
import { getSupabaseAdmin } from "../supabase-admin.js";

const ENTRYPOINT_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function depositTo(address account) payable",
];

// Defaults sized for testnet operation.
//
// Refill threshold (0.5 ETH): well above the client's "degraded" floor
// of 0.05 ETH, so a 6h-cron tick catches the drift before any user
// hits a degraded path.
//
// Refill amount (0.5 ETH): a single tick refills back to a healthy
// reserve in one call. With the daily cap at 2 ETH, four ticks per day
// would be the absolute ceiling.
//
// Daily cap (2 ETH per chain): hard ceiling. If the paymaster is
// burning more than 2 ETH/day on a single chain that's an attack or
// a runaway issue; pause and investigate, do not auto-refill more.
const DEFAULT_REFILL_THRESHOLD_WEI = 500_000_000_000_000_000n;    // 0.5 ETH
const DEFAULT_REFILL_AMOUNT_WEI    = 500_000_000_000_000_000n;    // 0.5 ETH
const DEFAULT_REFILL_DAILY_CAP_WEI = 2_000_000_000_000_000_000n;  // 2 ETH

const CHAIN_LABEL: Record<number, string> = {
  [ETH_SEPOLIA_ID]: "Ethereum Sepolia",
  [BASE_SEPOLIA_ID]: "Base Sepolia",
};

function readBigEnv(name: string, fallback: bigint): bigint {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  try {
    const parsed = BigInt(raw);
    return parsed > 0n ? parsed : fallback;
  } catch {
    return fallback;
  }
}

interface RefillSnapshot {
  chainId: number;
  chainLabel: string;
  paymaster: string;
  preDepositEth: string;
  postDepositEth?: string;
  refilledEth?: string;
  todaysTotalEth?: string;
  action: "refilled" | "ok" | "capped" | "error" | "skipped";
  txHash?: string;
  error?: string;
}

async function readRefilledTodayWei(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chainId: number,
  utcDay: string,
): Promise<bigint> {
  if (!supabase) return 0n;
  const { data, error } = await supabase
    .from("paymaster_refills")
    .select("amount_wei")
    .eq("chain_id", chainId)
    .eq("utc_day", utcDay)
    .eq("kind", "paymaster");
  if (error || !data) return 0n;
  let total = 0n;
  for (const row of data) {
    try {
      total += BigInt(row.amount_wei);
    } catch {
      // ignore malformed rows; never block the refill on a counter glitch
    }
  }
  return total;
}

async function recordRefill(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  chainId: number,
  utcDay: string,
  amountWei: bigint,
  txHash: string,
): Promise<void> {
  if (!supabase) return;
  await supabase.from("paymaster_refills").insert({
    chain_id: chainId,
    utc_day: utcDay,
    amount_wei: amountWei.toString(),
    tx_hash: txHash,
    kind: "paymaster",
  });
}

async function refillChain(
  chainId: number,
  signer: ethers.Wallet,
  thresholdWei: bigint,
  refillAmountWei: bigint,
  dailyCapWei: bigint,
  utcDay: string,
  supabase: ReturnType<typeof getSupabaseAdmin>,
): Promise<RefillSnapshot> {
  const chainLabel = CHAIN_LABEL[chainId] ?? `chain-${chainId}`;
  const contracts = getContracts(chainId);
  if (!contracts) {
    return {
      chainId,
      chainLabel,
      paymaster: "(none)",
      preDepositEth: "0",
      action: "error",
      error: "no contracts configured",
    };
  }

  const rpcUrl = RPC_URLS[chainId];
  if (!rpcUrl) {
    return {
      chainId,
      chainLabel,
      paymaster: contracts.BlankPaymaster,
      preDepositEth: "0",
      action: "error",
      error: "no RPC URL configured",
    };
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const connectedSigner = signer.connect(provider);
    const entrypoint = new ethers.Contract(
      contracts.EntryPoint,
      ENTRYPOINT_ABI,
      connectedSigner,
    );
    const deposit: bigint = await entrypoint.balanceOf(contracts.BlankPaymaster);
    const preDepositEth = ethers.formatEther(deposit);

    if (deposit >= thresholdWei) {
      return {
        chainId,
        chainLabel,
        paymaster: contracts.BlankPaymaster,
        preDepositEth,
        action: "ok",
      };
    }

    // Daily rate cap check.
    const refilledTodayWei = await readRefilledTodayWei(supabase, chainId, utcDay);
    if (refilledTodayWei + refillAmountWei > dailyCapWei) {
      return {
        chainId,
        chainLabel,
        paymaster: contracts.BlankPaymaster,
        preDepositEth,
        action: "capped",
        todaysTotalEth: ethers.formatEther(refilledTodayWei),
        error: `daily cap ${ethers.formatEther(dailyCapWei)} ETH reached`,
      };
    }

    // Topup-only signer pre-flight: make sure it can cover the call.
    const signerBalance = await provider.getBalance(connectedSigner.address);
    const gasReserve = 50_000_000_000_000_000n; // 0.05 ETH for gas
    if (signerBalance < refillAmountWei + gasReserve) {
      return {
        chainId,
        chainLabel,
        paymaster: contracts.BlankPaymaster,
        preDepositEth,
        action: "error",
        error: `topup signer balance ${ethers.formatEther(signerBalance)} ETH below refill+gas`,
      };
    }

    // Send the refill tx.
    const tx = await entrypoint.depositTo(contracts.BlankPaymaster, {
      value: refillAmountWei,
    });
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      return {
        chainId,
        chainLabel,
        paymaster: contracts.BlankPaymaster,
        preDepositEth,
        action: "error",
        txHash: tx.hash,
        error: "refill tx reverted",
      };
    }

    await recordRefill(supabase, chainId, utcDay, refillAmountWei, tx.hash);

    const postDeposit: bigint = await entrypoint.balanceOf(contracts.BlankPaymaster);
    return {
      chainId,
      chainLabel,
      paymaster: contracts.BlankPaymaster,
      preDepositEth,
      postDepositEth: ethers.formatEther(postDeposit),
      refilledEth: ethers.formatEther(refillAmountWei),
      todaysTotalEth: ethers.formatEther(refilledTodayWei + refillAmountWei),
      action: "refilled",
      txHash: tx.hash,
    };
  } catch (err) {
    return {
      chainId,
      chainLabel,
      paymaster: contracts.BlankPaymaster,
      preDepositEth: "0",
      action: "error",
      error: err instanceof Error ? err.message.slice(0, 280) : String(err).slice(0, 280),
    };
  }
}

function renderSummaryEmail(snapshots: RefillSnapshot[], reason: "refilled" | "capped" | "error"): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = reason === "refilled"
    ? `[Blank] Paymaster auto-refilled on ${snapshots.filter((s) => s.action === "refilled").length} chain(s)`
    : reason === "capped"
      ? `[Blank] Paymaster refill HIT DAILY CAP — manual top-up needed`
      : `[Blank] Paymaster refill cron errored`;

  const rows = snapshots
    .map((s) => {
      const status =
        s.action === "refilled" ? `<span style="color:#15803d">refilled ${s.refilledEth} ETH</span>` :
        s.action === "ok" ? `<span style="color:#475569">ok</span>` :
        s.action === "capped" ? `<span style="color:#b91c1c;font-weight:600">CAPPED</span>` :
        s.action === "error" ? `<span style="color:#b91c1c">ERROR: ${s.error}</span>` :
        s.action;
      const txCell = s.txHash
        ? `<a href="${s.chainId === ETH_SEPOLIA_ID ? "https://sepolia.etherscan.io/tx/" : "https://sepolia.basescan.org/tx/"}${s.txHash}" style="font-family:monospace;font-size:11px;color:#0369a1">${s.txHash.slice(0, 12)}…</a>`
        : "—";
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${s.chainLabel}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${s.preDepositEth} ETH</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${s.postDepositEth ?? "—"} ETH</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center">${status}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${txCell}</td>
        </tr>`;
    })
    .join("");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:680px;margin:0 auto">
      <h2 style="color:#0f172a">Paymaster refill cron — ${reason}</h2>
      <table style="border-collapse:collapse;width:100%;margin-top:16px;font-size:14px">
        <thead>
          <tr style="background:#f1f5f9;color:#334155">
            <th style="padding:8px 12px;text-align:left">Chain</th>
            <th style="padding:8px 12px;text-align:right">Before</th>
            <th style="padding:8px 12px;text-align:right">After</th>
            <th style="padding:8px 12px;text-align:center">Status</th>
            <th style="padding:8px 12px;text-align:left">Tx</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  const text = snapshots
    .map((s) => `${s.chainLabel.padEnd(20)}  pre=${s.preDepositEth.padStart(8)} ETH  post=${(s.postDepositEth ?? "—").padStart(8)} ETH  ${s.action}${s.error ? "  " + s.error : ""}`)
    .join("\n");

  return { subject, html, text };
}

export default async function handler(req: any, res: any) {
  // Fail closed: missing CRON_SECRET in env = reject all requests.
  const expected = process.env.CRON_SECRET;
  const provided = req.headers["authorization"];
  if (!expected || provided !== `Bearer ${expected}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const topupKey = process.env.PAYMASTER_TOPUP_PRIVATE_KEY?.trim();
  if (!topupKey || !/^0x[0-9a-fA-F]{64}$/.test(topupKey)) {
    res.status(503).json({
      status: "skipped",
      reason: "PAYMASTER_TOPUP_PRIVATE_KEY missing or malformed",
    });
    return;
  }

  const thresholdWei = readBigEnv("PAYMASTER_REFILL_THRESHOLD_WEI", DEFAULT_REFILL_THRESHOLD_WEI);
  const refillAmountWei = readBigEnv("PAYMASTER_REFILL_AMOUNT_WEI", DEFAULT_REFILL_AMOUNT_WEI);
  const dailyCapWei = readBigEnv("PAYMASTER_REFILL_DAILY_CAP_WEI", DEFAULT_REFILL_DAILY_CAP_WEI);

  const signer = new ethers.Wallet(topupKey);
  const supabase = getSupabaseAdmin();
  const utcDay = new Date().toISOString().slice(0, 10);

  const chainIds = [ETH_SEPOLIA_ID, BASE_SEPOLIA_ID];
  const snapshots = await Promise.all(
    chainIds.map((id) =>
      refillChain(id, signer, thresholdWei, refillAmountWei, dailyCapWei, utcDay, supabase),
    ),
  );

  const refilled = snapshots.filter((s) => s.action === "refilled");
  const capped = snapshots.filter((s) => s.action === "capped");
  const errored = snapshots.filter((s) => s.action === "error");

  // Email when something actionable happened. Don't email on ok-only ticks.
  if ((refilled.length || capped.length || errored.length) && emailEnabled()) {
    const recipient = process.env.PAYMASTER_ALERT_EMAIL_TO?.trim();
    if (recipient) {
      const reason: "refilled" | "capped" | "error" =
        errored.length > 0 ? "error" : capped.length > 0 ? "capped" : "refilled";
      try {
        const tpl = renderSummaryEmail(snapshots, reason);
        await sendEmail({
          to: recipient,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
          idempotencyKey: `paymaster-refill:${utcDay}:${reason}:${snapshots.map((s) => s.chainId + ":" + s.action).join(",")}`,
        });
      } catch (err) {
        console.error("[paymaster-refill] email send failed:", err);
      }
    }
  }

  res.status(200).json({
    status: "ok",
    utcDay,
    thresholdEth: ethers.formatEther(thresholdWei),
    refillAmountEth: ethers.formatEther(refillAmountWei),
    dailyCapEth: ethers.formatEther(dailyCapWei),
    signer: signer.address,
    chains: snapshots,
    refilled: refilled.length,
    capped: capped.length,
    errored: errored.length,
  });
}
