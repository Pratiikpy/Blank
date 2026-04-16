import { formatUnits } from "viem";

// USDC is 6-decimal on chain. `.toFixed(2)` or `toLocaleString()` without
// explicit fraction-digit options silently drops precision or commas depending
// on locale. Use these helpers everywhere a USDC amount is rendered to keep
// formatting consistent and lossless.

const LOCALE = "en-US";

/** Render a USDC string the user typed (possibly many decimals) using the
 *  app's canonical display format. Keeps up to 6 decimal places — matches
 *  on-chain precision so a display value never understates what was sent. */
export function formatUsdcInput(amount: string): string {
  const n = parseFloat(amount);
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString(LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

/** Render a raw 6-decimal bigint (wagmi/viem balance) as a comma-grouped
 *  USDC amount with up to 6 fraction digits. */
export function formatUsdcBigint(amount: bigint, decimals = 6): string {
  const asNumber = Number(formatUnits(amount, decimals));
  if (!Number.isFinite(asNumber)) return "0.00";
  return asNumber.toLocaleString(LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: decimals,
  });
}
