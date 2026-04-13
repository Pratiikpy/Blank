import { useState, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Search, ChevronRight, User, ClipboardPaste, Send } from "lucide-react";
import toast from "react-hot-toast";
import { isAddress, zeroAddress } from "viem";
import { cn } from "@/lib/cn";
import { useContacts } from "@/hooks/useContacts";

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

  const handleSelectContact = (address: string, nickname: string) => {
    navigate("/app/send/amount", { state: { recipient: address, nickname } });
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1
            className="text-4xl sm:text-5xl font-medium tracking-tight text-[var(--text-primary)] mb-2"
            style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
          >
            Send Money
          </h1>
          <p className="text-base text-[var(--text-secondary)] leading-relaxed">
            Transfer money privately with encrypted amounts
          </p>
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
                  {recentContacts.map((contact) => (
                    <button
                      key={contact.address}
                      className="flex flex-col items-center gap-1.5 min-w-[64px] shrink-0"
                      onClick={() =>
                        handleSelectContact(contact.address, contact.nickname)
                      }
                    >
                      <div
                        className={cn(
                          "w-14 h-14 rounded-full flex items-center justify-center text-lg font-semibold",
                          avatarColor(contact.address),
                        )}
                      >
                        {contact.nickname.charAt(0).toUpperCase()}
                      </div>
                      <span className="text-xs font-medium text-[var(--text-secondary)] truncate max-w-[64px]">
                        {contact.nickname}
                      </span>
                    </button>
                  ))}
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
                </div>
              ) : (
                <div className="space-y-3">
                  {filtered.map((contact) => (
                    <button
                      key={contact.address}
                      className="w-full flex items-center justify-between p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10 hover:bg-white/70 dark:hover:bg-white/10 transition-all text-left"
                      onClick={() =>
                        handleSelectContact(contact.address, contact.nickname)
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
                      <ChevronRight
                        size={18}
                        className="text-[var(--text-muted)] shrink-0"
                      />
                    </button>
                  ))}
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
                  Wallet Address
                </label>
                <div className="relative">
                  <input
                    id="direct-address-input"
                    type="text"
                    placeholder="0x..."
                    aria-label="Wallet address"
                    className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 outline-none transition-all placeholder:text-[var(--text-tertiary)] font-mono text-sm"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const input = (e.target as HTMLInputElement).value.trim();
                        if (isAddress(input) && input !== zeroAddress) {
                          handleSelectContact(input, truncateAddress(input));
                        } else if (input.length > 0) {
                          toast.error("Invalid Ethereum address");
                        }
                      }
                    }}
                  />
                </div>
              </div>

              {/* Continue button */}
              <button
                onClick={() => {
                  const el = document.getElementById("direct-address-input") as HTMLInputElement | null;
                  const input = el?.value?.trim() || "";
                  if (!input) {
                    toast.error("Enter a wallet address");
                    return;
                  }
                  if (!isAddress(input) || input === zeroAddress) {
                    toast.error("Invalid Ethereum address");
                    return;
                  }
                  handleSelectContact(input, truncateAddress(input));
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
    </div>
  );
}
