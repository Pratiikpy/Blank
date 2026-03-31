import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount, useDisconnect } from "wagmi";
import {
  ChevronLeft,
  Copy,
  Check,
  Wallet,
  Shield,
  Sun,
  Moon,
  ExternalLink,
  LogOut,
  Info,
  Github,
} from "lucide-react";
import { cn } from "@/lib/cn";
import toast from "react-hot-toast";

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export default function Settings() {
  const navigate = useNavigate();
  const { address, chain } = useAccount();
  const { disconnect } = useDisconnect();
  const [copied, setCopied] = useState(false);

  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window === "undefined") return false;
    const stored = localStorage.getItem("blank_theme");
    if (stored !== null) return stored === "dark";
    return localStorage.getItem("blank_dark_mode") === "true";
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  }, [darkMode]);

  const toggleDarkMode = useCallback(() => {
    setDarkMode((prev) => {
      const next = !prev;
      localStorage.setItem("blank_theme", next ? "dark" : "light");
      localStorage.setItem("blank_dark_mode", String(next));
      return next;
    });
  }, []);

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

  const handleDisconnect = useCallback(() => {
    disconnect();
    navigate("/", { replace: true });
  }, [disconnect, navigate]);

  if (!address) return null;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate(-1)}
            className="w-11 h-11 rounded-full bg-white dark:bg-white/10 border border-black/5 dark:border-white/10 flex items-center justify-center shadow-sm"
            aria-label="Go back"
          >
            <ChevronLeft size={20} />
          </button>
          <div className="flex-1">
            <h1
              className="text-3xl font-semibold tracking-tight text-[var(--text-primary)]"
              style={{ fontFamily: "'Outfit', sans-serif" }}
            >
              Settings
            </h1>
            <p className="text-sm text-[var(--text-secondary)]">
              Manage your account and preferences
            </p>
          </div>
        </div>

        {/* Account Section */}
        <div className="glass-card-static rounded-[2rem] p-6 mb-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-12 h-12 rounded-xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
              <Wallet size={24} />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">
                Account
              </h3>
              <p className="text-sm text-[var(--text-secondary)]">
                Wallet and connection details
              </p>
            </div>
          </div>

          <div className="space-y-3">
            {/* Wallet Address */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-[var(--text-secondary)] font-medium tracking-wide uppercase mb-1">
                  Wallet Address
                </p>
                <p className="text-sm text-[var(--text-primary)] font-mono truncate">
                  {truncateAddress(address)}
                </p>
              </div>
              <button
                onClick={copyAddress}
                className="h-9 px-4 rounded-lg bg-black/5 dark:bg-white/5 text-[var(--text-primary)] font-medium transition-all hover:bg-black/10 dark:hover:bg-white/10 flex items-center gap-2 shrink-0 ml-3 text-sm"
                aria-label={copied ? "Copied" : "Copy address"}
              >
                {copied ? (
                  <Check size={14} className="text-emerald-600" />
                ) : (
                  <Copy size={14} />
                )}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            {/* Chain */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5">
              <p className="text-sm text-[var(--text-secondary)]">Network</p>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-500" />
                <span className="text-sm font-medium text-[var(--text-primary)]">
                  {chain?.name ?? "Ethereum Sepolia"}
                </span>
              </div>
            </div>

            {/* Disconnect */}
            <button
              onClick={handleDisconnect}
              className="w-full flex items-center justify-center gap-2 p-4 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-100 dark:border-red-500/20 text-red-600 dark:text-red-400 font-medium hover:bg-red-100 dark:hover:bg-red-500/20 transition-colors"
            >
              <LogOut size={18} />
              Disconnect Wallet
            </button>
          </div>
        </div>

        {/* Privacy Section */}
        <div className="glass-card-static rounded-[2rem] p-6 mb-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-12 h-12 rounded-xl bg-purple-50 dark:bg-purple-500/10 flex items-center justify-center text-purple-600 dark:text-purple-400">
              <Shield size={24} />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">
                Privacy
              </h3>
              <p className="text-sm text-[var(--text-secondary)]">
                FHE permits and access control
              </p>
            </div>
          </div>

          <button
            onClick={() => navigate("/privacy")}
            className="w-full flex items-center justify-between p-4 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5 hover:bg-white/70 dark:hover:bg-white/10 transition-all text-left"
          >
            <div>
              <p className="font-medium text-[var(--text-primary)]">
                Privacy Settings
              </p>
              <p className="text-sm text-[var(--text-secondary)] mt-0.5">
                Manage FHE permits, shared access, and encryption keys
              </p>
            </div>
            <ExternalLink size={16} className="text-[var(--text-secondary)] shrink-0 ml-3" />
          </button>
        </div>

        {/* Appearance Section */}
        <div className="glass-card-static rounded-[2rem] p-6 mb-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-12 h-12 rounded-xl bg-amber-50 dark:bg-amber-500/10 flex items-center justify-center text-amber-600 dark:text-amber-400">
              {darkMode ? <Moon size={24} /> : <Sun size={24} />}
            </div>
            <div>
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">
                Appearance
              </h3>
              <p className="text-sm text-[var(--text-secondary)]">
                Theme and display preferences
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between p-4 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5">
            <div>
              <p className="font-medium text-[var(--text-primary)]">Dark Mode</p>
              <p className="text-sm text-[var(--text-secondary)] mt-0.5">
                {darkMode ? "Dark theme is active" : "Light theme is active"}
              </p>
            </div>
            <button
              onClick={toggleDarkMode}
              className={cn(
                "w-12 h-7 rounded-full relative transition-colors duration-200 shrink-0",
                darkMode ? "bg-emerald-500" : "bg-[var(--bg-tertiary)]",
              )}
              role="switch"
              aria-checked={darkMode}
              aria-label="Toggle dark mode"
            >
              <div
                className={cn(
                  "absolute top-0.5 w-6 h-6 rounded-full bg-white shadow-sm transition-transform duration-200",
                  darkMode ? "translate-x-[22px]" : "translate-x-0.5",
                )}
              />
            </button>
          </div>
        </div>

        {/* About Section */}
        <div className="glass-card-static rounded-[2rem] p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-12 h-12 rounded-xl bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center text-blue-600 dark:text-blue-400">
              <Info size={24} />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">
                About
              </h3>
              <p className="text-sm text-[var(--text-secondary)]">
                Application information
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between p-4 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5">
              <p className="text-sm text-[var(--text-secondary)]">Version</p>
              <p className="text-sm font-medium text-[var(--text-primary)]">
                Blank v1.0
              </p>
            </div>

            <div className="flex items-center justify-between p-4 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5">
              <p className="text-sm text-[var(--text-secondary)]">Network</p>
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-100 dark:border-emerald-500/20">
                <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  Ethereum Sepolia Testnet
                </span>
              </span>
            </div>

            <div className="flex items-center justify-between p-4 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5">
              <p className="text-sm text-[var(--text-secondary)]">Encryption</p>
              <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                FHE (Fhenix CoFHE)
              </p>
            </div>

            <a
              href="https://github.com/FhenixProtocol"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between p-4 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5 hover:bg-white/70 dark:hover:bg-white/10 transition-all"
            >
              <div className="flex items-center gap-3">
                <Github size={18} className="text-[var(--text-secondary)]" />
                <p className="text-sm font-medium text-[var(--text-primary)]">
                  View on GitHub
                </p>
              </div>
              <ExternalLink size={14} className="text-[var(--text-secondary)]" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
