import { useState, useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Ghost,
  Copy,
  Check,
  Plus,
  Lock,
  KeyRound,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Undo2,
  Search,
  Send,
  Clock,
  Inbox,
  Link2,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import toast from "react-hot-toast";
import {
  useStealthPayments,
  getStealthInbox,
  addToStealthInbox,
  markInboxEntryStatus,
  type StealthInboxEntry,
} from "@/hooks/useStealthPayments";
import { usePublicClient } from "wagmi";
import { useUnifiedWrite } from "@/hooks/useUnifiedWrite";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { useChain } from "@/providers/ChainProvider";
import { StealthPaymentsAbi } from "@/lib/abis";
import { keccak256, encodePacked, formatUnits } from "viem";
import { STORAGE_KEYS, getStoredJson, setStoredJson } from "@/lib/storage";
import { copyToClipboard } from "@/lib/clipboard";
import { onCrossTabAction } from "@/lib/cross-tab";
import { formatUsdcInput } from "@/lib/format";

// ---------------------------------------------------------------
//  TYPES
// ---------------------------------------------------------------

interface GeneratedCode {
  code: string;
  transferId: number;
  amount: string;
}

interface SentTransferInfo {
  transferId: number;
  plaintextAmount: bigint;
  note: string;
  timestamp: number;
  claimed: boolean;
  finalized: boolean;
}

interface StoredClaimCode {
  claimCode: string;
  transferId: number;
  recipientAddress: string;
  createdAt: number;
}

type TabValue = "create" | "claim" | "sent" | "inbox";

const REFUND_WINDOW_SECONDS = 30 * 24 * 60 * 60; // 30 days

// ---------------------------------------------------------------
//  STEP LABEL HELPER
// ---------------------------------------------------------------

function getStepLabel(step: string): string {
  switch (step) {
    case "approving":
      return "Approving USDC...";
    case "encrypting":
      return "Encrypting recipient...";
    case "sending":
      return "Sending stealth payment...";
    case "claiming":
      return "Claiming payment...";
    case "finalizing":
      return "Finalizing claim...";
    default:
      return "Processing...";
  }
}

// ---------------------------------------------------------------
//  MAIN SCREEN
// ---------------------------------------------------------------

export default function Stealth() {
  // R5-D: passkey-aware. effectiveAddress = smart-account when passkey-only,
  // EOA otherwise. Without this, "Connect wallet first" gates the create
  // path for passkey-only users.
  const { effectiveAddress: address } = useEffectiveAddress();
  const { activeChainId, contracts } = useChain();
  const {
    step,
    error,
    txHash,
    isWaitingForDecryption,
    decryptionProgress,
    sendStealth,
    claimStealth,
    finalizeClaim,
    getMyPendingClaims,
    getPendingClaims,
    resumePendingClaim,
    reset,
  } = useStealthPayments();
  // Route refund through useUnifiedWrite so passkey users go via the AA
  // relayer path; wagmi's writeContractAsync throws "Connector not connected"
  // for passkey-only users (no EOA → no wagmi connector).
  const { unifiedWriteAndWait } = useUnifiedWrite();
  // chainId so passkey-only users (no wagmi chain) get a working client.
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { activities } = useActivityFeed();

  const [activeTab, setActiveTab] = useState<TabValue>("create");
  const [copied, setCopied] = useState<string | null>(null);

  // Create form state
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [message, setMessage] = useState("");
  const [newCode, setNewCode] = useState<GeneratedCode | null>(null);

  // Claim form state
  const [claimTransferId, setClaimTransferId] = useState("");
  const [claimCode, setClaimCode] = useState("");
  const [claimSuccess, setClaimSuccess] = useState(false);
  const [finalizeId, setFinalizeId] = useState("");

  // Sent payments / refund state
  const [sentTransfers, setSentTransfers] = useState<SentTransferInfo[]>([]);
  const [loadingSent, setLoadingSent] = useState(false);
  const [refundingId, setRefundingId] = useState<number | null>(null);

  // Pending claims discovery state
  const [checkingClaims, setCheckingClaims] = useState(false);
  const [discoveredClaims, setDiscoveredClaims] = useState<number[]>([]);

  // Pending-claim resume state (persisted across sessions via localStorage)
  const [pendingClaimsTick, setPendingClaimsTick] = useState(0);
  const [resumingTransferId, setResumingTransferId] = useState<number | null>(null);

  // Stealth Inbox — claim codes this user received via deep link (?inbox=...)
  // Listed in a dedicated tab so recipients never need to copy/paste codes.
  const [searchParams, setSearchParams] = useSearchParams();
  const [inboxTick, setInboxTick] = useState(0);
  const [shareLink, setShareLink] = useState<string | null>(null);

  // Recompute whenever the tick advances (after claim start / finalize / resume)
  // or the address changes.
  const pendingClaims = useMemo(
    () => getPendingClaims(),
    // `getPendingClaims` is stable per-address; `pendingClaimsTick` forces a
    // refresh after mutations (claim submitted, finalize succeeded, etc).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getPendingClaims, pendingClaimsTick, address],
  );

  // Re-read from localStorage when the flow reaches a terminal state so a
  // freshly-persisted (or freshly-removed) entry shows/hides immediately.
  useEffect(() => {
    if (step === "success" || step === "error" || step === "waiting_for_decryption") {
      setPendingClaimsTick((t) => t + 1);
    }
  }, [step]);

  // #218/#219: another tab mutated the stealth inbox (added a new deep-link
  // claim, or updated an entry's status). Refresh our list from localStorage
  // so both tabs stay in sync without a reload.
  useEffect(() => {
    if (!address) return;
    return onCrossTabAction((action, data) => {
      if (action !== "stealth_inbox_changed") return;
      // Ignore broadcasts scoped to a different (address, chainId) pair.
      if (
        data &&
        typeof data.address === "string" &&
        data.address.toLowerCase() !== address.toLowerCase()
      ) {
        return;
      }
      if (data && typeof data.chainId === "number" && data.chainId !== activeChainId) {
        return;
      }
      setInboxTick((t) => t + 1);
    });
  }, [address, activeChainId]);

  // #225: another tab finalized a pending claim. Drop it from our "Resume
  // Pending Claims" list by re-reading the persisted store.
  useEffect(() => {
    if (!address) return;
    return onCrossTabAction((action, data) => {
      if (action !== "pending_claim_removed") return;
      if (
        data &&
        typeof data.address === "string" &&
        data.address.toLowerCase() !== address.toLowerCase()
      ) {
        return;
      }
      if (data && typeof data.chainId === "number" && data.chainId !== activeChainId) {
        return;
      }
      setPendingClaimsTick((t) => t + 1);
    });
  }, [address, activeChainId]);

  // ─── Inbox memo ──────────────────────────────────────────────────
  // Re-reads localStorage whenever `inboxTick` advances (e.g. after a
  // deep-link adds an entry, or an entry's status changes).
  const inboxEntries = useMemo<StealthInboxEntry[]>(() => {
    if (!address) return [];
    return getStealthInbox(address, activeChainId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, activeChainId, inboxTick]);

  // ─── Deep-link handler: #inbox=<base64>&from=<shortAddr> ─────────
  //
  // Preferred form: URL fragment (#inbox=...) — fragments are NEVER sent
  // to servers, don't appear in browser history by default, don't get
  // auto-unfurled by Slack/Discord, and don't leak via Referer.
  //
  // Backward-compat: if we land on a legacy ?inbox=... query-string link,
  // we still honour it but warn the user that the old format exposed the
  // claim code in server logs and they should re-share using a fresh link.
  useEffect(() => {
    if (!address) return;

    // Parse the URL fragment manually — it's not touched by react-router
    // and we *want* it kept out of the router's hash-aware state.
    const rawHash =
      typeof window !== "undefined" && window.location.hash
        ? window.location.hash.replace(/^#/, "")
        : "";
    const hashParams = new URLSearchParams(rawHash);

    const hashInbox = hashParams.get("inbox");
    const queryInbox = searchParams.get("inbox");
    const inboxParam = hashInbox ?? queryInbox;
    if (!inboxParam) return;

    const fromLegacyQuery = !hashInbox && !!queryInbox;

    try {
      const decoded = atob(inboxParam);
      // Validate shape: 0x + 64 hex chars (32-byte claim code)
      if (!/^0x[a-fA-F0-9]{64}$/.test(decoded)) {
        toast.error("Invalid stealth payment link");
        return;
      }
      const claimCodeBytes = decoded as `0x${string}`;
      const fromHint =
        hashParams.get("from") ?? searchParams.get("from") ?? undefined;
      // Same binding the contract uses for claim verification — keccak256
      // of (claimCode, recipientAddress). This matches computeClaimCodeHash
      // in useStealthPayments.
      const claimCodeHash = keccak256(
        encodePacked(
          ["bytes32", "address"],
          [claimCodeBytes, address as `0x${string}`],
        ),
      );

      const added = addToStealthInbox(address, activeChainId, {
        claimCode: claimCodeBytes,
        claimCodeHash,
        fromHint,
      });

      if (added) {
        toast.success("You have an incoming stealth payment");
      } else {
        toast("This stealth link is already in your Inbox", {
          icon: "\u2139\uFE0F",
        });
      }

      if (fromLegacyQuery) {
        toast(
          "For security, please re-share the link — the old format exposes the claim code in server logs.",
          { icon: "\u26A0\uFE0F", duration: 8000 },
        );
      }

      setInboxTick((t) => t + 1);
      setActiveTab("inbox");
    } catch {
      toast.error("Could not decode stealth payment link");
    } finally {
      // Clear both the query string and the fragment so a refresh doesn't
      // re-trigger import and the URL stays clean of the claim code.
      if (queryInbox) {
        setSearchParams({}, { replace: true });
      }
      if (hashInbox && typeof window !== "undefined") {
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
  }, [address, activeChainId, searchParams, setSearchParams]);

  const isSubmitting =
    step !== "idle" && step !== "success" && step !== "error" && step !== "waiting_for_decryption";

  // Filter stealth activities from the activity feed
  const stealthActivities = activities.filter(
    (a) =>
      a.activity_type === "stealth_sent" ||
      a.activity_type === "stealth_claim_started" ||
      a.activity_type === "stealth_claimed"
  );

  const handleCopy = useCallback((id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  // ─── localStorage Claim Code Helpers ──────────────────────────────

  const saveClaimCodeToStorage = useCallback(
    (code: string, transferId: number, recipientAddr: string) => {
      if (!address) return;
      const key = STORAGE_KEYS.claimCodes(address, activeChainId);
      const existing = getStoredJson<StoredClaimCode[]>(key, []);
      existing.push({
        claimCode: code,
        transferId,
        recipientAddress: recipientAddr,
        createdAt: Date.now(),
      });
      setStoredJson(key, existing);
    },
    [address, activeChainId]
  );

  const getStoredClaimCodes = useCallback((): StoredClaimCode[] => {
    if (!address) return [];
    return getStoredJson<StoredClaimCode[]>(
      STORAGE_KEYS.claimCodes(address, activeChainId),
      [],
    );
  }, [address, activeChainId]);

  // ─── Load Sent Transfers (for refund tab) ─────────────────────────

  const loadSentTransfers = useCallback(async () => {
    if (!address || !publicClient) return;
    setLoadingSent(true);
    try {
      const stealthAddress = contracts.StealthPayments as `0x${string}`;
      const ids = (await publicClient.readContract({
        address: stealthAddress,
        abi: StealthPaymentsAbi,
        functionName: "getSenderTransfers",
        args: [address],
      })) as bigint[];

      const infos: SentTransferInfo[] = [];
      for (const id of ids) {
        try {
          const result = (await publicClient.readContract({
            address: stealthAddress,
            abi: StealthPaymentsAbi,
            functionName: "getTransferInfo",
            args: [id],
          })) as [string, string, string, bigint, string, string, bigint, boolean, boolean];

          infos.push({
            transferId: Number(id),
            plaintextAmount: result[3],
            note: result[5],
            timestamp: Number(result[6]),
            claimed: result[7],
            finalized: result[8],
          });
        } catch {
          // Skip transfers that fail to load
        }
      }

      // Sort newest first
      infos.sort((a, b) => b.timestamp - a.timestamp);
      setSentTransfers(infos);
    } catch (err) {
      console.warn("Failed to load sent transfers:", err);
      toast.error("Failed to load sent payments");
    } finally {
      setLoadingSent(false);
    }
  }, [address, publicClient, contracts]);

  // Load sent transfers when "sent" tab is activated
  useEffect(() => {
    if (activeTab === "sent") {
      loadSentTransfers();
    }
  }, [activeTab, loadSentTransfers]);

  // ─── Refund Handler ───────────────────────────────────────────────

  const handleRefund = useCallback(
    async (transferId: number) => {
      if (!address || !publicClient) {
        toast.error("Connect wallet first");
        return;
      }

      setRefundingId(transferId);
      const refundToastId = toast.loading("Processing refund...");

      try {
        const stealthAddress = contracts.StealthPayments as `0x${string}`;
        const { hash, receipt: aaReceipt } = await unifiedWriteAndWait({
          address: stealthAddress,
          abi: StealthPaymentsAbi,
          functionName: "refund",
          args: [BigInt(transferId)],
          gas: BigInt(5_000_000), // CoFHE: manual gas limit (precompile breaks estimation)
        });

        // AA path returns a pre-fetched receipt from the relayer; EOA path
        // does not, so fall through to publicClient in that case.
        const status = aaReceipt?.status
          ?? (await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 })).status;

        if (status === "reverted") {
          throw new Error("Refund transaction reverted");
        }

        toast.success("Refund successful!", { id: refundToastId });
        // Reload the sent transfers list
        loadSentTransfers();
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Refund failed";
        toast.error(msg, { id: refundToastId });
      } finally {
        setRefundingId(null);
      }
    },
    [address, unifiedWriteAndWait, publicClient, loadSentTransfers, contracts]
  );

  // ─── Check for Pending Claims ─────────────────────────────────────

  const handleCheckPendingClaims = useCallback(async () => {
    if (!address) {
      toast.error("Connect wallet first");
      return;
    }

    setCheckingClaims(true);
    setDiscoveredClaims([]);

    try {
      const storedCodes = getStoredClaimCodes();
      if (storedCodes.length === 0) {
        toast("No stored claim codes found. Claim codes are saved when you send stealth payments.", { icon: "\u2139\uFE0F" });
        setCheckingClaims(false);
        return;
      }

      // Compute claim code hashes for each stored code
      const hashes: `0x${string}`[] = storedCodes.map((sc) =>
        keccak256(
          encodePacked(
            ["bytes32", "address"],
            [sc.claimCode as `0x${string}`, sc.recipientAddress as `0x${string}`]
          )
        )
      );

      const pending = await getMyPendingClaims(hashes);

      if (pending.length === 0) {
        toast.success("No pending claims found");
      } else {
        setDiscoveredClaims(pending);
        toast.success(`Found ${pending.length} pending claim(s)!`);
      }
    } catch (err) {
      console.warn("Check pending claims failed:", err);
      toast.error("Failed to check pending claims");
    } finally {
      setCheckingClaims(false);
    }
  }, [address, getStoredClaimCodes, getMyPendingClaims]);

  // ─── Create Stealth Payment ────────────────────────────────────────

  const handleCreateCode = useCallback(async () => {
    if (!address) { toast.error("Connect wallet first"); return; }
    if (!amount || !recipient) {
      toast.error(!amount ? "Enter an amount" : "Enter a recipient address");
      return;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(recipient.trim())) {
      return;
    }

    const result = await sendStealth(
      amount,
      recipient.trim(),
      contracts.FHERC20Vault_USDC,
      message || "Stealth payment"
    );

    if (result) {
      setNewCode({
        code: result.claimCode,
        transferId: result.transferId,
        // #294: preserve full input precision (USDC has 6 decimals on-chain).
        amount: formatUsdcInput(amount),
      });
      // Save claim code to localStorage for pending claims discovery
      saveClaimCodeToStorage(result.claimCode, result.transferId, recipient.trim());
    }
  }, [address, amount, recipient, message, sendStealth, saveClaimCodeToStorage, contracts]);

  // ─── Claim Stealth Payment ─────────────────────────────────────────

  const handleClaim = useCallback(async () => {
    if (!claimCode.trim() || !claimTransferId.trim()) return;
    const transferId = parseInt(claimTransferId, 10);
    if (isNaN(transferId)) return;

    const result = await claimStealth(transferId, claimCode.trim());
    if (result) {
      setClaimSuccess(true);
    }
  }, [claimCode, claimTransferId, claimStealth]);

  // ─── Finalize Claim ────────────────────────────────────────────────

  const handleFinalize = useCallback(async () => {
    if (!finalizeId.trim()) return;
    const transferId = parseInt(finalizeId, 10);
    if (isNaN(transferId)) return;
    await finalizeClaim(transferId);
  }, [finalizeId, finalizeClaim]);

  // ─── Resume Persisted Pending Claim ───────────────────────────────

  const handleResumeClaim = useCallback(
    async (transferId: number, claimCode: string) => {
      setResumingTransferId(transferId);
      try {
        await resumePendingClaim(BigInt(transferId), claimCode);
      } finally {
        setResumingTransferId(null);
        // Re-read the persisted list so a just-finalized entry drops out.
        setPendingClaimsTick((t) => t + 1);
      }
    },
    [resumePendingClaim],
  );

  // ─── Claim from Inbox ─────────────────────────────────────────────
  //
  // The recipient has a claim code but no transferId (the sender doesn't
  // know the eventual transferId off-chain either — it's only assigned
  // once the sender's sendStealth tx is mined). We discover it by hashing
  // the claim code with the recipient's address and calling the existing
  // `getMyPendingClaims` helper, which maps claimCodeHash -> transferId.

  const handleClaimFromInbox = useCallback(
    async (entry: StealthInboxEntry) => {
      if (!address) {
        toast.error("Connect wallet first");
        return;
      }

      markInboxEntryStatus(address, activeChainId, entry.claimCodeHash, "claiming");
      setInboxTick((t) => t + 1);

      try {
        const pending = await getMyPendingClaims([entry.claimCodeHash]);
        if (pending.length === 0) {
          toast.error(
            "Transfer not found on-chain yet. Ask the sender to confirm the tx was mined.",
          );
          markInboxEntryStatus(address, activeChainId, entry.claimCodeHash, "new");
          setInboxTick((t) => t + 1);
          return;
        }

        const transferId = pending[0];
        const result = await claimStealth(transferId, entry.claimCode);
        if (result) {
          // Auto-decryption polling started — mark as claimed so the user
          // sees the state change. Full finalization is handled by the
          // polling loop in useStealthPayments.
          markInboxEntryStatus(address, activeChainId, entry.claimCodeHash, "claimed");
          setInboxTick((t) => t + 1);
        } else {
          markInboxEntryStatus(address, activeChainId, entry.claimCodeHash, "new");
          setInboxTick((t) => t + 1);
        }
      } catch {
        markInboxEntryStatus(address, activeChainId, entry.claimCodeHash, "new");
        setInboxTick((t) => t + 1);
      }
    },
    [address, activeChainId, claimStealth, getMyPendingClaims],
  );

  // ─── Share Link Builder ───────────────────────────────────────────
  //
  // Once a stealth payment is created, build a deep link the sender can
  // share with the recipient. When opened on the recipient's device,
  // the `useEffect` above auto-imports the claim into their Inbox.
  // The claim code IS the secret — putting it in a URL is no worse than
  // DMing it, and the recipient must already have received the URL
  // out-of-band (SMS, DM, QR code, etc).

  const buildShareLink = useCallback(
    (claimCode: string, sender?: string): string => {
      const encoded = btoa(claimCode);
      // Fragment (#...) instead of query string (?...) — fragments are not
      // sent to servers, not unfurled by messengers, and not stored in
      // server logs or Referer headers.
      const params = new URLSearchParams({ inbox: encoded });
      if (sender) {
        params.set("from", `${sender.slice(0, 6)}...${sender.slice(-4)}`);
      }
      return `${window.location.origin}/app/stealth#${params.toString()}`;
    },
    [],
  );

  // Generate the share link whenever `newCode` is produced on the Create tab.
  useEffect(() => {
    if (newCode && address) {
      setShareLink(buildShareLink(newCode.code, address));
    } else {
      setShareLink(null);
    }
  }, [newCode, address, buildShareLink]);

  const handleCopyShareLink = useCallback(async () => {
    if (!shareLink) return;
    const ok = await copyToClipboard(shareLink);
    if (ok) {
      setCopied("share-link");
      toast.success("Link copied! Send it to the recipient.");
      setTimeout(() => setCopied(null), 2000);
    } else {
      toast.error("Could not copy link");
    }
  }, [shareLink]);

  // ─── Format "started 3m ago" style relative timestamps ────────────

  const formatRelative = useCallback((timestampMs: number): string => {
    const diff = Date.now() - timestampMs;
    const sec = Math.round(diff / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const days = Math.round(hr / 24);
    return `${days}d ago`;
  }, []);

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        {/* Page Title */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Stealth Payments
          </h1>
          <p className="text-sm sm:text-base text-[var(--text-primary)]/50 leading-relaxed">
            Send anonymous payments via claim codes
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex flex-wrap gap-2 sm:gap-3 mb-6" role="tablist" aria-label="Stealth payment tabs">
          <button
            onClick={() => setActiveTab("create")}
            role="tab"
            aria-selected={activeTab === "create"}
            aria-label="Create code"
            className={cn(
              "flex-1 min-w-[120px] sm:min-w-[140px] h-12 sm:h-14 px-3 sm:px-6 rounded-2xl font-medium transition-all text-xs sm:text-sm",
              activeTab === "create"
                ? "bg-[var(--text-primary)] text-white"
                : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80"
            )}
          >
            <div className="flex items-center justify-center gap-2">
              <Plus size={18} className="sm:w-5 sm:h-5" />
              <span>Create Code</span>
            </div>
          </button>
          <button
            onClick={() => setActiveTab("inbox")}
            role="tab"
            aria-selected={activeTab === "inbox"}
            aria-label="Stealth inbox"
            className={cn(
              "flex-1 min-w-[120px] sm:min-w-[140px] h-12 sm:h-14 px-3 sm:px-6 rounded-2xl font-medium transition-all relative text-xs sm:text-sm",
              activeTab === "inbox"
                ? "bg-[var(--text-primary)] text-white"
                : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80"
            )}
          >
            <div className="flex items-center justify-center gap-2">
              <Inbox size={18} className="sm:w-5 sm:h-5" />
              <span>Inbox</span>
              {inboxEntries.some((e) => e.status === "new") && (
                <span
                  className={cn(
                    "ml-1 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-semibold",
                    activeTab === "inbox"
                      ? "bg-white text-[var(--text-primary)]"
                      : "bg-purple-500 text-white",
                  )}
                  aria-label={`${inboxEntries.filter((e) => e.status === "new").length} new incoming payments`}
                >
                  {inboxEntries.filter((e) => e.status === "new").length}
                </span>
              )}
            </div>
          </button>
          <button
            onClick={() => setActiveTab("claim")}
            role="tab"
            aria-selected={activeTab === "claim"}
            aria-label="Claim code"
            className={cn(
              "flex-1 min-w-[120px] sm:min-w-[140px] h-12 sm:h-14 px-3 sm:px-6 rounded-2xl font-medium transition-all text-xs sm:text-sm",
              activeTab === "claim"
                ? "bg-[var(--text-primary)] text-white"
                : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80"
            )}
          >
            <div className="flex items-center justify-center gap-2">
              <KeyRound size={18} className="sm:w-5 sm:h-5" />
              <span>Claim Code</span>
            </div>
          </button>
          <button
            onClick={() => setActiveTab("sent")}
            role="tab"
            aria-selected={activeTab === "sent"}
            aria-label="My sent payments"
            className={cn(
              "flex-1 min-w-[120px] sm:min-w-[140px] h-12 sm:h-14 px-3 sm:px-6 rounded-2xl font-medium transition-all text-xs sm:text-sm",
              activeTab === "sent"
                ? "bg-[var(--text-primary)] text-white"
                : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80"
            )}
          >
            <div className="flex items-center justify-center gap-2">
              <Send size={18} className="sm:w-5 sm:h-5" />
              <span>My Sent</span>
            </div>
          </button>
        </div>

        {/* Create Code Tab */}
        {activeTab === "create" && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Create Form */}
            <div className="rounded-[2rem] glass-card p-8">
              {newCode ? (
                <div className="flex flex-col items-center text-center py-4">
                  <div className="w-16 h-16 rounded-2xl bg-purple-50 flex items-center justify-center mb-4">
                    <CheckCircle2 size={40} className="text-purple-500" />
                  </div>
                  <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-2">
                    Stealth Payment Sent!
                  </h3>
                  <p className="text-sm text-[var(--text-primary)]/50 mb-4">
                    Share the claim code and transfer ID with the recipient
                  </p>

                  <div className="w-full space-y-3 mb-4">
                    <div className="p-4 rounded-2xl bg-purple-50 border-2 border-purple-200">
                      <p className="text-xs text-purple-600 font-medium mb-1">
                        Claim Code
                      </p>
                      <p className="font-mono text-xs text-purple-800 break-all">
                        {newCode.code}
                      </p>
                    </div>
                    <div className="p-3 rounded-2xl bg-blue-50 border border-blue-200">
                      <p className="text-xs text-blue-600 font-medium mb-1">
                        Transfer ID
                      </p>
                      <p className="font-mono text-lg font-bold text-blue-800">
                        {newCode.transferId}
                      </p>
                    </div>
                  </div>

                  <p className="text-2xl font-heading font-medium text-[var(--text-primary)] mb-6">
                    ${newCode.amount}
                  </p>

                  {/* Share Link — the one-click way for the recipient to
                      receive this payment without copying codes manually.
                      Opens the Stealth screen on their side with ?inbox=...
                      which auto-imports the claim to their Inbox. */}
                  {shareLink && (
                    <div className="w-full p-4 rounded-2xl bg-indigo-50 border-2 border-indigo-200 mb-4">
                      <div className="flex items-center gap-2 mb-2">
                        <Link2 size={16} className="text-indigo-600" />
                        <p className="text-xs text-indigo-600 font-medium">
                          Share Link
                        </p>
                      </div>
                      <p className="font-mono text-[11px] text-indigo-800 break-all mb-3">
                        {shareLink}
                      </p>
                      <button
                        onClick={handleCopyShareLink}
                        className="w-full h-10 rounded-xl bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition-colors flex items-center justify-center gap-2"
                        aria-label="Copy share link"
                      >
                        {copied === "share-link" ? (
                          <Check size={16} />
                        ) : (
                          <Copy size={16} />
                        )}
                        <span>
                          {copied === "share-link" ? "Link copied!" : "Copy Link"}
                        </span>
                      </button>
                      <p className="text-[11px] text-indigo-700/80 mt-2 text-center">
                        Send this link to the recipient — they'll see it
                        appear in their Inbox automatically.
                      </p>
                      <p className="text-[11px] text-amber-700 dark:text-amber-400 mt-2 flex items-center justify-center gap-1">
                        <AlertTriangle size={12} />
                        <span>
                          Treat this link like a password. Anyone who opens
                          it can see the claim code. Share privately.
                        </span>
                      </p>
                    </div>
                  )}

                  <div className="flex gap-3 w-full">
                    <button
                      onClick={() =>
                        handleCopy(
                          "code",
                          `Claim Code: ${newCode.code}\nTransfer ID: ${newCode.transferId}`
                        )
                      }
                      className="flex-1 h-12 rounded-2xl bg-[var(--text-primary)] text-white font-medium flex items-center justify-center gap-2"
                      aria-label="Copy claim details"
                    >
                      {copied === "code" ? (
                        <Check size={20} />
                      ) : (
                        <Copy size={20} />
                      )}
                      {copied === "code" ? "Copied!" : "Copy Details"}
                    </button>
                    <button
                      onClick={() => {
                        setNewCode(null);
                        setAmount("");
                        setRecipient("");
                        setMessage("");
                        reset();
                      }}
                      className="flex-1 h-12 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium"
                    >
                      New Code
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3 mb-6">
                    <div className="w-12 h-12 rounded-xl bg-purple-50 flex items-center justify-center">
                      <Ghost size={24} className="text-purple-600" />
                    </div>
                    <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
                      New Stealth Payment
                    </h3>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
                        Amount (USDC)
                      </label>
                      <div className="relative">
                        <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-primary)]/50">
                          $
                        </span>
                        <input
                          type="text"
                          placeholder="0.00"
                          value={amount}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (/^\d*\.?\d{0,6}$/.test(v) || v === "")
                              setAmount(v);
                          }}
                          className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 text-lg"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
                        Recipient Address
                      </label>
                      <input
                        type="text"
                        placeholder="0x..."
                        value={recipient}
                        onChange={(e) => setRecipient(e.target.value)}
                        className="h-14 w-full px-5 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 font-mono text-sm"
                      />
                      {recipient &&
                        !/^0x[a-fA-F0-9]{40}$/.test(recipient.trim()) && (
                          <p className="text-xs text-red-500 mt-1">
                            Invalid Ethereum address
                          </p>
                        )}
                    </div>

                    <div>
                      <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
                        Note (Optional)
                      </label>
                      <textarea
                        placeholder="Add a private note..."
                        rows={3}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        className="w-full px-5 py-4 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 resize-none"
                      />
                    </div>

                    <div className="p-4 rounded-2xl bg-purple-50 border border-purple-100">
                      <div className="flex items-start gap-3">
                        <Lock size={20} className="text-purple-600 mt-0.5" />
                        <div>
                          <p className="text-sm font-medium text-purple-900">
                            Anonymous Payment
                          </p>
                          <p className="text-xs text-purple-700 mt-1">
                            The recipient identity is FHE-encrypted on-chain.
                            Only the claim code holder can receive funds.
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Processing indicator */}
                    {isSubmitting && (
                      <div className="p-4 rounded-2xl bg-blue-50 border border-blue-100">
                        <div className="flex items-center gap-3">
                          <Loader2
                            size={20}
                            className="text-blue-600 animate-spin"
                          />
                          <p className="text-sm font-medium text-blue-900">
                            {getStepLabel(step)}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Error display */}
                    {error && (
                      <div className="p-4 rounded-2xl bg-red-50 border border-red-100">
                        <div className="flex items-start gap-3">
                          <AlertCircle
                            size={20}
                            className="text-red-600 mt-0.5"
                          />
                          <p className="text-sm text-red-800">{error}</p>
                        </div>
                      </div>
                    )}

                    <button
                      disabled={
                        isSubmitting ||
                        !amount ||
                        !recipient ||
                        !/^0x[a-fA-F0-9]{40}$/.test(recipient.trim())
                      }
                      onClick={handleCreateCode}
                      className="w-full h-14 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      {isSubmitting ? (
                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      ) : (
                        <Ghost size={20} />
                      )}
                      <span>Send Stealth Payment</span>
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* How It Works */}
            <div className="rounded-[2rem] glass-card p-8">
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-6">
                How It Works
              </h3>

              <div className="space-y-4">
                <div className="flex gap-4">
                  <div className="w-8 h-8 rounded-full bg-[#007AFF]/10 flex items-center justify-center flex-shrink-0">
                    <span className="text-sm font-medium text-[#007AFF]">
                      1
                    </span>
                  </div>
                  <div>
                    <p className="font-medium text-[var(--text-primary)] mb-1">
                      Send Stealth Payment
                    </p>
                    <p className="text-sm text-[var(--text-primary)]/60">
                      Enter amount and recipient. A claim code is generated and
                      the recipient is FHE-encrypted on-chain.
                    </p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="w-8 h-8 rounded-full bg-[#007AFF]/10 flex items-center justify-center flex-shrink-0">
                    <span className="text-sm font-medium text-[#007AFF]">
                      2
                    </span>
                  </div>
                  <div>
                    <p className="font-medium text-[var(--text-primary)] mb-1">
                      Share Claim Code
                    </p>
                    <p className="text-sm text-[var(--text-primary)]/60">
                      Send the claim code and transfer ID to the recipient via
                      any private channel
                    </p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="w-8 h-8 rounded-full bg-[#007AFF]/10 flex items-center justify-center flex-shrink-0">
                    <span className="text-sm font-medium text-[#007AFF]">
                      3
                    </span>
                  </div>
                  <div>
                    <p className="font-medium text-[var(--text-primary)] mb-1">
                      Claim &rarr; Finalize
                    </p>
                    <p className="text-sm text-[var(--text-primary)]/60">
                      Recipient claims with their code, then finalizes after
                      async FHE decryption completes
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-6 p-4 rounded-2xl bg-emerald-50 border border-emerald-100">
                <div className="flex items-start gap-3">
                  <Lock size={20} className="text-emerald-600 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-emerald-900">
                      FHE Encrypted
                    </p>
                    <p className="text-xs text-emerald-700 mt-1">
                      All amounts are encrypted with Fully Homomorphic
                      Encryption. The recipient is hidden on-chain.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Inbox Tab — incoming stealth payments received via deep link */}
        {activeTab === "inbox" && (
          <div className="space-y-6">
            <div className="glass-card-static rounded-3xl p-8">
              <div className="max-w-2xl mx-auto">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center">
                    <Inbox size={20} className="text-purple-600" />
                  </div>
                  <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
                    Stealth Inbox
                  </h3>
                </div>
                <p className="text-sm text-[var(--text-primary)]/50 mb-6">
                  Incoming stealth payments you've received as a deep link.
                  Click <span className="font-medium">Claim</span> to receive
                  the funds — no copy/paste needed.
                </p>

                {inboxEntries.length === 0 ? (
                  <div className="py-12 text-center">
                    <div className="w-16 h-16 rounded-2xl bg-purple-50 flex items-center justify-center mx-auto mb-4">
                      <Inbox size={32} className="text-purple-400" />
                    </div>
                    <p className="text-lg font-heading font-medium text-[var(--text-primary)] mb-1">
                      No incoming payments
                    </p>
                    <p className="text-sm text-[var(--text-primary)]/50">
                      Ask a sender to share a stealth payment link with you.
                      It'll appear here automatically.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {inboxEntries.map((entry) => {
                      const isActive =
                        entry.status === "claiming" &&
                        (isSubmitting || isWaitingForDecryption);
                      return (
                        <div
                          key={entry.claimCodeHash}
                          className={cn(
                            "flex items-center justify-between p-5 rounded-2xl border transition-all",
                            entry.status === "claimed"
                              ? "bg-emerald-50/60 border-emerald-100"
                              : entry.status === "claiming"
                                ? "bg-amber-50/60 border-amber-100"
                                : "bg-purple-50/60 border-purple-100",
                          )}
                        >
                          <div className="flex-1 min-w-0 pr-3">
                            <div className="flex items-center gap-2 mb-1">
                              <p className="text-sm font-medium text-[var(--text-primary)]">
                                From:{" "}
                                <span className="font-mono text-xs">
                                  {entry.fromHint || "anonymous"}
                                </span>
                              </p>
                              <div
                                className={cn(
                                  "inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium border",
                                  entry.status === "claimed"
                                    ? "bg-emerald-100 text-emerald-700 border-emerald-200"
                                    : entry.status === "claiming"
                                      ? "bg-amber-100 text-amber-700 border-amber-200"
                                      : "bg-purple-100 text-purple-700 border-purple-200",
                                )}
                              >
                                {entry.status === "claimed"
                                  ? "claimed"
                                  : entry.status === "claiming"
                                    ? "claiming..."
                                    : "new"}
                              </div>
                            </div>
                            <p className="text-xs text-[var(--text-primary)]/50">
                              Received {formatRelative(entry.receivedAt)}
                            </p>
                          </div>
                          <button
                            disabled={
                              entry.status === "claimed" ||
                              isActive ||
                              isSubmitting ||
                              isWaitingForDecryption
                            }
                            onClick={() => handleClaimFromInbox(entry)}
                            className={cn(
                              "h-11 px-5 rounded-xl text-sm font-medium transition-colors flex items-center gap-2 disabled:opacity-50",
                              entry.status === "claimed"
                                ? "bg-emerald-500 text-white"
                                : "bg-[var(--text-primary)] text-white hover:bg-black",
                            )}
                          >
                            {entry.status === "claiming" ? (
                              <Loader2 size={16} className="animate-spin" />
                            ) : entry.status === "claimed" ? (
                              <CheckCircle2 size={16} />
                            ) : (
                              <KeyRound size={16} />
                            )}
                            <span>
                              {entry.status === "claimed"
                                ? "Claimed"
                                : entry.status === "claiming"
                                  ? "Claiming..."
                                  : "Claim"}
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Privacy notice */}
                <div className="mt-6 p-4 rounded-2xl bg-blue-50 border border-blue-100">
                  <div className="flex items-start gap-3">
                    <Lock size={18} className="text-blue-600 mt-0.5" />
                    <p className="text-xs text-blue-800">
                      Inbox entries are stored locally on this device only.
                      Claim codes never leave your browser until you claim.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Claim Code Tab */}
        {activeTab === "claim" && (
          <div className="space-y-6">
            {/* Resume Pending Claims — only shown when we have persisted entries
                for the current signer. These are claimStealth() calls that hit
                the chain but whose async-decrypt didn't observably finalize in
                the session that started them (e.g. 60s poll timed out, user
                navigated away). Clicking Resume runs finalizeClaim() again. */}
            {pendingClaims.length > 0 && (
              <div className="glass-card-static rounded-3xl p-8">
                <div className="max-w-2xl mx-auto">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
                      <Clock size={20} className="text-amber-600" />
                    </div>
                    <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
                      Resume Pending Claims
                    </h3>
                  </div>
                  <p className="text-sm text-[var(--text-primary)]/50 mb-4">
                    You started these claims but their FHE decryption didn't
                    finalize in this browser. Resume to finalize and release funds.
                  </p>
                  <div className="space-y-3">
                    {pendingClaims.map((pc) => {
                      const isResuming = resumingTransferId === pc.transferId;
                      return (
                        <div
                          key={pc.transferId}
                          className="flex items-center justify-between p-4 rounded-2xl bg-amber-50/60 border border-amber-100"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-amber-900">
                              Transfer #{pc.transferId}
                            </p>
                            <p className="text-xs text-amber-700/80 mt-0.5">
                              Started {formatRelative(pc.startedAt)}
                            </p>
                          </div>
                          <button
                            disabled={isResuming || isSubmitting || isWaitingForDecryption}
                            onClick={() =>
                              handleResumeClaim(pc.transferId, pc.claimCode)
                            }
                            className="h-10 px-5 rounded-xl bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors flex items-center gap-2 disabled:opacity-50"
                          >
                            {isResuming ? (
                              <Loader2 size={16} className="animate-spin" />
                            ) : (
                              <CheckCircle2 size={16} />
                            )}
                            <span>{isResuming ? "Resuming..." : "Resume"}</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* Claim Form */}
            <div className="rounded-[2rem] glass-card p-8">
              <div className="max-w-2xl mx-auto">
                {claimSuccess ? (
                  <div className="flex flex-col items-center text-center py-8">
                    <div className="w-20 h-20 rounded-full bg-emerald-50 flex items-center justify-center mb-4">
                      <CheckCircle2 size={48} className="text-emerald-500" />
                    </div>
                    <h3 className="text-2xl font-heading font-medium text-[var(--text-primary)] mb-2">
                      Claim Initiated!
                    </h3>
                    <p className="text-[var(--text-primary)]/60 mb-6">
                      Async FHE decryption is in progress. Use the Finalize
                      section below to complete the claim once decryption
                      resolves.
                    </p>
                    {txHash && (
                      <p className="text-xs font-mono text-[var(--text-primary)]/40 mb-4 break-all">
                        Tx: {txHash}
                      </p>
                    )}
                    {isWaitingForDecryption && (
                      <div className="w-full p-4 rounded-2xl bg-amber-50 border border-amber-200 mb-6">
                        <div className="flex items-center gap-3">
                          <Loader2 size={18} className="text-amber-600 animate-spin" />
                          <p className="text-sm text-amber-600 animate-pulse font-medium">
                            {decryptionProgress}
                          </p>
                        </div>
                      </div>
                    )}
                    {!isWaitingForDecryption && (
                      <div className="w-full p-4 rounded-2xl bg-emerald-50 border border-emerald-200 mb-6">
                        <p className="text-sm text-emerald-700 font-medium">
                          Decryption complete -- you can finalize below or it was auto-finalized.
                        </p>
                      </div>
                    )}
                    <button
                      onClick={() => {
                        setClaimSuccess(false);
                        setClaimCode("");
                        setClaimTransferId("");
                        reset();
                      }}
                      className="h-12 px-8 rounded-2xl bg-[var(--text-primary)] text-white font-medium"
                    >
                      Claim Another
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-center gap-3 mb-8">
                      <div className="w-16 h-16 rounded-2xl bg-emerald-50 flex items-center justify-center">
                        <KeyRound size={32} className="text-emerald-600" />
                      </div>
                    </div>

                    <h3 className="text-2xl font-heading font-medium text-[var(--text-primary)] text-center mb-2">
                      Claim Payment
                    </h3>
                    <p className="text-center text-[var(--text-primary)]/60 mb-8">
                      Enter the transfer ID and claim code to receive your
                      payment
                    </p>

                    <div className="space-y-4">
                      <div>
                        <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
                          Transfer ID
                        </label>
                        <input
                          type="text"
                          placeholder="0"
                          value={claimTransferId}
                          onChange={(e) => setClaimTransferId(e.target.value)}
                          className="h-14 w-full px-6 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 text-center text-xl font-mono"
                        />
                      </div>

                      <div>
                        <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
                          Claim Code
                        </label>
                        <input
                          type="text"
                          placeholder="0x..."
                          value={claimCode}
                          onChange={(e) => setClaimCode(e.target.value)}
                          className="h-14 w-full px-6 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 text-sm font-mono"
                        />
                      </div>

                      {/* Processing indicator */}
                      {isSubmitting && (
                        <div className="p-4 rounded-2xl bg-blue-50 border border-blue-100">
                          <div className="flex items-center gap-3">
                            <Loader2
                              size={20}
                              className="text-blue-600 animate-spin"
                            />
                            <p className="text-sm font-medium text-blue-900">
                              {getStepLabel(step)}
                            </p>
                          </div>
                        </div>
                      )}

                      {/* Decryption polling progress */}
                      {isWaitingForDecryption && (
                        <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200">
                          <div className="flex items-center gap-3">
                            <Loader2
                              size={20}
                              className="text-amber-600 animate-spin"
                            />
                            <p className="text-sm text-amber-600 animate-pulse font-medium">
                              {decryptionProgress}
                            </p>
                          </div>
                        </div>
                      )}

                      {error && (
                        <div className="p-4 rounded-2xl bg-red-50 border border-red-100">
                          <div className="flex items-start gap-3">
                            <AlertCircle
                              size={20}
                              className="text-red-600 mt-0.5"
                            />
                            <p className="text-sm text-red-800">{error}</p>
                          </div>
                        </div>
                      )}

                      <button
                        disabled={
                          isSubmitting ||
                          isWaitingForDecryption ||
                          !claimCode.trim() ||
                          !claimTransferId.trim()
                        }
                        onClick={handleClaim}
                        className="w-full h-14 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center justify-center gap-2 disabled:opacity-50"
                      >
                        {isSubmitting || isWaitingForDecryption ? (
                          <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        ) : (
                          <KeyRound size={20} />
                        )}
                        <span>Claim Payment</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Finalize Claim */}
            <div className="rounded-[2rem] glass-card p-8">
              <div className="max-w-2xl mx-auto">
                <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-4">
                  Finalize Claim
                </h3>
                <p className="text-sm text-[var(--text-primary)]/50 mb-2">
                  After claiming, wait for FHE decryption to resolve (a few
                  seconds), then finalize to release your funds.
                </p>
                <p className="text-xs text-amber-600 mb-4">
                  FHE decryption takes ~30s after claiming
                </p>
                <div className="flex gap-3">
                  <input
                    type="text"
                    placeholder="Transfer ID"
                    value={finalizeId}
                    onChange={(e) => setFinalizeId(e.target.value)}
                    className="flex-1 h-14 px-6 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 text-center font-mono"
                  />
                  <button
                    disabled={isSubmitting || !finalizeId.trim()}
                    onClick={handleFinalize}
                    className="h-14 px-8 rounded-2xl bg-emerald-500 text-white font-medium transition-transform active:scale-95 hover:bg-emerald-600 flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isSubmitting && step === "finalizing" ? (
                      <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <CheckCircle2 size={20} />
                    )}
                    <span>Finalize</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Pending Claims Discovery */}
            <div className="rounded-[2rem] glass-card p-8">
              <div className="max-w-2xl mx-auto">
                <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-2">
                  Check for Pending Claims
                </h3>
                <p className="text-sm text-[var(--text-primary)]/50 mb-4">
                  If you previously sent stealth payments, check if any are still
                  unclaimed using your stored claim codes.
                </p>
                <button
                  disabled={checkingClaims}
                  onClick={handleCheckPendingClaims}
                  className="w-full h-14 px-6 rounded-2xl bg-blue-500 text-white font-medium transition-transform active:scale-95 hover:bg-blue-600 flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {checkingClaims ? (
                    <Loader2 size={20} className="animate-spin" />
                  ) : (
                    <Search size={20} />
                  )}
                  <span>
                    {checkingClaims
                      ? "Checking..."
                      : "Check for Pending Claims"}
                  </span>
                </button>

                {discoveredClaims.length > 0 && (
                  <div className="mt-4 space-y-2">
                    <p className="text-sm font-medium text-[var(--text-primary)]">
                      Found {discoveredClaims.length} pending claim(s):
                    </p>
                    {discoveredClaims.map((tid) => (
                      <div
                        key={tid}
                        className="flex items-center justify-between p-4 rounded-2xl bg-blue-50 border border-blue-200"
                      >
                        <div>
                          <p className="text-sm font-medium text-blue-900">
                            Transfer #{tid}
                          </p>
                          <p className="text-xs text-blue-700">
                            Unclaimed -- use this Transfer ID above to claim
                          </p>
                        </div>
                        <button
                          onClick={() => {
                            setClaimTransferId(String(tid));
                            toast.success(
                              `Transfer ID #${tid} auto-filled. Enter the claim code to proceed.`
                            );
                          }}
                          className="h-10 px-4 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-colors"
                        >
                          Use
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Sent Payments Tab */}
        {activeTab === "sent" && (
          <div className="space-y-6">
            <div className="rounded-[2rem] glass-card p-8">
              <div className="flex items-center justify-between mb-6">
                <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
                  My Sent Payments
                </h3>
                <button
                  disabled={loadingSent}
                  onClick={loadSentTransfers}
                  className="h-10 px-4 rounded-xl bg-black/5 text-[var(--text-primary)] text-sm font-medium hover:bg-black/10 transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  {loadingSent ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Search size={16} />
                  )}
                  <span>Refresh</span>
                </button>
              </div>

              {loadingSent && sentTransfers.length === 0 ? (
                <div className="py-12 text-center">
                  <Loader2
                    size={32}
                    className="text-purple-400 animate-spin mx-auto mb-4"
                  />
                  <p className="text-sm text-[var(--text-primary)]/50">
                    Loading sent payments from chain...
                  </p>
                </div>
              ) : sentTransfers.length === 0 ? (
                <div className="py-12 text-center">
                  <div className="w-16 h-16 rounded-2xl bg-purple-50 flex items-center justify-center mx-auto mb-4">
                    <Send size={32} className="text-purple-400" />
                  </div>
                  <p className="text-lg font-heading font-medium text-[var(--text-primary)] mb-1">
                    No sent payments
                  </p>
                  <p className="text-sm text-[var(--text-primary)]/50">
                    Stealth payments you send will appear here
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {sentTransfers.map((transfer) => {
                    const now = Math.floor(Date.now() / 1000);
                    const age = now - transfer.timestamp;
                    const canRefund =
                      !transfer.claimed &&
                      !transfer.finalized &&
                      age >= REFUND_WINDOW_SECONDS;
                    const isRefunding = refundingId === transfer.transferId;
                    const daysOld = Math.floor(age / 86400);
                    const daysUntilRefund = Math.max(
                      0,
                      Math.ceil(
                        (REFUND_WINDOW_SECONDS - age) / 86400
                      )
                    );

                    return (
                      <div
                        key={transfer.transferId}
                        className="flex items-center justify-between p-6 rounded-2xl bg-white/50 border border-black/5 hover:bg-white/70 transition-all"
                      >
                        <div className="flex items-center gap-4 flex-1">
                          <div
                            className={cn(
                              "w-12 h-12 rounded-xl flex items-center justify-center",
                              transfer.finalized
                                ? "bg-emerald-50"
                                : transfer.claimed
                                  ? "bg-blue-50"
                                  : "bg-purple-50"
                            )}
                          >
                            <Ghost
                              size={24}
                              className={
                                transfer.finalized
                                  ? "text-emerald-600"
                                  : transfer.claimed
                                    ? "text-blue-600"
                                    : "text-purple-600"
                              }
                            />
                          </div>
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              <p className="text-sm font-medium text-[var(--text-primary)]">
                                Transfer #{transfer.transferId}
                              </p>
                              <div
                                className={cn(
                                  "inline-flex px-2 py-0.5 rounded-full text-xs font-medium border",
                                  transfer.finalized
                                    ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                                    : transfer.claimed
                                      ? "bg-blue-50 text-blue-700 border-blue-100"
                                      : "bg-purple-50 text-purple-700 border-purple-100"
                                )}
                              >
                                {transfer.finalized
                                  ? "claimed"
                                  : transfer.claimed
                                    ? "claim pending"
                                    : "unclaimed"}
                              </div>
                            </div>
                            <p className="text-sm text-[var(--text-primary)]/50">
                              {transfer.note || "Stealth payment"}
                              {" \u00B7 "}
                              {daysOld}d ago
                              {" \u00B7 "}
                              {formatUnits(transfer.plaintextAmount, 6)} USDC
                            </p>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-2 min-w-[180px]">
                          {/* #215: explicit countdown so the sender knows
                              exactly when the 30-day window opens. While
                              `daysUntilRefund > 0` the button is disabled and
                              we show a clear message; at 0 the window is open
                              and the button enables in amber-styling. */}
                          {!transfer.claimed && !transfer.finalized && (
                            <p
                              className={cn(
                                "text-xs text-right leading-snug",
                                canRefund
                                  ? "text-amber-700 font-medium"
                                  : "text-[var(--text-primary)]/50",
                              )}
                            >
                              {canRefund
                                ? "Refund window open"
                                : `Recipient hasn't claimed yet. Refund available in ${daysUntilRefund} day${daysUntilRefund === 1 ? "" : "s"}.`}
                            </p>
                          )}
                          {canRefund ? (
                            <button
                              disabled={isRefunding}
                              onClick={() =>
                                handleRefund(transfer.transferId)
                              }
                              className="h-10 px-4 rounded-xl bg-amber-500 text-white text-sm font-medium hover:bg-amber-600 transition-colors flex items-center gap-2 disabled:opacity-50"
                            >
                              {isRefunding ? (
                                <Loader2
                                  size={16}
                                  className="animate-spin"
                                />
                              ) : (
                                <Undo2 size={16} />
                              )}
                              <span>Refund</span>
                            </button>
                          ) : !transfer.claimed && !transfer.finalized ? (
                            <button
                              disabled
                              className="h-10 px-4 rounded-xl bg-black/5 text-[var(--text-primary)]/40 text-sm font-medium flex items-center gap-2 cursor-not-allowed"
                              aria-label={`Refund available in ${daysUntilRefund} days`}
                            >
                              <Undo2 size={16} />
                              <span>Refund</span>
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="mt-4 p-4 rounded-2xl bg-amber-50 border border-amber-100">
                <div className="flex items-start gap-3">
                  <AlertCircle
                    size={18}
                    className="text-amber-600 mt-0.5"
                  />
                  <p className="text-xs text-amber-700">
                    Refunds are available after 30 days for unclaimed payments.
                    Once a payment is claimed, it cannot be refunded.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* My Stealth Activity */}
        <div className="mt-6 rounded-[2rem] glass-card p-8">
          <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-6">
            Stealth Activity
          </h3>
          {stealthActivities.length === 0 ? (
            <div className="py-12 text-center">
              <div className="w-16 h-16 rounded-2xl bg-purple-50 flex items-center justify-center mx-auto mb-4">
                <Ghost size={32} className="text-purple-400" />
              </div>
              <p className="text-lg font-heading font-medium text-[var(--text-primary)] mb-1">
                No stealth activity
              </p>
              <p className="text-sm text-[var(--text-primary)]/50">
                Stealth payments you send or receive will appear here
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {stealthActivities.map((activity) => (
                <div
                  key={activity.id}
                  className="flex items-center justify-between p-6 rounded-2xl bg-white/50 border border-black/5 hover:bg-white/70 transition-all"
                >
                  <div className="flex items-center gap-4 flex-1">
                    <div
                      className={cn(
                        "w-12 h-12 rounded-xl flex items-center justify-center",
                        activity.activity_type === "stealth_sent"
                          ? "bg-purple-50"
                          : "bg-emerald-50"
                      )}
                    >
                      <Ghost
                        size={24}
                        className={
                          activity.activity_type === "stealth_sent"
                            ? "text-purple-600"
                            : "text-emerald-600"
                        }
                      />
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-medium text-[var(--text-primary)]">
                          {activity.activity_type === "stealth_sent"
                            ? "Sent"
                            : activity.activity_type ===
                                "stealth_claim_started"
                              ? "Claim Started"
                              : "Claimed"}
                        </p>
                      </div>
                      <p className="text-sm text-[var(--text-primary)]/50">
                        {activity.note}
                        {activity.created_at &&
                          ` \u00B7 ${new Date(activity.created_at).toLocaleDateString()}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <p className="text-lg font-heading font-medium encrypted-text">
                        ${"\u2022\u2022\u2022\u2022\u2022.\u2022\u2022"}
                      </p>
                      <div
                        className={cn(
                          "inline-flex px-2 py-1 rounded-full text-xs font-medium border",
                          activity.activity_type === "stealth_claimed"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-100"
                            : "bg-purple-50 text-purple-700 border-purple-100"
                        )}
                      >
                        {activity.activity_type === "stealth_sent"
                          ? "sent"
                          : activity.activity_type === "stealth_claim_started"
                            ? "pending"
                            : "claimed"}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
