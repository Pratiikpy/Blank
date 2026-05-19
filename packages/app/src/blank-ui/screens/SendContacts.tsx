import { useState, useMemo, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Search, ChevronRight, User, ClipboardPaste, Send, Loader2, Users, X, Check } from "lucide-react";
import toast from "react-hot-toast";
import { isAddress, zeroAddress } from "viem";
import { cn } from "@/lib/cn";
import { useContacts } from "@/hooks/useContacts";
import { useResolveName } from "@/hooks/useAddressResolver";
import { looksLikeEnsName, resolveName } from "@/lib/address-resolver";
import { useSendPayment, MAX_BATCH_RECIPIENTS } from "@/hooks/useSendPayment";

import { truncateAddress } from "@/lib/address";

/** Generate a deterministic pastel background from an address string. */
function avatarColor(addr: string): string {
  const colors = [
    "bg-indigo-100 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-400",
    "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400",
    "bg-amber-100 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400",
    "bg-rose-100 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400",
    "bg-cyan-100 text-cyan-600 dark:bg-cyan-500/20 dark:text-cyan-400",
    "bg-violet-100 text-violet-600 dark:bg-violet-500/20 dark:text-violet-400",
    "bg-orange-100 text-orange-600 dark:bg-orange-500/20 dark:text-orange-400",
    "bg-teal-100 text-teal-600 dark:bg-teal-500/20 dark:text-teal-400",
  ];
  const hash = addr
    .toLowerCase()
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
}

export default function SendContacts() {
  const navigate = useNavigate();
  const { contacts, isLoading } = useContacts();
  const [search, setSearch] = useState("");

  // Phase 8.2 — Single|Many toggle. The "many" mode flips the contact list
  // to multi-select with a bottom dock and routes to /app/send/amount with
  // mode=many already wired in the shared useSendPayment singleton state.
  const {
    mode,
    recipients,
    setMode,
    setRecipients,
    setRecipient,
    reset: resetSend,
  } = useSendPayment();
  // Local selection set so toggling in the UI is instant — synced down to
  // the shared useSendPayment state on Continue. Hydrate from shared state
  // on mount so a back-navigation from SendAmount preserves picks.
  const [selectedSet, setSelectedSet] = useState<Set<string>>(
    () => new Set(recipients.map((r) => r.toLowerCase())),
  );
  // Re-hydrate when the shared `recipients` array changes from outside this
  // screen (e.g. SendAmount calls reset() on success).
  useEffect(() => {
    setSelectedSet(new Set(recipients.map((r) => r.toLowerCase())));
  }, [recipients]);

  const filtered = useMemo(() => {
    if (!search.trim()) return contacts;
    const q = search.toLowerCase();
    return contacts.filter(
      (c) =>
        c.nickname.toLowerCase().includes(q) ||
        c.address.toLowerCase().includes(q),
    );
  }, [contacts, search]);

  const recentContacts = contacts.slice(0, 8);
  const [showScanInfo, setShowScanInfo] = useState(false);
  const dismissScanInfo = useCallback(() => setShowScanInfo(false), []);

  // Single-mode handler: existing behaviour — pick one, navigate forward.
  // We also write through to the shared singleton via setRecipient so the
  // amount screen's existing `setRecipient(target)` call is now a no-op
  // re-confirm rather than the only source of truth.
  const handleSelectContact = (address: string, nickname: string) => {
    setMode("single");
    setRecipient(address);
    navigate("/app/send/amount", { state: { recipient: address, nickname } });
  };

  // Multi-mode handler: toggle in/out of the set. Capped at
  // MAX_BATCH_RECIPIENTS (== contract MAX_PAYROLL_SIZE).
  const toggleRecipient = useCallback(
    (address: string) => {
      const lower = address.toLowerCase();
      setSelectedSet((prev) => {
        const next = new Set(prev);
        if (next.has(lower)) {
          next.delete(lower);
        } else {
          if (next.size >= MAX_BATCH_RECIPIENTS) {
            toast.error(`Max ${MAX_BATCH_RECIPIENTS} recipients per batch`);
            return prev;
          }
          next.add(lower);
        }
        return next;
      });
    },
    [],
  );

  const continueBatch = useCallback(() => {
    if (selectedSet.size === 0) return;
    // Pre-validate every selected address. The set is built from the
    // contacts list (already addresses) plus any direct-input added below;
    // belt-and-braces is cheap and the contract revert message is opaque.
    const list = Array.from(selectedSet);
    const bad = list.find((a) => !isAddress(a) || a === zeroAddress);
    if (bad) {
      toast.error(`Invalid address in selection: ${truncateAddress(bad)}`);
      return;
    }
    setMode("many");
    setRecipients(list);
    navigate("/app/send/amount", { state: { mode: "many" } });
  }, [selectedSet, navigate, setMode, setRecipients]);

  const clearAll = useCallback(() => {
    setSelectedSet(new Set());
    setRecipients([]);
    resetSend();
  }, [setRecipients, resetSend]);

  // Background ENS / Basenames resolution for whatever the user is typing in
  // the contact search box. The hook is no-op when the input isn't name-shaped.
  const ensResolve = useResolveName(search);

  // Shared continue path used by both the right-column "Continue" button and
  // its Enter-key handler. Accepts a 0x… address OR an ENS / Basenames name
  // (e.g. `pratik.eth`, `pratik.base.eth`).
  // In many-mode the resolved address is added to the multi-select set
  // instead of immediately advancing to the amount screen — letting the
  // user mix contact-list picks with typed-in addresses inside one batch.
  const submitDirectInput = useCallback(
    async (raw: string) => {
      const input = raw.trim();
      if (!input) {
        toast.error("Enter a wallet address or ENS name");
        return;
      }
      const advance = (addr: string, nickname: string) => {
        if (mode === "many") {
          toggleRecipient(addr);
          // Clear the input so the user can immediately type the next one.
          const el = document.getElementById("direct-address-input") as HTMLInputElement | null;
          if (el) el.value = "";
          toast.success(`Added ${nickname || truncateAddress(addr)}`);
        } else {
          handleSelectContact(addr, nickname || truncateAddress(addr));
        }
      };
      if (isAddress(input) && input !== zeroAddress) {
        advance(input, truncateAddress(input));
        return;
      }
      if (looksLikeEnsName(input)) {
        const id = toast.loading(`Resolving ${input}…`);
        const addr = await resolveName(input);
        toast.dismiss(id);
        if (addr && isAddress(addr) && addr !== zeroAddress) {
          advance(addr, input);
          return;
        }
        toast.error(addr ? `${input} resolves to an invalid address` : `Couldn't resolve ${input}`);
        return;
      }
      toast.error("Invalid address or ENS name");
    },
    [navigate, mode, toggleRecipient],
  );

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1
              className="text-4xl sm:text-5xl font-medium tracking-tight text-[var(--text-primary)] mb-2"
              style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
            >
              Send Money
            </h1>
            <p className="text-base text-[var(--text-secondary)] leading-relaxed">
              {mode === "many"
                ? `Pick up to ${MAX_BATCH_RECIPIENTS} recipients. One batched, encrypted tx.`
                : "Transfer money privately with encrypted amounts"}
            </p>
          </div>
          {/* Single | Many segmented toggle */}
          <div
            role="tablist"
            aria-label="Send mode"
            className="inline-flex p-1 rounded-2xl bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10"
          >
            <button
              role="tab"
              aria-selected={mode === "single"}
              data-testid="send-mode-single"
              onClick={() => setMode("single")}
              className={cn(
                "h-10 px-4 rounded-xl text-sm font-medium transition-all flex items-center gap-2",
                mode === "single"
                  ? "bg-white dark:bg-white/10 text-[var(--text-primary)] shadow-sm"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              <User size={16} />
              <span>One</span>
            </button>
            <button
              role="tab"
              aria-selected={mode === "many"}
              data-testid="send-mode-many"
              onClick={() => setMode("many")}
              className={cn(
                "h-10 px-4 rounded-xl text-sm font-medium transition-all flex items-center gap-2",
                mode === "many"
                  ? "bg-white dark:bg-white/10 text-[var(--text-primary)] shadow-sm"
                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              <Users size={16} />
              <span>Many</span>
              {mode === "many" && selectedSet.size > 0 && (
                <span className="ml-1 px-1.5 py-0.5 rounded-md bg-emerald-500 text-white text-[10px] font-bold">
                  {selectedSet.size}
                </span>
              )}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Search & Contact Selection */}
          <div className="rounded-[2rem] glass-card-static p-8">
            <h3
              className="text-xl font-medium text-[var(--text-primary)] mb-6"
              style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
            >
              Choose Recipient
            </h3>

            {/* Search input */}
            <div className="mb-6">
              <div className="relative">
                <Search
                  size={20}
                  className="absolute left-5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]"
                />
                <input
                  type="text"
                  className="h-14 w-full pl-12 pr-5 rounded-2xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 outline-none transition-all placeholder:text-[var(--text-tertiary)]"
                  placeholder="Name or address"
                  aria-label="Search contacts"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>

            {/* Recent contacts horizontal scroll */}
            {recentContacts.length > 0 && !search && (
              <div className="mb-6">
                <p className="text-xs font-semibold tracking-widest uppercase text-[var(--text-secondary)] mb-3">
                  Recent
                </p>
                <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-none">
                  {recentContacts.map((contact) => {
                    const isSelected = selectedSet.has(contact.address.toLowerCase());
                    return (
                      <button
                        key={contact.address}
                        className="flex flex-col items-center gap-1.5 min-w-[64px] shrink-0 relative"
                        onClick={() =>
                          mode === "many"
                            ? toggleRecipient(contact.address)
                            : handleSelectContact(contact.address, contact.nickname)
                        }
                      >
                        <div
                          className={cn(
                            "w-14 h-14 rounded-full flex items-center justify-center text-lg font-semibold transition-all",
                            avatarColor(contact.address),
                            mode === "many" && isSelected && "ring-4 ring-emerald-500 ring-offset-2 ring-offset-transparent",
                          )}
                        >
                          {contact.nickname.charAt(0).toUpperCase()}
                        </div>
                        {mode === "many" && isSelected && (
                          <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow-sm">
                            <Check size={12} strokeWidth={3} />
                          </div>
                        )}
                        <span className="text-xs font-medium text-[var(--text-secondary)] truncate max-w-[64px]">
                          {contact.nickname}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Full contact list */}
            <div>
              <p className="text-xs font-semibold tracking-widest uppercase text-[var(--text-secondary)] mb-3">
                {search ? "Results" : "All Contacts"}
              </p>

              {isLoading ? (
                <div className="space-y-3">
                  {[0, 1, 2, 3].map((i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10"
                    >
                      <div className="shimmer w-12 h-12 rounded-full" />
                      <div className="flex-1 space-y-2">
                        <div className="shimmer h-4 w-28 rounded" />
                        <div className="shimmer h-3 w-36 rounded" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : filtered.length === 0 ? (
                <div className="text-center py-12">
                  <User
                    size={40}
                    className="mx-auto text-[var(--text-muted)] mb-3"
                  />
                  <p className="text-[var(--text-tertiary)]">
                    {search
                      ? "No contacts found"
                      : "No contacts yet. Add one to get started."}
                  </p>
                  {search && isAddress(search) && search !== zeroAddress && (
                    <button
                      onClick={() =>
                        handleSelectContact(search, truncateAddress(search))
                      }
                      className="mt-4 text-emerald-600 dark:text-emerald-400 hover:underline font-medium"
                    >
                      Send to {truncateAddress(search)}
                    </button>
                  )}
                  {search && looksLikeEnsName(search) && ensResolve.isFetching && (
                    <div className="mt-4 inline-flex items-center gap-2 text-[var(--text-tertiary)]">
                      <Loader2 size={14} className="animate-spin" />
                      <span className="text-sm">Resolving {search.trim()}…</span>
                    </div>
                  )}
                  {search &&
                    looksLikeEnsName(search) &&
                    !ensResolve.isFetching &&
                    ensResolve.data && (
                      <button
                        onClick={() =>
                          handleSelectContact(ensResolve.data!, search.trim())
                        }
                        className="mt-4 text-emerald-600 dark:text-emerald-400 hover:underline font-medium"
                      >
                        Send to {search.trim()} ({truncateAddress(ensResolve.data)})
                      </button>
                    )}
                  {search &&
                    looksLikeEnsName(search) &&
                    !ensResolve.isFetching &&
                    ensResolve.isFetched &&
                    !ensResolve.data && (
                      <p className="mt-4 text-sm text-rose-600 dark:text-rose-400">
                        Couldn't resolve {search.trim()}
                      </p>
                    )}
                </div>
              ) : (
                <div className="space-y-3">
                  {filtered.map((contact) => {
                    const isSelected = selectedSet.has(contact.address.toLowerCase());
                    return (
                      <button
                        key={contact.address}
                        aria-pressed={mode === "many" ? isSelected : undefined}
                        className={cn(
                          "w-full flex items-center justify-between p-4 rounded-2xl border transition-all text-left",
                          mode === "many" && isSelected
                            ? "bg-emerald-50 dark:bg-emerald-500/10 border-emerald-300 dark:border-emerald-500/30 hover:bg-emerald-100 dark:hover:bg-emerald-500/20"
                            : "bg-white/50 dark:bg-white/5 border-black/5 dark:border-white/10 hover:bg-white/70 dark:hover:bg-white/10",
                        )}
                        onClick={() =>
                          mode === "many"
                            ? toggleRecipient(contact.address)
                            : handleSelectContact(contact.address, contact.nickname)
                        }
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={cn(
                              "w-12 h-12 rounded-full flex items-center justify-center text-base font-semibold shrink-0",
                              avatarColor(contact.address),
                            )}
                          >
                            {contact.nickname.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p className="font-medium text-[var(--text-primary)]">
                              {contact.nickname}
                            </p>
                            <p className="text-sm text-[var(--text-secondary)] font-mono">
                              {truncateAddress(contact.address)}
                            </p>
                          </div>
                        </div>
                        {mode === "many" ? (
                          <div
                            className={cn(
                              "w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-all",
                              isSelected
                                ? "bg-emerald-500 text-white"
                                : "border-2 border-gray-300 dark:border-white/20",
                            )}
                          >
                            {isSelected && <Check size={14} strokeWidth={3} />}
                          </div>
                        ) : (
                          <ChevronRight
                            size={18}
                            className="text-[var(--text-muted)] shrink-0"
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right column: Scan QR / Direct Address */}
          <div className="rounded-[2rem] glass-card-static p-8">
            <h3
              className="text-xl font-medium text-[var(--text-primary)] mb-6"
              style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
            >
              Other Options
            </h3>

            <div className="space-y-4">
              {/* Direct address input */}
              <div>
                <label className="text-xs font-semibold tracking-widest uppercase text-[var(--text-secondary)] mb-2 block">
                  Wallet Address or ENS
                </label>
                <div className="relative">
                  <input
                    id="direct-address-input"
                    type="text"
                    placeholder="0x… or pratik.eth"
                    aria-label="Wallet address or ENS name"
                    className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 outline-none transition-all placeholder:text-[var(--text-tertiary)] font-mono text-sm"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        void submitDirectInput((e.target as HTMLInputElement).value);
                      }
                    }}
                  />
                </div>
              </div>

              {/* Continue button */}
              <button
                onClick={() => {
                  const el = document.getElementById("direct-address-input") as HTMLInputElement | null;
                  void submitDirectInput(el?.value ?? "");
                }}
                className="w-full h-14 px-6 rounded-2xl bg-[#1D1D1F] text-white font-medium transition-all active:scale-95 hover:bg-[#2D2D2F] flex items-center justify-center gap-2"
              >
                <Send size={18} />
                <span>Continue</span>
              </button>

              {/* Paste from clipboard */}
              <button
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    const el = document.getElementById("direct-address-input") as HTMLInputElement | null;
                    if (el) {
                      el.value = text.trim();
                      el.focus();
                    }
                    if (isAddress(text.trim()) && text.trim() !== zeroAddress) {
                      handleSelectContact(text.trim(), truncateAddress(text.trim()));
                    }
                  } catch {
                    toast.error("Could not read clipboard");
                  }
                }}
                className="w-full h-14 px-6 rounded-2xl bg-black/5 dark:bg-white/10 text-[var(--text-primary)] font-medium transition-all active:scale-95 hover:bg-black/10 dark:hover:bg-white/20 flex items-center justify-center gap-2"
                aria-label="Paste address from clipboard"
              >
                <ClipboardPaste size={20} strokeWidth={2.2} />
                <span>Paste from Clipboard</span>
              </button>
              {showScanInfo && (
                <div className="mt-3 p-4 rounded-2xl bg-blue-50 dark:bg-blue-500/10 border border-blue-100 dark:border-blue-500/20">
                  <p className="text-sm text-blue-700 dark:text-blue-300">
                    Paste a wallet address above or use a QR scanner app to copy the address.
                  </p>
                  <button
                    onClick={dismissScanInfo}
                    className="text-xs text-blue-500 mt-2 hover:underline"
                    aria-label="Dismiss"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* Encryption info */}
              <div className="p-4 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-100 dark:border-emerald-500/20 flex items-start gap-3">
                <div className="w-5 h-5 mt-0.5 shrink-0">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    className="text-emerald-600 dark:text-emerald-400"
                    stroke="currentColor"
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-medium text-emerald-900 dark:text-emerald-300">
                    Amount will be encrypted
                  </p>
                  <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-1">
                    Only you and recipient can see the value
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Phase 8.2 — bottom dock surfaces in many-mode only. Sticky to the
          viewport bottom so the user can scroll the contact list freely
          without losing their selection summary or the Continue CTA. */}
      {mode === "many" && selectedSet.size > 0 && (
        <div
          data-testid="batch-send-dock"
          className="fixed bottom-4 inset-x-4 sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 sm:bottom-6 max-w-2xl sm:w-full z-40"
        >
          <div className="rounded-[1.75rem] bg-[#1D1D1F] dark:bg-white/10 backdrop-blur-md border border-white/10 shadow-2xl p-3 flex items-center gap-3">
            <div className="flex-1 min-w-0 pl-2">
              <p className="text-sm font-semibold text-white">
                {selectedSet.size} recipient{selectedSet.size === 1 ? "" : "s"}
              </p>
              <p className="text-xs text-white/60 truncate">
                {Array.from(selectedSet)
                  .slice(0, 3)
                  .map((a) => truncateAddress(a))
                  .join(", ")}
                {selectedSet.size > 3 && ` +${selectedSet.size - 3} more`}
              </p>
            </div>
            <button
              onClick={clearAll}
              aria-label="Clear all selected recipients"
              className="h-10 w-10 rounded-xl bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-all shrink-0"
            >
              <X size={18} />
            </button>
            <button
              onClick={continueBatch}
              data-testid="batch-send-continue"
              className="h-10 px-5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-medium transition-all flex items-center gap-2 shrink-0"
            >
              <span>Continue</span>
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
