import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePublicClient } from "wagmi";
import { BusinessHubAbi } from "@/lib/abis";
import type { EscrowRow, InvoiceRow } from "@/lib/supabase";
import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { log } from "@/lib/log";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** BusinessHub.InvoiceStatus, in declaration order. */
const INVOICE_STATUS: InvoiceRow["status"][] = [
  "pending",
  "paid",
  "cancelled",
  "payment_pending",
  "disputed",
];

/** BusinessHub.EscrowStatus, in declaration order. */
const ESCROW_STATUS: EscrowRow["status"][] = ["active", "released", "disputed", "expired"];

type InvoiceTuple = readonly [
  vendor: `0x${string}`,
  client: `0x${string}`,
  vault: `0x${string}`,
  amount: bigint,
  description: string,
  dueDate: bigint,
  status: number,
];

type EscrowTuple = readonly [
  depositor: `0x${string}`,
  beneficiary: `0x${string}`,
  arbiter: `0x${string}`,
  vault: `0x${string}`,
  amount: bigint,
  description: string,
  deadline: bigint,
  status: number,
];

function isoOrNull(seconds: bigint | undefined): string | null {
  const n = Number(seconds ?? 0n);
  return n > 0 ? new Date(n * 1000).toISOString() : null;
}

/**
 * Invoices and escrows this user is party to, read straight from BusinessHub.
 *
 * BusinessTools loads both lists from Supabase alone. That makes the indexer a
 * hard dependency of *acting* on them: a client whose invoice row had not been
 * written yet, or whose indexer was unreachable, saw "No invoices yet" and had
 * no Pay button, even though the invoice existed on chain and named them.
 * Same for a beneficiary who cannot find an escrow to mark delivered.
 *
 * getClientInvoices / getVendorInvoices / getUserEscrows have been on the
 * contract the whole time. Rows are shaped like the Supabase ones so the
 * screen merges them into its existing list instead of growing a second
 * render path. Fields the chain does not carry (emails, PDF CIDs, reminder
 * timestamps) stay null — those are genuinely indexer-only.
 */
export function useOnChainBusinessRecords() {
  const { activeChainId, contracts } = useChain();
  const { effectiveAddress, eoa } = useEffectiveAddress();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [escrows, setEscrows] = useState<EscrowRow[]>([]);
  const [tick, setTick] = useState(0);

  const hub = contracts.BusinessHub as `0x${string}` | undefined;

  const addresses = useMemo(() => {
    const set = new Set<string>();
    for (const a of [effectiveAddress, eoa]) {
      if (a && a.toLowerCase() !== ZERO_ADDRESS) set.add(a.toLowerCase());
    }
    return Array.from(set) as `0x${string}`[];
  }, [effectiveAddress, eoa]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const lastInvoices = useRef("");
  const lastEscrows = useRef("");

  useEffect(() => {
    if (!publicClient || !hub || hub === ZERO_ADDRESS || addresses.length === 0) {
      setInvoices([]);
      setEscrows([]);
      lastInvoices.current = "";
      lastEscrows.current = "";
      return;
    }
    let cancelled = false;

    type IdView = "getClientInvoices" | "getVendorInvoices" | "getUserEscrows";
    type DetailView = "getInvoice" | "getEscrow";

    const readIds = async (functionName: IdView) => {
      const settled = await Promise.allSettled(
        addresses.map((addr) =>
          publicClient.readContract({
            address: hub,
            abi: BusinessHubAbi,
            functionName,
            args: [addr],
          }),
        ),
      );
      if (settled.every((r) => r.status === "rejected")) {
        const first = settled[0];
        throw first && first.status === "rejected"
          ? first.reason
          : new Error(`${functionName} failed for every address`);
      }
      const ids = new Set<number>();
      for (const r of settled) {
        if (r.status !== "fulfilled") continue;
        for (const id of r.value as readonly bigint[]) ids.add(Number(id));
      }
      return Array.from(ids);
    };

    const readEach = async <T,>(functionName: DetailView, ids: number[]) => {
      const settled = await Promise.allSettled(
        ids.map((id) =>
          publicClient.readContract({
            address: hub,
            abi: BusinessHubAbi,
            functionName,
            args: [BigInt(id)],
          }),
        ),
      );
      const out: { id: number; value: T }[] = [];
      settled.forEach((r, i) => {
        if (r.status === "fulfilled") out.push({ id: ids[i], value: r.value as T });
      });
      return out;
    };

    (async () => {
      try {
        const [invoiceIds, escrowIds] = await Promise.all([
          readIds("getClientInvoices").then(async (client) => {
            const vendor = await readIds("getVendorInvoices").catch(() => [] as number[]);
            return Array.from(new Set([...client, ...vendor]));
          }),
          readIds("getUserEscrows"),
        ]);

        const [invoiceDetails, escrowDetails] = await Promise.all([
          readEach<InvoiceTuple>("getInvoice", invoiceIds),
          readEach<EscrowTuple>("getEscrow", escrowIds),
        ]);
        if (cancelled) return;

        const nextInvoices: InvoiceRow[] = invoiceDetails.map(({ id, value }) => ({
          id: `onchain-invoice-${activeChainId}-${id}`,
          invoice_id: id,
          vendor_address: value[0].toLowerCase(),
          client_address: value[1].toLowerCase(),
          description: value[4] || "Invoice",
          due_date: isoOrNull(value[5]),
          status: INVOICE_STATUS[value[6]] ?? "pending",
          tx_hash: `onchain-invoice-${id}`,
          chain_id: activeChainId,
          pdf_cid: null,
          client_email: null,
          vendor_email: null,
          last_reminder_at: null,
          // getInvoice does not return the struct's createdAt, and the screen
          // renders "No date" for an empty string. Better than dating every
          // chain-sourced invoice to the epoch.
          created_at: "",
          updated_at: "",
        }));

        const nextEscrows: EscrowRow[] = escrowDetails.map(({ id, value }) => ({
          id: `onchain-escrow-${activeChainId}-${id}`,
          escrow_id: id,
          depositor_address: value[0].toLowerCase(),
          beneficiary_address: value[1].toLowerCase(),
          arbiter_address: value[2].toLowerCase(),
          description: value[5] || "Escrow",
          deadline: isoOrNull(value[6]),
          status: ESCROW_STATUS[value[7]] ?? "active",
          tx_hash: `onchain-escrow-${id}`,
          chain_id: activeChainId,
          attachment_cid: null,
          created_at: "",
          updated_at: "",
        }));

        nextInvoices.sort((a, b) => b.invoice_id - a.invoice_id);
        nextEscrows.sort((a, b) => b.escrow_id - a.escrow_id);

        const invoicesJson = JSON.stringify(nextInvoices);
        if (invoicesJson !== lastInvoices.current) {
          lastInvoices.current = invoicesJson;
          setInvoices(nextInvoices);
        }
        const escrowsJson = JSON.stringify(nextEscrows);
        if (escrowsJson !== lastEscrows.current) {
          lastEscrows.current = escrowsJson;
          setEscrows(nextEscrows);
        }
      } catch (err) {
        // Not fatal: the Supabase-backed lists still render.
        log.warn(
          "useOnChainBusinessRecords.readFailed",
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [publicClient, hub, addresses, activeChainId, tick]);

  return { invoices, escrows, refresh };
}
