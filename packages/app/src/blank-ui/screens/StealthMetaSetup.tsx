/**
 * Phase 9.6 — stealth meta-address setup screen.
 *
 * Three states reflected in the UI:
 *
 *   • Empty (no keys generated yet) → "Generate" CTA.
 *   • Generated, not yet published   → meta-address visible locally,
 *                                       but ERC-6538 lookup returns
 *                                       empty for outside observers.
 *                                       "Publish to registry" CTA.
 *   • Published                      → meta-address + QR + share +
 *                                       publish-tx link. "Reset" hidden
 *                                       behind a danger-action confirmation.
 *
 * Storage: keys live in localStorage (plaintext today) keyed by the user's
 * main address. Phase 9.6.1 (future) will migrate to AES-GCM-at-rest with
 * a key derived from a passkey signature. We surface a clear warning
 * about this gap in the published-state info banner.
 *
 * Recovery: device loss = stealth funds loss UNLESS the user backed up
 * their privkeys to another device. The "Show backup phrase" panel in
 * the published state lets them export the spending+viewing privkeys as
 * a 64-char-hex pair they can paste on another device. A hardened
 * encrypted-export would use a passphrase; v1 is plaintext (dev/testnet
 * only).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  Sparkles,
  KeyRound,
  Copy,
  Check,
  AlertTriangle,
  Share2,
  Trash2,
  ExternalLink,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { bytesToHex } from "viem/utils";

import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useUnifiedWrite } from "@/hooks/useUnifiedWrite";
import { useChain } from "@/providers/ChainProvider";
import { usePassphrasePrompt } from "@/components/PassphrasePrompt";
import { ERC6538RegistryAbi } from "@/lib/abis";
import { metaAddressFromPrivKeys, parseMetaAddress } from "@/lib/stealth";
import {
  loadStealthKeys,
  saveStealthKeysAsync,
  clearStealthKeys,
  unlockStealthKeys,
  hasStealthKeysStored,
  type StealthKeyRecord,
} from "@/lib/stealth-keystore";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import toast from "react-hot-toast";

const SCHEME_ID = 1n;

function generateSecpPrivateKey(): `0x${string}` {
  // 32 bytes via crypto.getRandomValues. The probability of landing
  // outside [1, secp256k1_n - 1] is astronomical (~1/2^128), but we
  // still validate by attempting metaAddressFromPrivKeys which will
  // throw if the value happens to be 0 — extremely unlikely but cheap
  // to guard.
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  // Reject all-zero (the only invalid case in practice).
  if (buf.every((b) => b === 0)) {
    return generateSecpPrivateKey();
  }
  return bytesToHex(buf) as `0x${string}`;
}

/** Encode a meta-address string into the raw 66-byte concat the
 *  ERC-6538 registry stores. Strips the `st:eth:0x` prefix and
 *  re-validates the inner pubkeys. */
function metaAddressToRegistryBytes(metaAddress: string): `0x${string}` {
  const { spendingPubKey, viewingPubKey } = parseMetaAddress(metaAddress);
  // 33-byte spend || 33-byte view = 66 bytes = 132 hex.
  return ("0x" + spendingPubKey.slice(2) + viewingPubKey.slice(2)) as `0x${string}`;
}

export default function StealthMetaSetup() {
  const navigate = useNavigate();
  const { effectiveAddress } = useEffectiveAddress();
  const { activeChainId, contracts } = useChain();
  const { unifiedWriteAndWait } = useUnifiedWrite();
  const passphrasePrompt = usePassphrasePrompt();

  const [record, setRecord] = useState<StealthKeyRecord | null>(() =>
    effectiveAddress ? loadStealthKeys(effectiveAddress) : null,
  );
  const [showPrivKeys, setShowPrivKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  // Passphrase cached in a ref (not state) for the duration of the screen
  // — avoids re-prompting on every save and avoids triggering renders.
  const passphraseRef = useRef<string | null>(null);

  // Lazy unlock when stored keys exist but the in-memory cache is empty
  // (e.g. fresh page load). The user is prompted once; on success the
  // record is decrypted into module memory and surfaced to the screen.
  useEffect(() => {
    if (!effectiveAddress) return;
    if (record) return;
    if (!hasStealthKeysStored(effectiveAddress)) return;
    setNeedsUnlock(true);
  }, [effectiveAddress, record]);

  const handleUnlock = useCallback(async () => {
    if (!effectiveAddress) return;
    const pass = await passphrasePrompt.request({
      title: "Decrypt stealth keys",
      subtitle:
        "Enter the passphrase you set when generating your stealth keys.",
    });
    if (!pass) return;
    try {
      const rec = await unlockStealthKeys(effectiveAddress, pass);
      if (!rec) {
        toast.error("Wrong passphrase or no keys stored");
        return;
      }
      passphraseRef.current = pass;
      setRecord(rec);
      setNeedsUnlock(false);
    } catch {
      toast.error("Wrong passphrase");
    }
  }, [effectiveAddress, passphrasePrompt]);

  // One-time passphrase capture for both new-key creation and re-saves.
  // Cached in a ref so subsequent operations in the same screen session
  // reuse it without re-prompting.
  const ensurePassphrase = useCallback(async (): Promise<string | null> => {
    if (passphraseRef.current) return passphraseRef.current;
    const isFresh = !hasStealthKeysStored(effectiveAddress!);
    const pass = await passphrasePrompt.request(
      isFresh
        ? {
            title: "Set stealth passphrase",
            subtitle:
              "Encrypts your stealth keys at rest. Save it. Needed to recover your keys after a browser reset.",
          }
        : {
            title: "Decrypt stealth keys",
            subtitle:
              "Enter the passphrase you set when generating your stealth keys.",
          },
    );
    if (!pass) return null;
    passphraseRef.current = pass;
    return pass;
  }, [effectiveAddress, passphrasePrompt]);

  const state: "no-account" | "empty" | "generated" | "published" = !effectiveAddress
    ? "no-account"
    : !record
      ? "empty"
      : !record.publishedAt
        ? "generated"
        : "published";

  // Audit Top-28 #11: read registry from useChain().contracts so a
  // reload-free chain switch reaches the right address. Canonical singleton
  // today, so values match across chains, but stay chain-aware for safety.
  const registryAddress = contracts.ERC6538Registry;

  const handleGenerate = async () => {
    if (!effectiveAddress) return;
    const pass = await ensurePassphrase();
    if (!pass) return;
    const spending = generateSecpPrivateKey();
    const viewing = generateSecpPrivateKey();
    const { metaAddress } = metaAddressFromPrivKeys({
      spendingPrivateKey: spending,
      viewingPrivateKey: viewing,
    });
    const newRec: StealthKeyRecord = {
      spendingPrivateKey: spending,
      viewingPrivateKey: viewing,
      metaAddress,
    };
    const ok = await saveStealthKeysAsync(effectiveAddress, newRec, pass);
    if (!ok) {
      toast.error("Couldn't save stealth keys to local storage");
      return;
    }
    setRecord(newRec);
    toast.success("Stealth keys generated locally. Publish to start receiving.");
  };

  const handlePublish = async () => {
    if (!effectiveAddress || !record) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = metaAddressToRegistryBytes(record.metaAddress);
      const result = await unifiedWriteAndWait({
        address: registryAddress,
        abi: ERC6538RegistryAbi,
        functionName: "registerKeys",
        args: [SCHEME_ID, bytes],
      });
      const pass = await ensurePassphrase();
      if (!pass) {
        // Tx already landed but we can't persist publishedAt without
        // the passphrase. Surface it so the user knows the chain is
        // updated even if local cache isn't.
        toast.error("Published on-chain but couldn't save locally. Re-enter passphrase to refresh");
        return;
      }
      const updated: StealthKeyRecord = {
        ...record,
        publishTxHash: result.hash,
        publishedAt: Math.floor(Date.now() / 1000),
      };
      await saveStealthKeysAsync(effectiveAddress, updated, pass);
      setRecord(updated);
      toast.success("Meta-address published to ERC-6538 Registry");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error("Publish failed. See error below");
    } finally {
      setBusy(false);
    }
  };

  const handleReset = () => {
    if (!effectiveAddress) return;
    if (
      !confirm(
        "Reset deletes your stealth keys. Any unswept payments to old stealth addresses become permanently inaccessible UNLESS you've backed up the privkeys. Continue?",
      )
    )
      return;
    clearStealthKeys(effectiveAddress);
    setRecord(null);
    toast.success("Stealth keys cleared");
  };

  const handleCopy = async (text: string) => {
    await copyToClipboard(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
    toast.success("Copied");
  };

  const handleShare = async () => {
    if (!record) return;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({
          title: "My stealth meta-address",
          text: `Send me private payments at this stealth meta-address:\n\n${record.metaAddress}`,
        });
      } catch {
        // user cancelled — no toast needed
      }
    } else {
      await handleCopy(record.metaAddress);
    }
  };

  const explorerBase = useMemo(() => {
    if (activeChainId === 11155111) return "https://sepolia.etherscan.io/tx/";
    if (activeChainId === 84532) return "https://sepolia.basescan.org/tx/";
    return null;
  }, [activeChainId]);

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-2xl mx-auto flex flex-col">
        {/* Back */}
        <div className="mb-6">
          <button
            onClick={() => navigate(-1)}
            className="w-10 h-10 rounded-full bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 flex items-center justify-center hover:bg-white/80 dark:hover:bg-white/10 transition-all"
            aria-label="Go back"
          >
            <ChevronLeft size={20} className="text-[var(--text-primary)]" />
          </button>
        </div>

        {/* Title */}
        <div className="mb-8">
          <div className="flex items-start gap-3 mb-2">
            <div className="w-10 h-10 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
              <Sparkles size={20} />
            </div>
            <h1 className="text-3xl sm:text-4xl font-medium tracking-tight text-[var(--text-primary)]" style={{ fontFamily: "'Outfit', 'Inter', sans-serif" }}>
              Stealth Meta-Address
            </h1>
          </div>
          <p className="text-sm text-[var(--text-secondary)]">
            Publish a permanent meta-address. Senders derive a fresh
            one-time stealth address per payment. Outside observers
            can&apos;t link those payments to your main wallet.
          </p>
        </div>

        {state === "no-account" && (
          <div className="rounded-3xl glass-card-static p-8 text-center">
            <p className="text-sm text-[var(--text-secondary)]">
              Connect a wallet to set up your stealth meta-address.
            </p>
          </div>
        )}

        {state === "empty" && needsUnlock && (
          <div className="rounded-3xl glass-card-static p-8 flex flex-col items-center text-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center text-blue-600 dark:text-blue-400">
              <KeyRound size={22} />
            </div>
            <div>
              <h2 className="text-lg font-medium text-[var(--text-primary)] mb-1">
                Stealth keys are locked
              </h2>
              <p className="text-sm text-[var(--text-secondary)] max-w-md">
                Encrypted keys for this account are stored on this device.
                Enter your passphrase to decrypt them.
              </p>
            </div>
            <button
              onClick={handleUnlock}
              className="h-11 px-6 rounded-xl bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A] font-medium transition-colors"
            >
              Decrypt
            </button>
          </div>
        )}

        {state === "empty" && !needsUnlock && (
          <div className="rounded-3xl glass-card-static p-8 flex flex-col items-center text-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
              <KeyRound size={22} />
            </div>
            <div>
              <h2 className="text-lg font-medium text-[var(--text-primary)] mb-1">
                Generate your stealth keys
              </h2>
              <p className="text-sm text-[var(--text-secondary)] max-w-md">
                Two secp256k1 private keys are generated locally: a
                spending key (for sweeping) and a viewing key (for
                discovery). Encrypted at rest with a passphrase you choose.
              </p>
            </div>
            <button
              onClick={handleGenerate}
              className="h-11 px-6 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-medium transition-colors"
            >
              Generate keys
            </button>
          </div>
        )}

        {(state === "generated" || state === "published") && record && (
          <div className="flex flex-col gap-6">
            {/* Meta-address display */}
            <div className="rounded-3xl glass-card-static p-6">
              <div className="flex items-center gap-3 mb-4">
                <span className="text-sm font-medium text-[var(--text-primary)]">Your meta-address</span>
                {state === "generated" && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 inline-flex items-center gap-1">
                    <AlertTriangle size={12} /> Not published
                  </span>
                )}
                {state === "published" && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 inline-flex items-center gap-1">
                    <Check size={12} /> Published
                  </span>
                )}
              </div>
              <div className="flex flex-col sm:flex-row gap-4 items-start">
                <div className="flex-shrink-0 p-3 rounded-2xl bg-white border border-black/5 dark:border-white/5">
                  <QRCodeSVG value={record.metaAddress} size={120} level="M" includeMargin={false} />
                </div>
                <div className="flex-1 min-w-0 w-full">
                  <code className="block text-xs break-all p-3 rounded-xl bg-black/5 dark:bg-white/5 text-[var(--text-primary)] mb-2 font-mono">
                    {record.metaAddress}
                  </code>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => handleCopy(record.metaAddress)}
                      className="h-9 px-3 rounded-lg bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20 text-sm flex items-center gap-1.5"
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                      {copied ? "Copied" : "Copy"}
                    </button>
                    <button
                      onClick={handleShare}
                      className="h-9 px-3 rounded-lg bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20 text-sm flex items-center gap-1.5"
                    >
                      <Share2 size={14} />
                      Share
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Publish CTA OR published-status info */}
            {state === "generated" && (
              <div className="rounded-3xl glass-card-static p-6">
                <h3 className="text-base font-medium text-[var(--text-primary)] mb-2">Publish to the on-chain registry</h3>
                <p className="text-sm text-[var(--text-secondary)] mb-4">
                  Sends a sponsored UserOp that calls
                  {" "}<code className="text-xs bg-black/5 dark:bg-white/5 px-1 py-0.5 rounded">ERC6538Registry.registerKeys(1, ...)</code>{" "}
                  on the canonical singleton. Senders looking up your
                  address will discover the meta-address.
                </p>

                {/* Privacy trade-off warning: the publish UserOp originates
                    from the user's main AA, so the registry permanently
                    links `mainAA → metaAddress`. A chain analyst querying
                    the registry can correlate every stealth payment back
                    to this main account. We surface this BEFORE publish
                    so the user can make an informed choice — e.g. publish
                    from a fresh burner AA instead. */}
                <div className="rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/5 p-4 mb-4">
                  <div className="flex items-start gap-3">
                    <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                    <div className="text-sm text-[var(--text-secondary)]">
                      <strong className="text-[var(--text-primary)]">
                        This publish links your meta-address to your main
                        wallet on-chain.
                      </strong>{" "}
                      Anyone querying the ERC-6538 Registry can see that
                      this account published a stealth meta-address,
                      and tie every stealth payment back to it. Senders
                      stay unlinked from observers, but the recipient
                      (you) is permanently linked to the registry entry.
                      For maximum privacy, consider publishing from a
                      fresh burner AA instead.
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => void handlePublish()}
                  disabled={busy}
                  className={cn(
                    "h-11 px-6 rounded-xl font-medium transition-colors",
                    busy
                      ? "bg-gray-200 dark:bg-gray-700 text-gray-500 cursor-wait"
                      : "bg-emerald-600 hover:bg-emerald-700 text-white",
                  )}
                >
                  {busy ? "Publishing…" : "Publish meta-address"}
                </button>
                {error && (
                  <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
                )}
              </div>
            )}

            {state === "published" && (
              <div className="rounded-3xl glass-card-static p-6">
                <h3 className="text-base font-medium text-[var(--text-primary)] mb-2">Published</h3>
                <p className="text-sm text-[var(--text-secondary)] mb-3">
                  Your meta-address is live on the ERC-6538 Registry.
                  Senders looking up your address will see it; the
                  Stealth Inbox automatically discovers payments.
                </p>
                <div className="flex flex-wrap gap-2 items-center">
                  {record.publishTxHash && explorerBase && (
                    <a
                      href={`${explorerBase}${record.publishTxHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="h-9 px-3 rounded-lg bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20 text-sm flex items-center gap-1.5"
                    >
                      <ExternalLink size={14} /> View tx
                    </a>
                  )}
                  <button
                    onClick={() => navigate("/app/stealth/inbox")}
                    className="h-9 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm flex items-center gap-1.5"
                  >
                    Open Stealth Inbox
                  </button>
                </div>
              </div>
            )}

            {/* Backup + storage warning */}
            <div className="rounded-3xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/5 p-6">
              <div className="flex items-start gap-3 mb-3">
                <AlertTriangle size={18} className="text-amber-600 dark:text-amber-400 mt-0.5" />
                <div>
                  <h3 className="text-base font-medium text-[var(--text-primary)] mb-1">Back up your keys</h3>
                  <p className="text-sm text-[var(--text-secondary)]">
                    Keys are stored as plaintext in this browser&apos;s
                    localStorage today. <strong>Anyone with access to
                    this browser can sweep your stealth funds.</strong>{" "}
                    Lose this browser without backup ⇒ lose any unswept
                    payments. Encrypted-at-rest storage is on the
                    roadmap.
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowPrivKeys((s) => !s)}
                className="text-sm underline text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                {showPrivKeys ? "Hide private keys" : "Show backup keys"}
              </button>
              {showPrivKeys && (
                <div className="mt-3 flex flex-col gap-2">
                  <div>
                    <span className="text-xs font-medium text-[var(--text-secondary)]">Spending key (sweep authority):</span>
                    <code className="block text-xs break-all p-2 rounded-xl bg-black/5 dark:bg-white/10 text-[var(--text-primary)] font-mono mt-1">
                      {record.spendingPrivateKey}
                    </code>
                  </div>
                  <div>
                    <span className="text-xs font-medium text-[var(--text-secondary)]">Viewing key (discovery only, safe to share with auditors):</span>
                    <code className="block text-xs break-all p-2 rounded-xl bg-black/5 dark:bg-white/10 text-[var(--text-primary)] font-mono mt-1">
                      {record.viewingPrivateKey}
                    </code>
                  </div>
                </div>
              )}
            </div>

            {/* Reset */}
            <button
              onClick={handleReset}
              className="text-sm text-red-600 dark:text-red-400 hover:underline self-start flex items-center gap-1.5"
            >
              <Trash2 size={14} /> Reset stealth keys
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
