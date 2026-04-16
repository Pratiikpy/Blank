import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  Shield,
  KeyRound,
  Clock,
  UserCheck,
  Trash2,
  Plus,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { usePrivacy } from "@/hooks/usePrivacy";
import toast from "react-hot-toast";
import { truncateAddress } from "@/lib/address";

export default function Privacy() {
  const navigate = useNavigate();
  const {
    hasPermit,
    permitExpiresAt,
    isExpiringSoon,
    isExpired,
    isCreating,
    sharedPermits,
    createPermit,
    reconnectWallet,
    sharePermit,
    revokePermit,
  } = usePrivacy();

  const [showShareForm, setShowShareForm] = useState(false);
  const [shareAddress, setShareAddress] = useState("");
  const [shareLevel, setShareLevel] = useState<"full" | "balance-proof">("balance-proof");
  const [shareHours, setShareHours] = useState("168"); // 7 days

  const handleShare = async () => {
    if (!shareAddress.trim()) { toast.error("Enter a wallet address"); return; }
    if (!/^0x[a-fA-F0-9]{40}$/.test(shareAddress.trim())) { toast.error("Invalid Ethereum address"); return; }
    await sharePermit(shareAddress.trim(), shareLevel, parseInt(shareHours) || 168);
    setShareAddress("");
    setShowShareForm(false);
  };

  const formatDate = (ms: number | null) => {
    if (!ms) return "N/A";
    return new Date(ms).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const timeRemaining = (ms: number | null) => {
    if (!ms) return "N/A";
    const diff = ms - Date.now();
    if (diff <= 0) return "Expired";
    const hours = Math.floor(diff / 3_600_000);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h remaining`;
    return `${hours}h remaining`;
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate(-1)}
            className="w-11 h-11 rounded-full bg-white border border-black/5 flex items-center justify-center shadow-sm"
            aria-label="Go back"
          >
            <ChevronLeft size={20} />
          </button>
          <div className="flex-1">
            <h1
              className="text-3xl font-semibold tracking-tight"
              style={{ fontFamily: "'Outfit', sans-serif" }}
            >
              Privacy Settings
            </h1>
            <p className="text-sm text-[var(--text-secondary)]">
              Manage your FHE permits and access control
            </p>
          </div>
        </div>

        {/* Permit Status Card */}
        <div className="glass-card-static rounded-[2rem] p-6 mb-6">
          <div className="flex items-center gap-3 mb-4">
            <div
              className={cn(
                "w-12 h-12 rounded-xl flex items-center justify-center",
                hasPermit && !isExpired
                  ? "bg-emerald-50 text-emerald-600"
                  : "bg-amber-50 text-amber-600",
              )}
            >
              <Shield size={24} />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">
                FHE Permit
              </h3>
              <p className="text-sm text-[var(--text-secondary)]">
                {hasPermit && !isExpired
                  ? "Active -- your data is accessible"
                  : "No active permit"}
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex justify-between p-3 rounded-xl bg-white/50 border border-black/5">
              <span className="text-sm text-[var(--text-secondary)]">Status</span>
              <span
                className={cn(
                  "text-sm font-medium",
                  hasPermit && !isExpired ? "text-emerald-600" : "text-amber-600",
                )}
              >
                {isExpired ? "Expired" : hasPermit ? "Active" : "Not Created"}
              </span>
            </div>
            <div className="flex justify-between p-3 rounded-xl bg-white/50 border border-black/5">
              <span className="text-sm text-[var(--text-secondary)]">Expires</span>
              <span className="text-sm font-mono">
                {permitExpiresAt ? formatDate(permitExpiresAt) : "N/A"}
              </span>
            </div>
            <div className="flex justify-between p-3 rounded-xl bg-white/50 border border-black/5">
              <span className="text-sm text-[var(--text-secondary)]">Time Left</span>
              <span className="text-sm font-mono">
                {permitExpiresAt ? timeRemaining(permitExpiresAt) : "N/A"}
              </span>
            </div>
          </div>

          {isExpiringSoon && !isExpired && (
            <div className="mt-4 p-3 rounded-xl bg-amber-50 border border-amber-100 flex items-start gap-2">
              <AlertTriangle size={16} className="text-amber-600 mt-0.5 shrink-0" />
              <p className="text-xs text-amber-700">
                Your permit expires in less than 1 hour. Reconnect your wallet to renew.
              </p>
            </div>
          )}

          {(!hasPermit || isExpired) && (
            <button
              onClick={createPermit}
              disabled={isCreating}
              className="mt-4 w-full h-12 rounded-xl bg-[#1D1D1F] text-white font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              aria-label="Create or renew FHE permit"
            >
              <KeyRound size={16} />
              {isCreating ? "Creating..." : "Create / Renew Permit"}
            </button>
          )}

          <button
            onClick={reconnectWallet}
            className="mt-3 w-full h-11 rounded-xl bg-white border border-black/10 text-[var(--text-primary)] font-medium flex items-center justify-center gap-2 text-sm hover:bg-gray-50 transition-colors"
            aria-label="Reconnect wallet to renew permit"
          >
            <RefreshCw size={15} />
            Reconnect Wallet to Renew Permit
          </button>
        </div>

        {/* Shared Access */}
        <div className="glass-card-static rounded-[2rem] p-6 mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center text-blue-600">
                <UserCheck size={24} />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-[var(--text-primary)]">
                  Local Access Log
                </h3>
                <p className="text-sm text-[var(--text-secondary)]">
                  Track addresses you intend to share with
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowShareForm(!showShareForm)}
              className="h-9 px-3 rounded-full bg-[#1D1D1F] text-white text-sm font-medium flex items-center gap-1.5"
              aria-label="Share access"
            >
              <Plus size={14} /> Share
            </button>
          </div>

          {showShareForm && (
            <div className="mb-4 p-4 rounded-xl bg-white/50 border border-black/5 space-y-3">
              <input
                value={shareAddress}
                onChange={(e) => setShareAddress(e.target.value)}
                placeholder="0x... address to share with"
                className="h-11 w-full px-4 rounded-lg bg-white/60 border border-black/5 outline-none font-mono text-sm"
              />
              <div className="flex gap-2">
                <select
                  value={shareLevel}
                  onChange={(e) => setShareLevel(e.target.value as "full" | "balance-proof")}
                  className="h-11 flex-1 px-3 rounded-lg bg-white/60 border border-black/5 outline-none text-sm"
                >
                  <option value="balance-proof">Balance Proof Only</option>
                  <option value="full">Full Access</option>
                </select>
                <select
                  value={shareHours}
                  onChange={(e) => setShareHours(e.target.value)}
                  className="h-11 flex-1 px-3 rounded-lg bg-white/60 border border-black/5 outline-none text-sm"
                >
                  <option value="24">1 Day</option>
                  <option value="168">7 Days</option>
                  <option value="720">30 Days</option>
                </select>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleShare}
                  className="h-11 flex-1 rounded-lg bg-[#1D1D1F] text-white font-medium text-sm"
                >
                  Log Access
                </button>
                <button
                  onClick={() => setShowShareForm(false)}
                  className="h-11 px-4 rounded-lg bg-gray-100 text-gray-600 font-medium text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="mb-4 p-3 rounded-xl bg-blue-50/60 border border-blue-100 flex items-start gap-2">
            <AlertTriangle size={14} className="text-blue-500 mt-0.5 shrink-0" />
            <p className="text-xs text-blue-700 leading-relaxed">
              Shared access is tracked locally on this device only. On-chain permit sharing requires CoFHE SDK integration and is not yet available.
            </p>
          </div>

          {sharedPermits.length === 0 ? (
            <div className="py-8 text-center">
              <UserCheck size={28} className="mx-auto mb-2 text-gray-300" />
              <p className="text-sm text-[var(--text-secondary)]">
                No access log entries
              </p>
              <p className="text-xs text-[var(--text-tertiary)] mt-1">
                Track addresses you plan to share access with
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {sharedPermits.map((p) => (
                <div
                  key={p.address}
                  className="flex items-center justify-between p-3 rounded-xl bg-white/50 border border-black/5"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-indigo-400 flex items-center justify-center text-white text-xs font-bold shrink-0">
                      {p.address.slice(2, 4).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-mono truncate">
                        {truncateAddress(p.address)}
                      </p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-[var(--text-tertiary)]">
                          {p.accessLevel === "full" ? "Full access" : "Balance proof"}
                        </span>
                        <span className="text-xs text-[var(--text-tertiary)]">
                          <Clock size={10} className="inline mr-0.5" />
                          {timeRemaining(p.expiresAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => revokePermit(p.address)}
                    className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors shrink-0"
                    aria-label={`Revoke access for ${p.address}`}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Info Card */}
        <div className="glass-card-static rounded-[2rem] p-6">
          <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-3">
            How FHE Permits Work
          </h3>
          <div className="space-y-3">
            {[
              { n: 1, text: "Your wallet signs a message to derive a sealing key" },
              { n: 2, text: "The permit allows you to decrypt your own encrypted data" },
              { n: 3, text: "The Local Access Log lets you track who you intend to share with (on-chain sharing coming soon)" },
              { n: 4, text: "Permits expire after 7 days for security -- reconnect to renew" },
            ].map(({ n, text }) => (
              <div key={n} className="flex gap-3">
                <div className="w-7 h-7 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                  <span className="text-xs font-medium text-blue-600">{n}</span>
                </div>
                <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
