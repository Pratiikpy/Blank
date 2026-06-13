/**
 * /api/cron/paymaster-monitor — Vercel Cron entrypoint
 *
 * Daily server-side check on `EntryPoint.balanceOf(BlankPaymaster)` for every
 * supported chain. When the deposit on any chain dips below
 * `PAYMASTER_ALERT_THRESHOLD_WEI`, fires an email to `PAYMASTER_ALERT_EMAIL_TO`
 * via Resend so an operator can top it up before the next user hits the wall.
 *
 * Why this exists alongside the client-side `usePaymasterHealth` hook:
 *
 *   • The hook only runs while users have the app open. If everyone is asleep
 *     and the deposit drains, nobody sees the degraded banner — the next
 *     user just gets a cryptic AA31 revert on their first send.
 *   • The hook flips users to self-pay on `unavailable`, which is a graceful
 *     degradation but a worse UX than "we got this". Server-side alerting
 *     lets us fix the root cause before users even notice.
 *
 * Defaults:
 *   • Warn threshold:  0.1 ETH (10x the client's `unavailable` floor of 0.01
 *     ETH, ~2x the client's `degraded` warn of 0.05 ETH). Tunable via
 *     `PAYMASTER_ALERT_THRESHOLD_WEI`.
 *   • Email recipient: `PAYMASTER_ALERT_EMAIL_TO`. If unset, we just log and
 *     return — no email sent.
 *
 * No DB dedupe: cron runs daily, so if the balance stays below threshold the
 * operator will get a daily nag until they top up. That's intentional.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`.
 */

import { ethers } from "ethers";
import {
  getContracts,
  RPC_URLS,
  ETH_SEPOLIA_ID,
  BASE_SEPOLIA_ID,
  ARB_SEPOLIA_ID,
} from "../addresses.js";
import { sendEmail, emailEnabled } from "../resend.js";

const ENTRYPOINT_ABI = [
  "function balanceOf(address account) view returns (uint256)",
];

/** Default warn threshold — 0.1 ETH. Cron alerts at this level, well before
 *  the client-side `usePaymasterHealth` hook flips users to self-pay (which
 *  triggers at 0.05 ETH for "degraded" and 0.01 ETH for "unavailable"). */
const DEFAULT_ALERT_THRESHOLD_WEI = 100_000_000_000_000_000n;

const CHAIN_LABEL: Record<number, string> = {
  [ETH_SEPOLIA_ID]: "Ethereum Sepolia",
  [BASE_SEPOLIA_ID]: "Base Sepolia",
  [ARB_SEPOLIA_ID]: "Arbitrum Sepolia",
};

interface ChainSnapshot {
  chainId: number;
  chainLabel: string;
  paymaster: string;
  depositWei: string;
  depositEth: string;
  belowThreshold: boolean;
  error?: string;
}

function readThresholdWei(): bigint {
  const raw = process.env.PAYMASTER_ALERT_THRESHOLD_WEI?.trim();
  if (!raw) return DEFAULT_ALERT_THRESHOLD_WEI;
  try {
    const parsed = BigInt(raw);
    return parsed > 0n ? parsed : DEFAULT_ALERT_THRESHOLD_WEI;
  } catch {
    return DEFAULT_ALERT_THRESHOLD_WEI;
  }
}

async function readDeposit(chainId: number, threshold: bigint): Promise<ChainSnapshot> {
  const chainLabel = CHAIN_LABEL[chainId] ?? `chain-${chainId}`;
  const contracts = getContracts(chainId);
  if (!contracts) {
    return {
      chainId,
      chainLabel,
      paymaster: "(none)",
      depositWei: "0",
      depositEth: "0",
      belowThreshold: false,
      error: "no contracts configured",
    };
  }

  const rpcUrl = RPC_URLS[chainId];
  if (!rpcUrl) {
    return {
      chainId,
      chainLabel,
      paymaster: contracts.BlankPaymaster,
      depositWei: "0",
      depositEth: "0",
      belowThreshold: false,
      error: "no RPC URL configured",
    };
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const entrypoint = new ethers.Contract(contracts.EntryPoint, ENTRYPOINT_ABI, provider);
    const deposit: bigint = await entrypoint.balanceOf(contracts.BlankPaymaster);
    return {
      chainId,
      chainLabel,
      paymaster: contracts.BlankPaymaster,
      depositWei: deposit.toString(),
      depositEth: ethers.formatEther(deposit),
      belowThreshold: deposit < threshold,
    };
  } catch (err) {
    return {
      chainId,
      chainLabel,
      paymaster: contracts.BlankPaymaster,
      depositWei: "0",
      depositEth: "0",
      belowThreshold: false,
      error: err instanceof Error ? err.message.slice(0, 280) : String(err).slice(0, 280),
    };
  }
}

function renderAlertEmail(args: {
  snapshots: ChainSnapshot[];
  thresholdWei: bigint;
  thresholdEth: string;
}): { subject: string; html: string; text: string } {
  const breached = args.snapshots.filter((s) => s.belowThreshold);
  const subject = `[Blank] Paymaster low on ${breached.length} chain${breached.length === 1 ? "" : "s"}`;

  const rows = args.snapshots
    .map((s) => {
      const status = s.error
        ? `<span style="color:#b91c1c">ERROR: ${s.error}</span>`
        : s.belowThreshold
          ? `<span style="color:#b91c1c;font-weight:600">LOW</span>`
          : `<span style="color:#15803d">ok</span>`;
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${s.chainLabel}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:12px">${s.paymaster}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right">${s.depositEth} ETH</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center">${status}</td>
        </tr>`;
    })
    .join("");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto">
      <h2 style="color:#0f172a">BlankPaymaster low on EntryPoint deposit</h2>
      <p style="color:#475569">
        The cron monitor detected ${breached.length} chain${breached.length === 1 ? "" : "s"}
        below the configured warn threshold (${args.thresholdEth} ETH).
        Top up via <code>EntryPoint.depositTo(paymaster)</code> or run the
        <code>setup-aa</code> hardhat task.
      </p>
      <table style="border-collapse:collapse;width:100%;margin-top:16px;font-size:14px">
        <thead>
          <tr style="background:#f1f5f9;color:#334155">
            <th style="padding:8px 12px;text-align:left">Chain</th>
            <th style="padding:8px 12px;text-align:left">Paymaster</th>
            <th style="padding:8px 12px;text-align:right">Deposit</th>
            <th style="padding:8px 12px;text-align:center">Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#94a3b8;font-size:12px;margin-top:24px">
        Sent by /api/cron/paymaster-monitor. Tune
        <code>PAYMASTER_ALERT_THRESHOLD_WEI</code> to adjust sensitivity.
      </p>
    </div>`;

  const textRows = args.snapshots
    .map((s) => {
      const tag = s.error ? `ERROR (${s.error})` : s.belowThreshold ? "LOW" : "ok";
      return `  ${s.chainLabel.padEnd(20)}  ${s.depositEth.padStart(10)} ETH  ${tag}`;
    })
    .join("\n");

  const text = [
    `BlankPaymaster low on EntryPoint deposit`,
    ``,
    `${breached.length} chain(s) below ${args.thresholdEth} ETH threshold.`,
    ``,
    textRows,
    ``,
    `Top up via EntryPoint.depositTo(paymaster) or run the setup-aa hardhat task.`,
  ].join("\n");

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

  const thresholdWei = readThresholdWei();
  const thresholdEth = ethers.formatEther(thresholdWei);

  const chainIds = [ETH_SEPOLIA_ID, BASE_SEPOLIA_ID, ARB_SEPOLIA_ID];
  const snapshots = await Promise.all(chainIds.map((id) => readDeposit(id, thresholdWei)));

  const breached = snapshots.filter((s) => s.belowThreshold);
  const errored = snapshots.filter((s) => s.error);

  let emailed = false;
  if (breached.length > 0) {
    const recipient = process.env.PAYMASTER_ALERT_EMAIL_TO?.trim();
    if (!recipient) {
      console.warn(
        "[paymaster-monitor] threshold breached but PAYMASTER_ALERT_EMAIL_TO is unset",
        breached,
      );
    } else if (!emailEnabled()) {
      console.warn(
        "[paymaster-monitor] threshold breached but Resend is not configured",
        breached,
      );
    } else {
      try {
        const tpl = renderAlertEmail({ snapshots, thresholdWei, thresholdEth });
        const day = new Date().toISOString().slice(0, 10);
        await sendEmail({
          to: recipient,
          subject: tpl.subject,
          html: tpl.html,
          text: tpl.text,
          idempotencyKey: `paymaster-monitor:${day}:${breached.map((s) => s.chainId).join(",")}`,
        });
        emailed = true;
      } catch (err) {
        console.error("[paymaster-monitor] email send failed:", err);
      }
    }
  }

  res.status(200).json({
    status: "ok",
    thresholdEth,
    thresholdWei: thresholdWei.toString(),
    chains: snapshots.map((s) => ({
      chainId: s.chainId,
      chainLabel: s.chainLabel,
      paymaster: s.paymaster,
      depositEth: s.depositEth,
      belowThreshold: s.belowThreshold,
      ...(s.error ? { error: s.error } : {}),
    })),
    breached: breached.length,
    errored: errored.length,
    emailed,
  });
}
