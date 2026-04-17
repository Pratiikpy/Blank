import { useState, useEffect, useCallback } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { parseUnits, formatUnits } from "viem";
import { formatUsdcBigint } from "@/lib/format";
import {
  Fingerprint,
  ShieldCheck,
  Loader2,
  AlertCircle,
  Copy,
  Trash2,
  Wallet,
  ExternalLink,
  Send,
  Banknote,
} from "lucide-react";
import toast from "react-hot-toast";
import { useSmartAccount } from "@/hooks/useSmartAccount";
import { useChain } from "@/providers/ChainProvider";
import { TestUSDCAbi } from "@/lib/abis";

// ──────────────────────────────────────────────────────────────────
//  SmartWallet (`/app/wallet`) — passkey signup + account info.
//
//  Three states:
//   - no passkey on this chain → "Create your smart wallet" form
//   - passkey exists, account not deployed → show counterfactual
//     address + "Your wallet deploys lazily on the first transaction"
//   - passkey exists, account deployed → show address + "Send a UserOp"
//     test button + delete option
// ──────────────────────────────────────────────────────────────────

export default function SmartWallet() {
  const { status, account, error, createAccount, removeAccount, refresh } = useSmartAccount();
  const { address: eoaAddress } = useAccount();
  const { activeChain, contracts } = useChain();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [creating, setCreating] = useState(false);

  // Fund-in flow state — read USDC balance of smart account + EOA, let user
  // transfer USDC from EOA to smart account with one click.
  const [smartUsdc, setSmartUsdc] = useState<bigint | null>(null);
  const [eoaUsdc, setEoaUsdc] = useState<bigint | null>(null);
  const [fundAmount, setFundAmount] = useState("100");
  const [funding, setFunding] = useState(false);

  const refreshBalances = useCallback(async () => {
    if (!publicClient || !account || !eoaAddress) return;
    try {
      const [s, e] = await Promise.all([
        publicClient.readContract({
          address: contracts.TestUSDC,
          abi: TestUSDCAbi,
          functionName: "balanceOf",
          args: [account.address],
        }) as Promise<bigint>,
        publicClient.readContract({
          address: contracts.TestUSDC,
          abi: TestUSDCAbi,
          functionName: "balanceOf",
          args: [eoaAddress],
        }) as Promise<bigint>,
      ]);
      setSmartUsdc(s);
      setEoaUsdc(e);
    } catch (err) {
      console.warn("[SmartWallet] balance refresh failed:", err);
    }
  }, [publicClient, account, eoaAddress, contracts]);

  useEffect(() => {
    refreshBalances();
    const id = setInterval(refreshBalances, 10_000);
    return () => clearInterval(id);
  }, [refreshBalances]);

  const handleFund = useCallback(async () => {
    if (!account || !eoaAddress) return;
    const value = parseFloat(fundAmount);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Enter a positive amount");
      return;
    }
    const wei = parseUnits(String(value), 6);
    if (eoaUsdc !== null && wei > eoaUsdc) {
      toast.error(`Insufficient USDC in your EOA — have ${formatUnits(eoaUsdc, 6)}, need ${value}`);
      return;
    }
    setFunding(true);
    try {
      const hash = await writeContractAsync({
        address: contracts.TestUSDC,
        abi: TestUSDCAbi,
        functionName: "transfer",
        args: [account.address, wei],
      });
      toast.loading("Funding smart wallet…", { id: "fund-tx" });
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      }
      toast.success(`Sent ${value} USDC to your smart wallet!`, { id: "fund-tx" });
      await refreshBalances();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Fund transfer failed";
      toast.error(msg, { id: "fund-tx" });
    } finally {
      setFunding(false);
    }
  }, [account, eoaAddress, fundAmount, eoaUsdc, writeContractAsync, publicClient, refreshBalances, contracts]);

  const handleFaucet = useCallback(async () => {
    if (!eoaAddress) return;
    setFunding(true);
    try {
      const hash = await writeContractAsync({
        address: contracts.TestUSDC,
        abi: TestUSDCAbi,
        functionName: "faucet",
      });
      toast.loading("Minting 10,000 USDC to your EOA…", { id: "faucet-tx" });
      if (publicClient) {
        await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      }
      toast.success("10,000 USDC minted to your EOA — now click Fund", { id: "faucet-tx" });
      await refreshBalances();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Faucet failed", { id: "faucet-tx" });
    } finally {
      setFunding(false);
    }
  }, [eoaAddress, writeContractAsync, publicClient, refreshBalances, contracts]);

  const handleCreate = async () => {
    if (passphrase.length < 8) {
      toast.error("Passphrase must be at least 8 characters");
      return;
    }
    if (passphrase !== confirmPassphrase) {
      toast.error("Passphrases don't match");
      return;
    }
    setCreating(true);
    try {
      const result = await createAccount(passphrase);
      if (result) {
        toast.success("Smart wallet created — counterfactual address ready");
        setPassphrase("");
        setConfirmPassphrase("");
      }
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(
      "Delete your smart wallet? This is irreversible — any funds in the on-chain account will be unreachable from this browser.",
    )) return;
    await removeAccount();
    toast.success("Smart wallet deleted from this browser");
  };

  const copyAddress = () => {
    if (!account) return;
    navigator.clipboard.writeText(account.address);
    toast.success("Address copied");
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-3xl mx-auto">
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-2">
            <Fingerprint size={22} className="text-blue-600 dark:text-blue-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">
              Smart wallet · ERC-4337 · {activeChain.shortName}
            </span>
          </div>
          <h1 className="text-3xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Your wallet, no seed phrase
          </h1>
          <p className="text-sm sm:text-base text-[var(--text-primary)]/50 leading-relaxed max-w-2xl">
            A P-256 keypair generated in this browser, encrypted with a passphrase
            you choose. Sign every transaction with the passphrase. The smart
            account on-chain only knows the public key — your private key never
            leaves your device.
          </p>
        </div>

        {/* No passkey yet */}
        {status === "no-passkey" && (
          <div className="glass-card-static rounded-[2rem] p-4 sm:p-8 space-y-6">
            <div>
              <h2 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-2">
                Create your smart wallet
              </h2>
              <p className="text-sm text-[var(--text-secondary)]">
                Pick a passphrase (8+ chars). It encrypts your signing key locally
                — write it down somewhere safe; we can't recover it for you.
              </p>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5 block">
                  Passphrase
                </label>
                <input
                  type="password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder="At least 8 characters"
                  disabled={creating}
                  autoComplete="new-password"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  name="blank-new-passphrase"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  className="w-full h-12 px-4 rounded-2xl bg-white/60 dark:bg-white/[0.03] border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none font-mono text-sm disabled:opacity-50"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-1.5 block">
                  Confirm
                </label>
                <input
                  type="password"
                  value={confirmPassphrase}
                  onChange={(e) => setConfirmPassphrase(e.target.value)}
                  placeholder="Re-enter to confirm"
                  disabled={creating}
                  autoComplete="new-password"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  name="blank-confirm-passphrase"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  className="w-full h-12 px-4 rounded-2xl bg-white/60 dark:bg-white/[0.03] border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none font-mono text-sm disabled:opacity-50"
                />
              </div>
            </div>

            <button
              onClick={handleCreate}
              disabled={creating || !passphrase || !confirmPassphrase}
              className="w-full h-14 rounded-2xl bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] font-medium hover:bg-black dark:hover:bg-gray-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {creating ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Generating P-256 key...
                </>
              ) : (
                <>
                  <Fingerprint size={16} /> Create smart wallet
                </>
              )}
            </button>

            {error && (
              <div className="flex items-center gap-2 text-sm text-red-600">
                <AlertCircle size={16} />
                <span>{error}</span>
              </div>
            )}

            <div className="pt-4 border-t border-black/5 dark:border-white/5 text-xs text-[var(--text-tertiary)] leading-relaxed">
              <strong className="text-[var(--text-secondary)]">How this works:</strong>{" "}
              We generate a P-256 keypair in your browser using @noble/curves. The
              private key is encrypted with your passphrase via AES-256-GCM (key
              derived via PBKDF2 with 250K iterations) and stored in IndexedDB.
              Your smart account address on-chain is fully deterministic from the
              public key — same key, same address, no on-chain registration needed
              until your first transaction.
            </div>
          </div>
        )}

        {/* Passkey exists */}
        {status === "ready" && account && (
          <div className="space-y-5">
            {/* Address card */}
            <div className="glass-card-static rounded-[2rem] p-4 sm:p-8">
              <div className="flex items-start gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center text-blue-600 dark:text-blue-400">
                  <Wallet size={18} />
                </div>
                <div className="flex-1">
                  <h2 className="text-lg font-heading font-medium text-[var(--text-primary)]">
                    Smart account
                  </h2>
                  <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
                    {account.isDeployed
                      ? "Deployed on-chain — ready to send UserOps"
                      : "Counterfactual — deploys lazily on first UserOp"}
                  </p>
                </div>
                {account.isDeployed && (
                  <span className="text-xs font-semibold uppercase tracking-wider px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                    Live
                  </span>
                )}
              </div>

              <div className="rounded-2xl bg-white/40 dark:bg-black/20 border border-black/5 dark:border-white/5 p-4 mb-3 font-mono text-sm break-all">
                {account.address}
              </div>

              <div className="flex items-center gap-2 text-xs">
                <button
                  onClick={copyAddress}
                  className="font-medium px-3 py-2 rounded-lg bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.05] dark:hover:bg-white/[0.08] text-[var(--text-secondary)] transition-colors flex items-center gap-1.5"
                >
                  <Copy size={12} /> Copy
                </button>
                {account.isDeployed && (
                  <a
                    href={`${activeChain.explorerUrl}/address/${account.address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium px-3 py-2 rounded-lg bg-black/[0.04] hover:bg-black/[0.07] dark:bg-white/[0.05] dark:hover:bg-white/[0.08] text-[var(--text-secondary)] transition-colors flex items-center gap-1.5"
                  >
                    <ExternalLink size={12} /> Explorer
                  </a>
                )}
              </div>
            </div>

            {/* Fund-in card */}
            <div className="glass-card-static rounded-[2rem] p-4 sm:p-8">
              <div className="flex items-start gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-500/10 flex items-center justify-center text-amber-600 dark:text-amber-400">
                  <Banknote size={18} />
                </div>
                <div>
                  <h3 className="text-base font-heading font-medium text-[var(--text-primary)]">
                    Fund your smart wallet
                  </h3>
                  <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
                    Send USDC from your EOA → smart account. Required before shielding.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 mb-5">
                <div className="rounded-2xl bg-white/40 dark:bg-black/20 border border-black/5 dark:border-white/5 p-4">
                  <div className="text-[11px] uppercase tracking-wider text-[var(--text-tertiary)] mb-1">
                    EOA balance (source)
                  </div>
                  <div className="font-mono text-lg font-semibold text-[var(--text-primary)]">
                    {!eoaAddress ? (
                      <span className="text-sm text-[var(--text-tertiary)]">No MetaMask connected</span>
                    ) : (
                      <>{eoaUsdc !== null ? formatUsdcBigint(eoaUsdc) : "—"} USDC</>
                    )}
                  </div>
                </div>
                <div className="rounded-2xl bg-emerald-50/50 dark:bg-emerald-500/5 border border-emerald-200/40 dark:border-emerald-500/20 p-4">
                  <div className="text-[11px] uppercase tracking-wider text-emerald-700 dark:text-emerald-300 mb-1">
                    Smart wallet balance
                  </div>
                  <div className="font-mono text-lg font-semibold text-emerald-700 dark:text-emerald-300">
                    {smartUsdc !== null ? formatUsdcBigint(smartUsdc) : "—"} USDC
                  </div>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3">
                <div className="flex-1 relative">
                  <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]">$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={fundAmount}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setFundAmount(v);
                    }}
                    disabled={funding}
                    placeholder="100"
                    className="h-12 w-full pl-8 pr-4 rounded-2xl bg-white/60 dark:bg-white/[0.03] border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none text-base font-mono tabular-nums disabled:opacity-50"
                  />
                </div>
                <button
                  onClick={handleFund}
                  disabled={funding || !eoaUsdc || eoaUsdc === 0n}
                  className="h-12 px-5 rounded-2xl bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] font-medium hover:bg-black dark:hover:bg-gray-100 transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {funding ? (
                    <>
                      <Loader2 size={14} className="animate-spin" /> Sending…
                    </>
                  ) : (
                    <>
                      <Send size={14} /> Fund wallet
                    </>
                  )}
                </button>
              </div>

              {eoaAddress && (!eoaUsdc || eoaUsdc === 0n) && (
                <div className="mt-3 flex items-center justify-between gap-2 text-xs">
                  <span className="text-[var(--text-tertiary)]">Need test USDC first?</span>
                  <button
                    onClick={handleFaucet}
                    disabled={funding || !eoaAddress}
                    className="font-medium px-3 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 dark:bg-amber-500/10 dark:hover:bg-amber-500/15 text-amber-700 dark:text-amber-300 transition-colors disabled:opacity-50"
                  >
                    Mint 10,000 USDC to my EOA
                  </button>
                </div>
              )}

              <p className="text-[11px] text-[var(--text-tertiary)] mt-4 leading-relaxed">
                The smart wallet's USDC balance is what dashboards / shield / send all read against
                when your passkey is active. Without funding, those flows show $0.
              </p>
            </div>

            {/* Pubkey + delete card */}
            <div className="glass-card-static rounded-[2rem] p-4 sm:p-8">
              <div className="flex items-start gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-purple-50 dark:bg-purple-500/10 flex items-center justify-center text-purple-600 dark:text-purple-400">
                  <ShieldCheck size={18} />
                </div>
                <div>
                  <h3 className="text-base font-heading font-medium text-[var(--text-primary)]">
                    P-256 public key
                  </h3>
                  <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
                    The on-chain BlankAccount stores these as ownerX / ownerY
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-[var(--text-tertiary)] mb-1">x</div>
                  <code className="block text-xs font-mono break-all text-[var(--text-secondary)] bg-black/[0.04] dark:bg-white/[0.04] rounded-lg p-2.5">
                    {account.pubX}
                  </code>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-[var(--text-tertiary)] mb-1">y</div>
                  <code className="block text-xs font-mono break-all text-[var(--text-secondary)] bg-black/[0.04] dark:bg-white/[0.04] rounded-lg p-2.5">
                    {account.pubY}
                  </code>
                </div>
              </div>

              <button
                onClick={handleDelete}
                className="text-xs font-medium px-3 py-2 rounded-lg bg-red-50 hover:bg-red-100 dark:bg-red-500/10 dark:hover:bg-red-500/15 text-red-700 dark:text-red-300 transition-colors flex items-center gap-1.5"
              >
                <Trash2 size={12} /> Delete from this browser
              </button>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-red-600 px-2">
                <AlertCircle size={16} />
                <span>{error}</span>
                <button onClick={refresh} className="underline">retry</button>
              </div>
            )}
          </div>
        )}

        {status === "idle" && (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={24} className="animate-spin opacity-30" />
          </div>
        )}
      </div>
    </div>
  );
}
