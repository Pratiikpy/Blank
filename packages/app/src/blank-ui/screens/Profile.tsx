import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount, useDisconnect } from "wagmi";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import {
  Copy,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Users,
  Shield,
  Settings,
  LogOut,
  ChevronRight,
  Info,
} from "lucide-react";
import { cn } from "@/lib/cn";
import toast from "react-hot-toast";
import { useEncryptedBalance } from "@/hooks/useEncryptedBalance";
import { clearAllAddressScopes } from "@/lib/storage";

import { truncateAddress } from "@/lib/address";

interface MenuItem {
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  subtitle: string;
  route?: string;
  action?: () => void;
}

export default function Profile() {
  const navigate = useNavigate();
  // Passkey-aware: useAccount().address is undefined for passkey-only users,
  // which made this whole screen render `null`. effectiveAddress falls back
  // to the smart account address.
  const { effectiveAddress: address } = useEffectiveAddress();
  // Keep useAccount() imported for any EOA-only features (e.g. useDisconnect).
  useAccount();
  const { disconnect } = useDisconnect();
  const { formatted: realBalance, isDecrypted, hasBalance } = useEncryptedBalance();
  const [copied, setCopied] = useState(false);
  const [balanceRevealed, setBalanceRevealed] = useState(false);

  const copyAddress = useCallback(async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      toast.success("Address copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  }, [address]);

  const handleSignOut = useCallback(() => {
    // #313: purge per-address caches BEFORE disconnect — after disconnect
    // `address` becomes undefined and we lose the key to scope the purge.
    if (address) clearAllAddressScopes(address);
    disconnect();
    navigate("/", { replace: true });
  }, [address, disconnect, navigate]);

  const menuItems: MenuItem[] = [
    {
      icon: <KeyRound size={20} />,
      iconBg: "bg-[#007AFF]/10 text-[#007AFF]",
      label: "Wallet & Keys",
      subtitle: "Manage your wallet and recovery",
      route: "/app/privacy",
    },
    {
      icon: <Users size={20} />,
      iconBg: "bg-cyan-50 text-cyan-600",
      label: "Contacts",
      subtitle: "Your address book",
      route: "/app/contacts",
    },
    {
      icon: <Shield size={20} />,
      iconBg: "bg-purple-50 text-purple-600",
      label: "Privacy Settings",
      subtitle: "Permits and access control",
      route: "/app/privacy",
    },
    {
      icon: <Settings size={20} />,
      iconBg: "bg-gray-100 text-gray-600",
      label: "Settings",
      subtitle: "Preferences and notifications",
      route: "/app/settings",
    },
  ];

  if (!address) return null;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        {/* Page Title */}
        <div className="mb-8">
          <h1 className="text-4xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Profile
          </h1>
          <p className="text-base text-[var(--text-primary)]/50 leading-relaxed">
            Manage your account and privacy
          </p>
        </div>

        <div className="space-y-6">
          {/* Profile Card */}
          <div className="rounded-[2rem] glass-card p-8">
            <div className="flex items-center gap-6 mb-6">
              <div className="w-20 h-20 rounded-full bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center text-white text-2xl font-bold shadow-lg">
                {address.slice(2, 4).toUpperCase()}
              </div>
              <div>
                <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
                  {truncateAddress(address)}
                </h3>
                <p className="text-sm text-[var(--text-primary)]/50 font-mono mt-1">
                  @{address.slice(2, 8).toLowerCase()}
                </p>
              </div>
            </div>

            {/* Balance Section */}
            <div className="p-6 rounded-2xl bg-white/50 border border-black/5 mb-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase">
                  Encrypted Balance
                </p>
                <button
                  onClick={() => setBalanceRevealed(!balanceRevealed)}
                  className="p-2 rounded-xl hover:bg-black/5 transition-all"
                  aria-label={balanceRevealed ? "Hide balance" : "Reveal balance"}
                >
                  {balanceRevealed ? (
                    <EyeOff size={18} className="text-[var(--text-primary)]/50" />
                  ) : (
                    <Eye size={18} className="text-[var(--text-primary)]/50" />
                  )}
                </button>
              </div>
              <p
                className={cn(
                  "text-3xl font-heading font-medium",
                  balanceRevealed ? "decrypted-text" : "encrypted-text",
                )}
              >
                ${balanceRevealed && isDecrypted && realBalance ? realBalance : balanceRevealed && hasBalance ? "Decrypting..." : balanceRevealed ? "0.00" : "••••••.••"}
              </p>
              <div className="flex items-center gap-2 mt-3">
                <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 border border-emerald-100">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  <span className="text-xs font-medium text-emerald-600">
                    FHE Active
                  </span>
                </div>
                <span className="text-xs text-[var(--text-primary)]/50">
                  Ethereum Sepolia
                </span>
              </div>
            </div>

            {/* Wallet Address */}
            <div className="flex items-center justify-between p-4 rounded-2xl bg-white/50 border border-black/5">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-1">
                  Wallet Address
                </p>
                <p className="text-sm text-[var(--text-primary)] font-mono truncate">
                  {address}
                </p>
              </div>
              <button
                onClick={copyAddress}
                className="h-10 px-5 rounded-xl bg-black/5 text-[var(--text-primary)] font-medium transition-all hover:bg-black/10 flex items-center gap-2 shrink-0 ml-4"
                aria-label="Copy address"
              >
                {copied ? (
                  <Check size={16} className="text-emerald-600" />
                ) : (
                  <Copy size={16} />
                )}
                <span className="text-sm">{copied ? "Copied" : "Copy"}</span>
              </button>
            </div>
          </div>

          {/* Menu Items */}
          <div className="rounded-[2rem] glass-card p-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-xl bg-[#007AFF]/10 flex items-center justify-center">
                <Settings size={24} className="text-[#007AFF]" />
              </div>
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
                Account
              </h3>
            </div>
            <div className="space-y-3">
              {menuItems.map((item) => (
                <button
                  key={item.label}
                  onClick={() => {
                    if (item.action) item.action();
                    else if (item.route) navigate(item.route);
                  }}
                  className="w-full flex items-center justify-between p-4 rounded-2xl bg-white/50 border border-black/5 hover:bg-white/70 transition-all text-left"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={cn(
                        "w-10 h-10 rounded-xl flex items-center justify-center shrink-0",
                        item.iconBg,
                      )}
                    >
                      {item.icon}
                    </div>
                    <div>
                      <p className="font-medium text-[var(--text-primary)]">
                        {item.label}
                      </p>
                      <p className="text-sm text-[var(--text-primary)]/50">
                        {item.subtitle}
                      </p>
                    </div>
                  </div>
                  <ChevronRight size={18} className="text-[var(--text-primary)]/30" />
                </button>
              ))}
            </div>
          </div>

          {/* About Section */}
          <div className="rounded-[2rem] glass-card p-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 rounded-xl bg-blue-50 flex items-center justify-center">
                <Info size={24} className="text-blue-600" />
              </div>
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
                About
              </h3>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-4 rounded-2xl bg-white/50 border border-black/5">
                <p className="text-sm text-[var(--text-primary)]/70">Version</p>
                <p className="text-sm font-medium text-[var(--text-primary)]">1.0.0</p>
              </div>
              <div className="flex items-center justify-between p-4 rounded-2xl bg-white/50 border border-black/5">
                <p className="text-sm text-[var(--text-primary)]/70">Network</p>
                <p className="text-sm font-medium text-[var(--text-primary)]">Ethereum Sepolia</p>
              </div>
              <div className="flex items-center justify-between p-4 rounded-2xl bg-white/50 border border-black/5">
                <p className="text-sm text-[var(--text-primary)]/70">Encryption</p>
                <p className="text-sm font-medium text-emerald-600">FHE Active</p>
              </div>
            </div>
          </div>

          {/* Sign Out */}
          <button
            onClick={handleSignOut}
            className="w-full h-14 px-6 rounded-2xl bg-red-50 text-red-600 font-medium transition-all hover:bg-red-100 flex items-center justify-center gap-2 border border-red-100"
            aria-label="Disconnect wallet"
          >
            <LogOut size={20} />
            <span>Sign Out</span>
          </button>
        </div>
      </div>
    </div>
  );
}
