import { useState, useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useDisconnect } from "wagmi";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useLookupName } from "@/hooks/useAddressResolver";
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
  Link2,
  Coins,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { truncateAddress } from "@/lib/address";
import toast from "react-hot-toast";
import { clearAllAddressScopes } from "@/lib/storage";
import { faucetUsdc } from "@/lib/faucet-client";
import { useChain } from "@/providers/ChainProvider";
import { useWorkspaceMode } from "@/providers/WorkspaceModeProvider";
import {
  WORKSPACE_MODES,
  WORKSPACE_MODE_LABELS,
  WORKSPACE_MODE_DESCRIPTIONS,
} from "@/lib/workspace-mode";

// Workspace mode picker — local to Settings since this is the only
// surface that should let the user pick. Reads/writes the global
// WorkspaceModeProvider so the sidebar re-renders live.
function WorkspaceModePicker() {
  const { mode, setMode } = useWorkspaceMode();
  return (
    <div className="p-4 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-[var(--text-secondary)]">Workspace mode</p>
          <p className="text-xs text-[var(--text-primary)]/40 mt-0.5">
            Choose which screens appear in the sidebar. Hidden ones still
            work via direct URL.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {WORKSPACE_MODES.map((m) => {
          const active = m === mode;
          return (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={
                active
                  ? "h-10 rounded-lg bg-[var(--text-primary)] text-white text-sm font-medium transition-colors"
                  : "h-10 rounded-lg bg-black/5 dark:bg-white/10 text-[var(--text-primary)] text-sm font-medium transition-colors hover:bg-black/10 dark:hover:bg-white/15"
              }
              aria-pressed={active}
            >
              {WORKSPACE_MODE_LABELS[m]}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-[var(--text-primary)]/50 italic">
        {WORKSPACE_MODE_DESCRIPTIONS[mode]}
      </p>
    </div>
  );
}

export default function Settings() {
  const navigate = useNavigate();
  // Passkey-aware address — fixes blank Settings page for passkey-only users.
  const { effectiveAddress: address } = useEffectiveAddress();
  const { disconnect } = useDisconnect();
  const [copied, setCopied] = useState(false);
  const [copiedShare, setCopiedShare] = useState<"link" | "html" | null>(null);

  // Phase 7.3: manual USDC faucet. Drips 100 testnet USDC to the user's
  // smart-account address via `/api/faucet/usdc`. Rate-limited server-side
  // so we don't need additional client-side throttling — just show a
  // pending state on the button.
  const { activeChainId, activeChain } = useChain();
  const [faucetLoading, setFaucetLoading] = useState(false);
  const handleFaucet = useCallback(async () => {
    if (!address) {
      toast.error("Connect a wallet first");
      return;
    }
    setFaucetLoading(true);
    const id = toast.loading("Minting 100 testnet USDC…");
    try {
      const result = await faucetUsdc({ address, chainId: activeChainId });
      if (result.ok) {
        toast.success("100 testnet USDC minted to your wallet", { id });
      } else if (result.error === "rate_limited") {
        const scope = result.rateLimitScope === "address" ? "this address" : "your network";
        toast.error(`Faucet rate-limited for ${scope} — try again in a bit.`, { id });
      } else {
        toast.error(`Faucet failed: ${result.error ?? "unknown"}`, { id });
      }
    } finally {
      setFaucetLoading(false);
    }
  }, [address, activeChainId]);

  // ENS reverse lookup — when the user has set a primary name, we use it
  // for the pay link instead of their raw address. Prettier and stable.
  const lookup = useLookupName(address as `0x${string}` | null);
  const payIdentifier = lookup.data ?? address ?? "";

  const origin = typeof window !== "undefined" ? window.location.origin : "https://blank.app";
  const payUrl = useMemo(
    () => (payIdentifier ? `${origin}/pay/${payIdentifier}` : ""),
    [origin, payIdentifier],
  );
  const badgeUrl = useMemo(
    () => (payIdentifier ? `${origin}/api/badge?for=${encodeURIComponent(payIdentifier)}` : ""),
    [origin, payIdentifier],
  );
  const signatureHtml = useMemo(() => {
    if (!payUrl || !badgeUrl) return "";
    return `<a href="${payUrl}?utm_source=email_sig"><img src="${badgeUrl}" alt="Pay me on Blank" width="240" height="60" style="border:0" /></a>`;
  }, [payUrl, badgeUrl]);

  const copyShare = useCallback(
    async (kind: "link" | "html") => {
      const value = kind === "link" ? payUrl : signatureHtml;
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
        setCopiedShare(kind);
        toast.success(kind === "link" ? "Pay link copied" : "Signature HTML copied");
        setTimeout(() => setCopiedShare(null), 2000);
      } catch {
        toast.error("Failed to copy");
      }
    },
    [payUrl, signatureHtml],
  );

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
    // #313: purge per-address caches BEFORE disconnect so a shared browser
    // doesn't leave the next user with the previous session's cached state.
    if (address) clearAllAddressScopes(address);
    disconnect();
    navigate("/", { replace: true });
  }, [address, disconnect, navigate]);

  // Loading state: render the page shell with the h1 so the route is
  // visibly addressable even before the smart account materializes
  // (caught in P13 render sweep — pages returning null on no-address
  // appear blank to crawlers + the e2e sweep).
  if (!address) {
    return (
      <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-4 mb-8">
            <div className="flex-1">
              <h1
                className="text-3xl font-semibold tracking-tight text-[var(--text-primary)]"
                style={{ fontFamily: "'Outfit', sans-serif" }}
              >
                Settings
              </h1>
              <p className="text-sm text-[var(--text-secondary)]">
                Loading your account...
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

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
                  {activeChain?.name ?? "Unknown chain"}
                </span>
              </div>
            </div>

            {/* Workspace mode — controls which screens appear in nav.
                Direct routes still work for any hidden screen. */}
            <WorkspaceModePicker />


            {/* Phase 7.3: testnet USDC faucet. Hidden in production via
                the `import.meta.env.PROD` toggle — only useful while
                Blank runs on Sepolia/Base Sepolia. */}
            {!import.meta.env.PROD && (
              <button
                onClick={handleFaucet}
                disabled={faucetLoading}
                className="w-full flex items-center justify-center gap-2 p-4 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-100 dark:border-emerald-500/20 text-emerald-700 dark:text-emerald-400 font-medium hover:bg-emerald-100 dark:hover:bg-emerald-500/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {faucetLoading ? <Loader2 size={18} className="animate-spin" /> : <Coins size={18} />}
                {faucetLoading ? "Minting…" : "Get 100 testnet USDC"}
              </button>
            )}

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

        {/* Pay-Me Link Section — Phase 2.1 distribution wedge */}
        <div className="glass-card-static rounded-[2rem] p-6 mb-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-12 h-12 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
              <Link2 size={24} />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">
                Pay-Me Link
              </h3>
              <p className="text-sm text-[var(--text-secondary)]">
                Drop this anywhere — email signature, Twitter bio, Discord profile
              </p>
            </div>
          </div>

          <div className="space-y-4">
            {/* Live badge preview */}
            <div className="rounded-xl border border-black/5 dark:border-white/5 bg-white/40 dark:bg-white/5 p-4 flex items-center justify-center">
              {badgeUrl ? (
                <a
                  href={payUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                  aria-label="Open your pay page"
                >
                  <img
                    src={badgeUrl}
                    alt="Pay me on Blank"
                    width={240}
                    height={60}
                    style={{ borderRadius: 8 }}
                  />
                </a>
              ) : (
                <p className="text-sm text-[var(--text-tertiary)]">No address connected</p>
              )}
            </div>

            {/* Pay URL row */}
            <div className="flex items-center justify-between p-4 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5 gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-xs text-[var(--text-secondary)] font-medium tracking-wide uppercase mb-1">
                  Pay URL
                </p>
                <p className="text-sm text-[var(--text-primary)] font-mono truncate">
                  {payUrl || "—"}
                </p>
              </div>
              <button
                onClick={() => copyShare("link")}
                disabled={!payUrl}
                className="h-9 px-4 rounded-lg bg-black/5 dark:bg-white/5 text-[var(--text-primary)] font-medium hover:bg-black/10 dark:hover:bg-white/10 disabled:opacity-40 flex items-center gap-2 shrink-0 text-sm"
                aria-label="Copy pay link"
              >
                {copiedShare === "link" ? (
                  <Check size={14} className="text-emerald-600" />
                ) : (
                  <Copy size={14} />
                )}
                {copiedShare === "link" ? "Copied" : "Copy"}
              </button>
            </div>

            {/* Email signature HTML row */}
            <div className="p-4 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5">
              <div className="flex items-center justify-between mb-2 gap-3">
                <p className="text-xs text-[var(--text-secondary)] font-medium tracking-wide uppercase">
                  Email Signature HTML
                </p>
                <button
                  onClick={() => copyShare("html")}
                  disabled={!signatureHtml}
                  className="h-8 px-3 rounded-lg bg-black/5 dark:bg-white/5 text-[var(--text-primary)] font-medium hover:bg-black/10 dark:hover:bg-white/10 disabled:opacity-40 flex items-center gap-2 text-xs"
                  aria-label="Copy signature HTML"
                >
                  {copiedShare === "html" ? (
                    <Check size={14} className="text-emerald-600" />
                  ) : (
                    <Copy size={14} />
                  )}
                  {copiedShare === "html" ? "Copied" : "Copy HTML"}
                </button>
              </div>
              <code className="block text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-all">
                {signatureHtml || "—"}
              </code>
              <p className="mt-3 text-xs text-[var(--text-tertiary)]">
                Paste into Gmail / Outlook / Apple Mail signature settings. Anyone you email can pay you in one click.
              </p>
            </div>
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
            onClick={() => navigate("/app/privacy")}
            className="w-full flex items-center justify-between p-4 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5 hover:bg-white/70 dark:hover:bg-white/10 transition-all text-left mb-3"
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

          {/* Phase 9.6 — stealth meta-address setup. Independent of FHE
              permits; lives in this section for discoverability. */}
          <button
            onClick={() => navigate("/app/stealth/setup")}
            className="w-full flex items-center justify-between p-4 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/5 hover:bg-white/70 dark:hover:bg-white/10 transition-all text-left"
          >
            <div>
              <p className="font-medium text-[var(--text-primary)]">
                Stealth meta-address
              </p>
              <p className="text-sm text-[var(--text-secondary)] mt-0.5">
                Publish a permanent meta-address; receive unlinkable stealth payments
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
                  {activeChain?.name ?? "Unknown chain"}
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
