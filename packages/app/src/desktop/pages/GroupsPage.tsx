import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { useNavigate } from "react-router-dom";
import { Users, Plus, ArrowRight, X, RefreshCw, ChevronDown, Receipt, Handshake, Vote, Shield } from "lucide-react";
import { pageVariants, staggerContainer, fadeInUp } from "@/lib/animations";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { useGroupSplit } from "@/hooks/useGroupSplit";
import { useEncryptedBalance } from "@/hooks/useEncryptedBalance";
import { fetchUserGroups, type GroupMembershipRow } from "@/lib/supabase";
import toast from "react-hot-toast";

export function GroupsPage() {
  const { isConnected, address } = useAccount();
  const { hasBalance } = useEncryptedBalance();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);
  const [members, setMembers] = useState<string[]>([""]);
  const [groupName, setGroupName] = useState("");
  const { createGroup, addExpense, settleDebt, voteOnExpense, isProcessing } = useGroupSplit();

  // Data
  const [groups, setGroups] = useState<GroupMembershipRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedGroup, setExpandedGroup] = useState<number | null>(null);
  const [voteAmount, setVoteAmount] = useState("");
  const [voteExpenseId, setVoteExpenseId] = useState("0");

  // Settle debt state
  const [settleGroupId, setSettleGroupId] = useState<number | null>(null);
  const [settleWith, setSettleWith] = useState("");
  const [settleAmount, setSettleAmount] = useState("");

  // Expense form state
  const [showExpenseForm, setShowExpenseForm] = useState<number | null>(null);
  const [expenseDesc, setExpenseDesc] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");

  const refreshData = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    const data = await fetchUserGroups(address);
    setGroups(data);
    setLoading(false);
  }, [address]);

  // Fetch on mount + poll every 30s
  useEffect(() => {
    refreshData();
    const interval = setInterval(() => refreshData(), 30000);
    return () => clearInterval(interval);
  }, [refreshData]);

  if (!isConnected) return <ConnectPrompt />;

  const addMember = () => setMembers([...members, ""]);
  const removeMember = (i: number) => setMembers(members.filter((_, idx) => idx !== i));
  const updateMember = (i: number, val: string) => {
    const updated = [...members];
    updated[i] = val;
    setMembers(updated);
  };

  const handleCreateGroup = async () => {
    if (!groupName.trim()) {
      toast.error("Please enter a group name");
      return;
    }
    const validMembers = members.filter((m) => /^0x[a-fA-F0-9]{40}$/.test(m.trim()));
    if (validMembers.length === 0) {
      toast.error("Add at least one valid Ethereum address");
      return;
    }
    if (validMembers.length < 2) {
      toast.error("A group needs at least 2 members");
      return;
    }
    const uniqueMembers = [...new Set(validMembers.map((m) => m.toLowerCase()))];
    if (uniqueMembers.length < validMembers.length) {
      toast.error("Duplicate addresses removed");
    }
    await createGroup(groupName, uniqueMembers);
    setGroupName("");
    setMembers([""]);
    setShowCreate(false);
    await refreshData();
  };

  const handleAddExpense = async () => {
    if (showExpenseForm === null || !expenseDesc.trim() || !expenseAmount.trim() || !address) return;
    // Equal split among all group members (simplified: just the current user for now)
    const members = [address];
    const shares = [expenseAmount];
    await addExpense(showExpenseForm, expenseAmount, members, shares, expenseDesc);
    setExpenseDesc("");
    setExpenseAmount("");
    setShowExpenseForm(null);
    await refreshData();
  };

  const handleVote = async (groupId: number) => {
    if (!voteAmount.trim()) return;
    const expId = parseInt(voteExpenseId, 10) || 0;
    await voteOnExpense(groupId, expId, voteAmount);
    setVoteAmount("");
  };

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit" className="space-y-6">
      {!hasBalance && (
        <GlassCard className="!rounded-[2rem] !bg-warning/5 !border-warning/20">
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 text-warning shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-warning">Shield tokens first</p>
              <p className="text-xs text-warning/70 mt-1">You need to shield USDC into your encrypted vault before using group features. Go to Dashboard and click &ldquo;Shield Tokens&rdquo;.</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={() => navigate("/")}>
                Go to Dashboard
              </Button>
            </div>
          </div>
        </GlassCard>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Groups</h1>
          <p className="text-base text-apple-secondary font-medium mt-1">Split expenses with encrypted amounts</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refreshData} className="text-xs text-apple-secondary hover:text-white transition-colors flex items-center gap-1">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <Button variant="primary" size="md" icon={<Plus className="w-4 h-4" />} onClick={() => setShowCreate(!showCreate)}>
            New Group
          </Button>
        </div>
      </div>

      <AnimatePresence>
        {showCreate && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <GlassCard variant="elevated" className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center">
                  <Users className="w-5 h-5 text-orange-400" />
                </div>
                <div>
                  <h3 className="text-subheading font-semibold">Create Group</h3>
                  <p className="text-caption text-apple-secondary">Members only see their own debts</p>
                </div>
              </div>
              <div className="space-y-4">
                <Input label="Group Name" placeholder="Apartment Rent, Trip Fund, etc." value={groupName} onChange={(e) => setGroupName(e.target.value)} />
                <div>
                  <label className="label mb-2 block">Members</label>
                  {members.map((m, i) => (
                    <div key={i} className="flex gap-2 mb-2">
                      <Input placeholder="0x... member address" value={m} onChange={(e) => updateMember(i, e.target.value)} error={m && !m.match(/^0x[a-fA-F0-9]{40}$/) ? "Invalid Ethereum address" : undefined} />
                      {members.length > 1 && (
                        <button onClick={() => removeMember(i)} className="p-3 text-neutral-600 hover:text-red-400 transition-colors">
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                  <Button variant="ghost" size="sm" onClick={addMember} icon={<Plus className="w-3 h-3" />}>Add Member</Button>
                </div>
                <Button
                  variant="primary"
                  size="lg"
                  className="w-full"
                  icon={<ArrowRight className="w-4 h-4" />}
                  onClick={handleCreateGroup}
                  loading={isProcessing}
                  disabled={!groupName.trim() || members.some((m) => m.trim() !== "" && !/^0x[a-fA-F0-9]{40}$/.test(m))}
                >
                  Create Group
                </Button>
              </div>
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Expense Form */}
      <AnimatePresence>
        {showExpenseForm !== null && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <GlassCard className="!rounded-[2rem]">
              <h3 className="text-lg font-semibold mb-4">Add Expense to Group #{showExpenseForm}</h3>
              <div className="space-y-4">
                <Input label="Description" value={expenseDesc} onChange={(e) => setExpenseDesc(e.target.value)} placeholder="What was this expense for?" />
                <Input label="Amount (USDC)" isAmount value={expenseAmount} onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setExpenseAmount(v); }} placeholder="0.00" />
                <div className="flex gap-2">
                  <Button variant="primary" onClick={handleAddExpense} loading={isProcessing} disabled={!expenseDesc.trim() || !expenseAmount.trim()}>Add Expense</Button>
                  <Button variant="ghost" onClick={() => setShowExpenseForm(null)}>Cancel</Button>
                </div>
              </div>
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Group List */}
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-3">
        {loading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => <div key={i} className="shimmer h-16 rounded-xl" style={{ animationDelay: `${i * 0.15}s` }} />)}
          </div>
        ) : groups.length > 0 ? (
          groups.map((group) => (
            <motion.div key={group.id} variants={fadeInUp}>
              <GlassCard
                variant="interactive"
                className="!rounded-[2rem] cursor-pointer"
                onClick={() => setExpandedGroup(expandedGroup === group.group_id ? null : group.group_id)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-white">{group.group_name}</p>
                    <p className="text-caption text-apple-secondary">
                      {group.is_admin ? "Admin" : "Member"} · Group #{group.group_id}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="badge-info">Active</span>
                    <ChevronDown className={`w-4 h-4 text-apple-secondary transition-transform duration-200 ${expandedGroup === group.group_id ? "rotate-180" : ""}`} />
                  </div>
                </div>
                <AnimatePresence>
                  {expandedGroup === group.group_id && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      className="mt-3 pt-3 border-t border-glass-border"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <p className="text-xs font-semibold text-apple-secondary uppercase tracking-wider mb-2">Members</p>
                      <div className="space-y-1 mb-3">
                        <p className="text-xs font-mono text-neutral-300">{address?.slice(0, 10)}...{address?.slice(-6)} (you)</p>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="secondary" size="sm" icon={<Receipt className="w-3.5 h-3.5" />}
                          onClick={() => setShowExpenseForm(group.group_id)}>
                          Add Expense
                        </Button>
                        <Button variant="ghost" size="sm" icon={<Handshake className="w-3.5 h-3.5" />}
                          onClick={() => setSettleGroupId(settleGroupId === group.group_id ? null : group.group_id)}>
                          Settle Debt
                        </Button>
                      </div>
                      {settleGroupId === group.group_id && (
                        <div className="mt-3 space-y-2 p-3 rounded-xl bg-apple-gray6/40 border border-white/[0.05]">
                          <Input label="Settle with (address)" value={settleWith} onChange={e => setSettleWith(e.target.value)} placeholder="0x..." error={settleWith && !/^0x[a-fA-F0-9]{40}$/.test(settleWith) ? "Invalid address" : undefined} />
                          <Input label="Amount (USDC)" isAmount value={settleAmount} onChange={e => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setSettleAmount(v); }} placeholder="0.00" />
                          <div className="flex gap-2">
                            <Button variant="primary" size="sm" onClick={async () => {
                              if (!settleWith || !settleAmount) return;
                              await settleDebt(group.group_id, settleWith, settleAmount);
                              setSettleGroupId(null); setSettleWith(""); setSettleAmount("");
                              await refreshData();
                            }} loading={isProcessing} disabled={!settleWith || !settleAmount || !/^0x[a-fA-F0-9]{40}$/.test(settleWith)}>Settle</Button>
                            <Button variant="ghost" size="sm" onClick={() => setSettleGroupId(null)}>Cancel</Button>
                          </div>
                        </div>
                      )}

                      <div className="mt-4 space-y-2">
                        <h4 className="text-sm font-semibold text-white flex items-center gap-1.5">
                          <Vote className="w-3.5 h-3.5 text-apple-secondary" /> Vote on Expenses
                        </h4>
                        <div className="flex gap-2 items-end">
                          <div className="w-24">
                            <Input label="Expense ID" placeholder="0" value={voteExpenseId} onChange={(e) => setVoteExpenseId(e.target.value)} />
                          </div>
                          <div className="flex-1">
                            <Input label="Votes (USDC)" placeholder="0.00" isAmount value={voteAmount} onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setVoteAmount(v); }} />
                          </div>
                          <Button variant="secondary" size="sm" onClick={() => handleVote(group.group_id)} loading={isProcessing} disabled={!voteAmount.trim()}>
                            Vote
                          </Button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </GlassCard>
            </motion.div>
          ))
        ) : (
          <motion.div variants={fadeInUp}>
            <GlassCard className="py-12">
              <div className="flex flex-col items-center justify-center">
                <div className="relative mb-6">
                  <motion.div
                    animate={{ scale: [1, 1.3, 1], opacity: [0.15, 0.05, 0.15] }}
                    transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                    className="absolute inset-0 rounded-2xl bg-accent/20"
                    style={{ filter: "blur(16px)" }}
                    aria-hidden="true"
                  />
                  <div className="relative w-16 h-16 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                    <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}>
                      <Users className="w-8 h-8 text-text-muted" />
                    </motion.div>
                  </div>
                </div>
                <p className="text-heading-3 font-semibold text-text-secondary mb-1.5">No groups yet</p>
                <p className="text-body text-text-muted text-center max-w-xs mb-6">Create a group to start splitting expenses with friends</p>
                <Button variant="primary" size="md" icon={<Plus className="w-4 h-4" />} onClick={() => setShowCreate(true)}>
                  Create Your First Group
                </Button>
              </div>
            </GlassCard>
          </motion.div>
        )}
      </motion.div>
    </motion.div>
  );
}
