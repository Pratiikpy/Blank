import { useEffect, useRef, useState } from "react";
import { useReadContract } from "wagmi";
import {
  Clock,
  AlertTriangle,
  Shield,
  User,
  CheckCircle2,
  Info,
  X,
  Plus,
  Loader2,
  Trash2,
  Vault,
  Inbox,
} from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import { cn } from "@/lib/cn";
import toast from "react-hot-toast";
import { useInheritance } from "@/hooks/useInheritance";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { InheritanceManagerAbi } from "@/lib/abis";
import { useChain } from "@/providers/ChainProvider";
import { fetchHeirAssignments, type ActivityRow } from "@/lib/supabase";
import type { ContractMap } from "@/lib/constants";
import { truncateAddress } from "@/lib/address";

// ---------------------------------------------------------------
//  AVAILABLE VAULTS (the user can protect these in their plan)
// ---------------------------------------------------------------

/** Build the list of protectable vaults for the current chain. */
function buildAvailableVaults(contracts: ContractMap): { address: string; label: string }[] {
  return [{ address: contracts.FHERC20Vault_USDC, label: "USDC Vault" }];
}

// ---------------------------------------------------------------
//  VAULT SELECTOR MODAL
// ---------------------------------------------------------------

function VaultSelectorModal({
  currentVaults,
  availableVaults,
  isProcessing,
  onSave,
  onClose,
}: {
  currentVaults: string[];
  availableVaults: { address: string; label: string }[];
  isProcessing: boolean;
  onSave: (vaults: string[]) => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(currentVaults.map((v) => v.toLowerCase()))
  );
  const [customVault, setCustomVault] = useState("");

  const toggle = (addr: string) => {
    const key = addr.toLowerCase();
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const addCustomVault = () => {
    const trimmed = customVault.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) {
      toast.error("Invalid vault address");
      return;
    }
    setSelected((prev) => new Set(prev).add(trimmed.toLowerCase()));
    setCustomVault("");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-8">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-2xl font-heading font-medium text-[var(--text-primary)]">
            Select Protected Vaults
          </h3>
          <button onClick={onClose} className="p-2 hover:bg-black/5 rounded-xl">
            <X size={24} className="text-[var(--text-primary)]/50" />
          </button>
        </div>

        <p className="text-sm text-[var(--text-primary)]/50 mb-4">
          Choose which vaults your heir will be able to claim from. Only selected vaults are included in the inheritance plan.
        </p>

        <div className="space-y-2 mb-4">
          {availableVaults.map((vault) => {
            const isSelected = selected.has(vault.address.toLowerCase());
            return (
              <button
                key={vault.address}
                type="button"
                onClick={() => toggle(vault.address)}
                className={cn(
                  "w-full flex items-center justify-between p-4 rounded-2xl border-2 transition-all text-left",
                  isSelected
                    ? "bg-indigo-50 border-indigo-200"
                    : "bg-white/50 border-black/5 hover:border-black/10"
                )}
              >
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "w-8 h-8 rounded-lg flex items-center justify-center",
                    isSelected ? "bg-indigo-100" : "bg-gray-100"
                  )}>
                    <Vault size={16} className={isSelected ? "text-indigo-600" : "text-gray-400"} />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">{vault.label}</p>
                    <p className="text-xs font-mono text-[var(--text-primary)]/40">
                      {vault.address.slice(0, 6)}...{vault.address.slice(-4)}
                    </p>
                  </div>
                </div>
                <div className={cn(
                  "w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all",
                  isSelected ? "bg-indigo-500 border-indigo-500" : "border-black/20"
                )}>
                  {isSelected && <CheckCircle2 size={14} className="text-white" />}
                </div>
              </button>
            );
          })}

          {/* Custom vault addresses that were added */}
          {[...selected].filter(
            (s) => !availableVaults.some((av) => av.address.toLowerCase() === s)
          ).map((addr) => (
            <div
              key={addr}
              className="flex items-center justify-between p-4 rounded-2xl bg-indigo-50 border-2 border-indigo-200"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-100 flex items-center justify-center">
                  <Vault size={16} className="text-indigo-600" />
                </div>
                <p className="text-xs font-mono text-[var(--text-primary)]">
                  {truncateAddress(addr)}
                </p>
              </div>
              <button
                onClick={() => toggle(addr)}
                className="text-red-400 hover:text-red-600"
                aria-label="Remove vault"
              >
                <X size={16} />
              </button>
            </div>
          ))}
        </div>

        {/* Add custom vault */}
        <div className="flex gap-2 mb-6">
          <input
            type="text"
            value={customVault}
            onChange={(e) => setCustomVault(e.target.value)}
            placeholder="Custom vault address 0x..."
            className="flex-1 h-12 px-4 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none font-mono text-sm"
          />
          <button
            type="button"
            onClick={addCustomVault}
            className="h-12 px-4 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium hover:bg-black/10 text-sm"
          >
            Add
          </button>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onClose}
            className="flex-1 h-14 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave([...selected])}
            disabled={isProcessing}
            className="flex-1 h-14 rounded-2xl bg-[var(--text-primary)] text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {isProcessing ? <Loader2 size={20} className="animate-spin" /> : <Vault size={20} />}
            {isProcessing ? "Saving..." : `Save ${selected.size} Vault${selected.size !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
//  HEIR ASSIGNMENT CARD — shown in "Plans naming you" section
// ---------------------------------------------------------------

/**
 * Live status card for a single plan where the current user is the named
 * heir. Reads the principal's plan straight from `InheritanceManager.getPlan`
 * so the UI reflects the current inactivity deadline + claim progress.
 *
 * The "View status" action pre-fills the claim form + scrolls to it so the
 * heir can immediately start / finalize a claim if the window is open.
 */
function HeirAssignmentCard({
  principal,
  designatedAt,
  onSelect,
}: {
  principal: string;
  designatedAt: string;
  onSelect: (principal: string) => void;
}) {
  const { contracts } = useChain();

  const { data: principalPlanData } = useReadContract({
    address: contracts.InheritanceManager,
    abi: InheritanceManagerAbi,
    functionName: "getPlan",
    args: [principal as `0x${string}`],
    query: { enabled: /^0x[a-fA-F0-9]{40}$/.test(principal), refetchInterval: 60_000 },
  });

  const principalPlan = principalPlanData as
    | readonly [string, bigint, bigint, bigint, boolean, readonly string[]]
    | undefined;

  // Derived state — mirrors the shape used by the main screen for the user's
  // own plan so we can show the same status badges.
  const isActive = principalPlan?.[4] ?? false;
  const stillHeir =
    isActive &&
    !!principalPlan &&
    principalPlan[0].toLowerCase() !== "0x0000000000000000000000000000000000000000";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const inactivityPeriod = Number(principalPlan?.[1] ?? 0n);
  const lastHeartbeat = Number(principalPlan?.[2] ?? 0n);
  const claimStartedAt = Number(principalPlan?.[3] ?? 0n);
  const daysRemaining =
    principalPlan && lastHeartbeat > 0
      ? Math.max(0, Math.floor((lastHeartbeat + inactivityPeriod - nowSeconds) / 86400))
      : 0;
  const claimWindowOpen = isActive && daysRemaining === 0 && lastHeartbeat > 0;
  const claimInProgress = claimStartedAt > 0;

  const designatedRelative = (() => {
    try {
      return formatDistanceToNowStrict(new Date(designatedAt), { addSuffix: true });
    } catch {
      return "recently";
    }
  })();

  // Status label — reflects what this heir can actually DO with the plan.
  let status: { label: string; className: string };
  if (!principalPlan) {
    status = { label: "Loading", className: "bg-gray-50 border-gray-100 text-gray-500" };
  } else if (!stillHeir) {
    // Either plan was removed, or heir address was changed to someone else.
    status = { label: "No longer named", className: "bg-gray-50 border-gray-100 text-gray-500" };
  } else if (claimInProgress) {
    status = { label: "Claim in progress", className: "bg-amber-50 border-amber-100 text-amber-600" };
  } else if (claimWindowOpen) {
    status = { label: "Claimable", className: "bg-emerald-50 border-emerald-100 text-emerald-600" };
  } else {
    status = { label: "Active", className: "bg-blue-50 border-blue-100 text-blue-600" };
  }

  const truncateAddr = (addr: string) =>
    addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;

  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-5 rounded-2xl glass-card-static bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10">
      <div className="flex items-center gap-4 min-w-0">
        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
          {principal.slice(2, 4).toUpperCase()}
        </div>
        <div className="min-w-0">
          <p className="font-mono text-sm font-medium text-[var(--text-primary)] truncate">
            {truncateAddr(principal)}
          </p>
          <p className="text-xs text-[var(--text-primary)]/50 mt-0.5">
            Designated {designatedRelative}
            {stillHeir && daysRemaining > 0 ? ` · ${daysRemaining} day${daysRemaining !== 1 ? "s" : ""} until claimable` : ""}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-shrink-0">
        <span
          className={cn(
            "px-3 py-1 rounded-full border text-xs font-medium whitespace-nowrap",
            status.className,
          )}
        >
          {status.label}
        </span>
        <button
          onClick={() => onSelect(principal)}
          disabled={!stillHeir}
          className="h-10 px-4 rounded-xl bg-[var(--text-primary)] text-white text-sm font-medium disabled:opacity-40 hover:bg-[#000000] transition-colors"
        >
          View status
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------
//  MAIN SCREEN
// ---------------------------------------------------------------

export default function InheritancePlanning() {
  const { plan, setHeir, setVaults, heartbeat, removeHeir, startClaim, finalizeClaim, isProcessing } = useInheritance();
  const { contracts } = useChain();
  const { effectiveAddress } = useEffectiveAddress();
  const availableVaults = buildAvailableVaults(contracts);

  const [showAddModal, setShowAddModal] = useState(false);
  const [showVaultModal, setShowVaultModal] = useState(false);

  // Beneficiary form
  const [bAddress, setBAddress] = useState("");
  const [bDays, setBDays] = useState("30");

  // Heir claim form
  const [claimOwner, setClaimOwner] = useState("");
  const claimSectionRef = useRef<HTMLDivElement | null>(null);

  // Plans where THIS user is the named heir. Loaded from the activity feed
  // (written by useInheritance.setHeir). A principal may appear more than
  // once if they changed heir address and later re-designated us, so we
  // dedupe on principal address and keep the most recent row.
  const [heirAssignments, setHeirAssignments] = useState<ActivityRow[]>([]);
  const [loadingHeirAssignments, setLoadingHeirAssignments] = useState(false);
  useEffect(() => {
    if (!effectiveAddress) {
      setHeirAssignments([]);
      return;
    }
    let cancelled = false;
    setLoadingHeirAssignments(true);
    fetchHeirAssignments(effectiveAddress)
      .then((rows) => {
        if (cancelled) return;
        // Dedupe by principal (user_from) — keep the most recent row since
        // the query ordered by created_at desc.
        const seen = new Set<string>();
        const unique: ActivityRow[] = [];
        for (const row of rows) {
          const key = row.user_from.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          unique.push(row);
        }
        setHeirAssignments(unique);
      })
      .finally(() => {
        if (!cancelled) setLoadingHeirAssignments(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveAddress]);

  const selectPrincipalForClaim = (principal: string) => {
    setClaimOwner(principal);
    // Give React a tick to re-render the claim card before scrolling so the
    // `useReadContract` for ownerPlanData kicks in and the button enables.
    requestAnimationFrame(() => {
      claimSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  // Read the owner's plan when claiming (to get their vault count for finalizeClaim)
  const isValidClaimOwner = /^0x[a-fA-F0-9]{40}$/.test(claimOwner);
  const { data: ownerPlanData } = useReadContract({
    address: contracts.InheritanceManager,
    abi: InheritanceManagerAbi,
    functionName: "getPlan",
    args: isValidClaimOwner ? [claimOwner as `0x${string}`] : undefined,
    query: { enabled: isValidClaimOwner },
  });
  const ownerPlanTuple = ownerPlanData as readonly [string, bigint, bigint, bigint, boolean, readonly string[]] | undefined;
  const ownerVaultCount = ownerPlanTuple?.[5]?.length ?? 0;

  // Derived state from real plan
  const isActive = plan?.active ?? false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const daysSinceCheckin = plan && plan.lastHeartbeat > 0
    ? Math.max(0, Math.floor((nowSeconds - plan.lastHeartbeat) / 86400))
    : 0;
  const daysRemaining = plan ? Math.max(0, Math.floor((plan.lastHeartbeat + plan.inactivityPeriod - nowSeconds) / 86400)) : 0;
  const inactivityDays = plan ? Math.floor(plan.inactivityPeriod / 86400) : 0;
  const heirAddress = plan?.heir ?? "";
  const hasHeir = isActive && heirAddress !== "" && heirAddress !== "0x0000000000000000000000000000000000000000";

  const handleCheckIn = async () => {
    await heartbeat();
  };

  const handleAddBeneficiary = async () => {
    if (!bAddress) return;
    if (!/^0x[a-fA-F0-9]{40}$/.test(bAddress)) {
      toast.error("Invalid Ethereum address");
      return;
    }
    const days = parseInt(bDays) || 30;
    await setHeir(bAddress, days);
    setShowAddModal(false);
    setBAddress("");
    setBDays("30");
  };

  const handleRemoveBeneficiary = async () => {
    if (!window.confirm("Remove inheritance plan? This will deactivate your dead man's switch.")) return;
    await removeHeir();
  };

  const truncateAddr = (addr: string) =>
    addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Beneficiary Planning
          </h1>
          <p className="text-sm sm:text-base text-[var(--text-primary)]/50 leading-relaxed">
            Automatically transfer your funds to a trusted person if needed
          </p>
        </div>

        {/* Plans naming you — section hidden when the user is not the heir
            on any tracked plan. Lets heirs discover assignments without the
            principal having to share their address out of band. */}
        {heirAssignments.length > 0 && (
          <div className="glass-card-static rounded-3xl p-6 sm:p-8 mb-6">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center">
                <Inbox size={20} className="text-indigo-600" />
              </div>
              <div>
                <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
                  Plans naming you
                </h3>
                <p className="text-sm text-[var(--text-primary)]/50">
                  {heirAssignments.length} plan{heirAssignments.length !== 1 ? "s" : ""} where you're the designated heir
                </p>
              </div>
            </div>

            {loadingHeirAssignments && heirAssignments.length === 0 ? (
              <div className="flex items-center justify-center py-6 text-[var(--text-primary)]/50">
                <Loader2 size={16} className="animate-spin mr-2" />
                <span className="text-sm">Loading assignments...</span>
              </div>
            ) : (
              <div className="space-y-2 mt-4">
                {heirAssignments.map((row) => (
                  <HeirAssignmentCard
                    key={row.id}
                    principal={row.user_from}
                    designatedAt={row.created_at}
                    onSelect={selectPrincipalForClaim}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* No Plan State */}
        {!hasHeir && (
          <div className="rounded-[2rem] glass-card p-8 mb-6">
            <div className="flex flex-col items-center text-center py-8">
              <div className="w-20 h-20 rounded-2xl bg-blue-50 flex items-center justify-center mb-4">
                <Shield size={40} className="text-blue-600" />
              </div>
              <h3 className="text-2xl font-heading font-medium text-[var(--text-primary)] mb-2">No Plan Configured</h3>
              <p className="text-[var(--text-primary)]/50 max-w-md mb-6">
                Set up an inheritance plan to automatically transfer your funds to a beneficiary if you become inactive.
              </p>
              <button
                onClick={() => setShowAddModal(true)}
                className="h-14 px-8 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center gap-2"
              >
                <Plus size={20} />
                <span>Set Up Inheritance Plan</span>
              </button>
            </div>
          </div>
        )}

        {/* Active Plan */}
        {hasHeir && (
          <>
            {/* Status Card */}
            <div className="rounded-[2rem] glass-card p-4 sm:p-8 mb-6">
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-6">
                <div className="flex items-center gap-4 min-w-0">
                  <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-emerald-50 flex items-center justify-center shrink-0">
                    <Shield size={28} className="text-emerald-600 sm:w-8 sm:h-8" />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-xl sm:text-2xl font-heading font-medium text-[var(--text-primary)] mb-1">Plan Active</h3>
                    <p className="text-sm text-[var(--text-primary)]/50">
                      Last check-in: {daysSinceCheckin} day{daysSinceCheckin !== 1 ? "s" : ""} ago
                    </p>
                  </div>
                </div>
                <div className={cn(
                  "inline-flex items-center gap-2 px-4 py-2 rounded-full border self-start shrink-0",
                  daysRemaining > 7
                    ? "bg-emerald-50 border-emerald-100 text-emerald-600"
                    : "bg-amber-50 border-amber-100 text-amber-600",
                )}>
                  <CheckCircle2 size={20} />
                  <span className="text-sm font-medium">Protected</span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="p-6 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10">
                  <div className="flex items-center gap-2 mb-2">
                    <Clock size={20} className="text-[#007AFF]" />
                    <p className="text-sm text-[var(--text-primary)]/50 font-medium">Days Remaining</p>
                  </div>
                  <p className={cn(
                    "text-2xl font-heading font-medium",
                    daysRemaining <= 7 ? "text-amber-600" : "text-[var(--text-primary)]",
                  )}>
                    {daysRemaining}
                  </p>
                </div>

                <div className="p-6 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10">
                  <div className="flex items-center gap-2 mb-2">
                    <User size={20} className="text-[#007AFF]" />
                    <p className="text-sm text-[var(--text-primary)]/50 font-medium">Heir</p>
                  </div>
                  <p className="text-lg font-mono font-medium text-[var(--text-primary)]">
                    {truncateAddr(heirAddress)}
                  </p>
                </div>

                <div className="p-6 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield size={20} className="text-emerald-600" />
                    <p className="text-sm text-[var(--text-primary)]/50 font-medium">Protected Funds</p>
                  </div>
                  <p className="text-2xl font-heading font-medium encrypted-text">
                    ${"\u2588\u2588\u2588\u2588\u2588\u2588.\u2588\u2588"}
                  </p>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              {/* Switch Settings */}
              <div className="rounded-[2rem] glass-card p-4 sm:p-8">
                <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-6">Transfer Settings</h3>

                <div className="space-y-4">
                  <div className="p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10">
                    <p className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-1">Inactivity Period</p>
                    <p className="text-lg font-medium text-[var(--text-primary)]">{inactivityDays} days</p>
                  </div>

                  <div className="p-4 rounded-2xl bg-amber-50 border border-amber-100">
                    <div className="flex items-start gap-3">
                      <AlertTriangle size={20} className="text-amber-600 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-amber-900">Important</p>
                        <p className="text-xs text-amber-700 mt-1">
                          If you don't check in within {inactivityDays} days, funds will be automatically available to your heir
                        </p>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={handleCheckIn}
                    disabled={isProcessing}
                    className="w-full h-14 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center justify-center gap-2 disabled:opacity-60"
                  >
                    {isProcessing ? <Loader2 size={20} className="animate-spin" /> : <CheckCircle2 size={20} />}
                    <span>{isProcessing ? "Sending heartbeat..." : "Check In Now"}</span>
                  </button>

                  <button
                    onClick={handleRemoveBeneficiary}
                    disabled={isProcessing}
                    className="w-full h-12 px-6 rounded-2xl bg-red-50 text-red-600 border border-red-100 font-medium transition-all active:scale-95 hover:bg-red-100 flex items-center justify-center gap-2 disabled:opacity-60"
                  >
                    {isProcessing ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                    <span>Remove Inheritance Plan</span>
                  </button>
                </div>
              </div>

              {/* How It Works */}
              <div className="rounded-[2rem] glass-card p-4 sm:p-8">
                <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-6">How It Works</h3>

                <div className="space-y-4">
                  {[
                    { n: 1, title: "Set Your Heir", desc: "Designate a beneficiary and set your inactivity period" },
                    { n: 2, title: "Regular Check-Ins", desc: "Send a heartbeat transaction to prove you're active" },
                    { n: 3, title: "Automatic Transfer", desc: "If you miss the deadline, your heir can claim funds" },
                  ].map(({ n, title, desc }) => (
                    <div key={n} className="flex gap-4">
                      <div className="w-8 h-8 rounded-full bg-[#007AFF]/10 flex items-center justify-center flex-shrink-0">
                        <span className="text-sm font-medium text-[#007AFF]">{n}</span>
                      </div>
                      <div>
                        <p className="font-medium text-[var(--text-primary)] mb-1">{title}</p>
                        <p className="text-sm text-[var(--text-primary)]/60">{desc}</p>
                      </div>
                    </div>
                  ))}

                  <div className="mt-6 p-4 rounded-2xl bg-blue-50 border border-blue-100">
                    <div className="flex items-start gap-3">
                      <Info size={20} className="text-blue-600 mt-0.5" />
                      <div>
                        <p className="text-sm font-medium text-blue-900">Privacy Preserved</p>
                        <p className="text-xs text-blue-700 mt-1">
                          Your heir won't know the amounts until the automatic transfer is triggered
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Protected Vaults */}
            <div className="rounded-[2rem] glass-card p-8 mb-6">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center">
                    <Vault size={20} className="text-indigo-600" />
                  </div>
                  <div>
                    <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">Protected Vaults</h3>
                    <p className="text-sm text-[var(--text-primary)]/50">
                      {plan?.vaults?.length ?? 0} vault{(plan?.vaults?.length ?? 0) !== 1 ? "s" : ""} protected
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowVaultModal(true)}
                  disabled={isProcessing}
                  className="h-12 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center gap-2 disabled:opacity-60"
                >
                  <Vault size={18} />
                  <span>Manage Vaults</span>
                </button>
              </div>

              {plan?.vaults && plan.vaults.length > 0 ? (
                <div className="space-y-2">
                  {plan.vaults.map((v) => {
                    const known = availableVaults.find(
                      (av) => av.address.toLowerCase() === v.toLowerCase()
                    );
                    return (
                      <div
                        key={v}
                        className="flex items-center justify-between p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
                            <Vault size={16} className="text-indigo-500" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-[var(--text-primary)]">
                              {known?.label ?? "Unknown Vault"}
                            </p>
                            <p className="text-xs font-mono text-[var(--text-primary)]/40">
                              {v.slice(0, 6)}...{v.slice(-4)}
                            </p>
                          </div>
                        </div>
                        <div className="px-3 py-1 rounded-full bg-emerald-50 border border-emerald-100 text-xs font-medium text-emerald-600">
                          Protected
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="p-6 rounded-2xl bg-amber-50/50 border border-amber-100 text-center">
                  <p className="text-sm text-amber-800">
                    No vaults configured. Add vaults to specify which funds your heir can claim.
                  </p>
                </div>
              )}
            </div>

            {/* Heir Info */}
            <div className="rounded-[2rem] glass-card p-8">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">Designated Heir</h3>
                <button
                  onClick={() => setShowAddModal(true)}
                  className="h-12 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center gap-2"
                >
                  <User size={20} />
                  <span>Change Heir</span>
                </button>
              </div>

              <div className="flex items-center justify-between p-6 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-400 to-indigo-500 flex items-center justify-center text-white text-sm font-bold">
                    {heirAddress.slice(2, 4).toUpperCase()}
                  </div>
                  <div>
                    <p className="font-medium text-[var(--text-primary)] font-mono">{truncateAddr(heirAddress)}</p>
                    <p className="text-sm text-[var(--text-primary)]/50">
                      Inactivity period: {inactivityDays} days
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-2xl font-heading font-medium text-[var(--text-primary)]">100%</p>
                    <p className="text-sm text-[var(--text-primary)]/50">of funds</p>
                  </div>
                  <button
                    onClick={handleRemoveBeneficiary}
                    disabled={isProcessing}
                    className="p-2 hover:bg-red-50 hover:text-red-500 rounded-xl transition-all text-[var(--text-primary)]/30 disabled:opacity-50"
                  >
                    <Trash2 size={20} />
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
        {/* Heir Claim Section */}
        <div ref={claimSectionRef} className="rounded-[2rem] glass-card p-6 mt-6">
          <h3 className="text-lg font-heading font-semibold text-[var(--text-primary)] mb-2">Claim as Heir</h3>
          <p className="text-sm text-[var(--text-primary)]/50 mb-4">
            If you are designated as someone's heir and the inactivity period has passed, you can initiate a claim.
          </p>

          {plan && plan.claimStartedAt > 0 && (() => {
            const claimDate = new Date(plan.claimStartedAt * 1000);
            const challengeEndSeconds = plan.claimStartedAt + 7 * 86400;
            const challengeEndDate = new Date(challengeEndSeconds * 1000);
            const remainingSeconds = Math.max(0, challengeEndSeconds - nowSeconds);
            const remainingDays = Math.floor(remainingSeconds / 86400);
            const remainingHours = Math.floor((remainingSeconds % 86400) / 3600);
            const isReady = remainingSeconds === 0;
            return (
              <div className="mb-4 p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10 space-y-1">
                <p className="text-sm text-[var(--text-primary)]">
                  <span className="font-medium">Claim started:</span> {claimDate.toLocaleDateString()}
                </p>
                <p className="text-sm text-[var(--text-primary)]">
                  <span className="font-medium">Challenge period ends:</span> {challengeEndDate.toLocaleDateString()}
                </p>
                {isReady ? (
                  <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-100 text-emerald-600 text-sm font-medium mt-1">
                    <CheckCircle2 size={16} />
                    Ready to Finalize
                  </span>
                ) : (
                  <p className="text-sm text-amber-600 font-medium">
                    Time remaining: {remainingDays} day{remainingDays !== 1 ? "s" : ""}, {remainingHours} hour{remainingHours !== 1 ? "s" : ""}
                  </p>
                )}
              </div>
            );
          })()}

          <div className="space-y-3">
            <input
              value={claimOwner}
              onChange={(e) => setClaimOwner(e.target.value)}
              placeholder="Owner address (who set you as heir)"
              className="h-12 w-full px-4 rounded-xl bg-white/60 border border-black/5 outline-none font-mono text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (claimOwner && /^0x[a-fA-F0-9]{40}$/.test(claimOwner)) {
                    startClaim(claimOwner);
                  } else {
                    toast.error("Invalid Ethereum address");
                  }
                }}
                disabled={isProcessing || !claimOwner}
                className="h-12 flex-1 rounded-xl bg-amber-500 text-white font-medium disabled:opacity-30 flex items-center justify-center gap-2"
              >
                {isProcessing ? <Loader2 size={16} className="animate-spin" /> : null}
                Start Claim
              </button>
              <button
                onClick={() => {
                  if (claimOwner && /^0x[a-fA-F0-9]{40}$/.test(claimOwner)) {
                    if (ownerVaultCount === 0) {
                      toast.error("Owner has no vaults configured in their plan");
                      return;
                    }
                    finalizeClaim(claimOwner, ownerVaultCount);
                  } else {
                    toast.error("Invalid Ethereum address");
                  }
                }}
                disabled={isProcessing || !claimOwner || ownerVaultCount === 0}
                className="h-12 flex-1 rounded-xl bg-emerald-500 text-white font-medium disabled:opacity-30 flex items-center justify-center gap-2"
              >
                {isProcessing ? <Loader2 size={16} className="animate-spin" /> : null}
                Finalize Claim{ownerVaultCount > 0 ? ` (${ownerVaultCount} vault${ownerVaultCount !== 1 ? "s" : ""})` : ""}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Add / Change Heir Modal */}
      {/* Vault Selector Modal */}
      {showVaultModal && (
        <VaultSelectorModal
          currentVaults={plan?.vaults ?? []}
          availableVaults={availableVaults}
          isProcessing={isProcessing}
          onSave={async (vaults) => {
            await setVaults(vaults);
            setShowVaultModal(false);
          }}
          onClose={() => setShowVaultModal(false)}
        />
      )}

      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-8">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-2xl font-heading font-medium text-[var(--text-primary)]">
                {hasHeir ? "Change Heir" : "Set Up Inheritance"}
              </h3>
              <button onClick={() => setShowAddModal(false)} className="p-2 hover:bg-black/5 rounded-xl">
                <X size={24} className="text-[var(--text-primary)]/50" />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Heir Wallet Address</label>
                <input
                  type="text"
                  value={bAddress}
                  onChange={(e) => setBAddress(e.target.value)}
                  placeholder="0x..."
                  className="h-14 w-full px-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none font-mono text-sm"
                />
              </div>
              <div>
                <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Inactivity Period (Days)</label>
                <select
                  value={bDays}
                  onChange={(e) => setBDays(e.target.value)}
                  className="h-14 w-full px-5 rounded-2xl bg-white/60 border border-black/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none"
                >
                  <option value="7">7 days</option>
                  <option value="14">14 days</option>
                  <option value="30">30 days</option>
                  <option value="60">60 days</option>
                  <option value="90">90 days</option>
                  <option value="180">180 days</option>
                  <option value="365">365 days</option>
                </select>
              </div>

              <div className="p-4 rounded-2xl bg-amber-50 border border-amber-100">
                <div className="flex items-start gap-3">
                  <AlertTriangle size={20} className="text-amber-600 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-amber-900">Important</p>
                    <p className="text-xs text-amber-700 mt-1">
                      If you don't send a heartbeat within {bDays} days, this address will be able to claim your funds
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <button onClick={() => setShowAddModal(false)} className="flex-1 h-14 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium">Cancel</button>
                <button
                  onClick={handleAddBeneficiary}
                  disabled={!bAddress || isProcessing}
                  className="flex-1 h-14 rounded-2xl bg-[var(--text-primary)] text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isProcessing ? <Loader2 size={20} className="animate-spin" /> : <Plus size={20} />}
                  {isProcessing ? "Setting heir..." : "Set Heir"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
