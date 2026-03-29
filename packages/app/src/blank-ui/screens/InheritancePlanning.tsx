import { useState } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useInheritance } from "@/hooks/useInheritance";

// ---------------------------------------------------------------
//  MAIN SCREEN
// ---------------------------------------------------------------

export default function InheritancePlanning() {
  const { plan, setHeir, heartbeat, removeHeir, isProcessing } = useInheritance();

  const [showAddModal, setShowAddModal] = useState(false);

  // Beneficiary form
  const [bAddress, setBAddress] = useState("");
  const [bDays, setBDays] = useState("30");

  // Derived state from real plan
  const isActive = plan?.active ?? false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const daysSinceCheckin = plan ? Math.max(0, Math.floor((nowSeconds - plan.lastHeartbeat) / 86400)) : 0;
  const daysRemaining = plan ? Math.max(0, Math.floor((plan.lastHeartbeat + plan.inactivityPeriod - nowSeconds) / 86400)) : 0;
  const inactivityDays = plan ? Math.floor(plan.inactivityPeriod / 86400) : 0;
  const heirAddress = plan?.heir ?? "";
  const hasHeir = isActive && heirAddress !== "" && heirAddress !== "0x0000000000000000000000000000000000000000";

  const handleCheckIn = async () => {
    await heartbeat();
  };

  const handleAddBeneficiary = async () => {
    if (!bAddress) return;
    const days = parseInt(bDays) || 30;
    await setHeir(bAddress, days);
    setShowAddModal(false);
    setBAddress("");
    setBDays("30");
  };

  const handleRemoveBeneficiary = async () => {
    await removeHeir();
  };

  const truncateAddr = (addr: string) =>
    addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Inheritance Planning
          </h1>
          <p className="text-base text-[var(--text-primary)]/50 leading-relaxed">
            Dead man's switch for secure fund transfer
          </p>
        </div>

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
            <div className="rounded-[2rem] glass-card p-8 mb-6">
              <div className="flex items-start justify-between mb-6">
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center">
                    <Shield size={32} className="text-emerald-600" />
                  </div>
                  <div>
                    <h3 className="text-2xl font-heading font-medium text-[var(--text-primary)] mb-1">Plan Active</h3>
                    <p className="text-sm text-[var(--text-primary)]/50">
                      Last check-in: {daysSinceCheckin} day{daysSinceCheckin !== 1 ? "s" : ""} ago
                    </p>
                  </div>
                </div>
                <div className={cn(
                  "flex items-center gap-2 px-4 py-2 rounded-full border",
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
              <div className="rounded-[2rem] glass-card p-8">
                <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-6">Switch Settings</h3>

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
              <div className="rounded-[2rem] glass-card p-8">
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
                          Your heir won't know the amounts until the switch is triggered
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
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
      </div>

      {/* Add / Change Heir Modal */}
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
