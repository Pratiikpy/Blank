/**
 * Phase 3.3 — Splitwise CSV import modal.
 *
 * Three-step flow:
 *
 *   1. **Upload**  — user picks the CSV exported from Splitwise's
 *                     "Export trip / group history" feature.
 *   2. **Map**     — each unique member label in the CSV needs a
 *                     0x address (or an existing Blank-resolvable
 *                     handle). Defaults to the active group's known
 *                     member addresses where the label looks plausibly
 *                     similar; otherwise the user types an address.
 *   3. **Import**  — loops over rows, calling `addExpense` for each.
 *                     Each row produces one UserOp; we surface
 *                     per-row progress and continue past failures so
 *                     a single bad row doesn't lose the rest.
 *
 * Performance note: each row = one batched `vault.approve` (cached) +
 * one `addExpense` UserOp. On testnet that's ~3-5s per row, so a 50-row
 * CSV takes ~3-4 minutes. Acceptable for a one-shot batch import; we
 * surface a clear progress bar so users don't think it's hung.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { Upload, X, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

import { parseSplitwiseCsv, type SplitwiseImportResult } from "@/lib/splitwise-csv";
import { useGroupSplit } from "@/hooks/useGroupSplit";
import { cn } from "@/lib/cn";
import toast from "react-hot-toast";

type Step = "upload" | "map" | "importing" | "done";

interface RowProgress {
  index: number;
  description: string;
  status: "pending" | "ok" | "error";
  error?: string;
}

export function SplitwiseImportModal({
  groupId,
  groupMembers,
  onClose,
  onImported,
}: {
  groupId: number;
  /** Lowercased member addresses already in this group. */
  groupMembers: string[];
  onClose: () => void;
  onImported: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>("upload");
  const [parsed, setParsed] = useState<SplitwiseImportResult | null>(null);
  const [memberMap, setMemberMap] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<RowProgress[]>([]);
  const { addExpense } = useGroupSplit();

  const handleFile = useCallback(async (file: File) => {
    if (!file) return;
    try {
      const text = await file.text();
      const result = parseSplitwiseCsv(text);
      if (result.rows.length === 0) {
        toast.error("CSV has no usable expense rows. Check the file format.");
        return;
      }
      setParsed(result);
      // Pre-fill mapping where a member label matches an existing
      // group member's last 4 chars (best-effort heuristic — users can
      // override). Empty defaults otherwise.
      const initial: Record<string, string> = {};
      for (const m of result.members) {
        const lower = m.toLowerCase();
        const match = groupMembers.find((addr) => addr.includes(lower));
        initial[m] = match ?? "";
      }
      setMemberMap(initial);
      setStep("map");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "CSV parse failed");
    }
  }, [groupMembers]);

  const allMappingsValid = useMemo(() => {
    if (!parsed) return false;
    return parsed.members.every((m) => /^0x[0-9a-fA-F]{40}$/.test(memberMap[m] ?? ""));
  }, [parsed, memberMap]);

  const startImport = useCallback(async () => {
    if (!parsed || !allMappingsValid) return;
    setStep("importing");
    const rows = parsed.rows;
    const initialProgress: RowProgress[] = rows.map((r, i) => ({
      index: i,
      description: r.description || `(row ${i + 1})`,
      status: "pending",
    }));
    setProgress(initialProgress);

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      // Map members to addresses + non-zero-share filter. Splitwise
      // sometimes emits 0-share entries for members who weren't on a
      // particular expense; we drop them so addExpense receives only
      // members who actually owe / paid.
      const members: string[] = [];
      const shares: string[] = [];
      for (const [label, share] of Object.entries(row.shares)) {
        if (share === 0) continue;
        const addr = memberMap[label];
        if (!addr) continue;
        members.push(addr.toLowerCase());
        // addExpense expects POSITIVE-only shares (owed amounts). Splitwise
        // emits negatives for the payer; absolute-value those into shares
        // so the contract sees what each member owed (the payer themselves
        // gets a 0-or-negative share, i.e. they paid more than their cut).
        // The Splitwise per-row sum is always 0, so |share| reflects each
        // member's liability for that expense.
        shares.push(Math.abs(share).toFixed(6));
      }
      if (members.length === 0) {
        setProgress((p) => p.map((rp) => rp.index === i ? { ...rp, status: "error", error: "no mapped members on this row" } : rp));
        continue;
      }
      try {
        await addExpense(groupId, row.cost.toFixed(6), members, shares, row.description || `Imported row ${i + 1}`);
        setProgress((p) => p.map((rp) => rp.index === i ? { ...rp, status: "ok" } : rp));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setProgress((p) => p.map((rp) => rp.index === i ? { ...rp, status: "error", error: msg } : rp));
        // Continue to the next row — single row failure shouldn't kill
        // the whole import. User can re-import the failures from a
        // filtered CSV later.
      }
    }
    setStep("done");
    onImported();
  }, [parsed, allMappingsValid, memberMap, addExpense, groupId, onImported]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-lg bg-white rounded-t-3xl sm:rounded-3xl p-6 sm:p-8 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-medium text-[var(--text-primary)]">Import from Splitwise</h2>
          <button onClick={onClose} className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Close">
            <X size={20} className="text-[var(--text-primary)]/50" />
          </button>
        </div>

        {step === "upload" && (
          <div>
            <p className="text-sm text-[var(--text-secondary)] mb-4 leading-snug">
              Export your Splitwise group&apos;s history as CSV
              (Settings → Export → CSV) and upload it here. We&apos;ll
              parse the rows, ask you to map each Splitwise member to a
              0x address, then re-create each expense on this Blank
              group.
            </p>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full h-32 rounded-2xl border-2 border-dashed border-black/10 hover:border-emerald-500/40 hover:bg-emerald-50/30 flex flex-col items-center justify-center gap-2 text-[var(--text-secondary)]"
            >
              <Upload size={24} />
              <span className="text-sm">Click to upload CSV</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = "";
              }}
            />
          </div>
        )}

        {step === "map" && parsed && (
          <div>
            <p className="text-sm text-[var(--text-secondary)] mb-4">
              Found <strong>{parsed.rows.length}</strong> expenses across <strong>{parsed.members.length}</strong> members. Map each member to a 0x address:
            </p>
            <div className="flex flex-col gap-3 mb-6 max-h-72 overflow-y-auto">
              {parsed.members.map((label) => {
                const value = memberMap[label] ?? "";
                const valid = /^0x[0-9a-fA-F]{40}$/.test(value);
                return (
                  <div key={label} className="flex items-center gap-3">
                    <span className="w-32 text-sm font-medium truncate" title={label}>{label}</span>
                    <input
                      type="text"
                      value={value}
                      onChange={(e) => setMemberMap((m) => ({ ...m, [label]: e.target.value }))}
                      placeholder="0x..."
                      list="splitwise-known-members"
                      className={cn(
                        "flex-1 h-11 px-3 rounded-xl border outline-none text-sm font-mono",
                        valid ? "border-emerald-200 bg-emerald-50/50" : "border-black/10",
                      )}
                    />
                  </div>
                );
              })}
              <datalist id="splitwise-known-members">
                {groupMembers.map((m) => <option key={m} value={m} />)}
              </datalist>
            </div>
            {parsed.errors.length > 0 && (
              <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 mb-4 text-xs text-amber-900">
                {parsed.errors.length} row(s) had parse errors and will be skipped.
              </div>
            )}
            <button
              onClick={() => void startImport()}
              disabled={!allMappingsValid}
              className={cn(
                "w-full h-12 rounded-2xl font-medium transition-colors",
                allMappingsValid
                  ? "bg-emerald-600 hover:bg-emerald-700 text-white"
                  : "bg-gray-200 text-gray-500 cursor-not-allowed",
              )}
            >
              Import {parsed.rows.length} expenses
            </button>
          </div>
        )}

        {(step === "importing" || step === "done") && (
          <div>
            <p className="text-sm text-[var(--text-secondary)] mb-4">
              {step === "importing" ? "Importing expenses one at a time…" : "Import complete."}
            </p>
            <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto mb-4">
              {progress.map((p) => (
                <div key={p.index} className="flex items-center gap-2 text-xs">
                  {p.status === "pending" && <Loader2 size={14} className="animate-spin text-gray-400" />}
                  {p.status === "ok" && <CheckCircle2 size={14} className="text-emerald-600" />}
                  {p.status === "error" && <AlertCircle size={14} className="text-rose-600" />}
                  <span className={cn(
                    "flex-1 truncate",
                    p.status === "error" && "text-rose-600",
                  )}>{p.description}</span>
                  {p.error && (
                    <span className="text-[10px] text-rose-500 truncate" title={p.error}>
                      {p.error.slice(0, 40)}
                    </span>
                  )}
                </div>
              ))}
            </div>
            {step === "done" && (
              <button
                onClick={onClose}
                className="w-full h-11 rounded-2xl bg-[var(--text-primary)] text-white"
              >
                Close
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
