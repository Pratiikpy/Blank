import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Search, X, Clock, ArrowRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { useContacts } from "@/hooks/useContacts";
import { truncateAddress } from "@/lib/address";

const MAX_RESULTS_PER_CATEGORY = 5;
const DEBOUNCE_MS = 300;

const activityLabels: Record<string, string> = {
  payment: "Sent payment",
  request: "Payment request",
  request_fulfilled: "Request fulfilled",
  request_cancelled: "Request cancelled",
  group_expense: "Group expense",
  group_settle: "Debt settled",
  tip: "Creator tip",
  invoice_created: "Invoice created",
  invoice_paid: "Invoice paid",
  payroll: "Payroll sent",
  escrow_created: "Escrow created",
  escrow_released: "Escrow released",
  exchange_created: "Swap offer",
  exchange_filled: "Swap completed",
  shield: "Deposited to vault",
  unshield: "Withdrawn from vault",
  mint: "Faucet tokens",
  gift_created: "Gift sent",
  gift_claimed: "Gift opened",
  stealth_sent: "Anonymous payment",
  stealth_claim_started: "Claim started",
  stealth_claimed: "Payment claimed",
};

interface GlobalSearchProps {
  /** When true, renders as a compact icon that expands (mobile mode) */
  compact?: boolean;
}

export function GlobalSearch({ compact = false }: GlobalSearchProps) {
  const navigate = useNavigate();
  const { activities } = useActivityFeed();
  const { contacts } = useContacts();

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Filter activities
  const matchedActivities = useMemo(() => {
    if (!debouncedQuery.trim()) return [];
    const q = debouncedQuery.toLowerCase();
    return activities
      .filter(
        (a) =>
          (a.note || "").toLowerCase().includes(q) ||
          a.tx_hash.toLowerCase().includes(q) ||
          a.user_from.toLowerCase().includes(q) ||
          a.user_to.toLowerCase().includes(q),
      )
      .slice(0, MAX_RESULTS_PER_CATEGORY);
  }, [activities, debouncedQuery]);

  // Filter contacts
  const matchedContacts = useMemo(() => {
    if (!debouncedQuery.trim()) return [];
    const q = debouncedQuery.toLowerCase();
    return contacts
      .filter(
        (c) =>
          c.nickname.toLowerCase().includes(q) ||
          c.address.toLowerCase().includes(q),
      )
      .slice(0, MAX_RESULTS_PER_CATEGORY);
  }, [contacts, debouncedQuery]);

  const hasResults = matchedActivities.length > 0 || matchedContacts.length > 0;
  const showDropdown = isOpen && debouncedQuery.trim().length > 0;

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        if (compact) setIsExpanded(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [compact]);

  // Close on Escape
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setIsOpen(false);
        if (compact) setIsExpanded(false);
        inputRef.current?.blur();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [compact]);

  const handleNavigate = useCallback(
    (path: string) => {
      setIsOpen(false);
      setIsExpanded(false);
      setQuery("");
      setDebouncedQuery("");
      navigate(path);
    },
    [navigate],
  );

  const handleFocus = useCallback(() => {
    setIsOpen(true);
  }, []);

  const handleExpandToggle = useCallback(() => {
    setIsExpanded((prev) => {
      if (!prev) {
        setTimeout(() => inputRef.current?.focus(), 100);
      }
      return !prev;
    });
  }, []);

  // Compact mobile mode: search icon that expands
  if (compact && !isExpanded) {
    return (
      <button
        onClick={handleExpandToggle}
        className="w-10 h-10 rounded-full bg-white/60 backdrop-blur-xl border border-black/5 flex items-center justify-center hover:bg-white/80 transition-colors"
        aria-label="Open search"
      >
        <Search size={18} className="text-[var(--text-secondary)]" />
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Search Input */}
      <div className="relative flex items-center">
        <Search
          size={18}
          className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none"
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={handleFocus}
          placeholder="Search transactions, contacts..."
          aria-label="Global search"
          className="h-11 w-full pl-11 pr-10 rounded-full bg-gray-100 border-none outline-none text-sm transition-shadow focus:ring-2 focus:ring-emerald-500/20"
        />
        {(query || (compact && isExpanded)) && (
          <button
            onClick={() => {
              setQuery("");
              setDebouncedQuery("");
              if (compact) {
                setIsExpanded(false);
                setIsOpen(false);
              }
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-full hover:bg-black/5 transition-colors"
            aria-label="Clear search"
          >
            <X size={16} className="text-[var(--text-tertiary)]" />
          </button>
        )}
      </div>

      {/* Results Dropdown */}
      {showDropdown && (
        <div className="absolute top-full left-0 right-0 mt-2 z-50 rounded-2xl bg-white/95 backdrop-blur-2xl border border-black/5 shadow-xl overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200">
          {!hasResults ? (
            <div className="px-6 py-8 text-center">
              <Search size={24} className="mx-auto mb-2 text-gray-300" />
              <p className="text-sm text-[var(--text-secondary)]">
                No results for &quot;{debouncedQuery}&quot;
              </p>
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {/* Activities Section */}
              {matchedActivities.length > 0 && (
                <div>
                  <div className="px-4 pt-3 pb-1">
                    <p className="text-xs font-medium text-[var(--text-tertiary)] uppercase tracking-wider">
                      Transactions
                    </p>
                  </div>
                  {matchedActivities.map((activity) => (
                    <button
                      key={activity.id}
                      onClick={() => handleNavigate(`/tx/${activity.id}`)}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-black/5 transition-colors text-left"
                    >
                      <div className="w-9 h-9 rounded-xl bg-blue-50 flex items-center justify-center flex-shrink-0">
                        <Clock size={16} className="text-blue-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                          {activity.note ||
                            activityLabels[activity.activity_type] ||
                            activity.activity_type}
                        </p>
                        <p className="text-xs text-[var(--text-tertiary)] truncate">
                          {truncateAddress(activity.user_from)} →{" "}
                          {truncateAddress(activity.user_to)}
                        </p>
                      </div>
                      <ArrowRight
                        size={14}
                        className="text-[var(--text-tertiary)] flex-shrink-0"
                      />
                    </button>
                  ))}
                </div>
              )}

              {/* Contacts Section */}
              {matchedContacts.length > 0 && (
                <div>
                  <div
                    className={cn(
                      "px-4 pt-3 pb-1",
                      matchedActivities.length > 0 && "border-t border-black/5",
                    )}
                  >
                    <p className="text-xs font-medium text-[var(--text-tertiary)] uppercase tracking-wider">
                      Contacts
                    </p>
                  </div>
                  {matchedContacts.map((contact) => (
                    <button
                      key={contact.address}
                      onClick={() => handleNavigate("/app/contacts")}
                      className="w-full flex items-center gap-3 px-4 py-3 hover:bg-black/5 transition-colors text-left"
                    >
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-purple-400 to-blue-400 flex items-center justify-center flex-shrink-0">
                        <span className="text-white text-xs font-medium">
                          {contact.nickname.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                          {contact.nickname}
                        </p>
                        <p className="text-xs font-mono text-[var(--text-tertiary)] truncate">
                          {truncateAddress(contact.address)}
                        </p>
                      </div>
                      <ArrowRight
                        size={14}
                        className="text-[var(--text-tertiary)] flex-shrink-0"
                      />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default GlobalSearch;
