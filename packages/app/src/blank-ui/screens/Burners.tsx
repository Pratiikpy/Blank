// Phase 6.1 MVP — Burner wallet management.
//
// One passkey, many addresses. Each burner is a deterministic AA address
// derived from the user's passkey + a random salt. Public-facing receive
// surfaces (newsletter tips, Twitter giveaways, ENS-published meta-address)
// can use a burner instead of the main wallet so cross-burner correlation
// is hard for outside observers.
//
// Receive-only this pass: addresses are computed read-only via
// `factory.getAddress`. The Send/Sweep flow needs `useSmartAccount` to
// gain salt awareness (separate refactor) — for now, users with funds
// in a burner can send-from-main to that burner OR import the burner
// address into Send to sweep manually once that path lands.
//
// What this screen ships:
//   • List of registered burners with derived address + status pill
//     (Active / Deriving / Empty)
//   • Create form (label-only — salt is generated CSPRNG; sequential
//     salts would leak ordering on-chain across an attacker's set)
//   • Per-burner: copy address, copy pay-link, QR code, rename, delete
//   • Empty state coaching new users on what burners are for

import { useState } from "react";
import {
  Plus,
  Copy,
  Check,
  Trash2,
  Edit2,
  QrCode,
  Eye,
  EyeOff,
  Flame,
  Loader2,
  Cloud,
  CloudDownload,
  KeyRound,
} from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { QRCodeSVG } from "qrcode.react";
import toast from "react-hot-toast";
import { toastMappedError } from "@/lib/error-messages";
import { usePublicClient } from "wagmi";
import { useBurnerAccounts, type BurnerWithAddress } from "@/hooks/useBurnerAccounts";
import { useSmartAccount } from "@/hooks/useSmartAccount";
import { useChain } from "@/providers/ChainProvider";
import { useUnifiedWrite } from "@/hooks/useUnifiedWrite";
import {
  encryptBlob,
  recoverBurnersFromEvents,
  BurnerRegistryAbi,
} from "@/lib/burner-registry";
import { truncateAddress } from "@/lib/address";
import { cn } from "@/lib/cn";

export default function Burners() {
  const { account, status } = useSmartAccount();
  const { activeChain, activeChainId, contracts } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { unifiedWrite } = useUnifiedWrite();
  const { burners, error, createBurner, renameBurner, deleteBurner, importBurners } = useBurnerAccounts();
  const registryAddr = contracts.BurnerRegistry;
  // Address(0) when the registry hasn't been deployed on this chain yet —
  // disables backup actions instead of failing opaquely at write time.
  const registryDeployed =
    registryAddr && registryAddr !== "0x0000000000000000000000000000000000000000";

  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revealedSaltId, setRevealedSaltId] = useState<string | null>(null);

  // Phase 6.2 backup state. Modal opens with a target burner (or null for
  // "recover all"), prompts for passphrase, runs encrypt+publish (backup)
  // or events+decrypt (recover). Passphrase is NEVER persisted — held in
  // form-state only for the duration of the modal.
  const [backupModal, setBackupModal] = useState<
    | null
    | { kind: "backup"; burner: BurnerWithAddress }
    | { kind: "recover" }
  >(null);
  const [backupPassphrase, setBackupPassphrase] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);

  const onCreate = async () => {
    const label = newLabel.trim();
    if (!label) {
      toast.error("Give the burner a label so future-you knows what it's for");
      return;
    }
    setCreating(true);
    try {
      await createBurner(label);
      setNewLabel("");
      toast.success(`Created burner "${label}"`);
    } catch (err) {
      toastMappedError(err);
    } finally {
      setCreating(false);
    }
  };

  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Couldn't copy. Your browser blocked clipboard access");
    }
  };

  const startRename = (b: BurnerWithAddress) => {
    setEditingId(b.id);
    setEditingLabel(b.label);
  };

  const finishRename = () => {
    if (!editingId) return;
    renameBurner(editingId, editingLabel);
    setEditingId(null);
    setEditingLabel("");
  };

  // Phase 6.2 — encrypt the burner's metadata (label + salt) with the
  // user's passphrase and write to BurnerRegistry. Reusing the existing
  // unifiedWrite path means AA users batch via paymaster and EOA users
  // sign through their wallet.
  const onBackup = async () => {
    if (!backupModal || backupModal.kind !== "backup") return;
    if (!registryDeployed) {
      toast.error("BurnerRegistry isn't deployed on this chain yet");
      return;
    }
    if (!account) return;
    if (backupPassphrase.length < 6) {
      toast.error("Passphrase must be at least 6 characters");
      return;
    }
    setBackupBusy(true);
    try {
      const b = backupModal.burner;
      if (!b.address) throw new Error("Burner address not derived yet");
      const ciphertext = await encryptBlob(
        {
          id: b.id,
          salt: b.salt,
          label: b.label,
          createdAt: b.createdAt,
        },
        backupPassphrase,
      );
      await unifiedWrite({
        address: registryAddr,
        abi: BurnerRegistryAbi,
        functionName: "setMetadata",
        args: [b.address, ciphertext],
        gas: BigInt(200_000),
      });
      toast.success(`Backed up "${b.label}" to chain`);
      setBackupModal(null);
      setBackupPassphrase("");
    } catch (err) {
      toastMappedError(err);
    } finally {
      setBackupBusy(false);
    }
  };

  // Phase 6.2 — recover burners from on-chain events. Decrypts each
  // ciphertext with the entered passphrase, then merges into local
  // registry via createBurner-style writes (reusing the localStorage
  // shape so existing UI code "just works"). Decryption failures are
  // counted but not thrown — partial recovery is better than nothing.
  const onRecover = async () => {
    if (!backupModal || backupModal.kind !== "recover") return;
    if (!registryDeployed) {
      toast.error("BurnerRegistry isn't deployed on this chain yet");
      return;
    }
    if (!account || !publicClient) return;
    if (backupPassphrase.length < 6) {
      toast.error("Passphrase must be at least 6 characters");
      return;
    }
    setBackupBusy(true);
    try {
      const result = await recoverBurnersFromEvents({
        publicClient,
        registryAddress: registryAddr,
        mainAddress: account.address,
        passphrase: backupPassphrase,
      });
      // Import preserves salt + id (vs. createBurner which generates new
      // randoms) so the recovered AA addresses match what the user had
      // before. Dedup happens inside the hook on id + salt.
      // Explicit shape mapping (audit fix): BurnerBackupPayload has an
      // optional `notes` field that BurnerRecord doesn't. Strip it
      // explicitly so future divergence between the two types fails the
      // type check at this boundary instead of silently coercing.
      const toImport = result.records.map((r) => ({
        id: r.id,
        salt: r.salt,
        label: r.label,
        createdAt: r.createdAt,
      }));
      const added = importBurners(toImport);
      if (result.records.length === 0 && result.failedCount === 0) {
        toast("No burner backups found on chain for this address");
      } else if (added === 0 && result.records.length > 0) {
        toast.success(
          `${result.records.length} burner${result.records.length === 1 ? "" : "s"} already in your local list — nothing new to import`,
        );
      } else {
        toast.success(
          `Recovered ${added} burner${added === 1 ? "" : "s"}` +
            (result.failedCount > 0 ? ` (${result.failedCount} failed to decrypt)` : ""),
        );
      }
      setBackupModal(null);
      setBackupPassphrase("");
    } catch (err) {
      toastMappedError(err);
    } finally {
      setBackupBusy(false);
    }
  };

  const onDelete = (b: BurnerWithAddress) => {
    // The burner's private key is derived from (passkey + salt). The
    // salt is stored only in IndexedDB unless the user backed up to
    // chain via BurnerRegistry. Without that backup, deleting the
    // local record means the salt is gone forever + any funds at this
    // address become unrecoverable. The previous copy ("Funds in it
    // stay safe") understated this risk; rewrite to match reality.
    const warning = registryDeployed
      ? `Delete "${b.label}"?\n\nIf you haven't backed this burner up to chain, you'll permanently lose the salt — and any funds at ${b.address ?? "this address"} will become unrecoverable. Back up first if you're unsure.\n\nThis cannot be undone.`
      : `Delete "${b.label}"?\n\nThis burner's salt is stored only in this browser. On-chain backup isn't deployed on this network yet, so deleting now means the salt is gone forever + any funds at ${b.address ?? "this address"} become unrecoverable.\n\nThis cannot be undone.`;
    if (!confirm(warning)) {
      return;
    }
    deleteBurner(b.id);
    toast.success("Burner removed");
  };

  // Loading / unauthenticated states
  if (status === "no-passkey" || !account) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <h1 className="text-3xl font-medium tracking-tight mb-2">Burner wallets</h1>
        <p className="text-sm text-[var(--text-secondary)] mb-8">
          Create a passkey to derive burner addresses.
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
            <div className="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center">
              <Flame size={20} className="text-orange-600 dark:text-orange-400" />
            </div>
            <h1
              className="text-3xl sm:text-4xl font-medium tracking-tight"
              style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}
            >
              Burner wallets
            </h1>
          </div>
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed max-w-2xl">
            Public-facing receive addresses derived from your passkey. Use one per
            channel — newsletter tips, Twitter giveaways, podcast sponsors — so
            outside observers can't link them back to your main wallet.
          </p>
        </div>

        {/* Privacy boundary — burners are receive-side accounts. Funds
            stay in the burner until you decide what to do with them. */}
        <div className="rounded-2xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 p-4 text-sm text-amber-900 dark:text-amber-200 leading-snug">
          <strong className="font-semibold">Receive-only.</strong>{" "}
          Burners are designed to receive payments without exposing your
          main wallet's address. Funds remain in the burner — consolidation
          happens off-chain or via the privacy router.
        </div>

        {/* Phase 6.2 — Recover from chain. Shown when the registry is
            deployed on this chain. Independent of "Back up to chain" so a
            user on a fresh device can rebuild their burner list without
            ever creating one locally first. */}
        {registryDeployed && (
          <button
            onClick={() => setBackupModal({ kind: "recover" })}
            data-testid="burner-recover-button"
            className="w-full rounded-2xl bg-violet-50 dark:bg-violet-500/10 border border-violet-200 dark:border-violet-500/20 hover:bg-violet-100 dark:hover:bg-violet-500/20 p-4 flex items-center gap-3 text-left transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-violet-500/15 flex items-center justify-center text-violet-700 dark:text-violet-300 shrink-0">
              <CloudDownload size={18} />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-violet-900 dark:text-violet-200">
                Recover burners from chain
              </p>
              <p className="text-xs text-violet-700 dark:text-violet-300/80 leading-snug">
                Decrypt and import any burners you previously backed up.
                Requires the same passphrase you used at backup.
              </p>
            </div>
          </button>
        )}

        {/* Create form */}
        <div className="rounded-2xl glass-card-static p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-3">
            Create a new burner
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="e.g. Newsletter tips"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value.slice(0, 64))}
              onKeyDown={(e) => {
                // Audit Top-28 #16: gate Enter on `creating` so a fast
                // double-press doesn't fire onCreate twice (the second
                // call would race the first if state hasn't settled).
                if (e.key === "Enter" && !creating) void onCreate();
              }}
              data-testid="burner-label-input"
              aria-label="Burner label"
              className="flex-1 h-12 px-4 rounded-xl bg-white/60 dark:bg-white/5 border border-black/10 dark:border-white/15 focus:border-black/30 dark:focus:border-white/30 outline-none transition-all placeholder:text-[var(--text-tertiary)]"
            />
            <button
              onClick={onCreate}
              disabled={creating || !newLabel.trim()}
              data-testid="burner-create-button"
              className={cn(
                "h-12 px-5 rounded-xl font-medium transition-all flex items-center gap-2 shrink-0",
                creating || !newLabel.trim()
                  ? "bg-gray-200 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed"
                  : "bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] hover:bg-black",
              )}
            >
              {creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={18} />}
              <span>Create</span>
            </button>
          </div>
        </div>

        {/* Errors */}
        {error && (
          <div className="rounded-2xl bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 p-4 text-sm text-rose-900 dark:text-rose-200">
            Address derivation hit an RPC error: {error}
          </div>
        )}

        {/* On-chain backup gate — visible explainer for why the cloud
            icons are disabled. The per-button `title` tooltip is
            hover-only (desktop) so mobile users had no way to see why
            backup wasn't available. This banner makes the constraint
            obvious for everyone. */}
        {!registryDeployed && (
          <div className="rounded-2xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 p-4 text-sm text-amber-900 dark:text-amber-200">
            <strong className="font-semibold">On-chain backup isn't available on {activeChain.name} yet.</strong>{" "}
            BurnerRegistry hasn't shipped on this network. Each burner's
            salt stays in this browser only — clear site data or delete
            the burner and you lose the private key. We'll enable
            cloud-backup as soon as the registry deploys.
          </div>
        )}

        {/* Burner list */}
        {burners.length === 0 ? (
          <div className="rounded-[2rem] glass-card-static">
            <EmptyState
              icon={Flame}
              tone="amber"
              title="No burners yet"
              body="Create one with the form above. Each burner gets its own address you can share publicly. Your main wallet stays separate."
            />
          </div>
        ) : (
          <div className="space-y-3" data-testid="burner-list">
            {burners.map((b) => {
              const isExpanded = expandedId === b.id;
              const payLink = b.address
                ? `${window.location.origin}/pay/${b.address}`
                : null;
              const isRenaming = editingId === b.id;
              const saltRevealed = revealedSaltId === b.id;
              return (
                <div
                  key={b.id}
                  data-testid={`burner-${b.id}`}
                  className="rounded-2xl glass-card-static p-5"
                >
                  {/* Top row */}
                  <div className="flex items-center gap-3 flex-wrap">
                    {/* Label / rename input */}
                    <div className="flex-1 min-w-[180px]">
                      {isRenaming ? (
                        <input
                          autoFocus
                          type="text"
                          value={editingLabel}
                          onChange={(e) => setEditingLabel(e.target.value.slice(0, 64))}
                          onBlur={finishRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") finishRename();
                            if (e.key === "Escape") {
                              setEditingId(null);
                              setEditingLabel("");
                            }
                          }}
                          className="w-full h-8 px-2 rounded-lg bg-white/80 dark:bg-white/10 border border-black/10 dark:border-white/15 outline-none font-medium"
                        />
                      ) : (
                        <div className="flex items-center gap-2">
                          <p className="font-medium text-[var(--text-primary)]">
                            {b.label}
                          </p>
                          <button
                            onClick={() => startRename(b)}
                            aria-label="Rename burner"
                            className="text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                          >
                            <Edit2 size={12} />
                          </button>
                        </div>
                      )}
                      <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
                        Created {new Date(b.createdAt).toLocaleDateString()}
                      </p>
                    </div>

                    {/* Status pill — shrink-0 prevents text squeeze on narrow viewports */}
                    {b.isLoading ? (
                      <span className="shrink-0 text-xs px-2.5 py-1 rounded-full bg-blue-500/10 text-blue-700 dark:text-blue-300 flex items-center gap-1.5">
                        <Loader2 size={11} className="animate-spin" />
                        Deriving
                      </span>
                    ) : b.address ? (
                      <span className="shrink-0 text-xs px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                        Ready
                      </span>
                    ) : (
                      <span className="shrink-0 text-xs px-2.5 py-1 rounded-full bg-rose-500/10 text-rose-700 dark:text-rose-300">
                        Unavailable
                      </span>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : b.id)}
                        aria-label={isExpanded ? "Hide details" : "Show details"}
                        disabled={!b.address}
                        className="w-8 h-8 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 flex items-center justify-center text-[var(--text-secondary)] disabled:opacity-40"
                      >
                        <QrCode size={16} />
                      </button>
                      <button
                        onClick={() => setBackupModal({ kind: "backup", burner: b })}
                        aria-label="Back up to chain"
                        disabled={!b.address || !registryDeployed}
                        title={
                          !registryDeployed
                            ? "BurnerRegistry not deployed on this chain yet"
                            : "Back up label + salt to chain (encrypted)"
                        }
                        data-testid={`burner-backup-${b.id}`}
                        className="w-8 h-8 rounded-lg hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-400 flex items-center justify-center text-[var(--text-tertiary)] disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <Cloud size={16} />
                      </button>
                      <button
                        onClick={() => onDelete(b)}
                        aria-label="Delete burner"
                        className="w-8 h-8 rounded-lg hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400 flex items-center justify-center text-[var(--text-tertiary)]"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>

                  {/* Address row */}
                  <div className="mt-3 flex items-center gap-2 p-3 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-black/5 dark:border-white/5">
                    <p className="flex-1 min-w-0 font-mono text-xs sm:text-sm text-[var(--text-secondary)] truncate">
                      {b.address ?? "—"}
                    </p>
                    {b.address && (
                      <button
                        onClick={() => copy(b.address!, b.id)}
                        aria-label="Copy address"
                        className="shrink-0 w-7 h-7 rounded-lg hover:bg-white/60 dark:hover:bg-white/10 flex items-center justify-center text-[var(--text-secondary)]"
                      >
                        {copiedId === b.id ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                    )}
                  </div>

                  {/* Expanded panel: QR + pay link + salt */}
                  {isExpanded && b.address && payLink && (
                    <div className="mt-4 pt-4 border-t border-black/5 dark:border-white/5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className="flex flex-col items-center gap-2">
                        <div className="rounded-2xl bg-white p-3 border-4 border-black/5">
                          <QRCodeSVG
                            value={payLink}
                            size={160}
                            level="M"
                            bgColor="#FFFFFF"
                            fgColor="#000000"
                            includeMargin={false}
                          />
                        </div>
                        <p className="text-[11px] text-[var(--text-tertiary)] text-center max-w-[180px]">
                          Scan to pay this burner via the public {activeChain.name} pay page
                        </p>
                      </div>

                      <div className="space-y-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5">
                            Pay link
                          </p>
                          <div className="flex items-center gap-2 p-2 rounded-lg bg-black/[0.03] dark:bg-white/[0.03]">
                            <p className="flex-1 min-w-0 text-xs font-mono text-[var(--text-secondary)] truncate">
                              {payLink}
                            </p>
                            <button
                              onClick={() => copy(payLink, `${b.id}:link`)}
                              aria-label="Copy pay link"
                              className="shrink-0 w-6 h-6 rounded hover:bg-white/60 dark:hover:bg-white/10 flex items-center justify-center text-[var(--text-secondary)]"
                            >
                              {copiedId === `${b.id}:link` ? (
                                <Check size={12} />
                              ) : (
                                <Copy size={12} />
                              )}
                            </button>
                          </div>
                        </div>

                        <div>
                          <div className="flex items-center justify-between mb-1.5">
                            <p className="text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)]">
                              Salt
                            </p>
                            <button
                              onClick={() =>
                                setRevealedSaltId(saltRevealed ? null : b.id)
                              }
                              className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] flex items-center gap-1"
                            >
                              {saltRevealed ? (
                                <>
                                  <EyeOff size={11} />
                                  Hide
                                </>
                              ) : (
                                <>
                                  <Eye size={11} />
                                  Reveal
                                </>
                              )}
                            </button>
                          </div>
                          <p className="text-[10px] font-mono text-[var(--text-tertiary)] break-all">
                            {saltRevealed
                              ? b.salt
                              : "•••••••••••••••••••••••••••••• (the seed for this address)"}
                          </p>
                          <p className="text-[10px] text-[var(--text-tertiary)] mt-1.5">
                            Re-derivable: factory + your passkey + this salt = this address.
                          </p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Footnote */}
        {burners.length > 0 && (
          <p className="text-xs text-[var(--text-tertiary)] text-center">
            Main wallet: {truncateAddress(account.address)} · {activeChain.name}
          </p>
        )}
      </div>

      {/* Phase 6.2 — backup / recover passphrase modal. Single modal handles
          both directions; passphrase is held only in form-state and never
          persisted (no localStorage write of the secret). */}
      {backupModal !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={backupModal.kind === "backup" ? "Back up burner" : "Recover burners"}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget && !backupBusy) {
              setBackupModal(null);
              setBackupPassphrase("");
            }
          }}
          onKeyDown={(e) => {
            // a11y: aria-modal dialogs should close on Escape. Gated by
            // !backupBusy so we don't yank a write that's mid-flight.
            if (e.key === "Escape" && !backupBusy) {
              setBackupModal(null);
              setBackupPassphrase("");
            }
          }}
        >
          <div className="w-full max-w-md rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-6 sm:p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-violet-500/15 flex items-center justify-center text-violet-700 dark:text-violet-300">
                <KeyRound size={18} />
              </div>
              <h3 className="text-lg font-semibold text-[var(--text-primary)]">
                {backupModal.kind === "backup"
                  ? `Back up "${backupModal.burner.label}"`
                  : "Recover burners from chain"}
              </h3>
            </div>

            <p className="text-sm text-[var(--text-secondary)] leading-snug mb-4">
              {backupModal.kind === "backup"
                ? "Encrypt the label + salt with a passphrase only you know. The on-chain blob is opaque to anyone without this passphrase."
                : "Enter the same passphrase you used at backup time. We'll fetch your encrypted records from chain and decrypt locally. The passphrase never leaves your device."}
            </p>

            <input
              type="password"
              autoFocus
              value={backupPassphrase}
              onChange={(e) => setBackupPassphrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && backupPassphrase.length >= 6 && !backupBusy) {
                  void (backupModal.kind === "backup" ? onBackup() : onRecover());
                }
              }}
              placeholder="Passphrase (min 6 chars)"
              data-testid="burner-backup-passphrase"
              aria-label="Backup passphrase"
              className="h-12 w-full px-4 rounded-xl bg-white/60 dark:bg-white/5 border border-black/10 dark:border-white/15 focus:border-violet-400 focus:ring-4 focus:ring-violet-500/10 outline-none transition-all placeholder:text-[var(--text-tertiary)] mb-2"
            />
            <p className="text-[11px] text-[var(--text-tertiary)] leading-snug mb-5">
              Choose something memorable — losing this passphrase makes the
              backup unrecoverable. We can't help you reset it (we never see it).
            </p>

            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (backupBusy) return;
                  setBackupModal(null);
                  setBackupPassphrase("");
                }}
                disabled={backupBusy}
                className="flex-1 h-12 rounded-xl bg-black/5 dark:bg-white/5 text-[var(--text-primary)] font-medium hover:bg-black/10 dark:hover:bg-white/10 transition-all disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() =>
                  void (backupModal.kind === "backup" ? onBackup() : onRecover())
                }
                disabled={backupBusy || backupPassphrase.length < 6}
                data-testid="burner-backup-confirm"
                className="flex-1 h-12 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              >
                {backupBusy && <Loader2 size={14} className="animate-spin" />}
                <span>{backupModal.kind === "backup" ? "Encrypt + back up" : "Decrypt + import"}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
