/**
 * /api/cron/relayer-refill — every 6h auto-refill of the relayer EOA
 *
 * Mirrors cron-paymaster-refill.ts but for the relayer hot wallet
 * (the EOA that signs UserOp submission via /api/relay). When its
 * balance dips below RELAYER_REFILL_THRESHOLD_WEI (default 0.05 ETH),
 * tops up by RELAYER_REFILL_AMOUNT_WEI (default 0.05 ETH) from the
 * dedicated RELAYER_TOPUP_PRIVATE_KEY signer.
 *
 * Key custody: separate hot key from RELAYER_PRIVATE_KEY itself.
 * Operator funds it with at most ~0.5 ETH at a time. If leaked,
 * attacker drains the float, neither relayer nor deployer touched.
 *
 * Daily rate cap: RELAYER_REFILL_DAILY_CAP_WEI (default 0.5 ETH per
 * chain per UTC day) tracked in the same paymaster_refills Supabase
 * table with kind='relayer'.
 */

import { ethers } from "ethers";
import {
  RPC_URLS,
  ETH_SEPOLIA_ID,
  BASE_SEPOLIA_ID,
  ARB_SEPOLIA_ID,
} from "../addresses.js";
import { sendEmail, emailEnabled } from "../resend.js";
import { getSupabaseAdmin } from "../supabase-admin.js";
import { getSigner } from "../signer.js";

// Defaults sized for testnet relayer (much lower burn than paymaster).
const DEFAULT_REFILL_THRESHOLD_WEI = 50_000_000_000_000_000n;   // 0.05 ETH
const DEFAULT_REFILL_AMOUNT_WEI    = 50_000_000_000_000_000n;   // 0.05 ETH
const DEFAULT_REFILL_DAILY_CAP_WEI = 500_000_000_000_000_000n;  // 0.5 ETH

const CHAIN_LABEL: Record<number, string> = {
  [ETH_SEPOLIA_ID]: "Ethereum Sepolia",
  [BASE_SEPOLIA_ID]: "Base Sepolia",
  [ARB_SEPOLIA_ID]: "Arbitrum Sepolia",
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
  relayer: string;
  preBalanceEth: string;
  postBalanceEth?: string;
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
    .eq("kind", "relayer");
  if (error || !data) return 0n;
  let total = 0n;
  for (const row of data) {
    try { total += BigInt(row.amount_wei); } catch {}
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
    kind: "relayer",
  });
}

async function refillChain(
  chainId: number,
  relayerAddress: string,
  topupSigner: ethers.Wallet,
  thresholdWei: bigint,
  refillAmountWei: bigint,
  dailyCapWei: bigint,
  utcDay: string,
  supabase: ReturnType<typeof getSupabaseAdmin>,
): Promise<RefillSnapshot> {
  const chainLabel = CHAIN_LABEL[chainId] ?? `chain-${chainId}`;
  const rpcUrl = RPC_URLS[chainId];
  if (!rpcUrl) {
    return {
      chainId,
      chainLabel,
      relayer: relayerAddress,
      preBalanceEth: "0",
      action: "error",
      error: "no RPC URL configured",
    };
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const balance = await provider.getBalance(relayerAddress);
    const preBalanceEth = ethers.formatEther(balance);

    if (balance >= thresholdWei) {
      return {
        chainId,
        chainLabel,
        relayer: relayerAddress,
        preBalanceEth,
        action: "ok",
      };
    }

    const refilledTodayWei = await readRefilledTodayWei(supabase, chainId, utcDay);
    if (refilledTodayWei + refillAmountWei > dailyCapWei) {
      return {
        chainId,
        chainLabel,
        relayer: relayerAddress,
        preBalanceEth,
        action: "capped",
        todaysTotalEth: ethers.formatEther(refilledTodayWei),
        error: `daily cap ${ethers.formatEther(dailyCapWei)} ETH reached`,
      };
    }

    const connectedSigner = topupSigner.connect(provider);
    const signerBalance = await provider.getBalance(connectedSigner.address);
    const gasReserve = 10_000_000_000_000_000n; // 0.01 ETH for gas
    if (signerBalance < refillAmountWei + gasReserve) {
      return {
        chainId,
        chainLabel,
        relayer: relayerAddress,
        preBalanceEth,
        action: "error",
        error: `topup signer balance ${ethers.formatEther(signerBalance)} ETH below refill+gas`,
      };
    }

    // Plain ETH send to the relayer EOA.
    const tx = await connectedSigner.sendTransaction({
      to: relayerAddress,
      value: refillAmountWei,
    });
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      return {
        chainId,
        chainLabel,
        relayer: relayerAddress,
        preBalanceEth,
        action: "error",
        txHash: tx.hash,
        error: "refill tx reverted",
      };
    }

    await recordRefill(supabase, chainId, utcDay, refillAmountWei, tx.hash);

    const postBalance = await provider.getBalance(relayerAddress);
    return {
      chainId,
      chainLabel,
      relayer: relayerAddress,
      preBalanceEth,
      postBalanceEth: ethers.formatEther(postBalance),
      refilledEth: ethers.formatEther(refillAmountWei),
      todaysTotalEth: ethers.formatEther(refilledTodayWei + refillAmountWei),
      action: "refilled",
      txHash: tx.hash,
    };
  } catch (err) {
    return {
      chainId,
      chainLabel,
      relayer: relayerAddress,
      preBalanceEth: "0",
      action: "error",
      error: err instanceof Error ? err.message.slice(0, 280) : String(err).slice(0, 280),
    };
  }
}

export default async function handler(req: any, res: any) {
  const expected = process.env.CRON_SECRET;
  const provided = req.headers["authorization"];
  if (!expected || provided !== `Bearer ${expected}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const topupKey = process.env.RELAYER_TOPUP_PRIVATE_KEY?.trim();
  if (!topupKey || !/^0x[0-9a-fA-F]{64}$/.test(topupKey)) {
    res.status(503).json({
      status: "skipped",
      reason: "RELAYER_TOPUP_PRIVATE_KEY missing or malformed",
    });
    return;
  }

  let relayerAddress: string;
  try {
    relayerAddress = await getSigner("relayer").getAddress();
  } catch (err) {
    res.status(503).json({
      status: "skipped",
      reason: `relayer signer unavailable: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const thresholdWei = readBigEnv("RELAYER_REFILL_THRESHOLD_WEI", DEFAULT_REFILL_THRESHOLD_WEI);
  const refillAmountWei = readBigEnv("RELAYER_REFILL_AMOUNT_WEI", DEFAULT_REFILL_AMOUNT_WEI);
  const dailyCapWei = readBigEnv("RELAYER_REFILL_DAILY_CAP_WEI", DEFAULT_REFILL_DAILY_CAP_WEI);

  const topupSigner = new ethers.Wallet(topupKey);
  const supabase = getSupabaseAdmin();
  const utcDay = new Date().toISOString().slice(0, 10);

  const chainIds = [ETH_SEPOLIA_ID, BASE_SEPOLIA_ID, ARB_SEPOLIA_ID];
  const snapshots = await Promise.all(
    chainIds.map((id) =>
      refillChain(id, relayerAddress, topupSigner, thresholdWei, refillAmountWei, dailyCapWei, utcDay, supabase),
    ),
  );

  const refilled = snapshots.filter((s) => s.action === "refilled");
  const capped = snapshots.filter((s) => s.action === "capped");
  const errored = snapshots.filter((s) => s.action === "error");

  if ((refilled.length || capped.length || errored.length) && emailEnabled()) {
    const recipient = process.env.PAYMASTER_ALERT_EMAIL_TO?.trim();
    if (recipient) {
      try {
        const reason =
          errored.length > 0 ? "error" : capped.length > 0 ? "capped" : "refilled";
        const subject = `[Blank] Relayer refill ${reason} on ${snapshots.length} chain(s)`;
        const text = snapshots
          .map((s) => `${s.chainLabel.padEnd(20)}  pre=${s.preBalanceEth.padStart(8)} ETH  post=${(s.postBalanceEth ?? "—").padStart(8)} ETH  ${s.action}${s.error ? "  " + s.error : ""}`)
          .join("\n");
        await sendEmail({
          to: recipient,
          subject,
          html: `<pre>${text}</pre>`,
          text,
          idempotencyKey: `relayer-refill:${utcDay}:${reason}:${snapshots.map((s) => s.chainId + ":" + s.action).join(",")}`,
        });
      } catch (err) {
        console.error("[relayer-refill] email send failed:", err);
      }
    }
  }

  res.status(200).json({
    status: "ok",
    utcDay,
    thresholdEth: ethers.formatEther(thresholdWei),
    refillAmountEth: ethers.formatEther(refillAmountWei),
    dailyCapEth: ethers.formatEther(dailyCapWei),
    relayer: relayerAddress,
    topupSigner: topupSigner.address,
    chains: snapshots,
    refilled: refilled.length,
    capped: capped.length,
    errored: errored.length,
  });
}
