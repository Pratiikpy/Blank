import { useState, useCallback, useEffect } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/cn";
import toast from "react-hot-toast";
import { useStealthPayments } from "@/hooks/useStealthPayments";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { CONTRACTS } from "@/lib/constants";
import { StealthPaymentsAbi } from "@/lib/abis";
import { keccak256, encodePacked, formatUnits } from "viem";

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

type TabValue = "create" | "claim" | "sent";

const STEALTH_CLAIM_CODES_KEY = "blank_stealth_claim_codes";
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
  const { address } = useAccount();
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
    reset,
  } = useStealthPayments();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient();
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
      const key = `${STEALTH_CLAIM_CODES_KEY}_${address.toLowerCase()}`;
      try {
        const existing: StoredClaimCode[] = JSON.parse(
          localStorage.getItem(key) || "[]"
        );
        existing.push({
          claimCode: code,
          transferId,
          recipientAddress: recipientAddr,
          createdAt: Date.now(),
        });
        localStorage.setItem(key, JSON.stringify(existing));
      } catch {
        // Storage full or corrupt -- non-critical
      }
    },
    [address]
  );

  const getStoredClaimCodes = useCallback((): StoredClaimCode[] => {
    if (!address) return [];
    const key = `${STEALTH_CLAIM_CODES_KEY}_${address.toLowerCase()}`;
    try {
      return JSON.parse(localStorage.getItem(key) || "[]");
    } catch {
      return [];
    }
  }, [address]);

  // ─── Load Sent Transfers (for refund tab) ─────────────────────────

  const loadSentTransfers = useCallback(async () => {
    if (!address || !publicClient) return;
    setLoadingSent(true);
    try {
      const stealthAddress = CONTRACTS.StealthPayments as `0x${string}`;
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
  }, [address, publicClient]);

  // Load sent transfers when "sent" tab is activated
  useEffect(() => {
    if (activeTab === "sent") {
      loadSentTransfers();
    }
  }, [activeTab, loadSentTransfers]);

  // ─── Refund Handler ───────────────────────────────────────────────

  const handleRefund = useCallback(
    async (transferId: number) => {
      if (!address || !writeContractAsync || !publicClient) {
        toast.error("Connect wallet first");
        return;
      }

      setRefundingId(transferId);
      const refundToastId = toast.loading("Processing refund...");

      try {
        const stealthAddress = CONTRACTS.StealthPayments as `0x${string}`;
        const hash = await writeContractAsync({
          address: stealthAddress,
          abi: StealthPaymentsAbi,
          functionName: "refund",
          args: [BigInt(transferId)],
        });

        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          confirmations: 1,
        });

        if (receipt.status === "reverted") {
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
    [address, writeContractAsync, publicClient, loadSentTransfers]
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
    if (!amount || !recipient) return;
    if (!/^0x[a-fA-F0-9]{40}$/.test(recipient.trim())) {
      return;
    }

    const result = await sendStealth(
      amount,
      recipient.trim(),
      CONTRACTS.FHERC20Vault_USDC,
      message || "Stealth payment"
    );

    if (result) {
      setNewCode({
        code: result.claimCode,
        transferId: result.transferId,
        amount: parseFloat(amount).toFixed(2),
      });
      // Save claim code to localStorage for pending claims discovery
      saveClaimCodeToStorage(result.claimCode, result.transferId, recipient.trim());
    }
  }, [address, amount, recipient, message, sendStealth, saveClaimCodeToStorage]);

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

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        {/* Page Title */}
        <div className="mb-8">
          <h1 className="text-4xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Stealth Payments
          </h1>
          <p className="text-base text-[var(--text-primary)]/50 leading-relaxed">
            Send anonymous payments via claim codes
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex gap-3 mb-6" role="tablist" aria-label="Stealth payment tabs">
          <button
            onClick={() => setActiveTab("create")}
            role="tab"
            aria-selected={activeTab === "create"}
            aria-label="Create code"
            className={cn(
              "flex-1 h-14 px-6 rounded-2xl font-medium transition-all",
              activeTab === "create"
                ? "bg-[var(--text-primary)] text-white"
                : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80"
            )}
          >
            <div className="flex items-center justify-center gap-2">
              <Plus size={20} />
              <span>Create Code</span>
            </div>
          </button>
          <button
            onClick={() => setActiveTab("claim")}
            role="tab"
            aria-selected={activeTab === "claim"}
            aria-label="Claim code"
            className={cn(
              "flex-1 h-14 px-6 rounded-2xl font-medium transition-all",
              activeTab === "claim"
                ? "bg-[var(--text-primary)] text-white"
                : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80"
            )}
          >
            <div className="flex items-center justify-center gap-2">
              <KeyRound size={20} />
              <span>Claim Code</span>
            </div>
          </button>
          <button
            onClick={() => setActiveTab("sent")}
            role="tab"
            aria-selected={activeTab === "sent"}
            aria-label="My sent payments"
            className={cn(
              "flex-1 h-14 px-6 rounded-2xl font-medium transition-all",
              activeTab === "sent"
                ? "bg-[var(--text-primary)] text-white"
                : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80"
            )}
          >
            <div className="flex items-center justify-center gap-2">
              <Send size={20} />
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

        {/* Claim Code Tab */}
        {activeTab === "claim" && (
          <div className="space-y-6">
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
                        <div className="flex items-center gap-3">
                          {canRefund ? (
                            <button
                              disabled={isRefunding}
                              onClick={() =>
                                handleRefund(transfer.transferId)
                              }
                              className="h-10 px-4 rounded-xl bg-red-500 text-white text-sm font-medium hover:bg-red-600 transition-colors flex items-center gap-2 disabled:opacity-50"
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
                            <p className="text-xs text-[var(--text-primary)]/40 text-right">
                              Refund in {daysUntilRefund}d
                            </p>
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
                        ${"\u2588\u2588\u2588\u2588\u2588.\u2588\u2588"}
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
