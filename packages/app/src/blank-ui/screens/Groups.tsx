import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Users,
  X,
  RefreshCw,
  Receipt,
  Handshake,
  Vote,
  LogOut,
  Archive,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useGroupSplit } from "@/hooks/useGroupSplit";
import { useAccount } from "wagmi";
import {
  fetchUserGroups,
  fetchGroupExpenses,
  type GroupMembershipRow,
  type GroupExpenseRow,
} from "@/lib/supabase";
import toast from "react-hot-toast";

// ---------------------------------------------------------------
//  STATUS HELPERS
// ---------------------------------------------------------------

type GroupStatus = "active" | "completed";

const getStatusColor = (status: GroupStatus) => {
  switch (status) {
    case "active":
      return "bg-blue-50 text-blue-700 border-blue-100";
    case "completed":
      return "bg-emerald-50 text-emerald-700 border-emerald-100";
    default:
      return "bg-gray-50 text-gray-700 border-gray-100";
  }
};

/** Generate a deterministic avatar color from an address. */
function addressToColor(addr: string): string {
  const colors = ["#818CF8", "#F472B6", "#34D399", "#FB923C", "#60A5FA", "#A78BFA", "#F87171", "#FBBF24"];
  let hash = 0;
  for (let i = 0; i < addr.length; i++) {
    hash = addr.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

// ---------------------------------------------------------------
//  SHIMMER PLACEHOLDER
// ---------------------------------------------------------------

function GroupCardShimmer() {
  return (
    <div className="rounded-[2rem] glass-card p-8 animate-pulse">
      <div className="flex items-start justify-between mb-6">
        <div className="flex-1">
          <div className="h-6 w-40 bg-black/10 rounded-lg mb-2" />
          <div className="h-4 w-24 bg-black/5 rounded-lg" />
        </div>
        <div className="h-6 w-16 bg-black/5 rounded-full" />
      </div>
      <div className="flex -space-x-3 mb-6">
        {[1, 2, 3].map((i) => (
          <div key={i} className="w-10 h-10 rounded-full bg-black/10 border-2 border-white" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="p-4 rounded-2xl bg-white/50 border border-black/5">
          <div className="h-3 w-12 bg-black/5 rounded mb-2" />
          <div className="h-5 w-20 bg-black/10 rounded" />
        </div>
        <div className="p-4 rounded-2xl bg-white/50 border border-black/5">
          <div className="h-3 w-16 bg-black/5 rounded mb-2" />
          <div className="h-5 w-16 bg-black/10 rounded" />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
//  CREATE GROUP MODAL
// ---------------------------------------------------------------

function CreateGroupModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { createGroup, isProcessing } = useGroupSplit();
  const [name, setName] = useState("");
  const [memberInput, setMemberInput] = useState("");
  const [members, setMembers] = useState<string[]>([]);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) {
      toast.error("Please enter a group name");
      return;
    }
    const validMembers = members.filter((m) =>
      /^0x[a-fA-F0-9]{40}$/.test(m.trim())
    );
    if (validMembers.length === 0) {
      toast.error("Add at least one valid Ethereum address");
      return;
    }
    const uniqueMembers = [
      ...new Set(validMembers.map((m) => m.toLowerCase())),
    ];
    const result = await createGroup(name.trim(), uniqueMembers);
    if (result) {
      onCreated();
      onClose();
    }
  }, [name, members, createGroup, onClose, onCreated]);

  const addMember = () => {
    const trimmed = memberInput.trim();
    if (!trimmed) { toast.error("Paste a wallet address first"); return; }
    if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
      toast.error("Invalid Ethereum address");
      return;
    }
    if (members.includes(trimmed.toLowerCase())) {
      toast.error("Address already added");
      return;
    }
    setMembers([...members, trimmed.toLowerCase()]);
    setMemberInput("");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
    >
      <div
        className="glass-elevated w-full max-w-lg mx-4 mb-4 sm:mb-0 p-8 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between" style={{ position: "relative", zIndex: 10 }}>
          <h2 className="text-2xl font-heading font-medium text-[var(--text-primary)]">
            Create New Group
          </h2>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-black/5 transition-colors"
            aria-label="Close"
          >
            <X size={20} className="text-[var(--text-primary)]/50" />
          </button>
        </div>

        <div>
          <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
            Group Name
          </label>
          <input
            type="text"
            placeholder="Weekend getaway"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-14 w-full px-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30"
          />
        </div>

        <div>
          <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
            Add Members (Ethereum addresses)
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="0x..."
              value={memberInput}
              onChange={(e) => setMemberInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addMember();
                }
              }}
              className="flex-1 h-12 px-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 font-mono text-sm"
            />
            <button
              type="button"
              onClick={addMember}
              className="h-12 w-12 rounded-2xl bg-[var(--text-primary)] text-white flex items-center justify-center"
              aria-label="Add member"
            >
              <Plus size={20} />
            </button>
          </div>
          {members.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {members.map((m, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/5 text-sm font-mono"
                >
                  <span>
                    {m.slice(0, 6)}...{m.slice(-4)}
                  </span>
                  <button
                    onClick={() =>
                      setMembers(members.filter((_, idx) => idx !== i))
                    }
                    className="text-[var(--text-primary)]/40 hover:text-red-500"
                    aria-label={`Remove member ${m.slice(0, 6)}...${m.slice(-4)}`}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            className="flex-1 h-14 px-6 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium transition-all hover:bg-black/10"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={isProcessing || !name.trim() || members.length === 0}
            className="flex-1 h-14 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isProcessing ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <Plus size={20} />
            )}
            <span>Create Group</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
//  EXPENSE MODAL
// ---------------------------------------------------------------

function AddExpenseModal({
  groupId,
  onClose,
  onAdded,
}: {
  groupId: number;
  onClose: () => void;
  onAdded: () => void;
}) {
  const { address } = useAccount();
  const { addExpense, computeEqualSplit, isProcessing } = useGroupSplit();
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [memberInput, setMemberInput] = useState("");
  const [expenseMembers, setExpenseMembers] = useState<string[]>([]);
  const [splitMode, setSplitMode] = useState<"equal" | "custom">("equal");
  const [customShares, setCustomShares] = useState<Record<string, string>>({});

  const allMembers =
    expenseMembers.length > 0
      ? expenseMembers
      : address
        ? [address.toLowerCase()]
        : [];

  // Compute shares based on split mode
  const computedShares: string[] = (() => {
    if (splitMode === "custom") {
      return allMembers.map((m) => customShares[m] || "0");
    }
    if (!amount || allMembers.length === 0) return allMembers.map(() => "0");
    const perPerson = computeEqualSplit(amount, allMembers.length);
    return allMembers.map(() => perPerson);
  })();

  const customSharesTotal = splitMode === "custom"
    ? computedShares.reduce((sum, s) => sum + parseFloat(s || "0"), 0)
    : 0;
  const customSharesValid = splitMode === "equal" || (
    amount !== "" && Math.abs(customSharesTotal - parseFloat(amount || "0")) < 0.000001
  );

  const handleAddExpense = useCallback(async () => {
    if (!description.trim() || !amount.trim() || !address) return;
    if (!customSharesValid) {
      toast.error("Custom shares must sum to the total amount");
      return;
    }
    await addExpense(groupId, amount, allMembers, computedShares, description);
    onAdded();
    onClose();
  }, [
    description,
    amount,
    address,
    allMembers,
    computedShares,
    customSharesValid,
    groupId,
    addExpense,
    onAdded,
    onClose,
  ]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
    >
      <div
        className="glass-elevated w-full max-w-lg mx-4 mb-4 sm:mb-0 p-8 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-heading font-medium text-[var(--text-primary)]">
            Add Expense to Group #{groupId}
          </h2>
          <button onClick={onClose} className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-black/5 transition-colors" aria-label="Close">
            <X size={20} className="text-[var(--text-primary)]/50" />
          </button>
        </div>

        <div>
          <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">Description</label>
          <input type="text" placeholder="What was this expense for?" value={description} onChange={(e) => setDescription(e.target.value)}
            className="h-14 w-full px-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30" />
        </div>

        <div>
          <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">Amount (USDC)</label>
          <div className="relative">
            <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-primary)]/50">$</span>
            <input type="text" placeholder="0.00" value={amount}
              onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setAmount(v); }}
              className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 text-lg" />
          </div>
        </div>

        <div>
          <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">Split with (addresses, optional)</label>
          <div className="flex gap-2">
            <input type="text" placeholder="0x..." value={memberInput} onChange={(e) => setMemberInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  const trimmed = memberInput.trim();
                  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed) && !expenseMembers.includes(trimmed.toLowerCase())) {
                    setExpenseMembers([...expenseMembers, trimmed.toLowerCase()]);
                    setMemberInput("");
                  }
                }
              }}
              className="flex-1 h-12 px-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 font-mono text-sm" />
            <button type="button" onClick={() => {
              const trimmed = memberInput.trim();
              if (/^0x[a-fA-F0-9]{40}$/.test(trimmed) && !expenseMembers.includes(trimmed.toLowerCase())) {
                setExpenseMembers([...expenseMembers, trimmed.toLowerCase()]);
                setMemberInput("");
              }
            }} className="h-12 w-12 rounded-2xl bg-[var(--text-primary)] text-white flex items-center justify-center" aria-label="Add member to expense">
              <Plus size={20} />
            </button>
          </div>
          {expenseMembers.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {expenseMembers.map((m, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/5 text-xs font-mono">
                  <span>{m.slice(0, 6)}...{m.slice(-4)}</span>
                  <button onClick={() => setExpenseMembers(expenseMembers.filter((_, idx) => idx !== i))} className="text-[var(--text-primary)]/40 hover:text-red-500" aria-label={`Remove member ${m.slice(0, 6)}...${m.slice(-4)}`}><X size={12} /></button>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-[var(--text-primary)]/40 mt-2">Leave empty to expense to yourself only</p>
        </div>

        {/* Split Mode Toggle */}
        {allMembers.length > 1 && (
          <div>
            <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">Split Mode</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setSplitMode("equal")}
                className={cn(
                  "flex-1 h-12 rounded-2xl font-medium text-sm transition-all",
                  splitMode === "equal"
                    ? "bg-[var(--text-primary)] text-white"
                    : "bg-black/5 text-[var(--text-primary)] hover:bg-black/10"
                )}
              >
                Equal Split
              </button>
              <button
                type="button"
                onClick={() => setSplitMode("custom")}
                className={cn(
                  "flex-1 h-12 rounded-2xl font-medium text-sm transition-all",
                  splitMode === "custom"
                    ? "bg-[var(--text-primary)] text-white"
                    : "bg-black/5 text-[var(--text-primary)] hover:bg-black/10"
                )}
              >
                Custom Split
              </button>
            </div>
            {splitMode === "custom" && (
              <div className="mt-3 space-y-2">
                {allMembers.map((m) => (
                  <div key={m} className="flex items-center gap-3">
                    <span className="text-xs font-mono text-[var(--text-primary)]/60 w-28 truncate">
                      {m.slice(0, 8)}...{m.slice(-4)}
                    </span>
                    <div className="relative flex-1">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[var(--text-primary)]/50">$</span>
                      <input
                        type="text"
                        placeholder="0.00"
                        value={customShares[m] || ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (/^\d*\.?\d{0,6}$/.test(v) || v === "") {
                            setCustomShares({ ...customShares, [m]: v });
                          }
                        }}
                        className="h-10 w-full pl-8 pr-3 rounded-xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all text-sm font-mono"
                      />
                    </div>
                  </div>
                ))}
                {amount && (
                  <p className={cn(
                    "text-xs mt-1",
                    customSharesValid ? "text-emerald-600" : "text-red-500"
                  )}>
                    Total: ${customSharesTotal.toFixed(6)} / ${parseFloat(amount || "0").toFixed(6)}
                    {customSharesValid ? " (matches)" : " (must match total)"}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Split Preview */}
        {amount && allMembers.length > 0 && (
          <div className="bg-gray-50 rounded-xl p-3 space-y-1">
            <p className="text-xs font-medium text-[var(--text-secondary)]">Split Preview</p>
            {computedShares.map((share, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="text-[var(--text-primary)]/70">{allMembers[i].slice(0, 8)}...</span>
                <span className="font-mono text-[var(--text-primary)]">${share}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button onClick={onClose} className="flex-1 h-14 px-6 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium transition-all hover:bg-black/10">Cancel</button>
          <button onClick={handleAddExpense} disabled={isProcessing || !description.trim() || !amount.trim() || !customSharesValid}
            className="flex-1 h-14 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center justify-center gap-2 disabled:opacity-50">
            {isProcessing ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Receipt size={20} />}
            <span>Add Expense</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
//  SETTLE DEBT MODAL
// ---------------------------------------------------------------

function SettleDebtModal({
  groupId,
  onClose,
  onSettled,
}: {
  groupId: number;
  onClose: () => void;
  onSettled: () => void;
}) {
  const { settleDebt, isProcessing } = useGroupSplit();
  const [withAddress, setWithAddress] = useState("");
  const [amount, setAmount] = useState("");

  const handleSettle = useCallback(async () => {
    if (!withAddress || !amount) return;
    if (!/^0x[a-fA-F0-9]{40}$/.test(withAddress.trim())) {
      toast.error("Invalid Ethereum address");
      return;
    }
    const result = await settleDebt(groupId, withAddress.trim(), amount);
    if (result) {
      onSettled();
      onClose();
    }
  }, [groupId, withAddress, amount, settleDebt, onSettled, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
    >
      <div
        className="glass-elevated w-full max-w-lg mx-4 mb-4 sm:mb-0 p-8 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-heading font-medium text-[var(--text-primary)]">
            Settle Debt &mdash; Group #{groupId}
          </h2>
          <button onClick={onClose} className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-black/5 transition-colors" aria-label="Close">
            <X size={20} className="text-[var(--text-primary)]/50" />
          </button>
        </div>

        <div>
          <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">Settle with (address)</label>
          <input type="text" placeholder="0x..." value={withAddress} onChange={(e) => setWithAddress(e.target.value)}
            className="h-14 w-full px-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 font-mono" />
        </div>

        <div>
          <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">Amount (USDC)</label>
          <div className="relative">
            <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-primary)]/50">$</span>
            <input type="text" placeholder="0.00" value={amount}
              onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setAmount(v); }}
              className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 text-lg" />
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <button onClick={onClose} className="flex-1 h-14 px-6 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium transition-all hover:bg-black/10">Cancel</button>
          <button onClick={handleSettle} disabled={isProcessing || !withAddress.trim() || !amount.trim()}
            className="flex-1 h-14 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center justify-center gap-2 disabled:opacity-50">
            {isProcessing ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Handshake size={20} />}
            <span>Settle Debt</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
//  VOTE MODAL
// ---------------------------------------------------------------

function VoteModal({
  groupId,
  onClose,
}: {
  groupId: number;
  onClose: () => void;
}) {
  const { voteOnExpense, isProcessing } = useGroupSplit();
  const [selectedExpenseId, setSelectedExpenseId] = useState<number | null>(null);
  const [votes, setVotes] = useState("");
  const [expenses, setExpenses] = useState<GroupExpenseRow[]>([]);
  const [loadingExpenses, setLoadingExpenses] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoadingExpenses(true);
    fetchGroupExpenses(groupId).then((data) => {
      if (!cancelled) {
        setExpenses(data);
        setLoadingExpenses(false);
      }
    }).catch(() => {
      if (!cancelled) setLoadingExpenses(false);
    });
    return () => { cancelled = true; };
  }, [groupId]);

  const handleVote = useCallback(async () => {
    if (!votes.trim() || selectedExpenseId === null) return;
    await voteOnExpense(groupId, selectedExpenseId, votes);
    onClose();
  }, [groupId, selectedExpenseId, votes, voteOnExpense, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
    >
      <div
        className="glass-elevated w-full max-w-lg mx-4 mb-4 sm:mb-0 p-8 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-heading font-medium text-[var(--text-primary)]">
            Vote on Expense &mdash; Group #{groupId}
          </h2>
          <button onClick={onClose} className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-black/5 transition-colors" aria-label="Close">
            <X size={20} className="text-[var(--text-primary)]/50" />
          </button>
        </div>

        <div>
          <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">Select Expense</label>
          {loadingExpenses ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="h-16 rounded-2xl bg-black/5 animate-pulse" />
              ))}
            </div>
          ) : expenses.length === 0 ? (
            <div className="p-6 rounded-2xl bg-white/60 border border-black/10 text-center">
              <p className="text-sm text-[var(--text-primary)]/50">No expenses to vote on</p>
            </div>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {expenses.map((exp) => (
                <button
                  key={exp.expense_id}
                  type="button"
                  onClick={() => setSelectedExpenseId(exp.expense_id)}
                  className={cn(
                    "w-full text-left p-4 rounded-2xl border transition-all",
                    selectedExpenseId === exp.expense_id
                      ? "bg-[var(--text-primary)]/5 border-[var(--text-primary)]/30 ring-2 ring-[var(--text-primary)]/10"
                      : "bg-white/60 border-black/10 hover:border-black/20"
                  )}
                >
                  <p className="text-sm font-medium text-[var(--text-primary)]">{exp.description}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-[var(--text-primary)]/50 font-mono">
                      {exp.payer_address.slice(0, 6)}...{exp.payer_address.slice(-4)}
                    </span>
                    <span className="text-xs text-[var(--text-primary)]/30">&middot;</span>
                    <span className="text-xs text-[var(--text-primary)]/50">
                      {new Date(exp.created_at).toLocaleDateString()}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">Votes (USDC)</label>
          <div className="relative">
            <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-primary)]/50">$</span>
            <input type="text" placeholder="0.00" value={votes}
              onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setVotes(v); }}
              className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 text-lg" />
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <button onClick={onClose} className="flex-1 h-14 px-6 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium transition-all hover:bg-black/10">Cancel</button>
          <button onClick={handleVote} disabled={isProcessing || !votes.trim() || selectedExpenseId === null}
            className="flex-1 h-14 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center justify-center gap-2 disabled:opacity-50">
            {isProcessing ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Vote size={20} />}
            <span>Submit Vote</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
//  GROUP CARD
// ---------------------------------------------------------------

function GroupCard({
  group,
  expenses,
  onAddExpense,
  onSettleDebt,
  onVote,
  onLeave,
  onArchive,
  isProcessing,
}: {
  group: GroupMembershipRow;
  expenses: GroupExpenseRow[];
  onAddExpense: (groupId: number) => void;
  onSettleDebt: (groupId: number) => void;
  onVote: (groupId: number) => void;
  onLeave: (groupId: number) => void;
  onArchive: (groupId: number) => void;
  isProcessing: boolean;
}) {
  const color = addressToColor(group.member_address);

  return (
    <div className="rounded-[2rem] glass-card p-8 hover:-translate-y-1 transition-all duration-300">
      {/* Name + Status */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex-1">
          <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-2">
            {group.group_name}
          </h3>
          <div className="flex items-center gap-2">
            <Users size={16} className="text-[var(--text-primary)]/50" />
            <p className="text-sm text-[var(--text-primary)]/50">
              Group #{group.group_id} &middot;{" "}
              {group.is_admin ? "Admin" : "Member"}
            </p>
          </div>
        </div>
        <div
          className={cn(
            "px-3 py-1 rounded-full text-xs font-medium border",
            getStatusColor("active")
          )}
        >
          active
        </div>
      </div>

      {/* Avatar */}
      <div className="flex items-center gap-2 mb-6">
        <div className="flex -space-x-3">
          <div
            className="w-10 h-10 rounded-full border-2 border-white flex items-center justify-center text-xs font-bold text-white"
            style={{ background: color }}
          >
            {group.member_address.slice(2, 4).toUpperCase()}
          </div>
        </div>
      </div>

      {/* Amounts (encrypted) */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="p-4 rounded-2xl bg-white/50 border border-black/5">
          <p className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-1">
            Expenses
          </p>
          <p className="text-lg font-heading font-medium text-[var(--text-primary)]">
            {expenses.length}
          </p>
        </div>
        <div className="p-4 rounded-2xl bg-white/50 border border-black/5">
          <p className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-1">
            Your Share
          </p>
          <p className="text-lg font-heading font-medium encrypted-text">
            ${"\u2588\u2588\u2588.\u2588\u2588"}
          </p>
        </div>
      </div>

      {/* Recent Expenses */}
      {expenses.length > 0 && (
        <div className="mb-4">
          <p className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2">
            Recent Expenses
          </p>
          <div className="space-y-2">
            {expenses.slice(0, 3).map((exp) => (
              <div
                key={exp.id}
                className="flex items-center justify-between p-3 rounded-xl bg-white/30 border border-black/5 text-sm"
              >
                <span className="text-[var(--text-primary)]">
                  {exp.description}
                </span>
                <span className="text-[var(--text-primary)]/50 font-mono text-xs">
                  {exp.payer_address.slice(0, 6)}...{exp.payer_address.slice(-4)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={() => onAddExpense(group.group_id)}
          className="flex-1 h-12 px-4 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center justify-center gap-2 text-sm"
        >
          <Receipt size={18} />
          <span>Add Expense</span>
        </button>
        <button
          onClick={() => onSettleDebt(group.group_id)}
          className="flex-1 h-12 px-4 rounded-2xl bg-emerald-500 text-white font-medium transition-transform active:scale-95 hover:bg-emerald-600 flex items-center justify-center gap-2 text-sm"
        >
          <Handshake size={18} />
          <span>Settle</span>
        </button>
        <button
          onClick={() => onVote(group.group_id)}
          className="h-12 w-12 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium transition-all active:scale-95 hover:bg-black/10 flex items-center justify-center"
          aria-label="Vote on expense"
        >
          <Vote size={18} />
        </button>
      </div>

      {/* Leave / Archive Actions */}
      <div className="flex gap-2 mt-3">
        <button
          onClick={() => {
            if (window.confirm("Leave this group? You will no longer see expenses or debts.")) {
              onLeave(group.group_id);
            }
          }}
          disabled={isProcessing}
          className="flex-1 h-10 px-4 rounded-xl bg-amber-50 text-amber-700 border border-amber-100 font-medium transition-all active:scale-95 hover:bg-amber-100 flex items-center justify-center gap-2 text-sm disabled:opacity-50"
        >
          <LogOut size={16} />
          <span>Leave Group</span>
        </button>
        {group.is_admin && (
          <button
            onClick={() => {
              if (window.confirm("Archive this group? It will be deactivated for all members.")) {
                onArchive(group.group_id);
              }
            }}
            disabled={isProcessing}
            className="flex-1 h-10 px-4 rounded-xl bg-red-50 text-red-600 border border-red-100 font-medium transition-all active:scale-95 hover:bg-red-100 flex items-center justify-center gap-2 text-sm disabled:opacity-50"
          >
            <Archive size={16} />
            <span>Archive Group</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
//  MAIN SCREEN
// ---------------------------------------------------------------

export default function Groups() {
  const { address } = useAccount();
  const { leaveGroup, archiveGroup, isProcessing: groupActionProcessing } = useGroupSplit();
  const [showCreate, setShowCreate] = useState(false);
  const [expenseGroupId, setExpenseGroupId] = useState<number | null>(null);
  const [settleGroupId, setSettleGroupId] = useState<number | null>(null);
  const [voteGroupId, setVoteGroupId] = useState<number | null>(null);

  // Real data from Supabase
  const [groups, setGroups] = useState<GroupMembershipRow[]>([]);
  const [expensesMap, setExpensesMap] = useState<
    Record<number, GroupExpenseRow[]>
  >({});
  const [loading, setLoading] = useState(true);

  const refreshData = useCallback(async () => {
    if (!address) {
      setGroups([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await fetchUserGroups(address.toLowerCase());
      setGroups(data);

      // Fetch expenses for each unique group
      const uniqueGroupIds = [
        ...new Set(data.map((g) => g.group_id)),
      ];
      const expMap: Record<number, GroupExpenseRow[]> = {};
      await Promise.all(
        uniqueGroupIds.map(async (gid) => {
          const exps = await fetchGroupExpenses(gid);
          expMap[gid] = exps;
        })
      );
      setExpensesMap(expMap);
    } catch {
      // Supabase might be down -- offline mode
    }
    setLoading(false);
  }, [address]);

  // Fetch on mount + poll every 30s
  useEffect(() => {
    refreshData();
    const interval = setInterval(() => refreshData(), 30_000);
    return () => clearInterval(interval);
  }, [refreshData]);

  // Deduplicate groups by group_id (user might have multiple membership rows)
  const uniqueGroups = groups.reduce<GroupMembershipRow[]>((acc, g) => {
    if (!acc.find((existing) => existing.group_id === g.group_id)) {
      acc.push(g);
    }
    return acc;
  }, []);

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-4xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
              Group Expenses
            </h1>
            <p className="text-base text-[var(--text-primary)]/50 leading-relaxed">
              Split bills privately with voting approval
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={refreshData}
              disabled={loading}
              className="h-14 w-14 rounded-2xl bg-white/60 backdrop-blur-2xl border border-white/60 flex items-center justify-center hover:bg-white/80 transition-all"
              aria-label="Refresh"
            >
              <RefreshCw
                size={20}
                className={cn(
                  "text-[var(--text-primary)]/50",
                  loading && "animate-spin"
                )}
              />
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="h-14 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center gap-2"
            >
              <Plus size={20} />
              <span>Create Group</span>
            </button>
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {[1, 2, 3, 4].map((i) => (
              <GroupCardShimmer key={i} />
            ))}
          </div>
        ) : uniqueGroups.length === 0 ? (
          /* Empty State */
          <div className="rounded-[2rem] glass-card p-16 text-center">
            <div className="w-20 h-20 rounded-2xl bg-blue-50 flex items-center justify-center mx-auto mb-6">
              <Users size={40} className="text-blue-400" />
            </div>
            <h3 className="text-2xl font-heading font-medium text-[var(--text-primary)] mb-2">
              No groups yet
            </h3>
            <p className="text-[var(--text-primary)]/50 mb-6 max-w-sm mx-auto">
              Create a group to start splitting expenses with friends. All
              amounts are encrypted with FHE.
            </p>
            <button
              onClick={() => setShowCreate(true)}
              className="h-14 px-8 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] inline-flex items-center gap-2"
            >
              <Plus size={20} />
              <span>Create Your First Group</span>
            </button>
          </div>
        ) : (
          /* Group Cards Grid */
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {uniqueGroups.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                expenses={expensesMap[group.group_id] || []}
                onAddExpense={setExpenseGroupId}
                onSettleDebt={setSettleGroupId}
                onVote={setVoteGroupId}
                onLeave={async (gid) => {
                  await leaveGroup(gid);
                  refreshData();
                }}
                onArchive={async (gid) => {
                  await archiveGroup(gid);
                  refreshData();
                }}
                isProcessing={groupActionProcessing}
              />
            ))}
          </div>
        )}
      </div>

      {/* Modals */}
      {showCreate && (
        <CreateGroupModal
          onClose={() => setShowCreate(false)}
          onCreated={refreshData}
        />
      )}
      {expenseGroupId !== null && (
        <AddExpenseModal
          groupId={expenseGroupId}
          onClose={() => setExpenseGroupId(null)}
          onAdded={refreshData}
        />
      )}
      {settleGroupId !== null && (
        <SettleDebtModal
          groupId={settleGroupId}
          onClose={() => setSettleGroupId(null)}
          onSettled={refreshData}
        />
      )}
      {voteGroupId !== null && (
        <VoteModal
          groupId={voteGroupId}
          onClose={() => setVoteGroupId(null)}
        />
      )}
    </div>
  );
}
