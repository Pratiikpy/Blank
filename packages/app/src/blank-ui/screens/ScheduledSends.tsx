// Phase 4.1 — ScheduledSends management screen.
//
// Lets the user authorize a server-held session key to fire recurring
// USDC transfers within a tight scope (recipient, max amount, period,
// expiry). The actual cron + KMS storage isn't wired in this release —
// surface the "stub" warning so the user knows their setup is queued
// for the next ship.
//
// Build order from a fresh state:
//   1. UpgradeBanner on Dashboard → user's proxy upgrades to v041
//   2. EnableValidator self-call (one-time, scoped per session-key
//      validator) — the screen handles this on first scope creation
//      since enable-then-set-scope can be batched in one UserOp via
//      executeBatch (future polish; today we surface a one-time prompt)
//   3. setScope per (sessionKey, recipient) — registers the authorization
//   4. Cron eventually fires UserOps signed by the session key

import { useState } from "react";
import {
  CalendarClock,
  Plus,
  Trash2,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Clock,
  X,
} from "lucide-react";
import toast from "react-hot-toast";
import { toastMappedError } from "@/lib/error-messages";
import { type Address, encodeFunctionData, isAddress, parseUnits, zeroAddress } from "viem";
import { usePublicClient } from "wagmi";
import { useScheduledSends } from "@/hooks/useScheduledSends";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useEmailAuthSigner } from "@/hooks/useEmailAuthSigner";
import { buildScheduledSendCreateSignableMessage } from "@/lib/email-client";
import { useAccountVersion } from "@/hooks/useAccountVersion";
import { useChain } from "@/providers/ChainProvider";
import { useUnifiedWrite } from "@/hooks/useUnifiedWrite";
import { usePaymasterHealth } from "@/hooks/usePaymasterHealth";
import { useBalance } from "wagmi";
import {
  PERIOD_PRESETS,
  SessionKeyValidatorAbi,
  computeNextFireSeconds,
  formatTimeUntil,
} from "@/lib/scheduled-sends";
import { truncateAddress } from "@/lib/address";
import { cn } from "@/lib/cn";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as const;

const BlankAccountAbi = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "executeBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "targets", type: "address[]" },
      { name: "values", type: "uint256[]" },
      { name: "datas", type: "bytes[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "enableValidator",
    stateMutability: "nonpayable",
    inputs: [{ name: "validator", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "enabledValidators",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;


export default function ScheduledSends() {
  const { effectiveAddress } = useEffectiveAddress();
  const { contracts, activeChain, activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { status: accountStatus } = useAccountVersion();
  const { unifiedWrite } = useUnifiedWrite();
  const paymasterHealth = usePaymasterHealth();
  // Phase 7.5 self-pay readiness: thread `paymaster: "self"` when the
  // paymaster is unavailable AND the AA has enough ETH. Same pattern as
  // SendConfirm + UpgradeBanner — admin ops shouldn't be blocked by a
  // paymaster outage. Audit caught this missing.
  const aaBalance = useBalance({
    address: effectiveAddress as `0x${string}` | undefined,
    chainId: activeChainId,
    query: { enabled: !!effectiveAddress, refetchInterval: 30_000 },
  });
  const SELF_PAY_REQUIRED_WEI = 1_000_000_000_000_000n;
  const aaCanSelfPay = (aaBalance.data?.value ?? 0n) >= SELF_PAY_REQUIRED_WEI;
  const paymasterMode: "self" | undefined =
    paymasterHealth.status === "unavailable" && aaCanSelfPay ? "self" : undefined;
  const { scopes, isLoading, error, refetch, revokeScope } = useScheduledSends();
  // #350 — Wallet-signed auth for the keypair-creation request. Proves
  // the caller controls `effectiveAddress` so an attacker can't spam
  // keypair generation tied to a victim's AA.
  const { signEmailAuth } = useEmailAuthSigner();

  const validatorAddr = (contracts.SessionKeyValidator ?? ZERO_ADDR) as Address;
  const validatorDeployed = validatorAddr !== ZERO_ADDR;
  const accountReady = accountStatus === "current";

  const [createOpen, setCreateOpen] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [period, setPeriod] = useState<number>(PERIOD_PRESETS[1].seconds); // weekly default
  const [validUntilDays, setValidUntilDays] = useState(180);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [revokingKey, setRevokingKey] = useState<string | null>(null);
  // Audit Top-28 #15 + #18: stub-mode state. The backend returns
  // `{ stub: true }` from /api/scheduled-sends/create when the cron + KMS
  // backing isn't wired yet. The previous behaviour was a 6-second toast
  // that fades. Persist the flag for the lifetime of the screen so the
  // user has a continuously-visible banner indicating their schedule is
  // queued but won't fire. Once the backend ships the cron, this stays
  // false and the banner doesn't render.
  const [stubModeDetected, setStubModeDetected] = useState(false);

  const resetForm = () => {
    setCreateOpen(false);
    setRecipient("");
    setAmount("");
    setPeriod(PERIOD_PRESETS[1].seconds);
    setValidUntilDays(180);
    setLabel("");
  };

  const handleCreate = async () => {
    if (!effectiveAddress || !validatorDeployed) {
      toast.error("Account or validator not ready");
      return;
    }
    if (!isAddress(recipient) || recipient === zeroAddress) {
      toast.error("Enter a valid recipient address");
      return;
    }
    if (!amount || parseFloat(amount) <= 0) {
      toast.error("Enter a positive amount");
      return;
    }
    setCreating(true);
    try {
      // Step 1: read enabledValidators from chain.
      let enabled = false;
      if (publicClient) {
        enabled = (await publicClient.readContract({
          address: effectiveAddress as `0x${string}`,
          abi: BlankAccountAbi,
          functionName: "enabledValidators",
          args: [validatorAddr],
        })) as boolean;
      }

      // Step 2: sign the scope-creation request so the backend can prove
      // the caller controls `effectiveAddress`. Without this signature an
      // attacker could spam keypair generation tied to ANY victim's AA —
      // server-side anti-pollution gate (#350). The signature is bound
      // to (account, recipient, spendToken, chainId, signedAt) so a
      // captured sig cannot be replayed for a different scope.
      const signedAt = Math.floor(Date.now() / 1000);
      const sigMsg = buildScheduledSendCreateSignableMessage({
        account: effectiveAddress,
        recipient,
        spendToken: contracts.TestUSDC,
        chainId: activeChainId,
        signedAt,
      });
      const sig = await signEmailAuth(sigMsg, signedAt);
      if (!sig) {
        throw new Error("Wallet signature required to create scheduled send");
      }

      // Step 3: generate session key via the backend (now persists to
      // an encrypted keystore + cron will fire UserOps from it).
      const res = await fetch("/api/scheduled-sends/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: effectiveAddress,
          chainId: activeChainId,
          recipient,
          spendToken: contracts.TestUSDC,
          label: label.trim() || undefined,
          signature: sig.signature,
          signerAddress: sig.signerAddress,
          signedAt: sig.signedAt,
          signerChainId: sig.signerChainId,
        }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errJson.error ?? `Backend rejected: ${res.status}`);
      }
      const json = (await res.json()) as { sessionKey: string; stub?: boolean };
      if (json.stub) {
        // Audit Top-28 #15 + #18: persist the stub state so the
        // banner stays visible — a 6s toast fades while the user is
        // still configuring their next field, leaving them to think
        // the schedule is active when it isn't.
        setStubModeDetected(true);
        toast(
          "Session key generated, but the cron isn't wired yet. Fires won't trigger until next release.",
          { icon: "⏳", duration: 8000 },
        );
      }

      // Step 4: encode amount + scope.
      const amountBase = parseUnits(amount, 6);
      if (amountBase === 0n) {
        throw new Error("Amount below smallest USDC unit (0.000001)");
      }
      if (amountBase > (1n << 128n) - 1n) {
        throw new Error("Amount exceeds uint128 cap");
      }
      const validUntil = Math.floor(Date.now() / 1000) + validUntilDays * 86400;
      const setScopeData = encodeFunctionData({
        abi: SessionKeyValidatorAbi,
        functionName: "setScope",
        args: [
          json.sessionKey as Address,
          {
            recipient: recipient as Address,
            spendToken: contracts.TestUSDC as Address,
            maxAmountPerCall: amountBase,
            periodSeconds: period,
            validUntil,
            lastFiredAt: 0, // contract overrides with block.timestamp - period
          },
        ],
      });

      // Step 4: fire the on-chain authorization. When the validator
      // isn't yet enabled, batch enable+setScope into a single
      // executeBatch UserOp — one passkey prompt, atomic, paymaster
      // sponsors both. Otherwise fire a single execute.
      if (!enabled) {
        toast("First-time setup: enabling validator + scope in one tx…", {
          icon: "🔧",
        });
        const enableData = encodeFunctionData({
          abi: BlankAccountAbi,
          functionName: "enableValidator",
          args: [validatorAddr],
        });
        await unifiedWrite({
          address: effectiveAddress as `0x${string}`,
          abi: BlankAccountAbi,
          functionName: "executeBatch",
          args: [
            [effectiveAddress as `0x${string}`, validatorAddr],
            [0n, 0n],
            [enableData, setScopeData],
          ],
          gas: 400_000n,
          paymaster: paymasterMode,
        });
      } else {
        await unifiedWrite({
          address: effectiveAddress as `0x${string}`,
          abi: BlankAccountAbi,
          functionName: "execute",
          args: [validatorAddr, 0n, setScopeData],
          gas: 250_000n,
          paymaster: paymasterMode,
        });
      }
      await refetch();
      toast.success("Scheduled send authorized on chain");
      resetForm();
    } catch (err) {
      toastMappedError(err);
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (sessionKey: Address) => {
    if (
      !confirm(
        "Revoke this scheduled send? The server-held session key will no longer authorize transfers. This is irreversible. You'd need to set up a new one to resume.",
      )
    ) {
      return;
    }
    setRevokingKey(sessionKey.toLowerCase());
    try {
      await revokeScope(sessionKey, paymasterMode);
      toast.success("Scheduled send revoked");
    } catch (err) {
      toastMappedError(err);
    } finally {
      setRevokingKey(null);
    }
  };

  if (!effectiveAddress) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <h1 className="text-3xl font-medium tracking-tight mb-2">
          Scheduled sends
        </h1>
        <p className="text-sm text-[var(--text-secondary)]">
          Connect your wallet to set up recurring payments.
        </p>
      </div>
    );
  }

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* Header */}
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center">
              <CalendarClock size={20} className="text-violet-600 dark:text-violet-400" />
            </div>
            <h1
              className="text-3xl sm:text-4xl font-medium tracking-tight"
              style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
            >
              Scheduled sends
            </h1>
          </div>
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed max-w-2xl">
            Authorize a session key to fire recurring USDC transfers on a
            fixed cadence (rent, payroll, subscriptions). Each authorization
            is scoped to one recipient + max amount + min interval + expiry.
            You can revoke at any time.
          </p>
        </div>

        {/* Pre-flight gate: account upgrade required */}
        {accountStatus === "needs-upgrade" && (
          <div className="rounded-2xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 p-4 flex gap-3">
            <AlertTriangle size={20} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200 mb-0.5">
                Upgrade your account first
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-300/80 leading-snug">
                Scheduled sends need the v0.4.1 BlankAccount implementation
                with validator dispatch. Tap "Upgrade" on the Dashboard
                banner to enable it (one-time UUPS upgrade, your address +
                balances are preserved).
              </p>
            </div>
          </div>
        )}

        {/* Pre-flight gate: validator not yet available on this chain. */}
        {!validatorDeployed && (
          <div className="rounded-2xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 p-4 flex gap-3">
            <AlertTriangle size={20} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-amber-900 dark:text-amber-200 mb-0.5">
                Scheduled sends aren't available on {activeChain.name} yet
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-300/80 leading-snug">
                Try switching to a different network from the chain
                selector. We're rolling this feature out chain by chain
                as the underlying validator is deployed.
              </p>
            </div>
          </div>
        )}

        {/* Cron-cadence note — Hobby tier supports daily fires only. Pro
            users can lower the cadence in vercel.json to align with the
            user's actual period. */}
        {accountReady && validatorDeployed && (
          <div className="rounded-2xl bg-indigo-50 dark:bg-indigo-500/10 border border-indigo-200 dark:border-indigo-500/30 p-4 flex gap-3">
            <Clock size={20} className="text-indigo-600 dark:text-indigo-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-indigo-900 dark:text-indigo-200 mb-0.5">
                Cron fires daily at 00:00 UTC
              </p>
              <p className="text-sm text-indigo-700 dark:text-indigo-300/80 leading-snug">
                The server tick checks for due scopes once per day (Vercel
                Hobby tier limit). On Pro you can drop it to every 15
                minutes by editing vercel.json. The on-chain validAfter
                stops any scope from firing more than once per period.
              </p>
            </div>
          </div>
        )}

        {/* Create button */}
        {accountReady && validatorDeployed && (
          <button
            onClick={() => setCreateOpen(true)}
            data-testid="scheduled-create-button"
            className="w-full rounded-2xl bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] font-medium hover:bg-black p-4 flex items-center justify-center gap-2 transition-all"
          >
            <Plus size={18} />
            <span>Set up a scheduled send</span>
          </button>
        )}

        {/* Error surface */}
        {error && (
          <div className="rounded-2xl bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 p-4 text-sm text-rose-900 dark:text-rose-200">
            {error}
          </div>
        )}

        {/* Audit Top-28 #15 + #18: persistent stub-mode banner. Visible
            for as long as the screen is mounted once we've detected the
            backend isn't wiring fires yet. Replaces the 6s toast that
            previously buried this critical fact. */}
        {stubModeDetected && (
          <div
            role="status"
            className="rounded-2xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 p-4 text-sm text-amber-900 dark:text-amber-200 flex items-start gap-3"
          >
            <AlertTriangle size={18} className="shrink-0 mt-0.5" />
            <div>
              <p className="font-medium mb-1">Schedules are queued — not firing yet</p>
              <p className="text-amber-800 dark:text-amber-200/90 leading-snug">
                Your session-key scope is registered on-chain, but the cron + KMS
                backing that actually fires the recurring tx hasn't shipped on this
                deployment. Don't rely on these to send funds until that lands. You'll
                see this banner disappear once it's live.
              </p>
            </div>
          </div>
        )}

        {/* Scope list */}
        {isLoading ? (
          <div className="rounded-[2rem] glass-card-static p-10 text-center">
            <Loader2 size={20} className="animate-spin mx-auto text-[var(--text-tertiary)]" />
            <p className="mt-3 text-sm text-[var(--text-secondary)]">Loading scopes…</p>
          </div>
        ) : scopes.length === 0 && validatorDeployed && accountReady ? (
          <div className="rounded-[2rem] glass-card-static p-10 text-center">
            <div className="w-12 h-12 rounded-2xl bg-violet-500/10 flex items-center justify-center mx-auto mb-4">
              <CalendarClock size={22} className="text-violet-600 dark:text-violet-400" />
            </div>
            <p className="text-base font-medium text-[var(--text-primary)] mb-1">
              No scheduled sends yet
            </p>
            <p className="text-sm text-[var(--text-secondary)] max-w-sm mx-auto">
              Set one up above to authorize a recurring transfer scope.
            </p>
          </div>
        ) : (
          <div className="space-y-3" data-testid="scope-list">
            {scopes.map((s) => {
              const nextFireSec = computeNextFireSeconds(s);
              const nowSec = Math.floor(Date.now() / 1000);
              const untilLabel = formatTimeUntil(nextFireSec - nowSec);
              const amountHuman = (Number(s.maxAmountPerCall) / 1e6).toLocaleString(undefined, {
                maximumFractionDigits: 6,
              });
              const periodLabel =
                PERIOD_PRESETS.find((p) => p.seconds === s.periodSeconds)?.label ??
                `${s.periodSeconds}s`;
              const expires = new Date(s.validUntil * 1000).toLocaleDateString();
              const isRevoking = revokingKey === s.sessionKey.toLowerCase();
              return (
                <div
                  key={s.sessionKey}
                  data-testid={`scope-${s.sessionKey}`}
                  className="rounded-2xl glass-card-static p-5"
                >
                  <div className="flex items-start gap-3 flex-wrap">
                    <div
                      className={cn(
                        "w-10 h-10 rounded-xl flex items-center justify-center shrink-0",
                        s.isExpired
                          ? "bg-rose-500/10 text-rose-700 dark:text-rose-300"
                          : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                      )}
                    >
                      {s.isExpired ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-[var(--text-primary)] flex items-center gap-2 flex-wrap">
                        <span>
                          ${amountHuman} USDC{" "}
                          <span className="text-[var(--text-secondary)] font-normal">
                            to {truncateAddress(s.recipient)}
                          </span>
                        </span>
                        {s.isExpired && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-700 dark:text-rose-300 font-semibold uppercase tracking-wider">
                            Expired
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
                        {periodLabel} · expires {expires}
                        {!s.isExpired && (
                          <>
                            {" · next fire "}
                            <span className="text-[var(--text-secondary)]">{untilLabel}</span>
                          </>
                        )}
                      </p>
                      <p className="text-[10px] font-mono text-[var(--text-tertiary)] mt-1 truncate">
                        Session key: {s.sessionKey}
                      </p>
                    </div>
                    <button
                      onClick={() => void handleRevoke(s.sessionKey)}
                      disabled={isRevoking}
                      aria-label="Revoke scope"
                      data-testid={`scope-revoke-${s.sessionKey}`}
                      className="w-9 h-9 rounded-xl hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400 flex items-center justify-center text-[var(--text-tertiary)] disabled:opacity-50 shrink-0"
                    >
                      {isRevoking ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Trash2 size={16} />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
            {/* Refresh hint */}
            <button
              onClick={() => void refetch()}
              className="w-full text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] py-2"
            >
              Refresh scopes
            </button>
          </div>
        )}

        {/* Footer */}
        <p className="text-xs text-[var(--text-tertiary)] text-center">
          Account: {truncateAddress(effectiveAddress)} · {activeChain.name}
        </p>
      </div>

      {/* Create modal */}
      {createOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm overflow-y-auto"
          onClick={(e) => {
            if (e.target === e.currentTarget && !creating) resetForm();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !creating) resetForm();
          }}
        >
          <div className="w-full max-w-md rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-6 sm:p-8 my-8 animate-in fade-in slide-in-from-bottom-4 duration-300 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">
                New scheduled send
              </h3>
              <button
                onClick={resetForm}
                disabled={creating}
                aria-label="Close"
                className="w-8 h-8 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 flex items-center justify-center text-[var(--text-secondary)]"
              >
                <X size={16} />
              </button>
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5 block">
                Label
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value.slice(0, 64))}
                placeholder="e.g. Rent for March"
                aria-label="Label"
                className="h-11 w-full px-3 rounded-xl bg-white/60 dark:bg-white/5 border border-black/10 dark:border-white/15 outline-none focus:border-black/30 dark:focus:border-white/30 transition-all placeholder:text-[var(--text-tertiary)]"
              />
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5 block">
                Recipient
              </label>
              <input
                type="text"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value.trim())}
                placeholder="0x..."
                aria-label="Recipient address"
                data-testid="scheduled-recipient"
                className="h-11 w-full px-3 rounded-xl bg-white/60 dark:bg-white/5 border border-black/10 dark:border-white/15 outline-none focus:border-black/30 dark:focus:border-white/30 transition-all font-mono text-sm placeholder:text-[var(--text-tertiary)]"
              />
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5 block">
                Max per fire (USDC)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]">
                  $
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "" || /^\d*\.?\d*$/.test(v)) setAmount(v);
                  }}
                  placeholder="0.00"
                  aria-label="Maximum amount per fire"
                  data-testid="scheduled-amount"
                  className="h-11 w-full pl-7 pr-3 rounded-xl bg-white/60 dark:bg-white/5 border border-black/10 dark:border-white/15 outline-none focus:border-black/30 dark:focus:border-white/30 transition-all"
                />
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5 block">
                Cadence
              </label>
              <div className="grid grid-cols-2 gap-2">
                {PERIOD_PRESETS.map((p) => (
                  <button
                    key={p.seconds}
                    onClick={() => setPeriod(p.seconds)}
                    data-testid={`scheduled-period-${p.seconds}`}
                    className={cn(
                      "h-10 rounded-xl text-sm font-medium transition-all",
                      period === p.seconds
                        ? "bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A]"
                        : "bg-black/5 dark:bg-white/5 text-[var(--text-secondary)] hover:bg-black/10",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5 block">
                Expires after
              </label>
              <div className="grid grid-cols-3 gap-2">
                {[30, 90, 180].map((d) => (
                  <button
                    key={d}
                    onClick={() => setValidUntilDays(d)}
                    className={cn(
                      "h-10 rounded-xl text-sm font-medium transition-all",
                      validUntilDays === d
                        ? "bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A]"
                        : "bg-black/5 dark:bg-white/5 text-[var(--text-secondary)] hover:bg-black/10",
                    )}
                  >
                    {d} days
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                onClick={resetForm}
                disabled={creating}
                className="flex-1 h-12 rounded-xl bg-black/5 dark:bg-white/5 text-[var(--text-primary)] font-medium hover:bg-black/10 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleCreate()}
                disabled={creating || !recipient || !amount}
                data-testid="scheduled-confirm"
                className="flex-1 h-12 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating && <Loader2 size={14} className="animate-spin" />}
                <span>Authorize</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
