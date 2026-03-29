import { useState, useCallback } from "react";
import {
  Gift,
  Sparkles,
  Heart,
  PartyPopper,
  Mail,
  CheckCircle2,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useGiftMoney } from "@/hooks/useGiftMoney";
import { useAccount } from "wagmi";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { CONTRACTS } from "@/lib/constants";

// ---------------------------------------------------------------
//  THEME OPTIONS
// ---------------------------------------------------------------

interface ThemeOption {
  id: number;
  name: string;
  icon: typeof Gift;
  color: string;
  bgColor: string;
  borderColor: string;
}

const themes: ThemeOption[] = [
  {
    id: 1,
    name: "Birthday",
    icon: PartyPopper,
    color: "text-pink-600",
    bgColor: "bg-pink-50",
    borderColor: "border-pink-100",
  },
  {
    id: 2,
    name: "Celebration",
    icon: Sparkles,
    color: "text-amber-600",
    bgColor: "bg-amber-50",
    borderColor: "border-amber-100",
  },
  {
    id: 3,
    name: "Love",
    icon: Heart,
    color: "text-red-600",
    bgColor: "bg-red-50",
    borderColor: "border-red-100",
  },
  {
    id: 4,
    name: "Thank You",
    icon: Gift,
    color: "text-emerald-600",
    bgColor: "bg-emerald-50",
    borderColor: "border-emerald-100",
  },
];

type TabValue = "received" | "sent";

// ---------------------------------------------------------------
//  STEP LABEL HELPER
// ---------------------------------------------------------------

function getStepLabel(step: string): string {
  switch (step) {
    case "approving":
      return "Approving encrypted transfers...";
    case "encrypting":
      return "Encrypting gift amounts...";
    case "confirming":
      return "Confirming encryption...";
    case "sending":
      return "Sending gift envelope...";
    default:
      return "Processing...";
  }
}

// ---------------------------------------------------------------
//  MAIN SCREEN
// ---------------------------------------------------------------

export default function Gifts() {
  const { address } = useAccount();
  const {
    step,
    isProcessing,
    error,
    createGift,
    claimGift,
    computeEqualSplits,
    computeRandomSplits,
    reset,
  } = useGiftMoney();
  const { activities } = useActivityFeed();

  const [activeTab, setActiveTab] = useState<TabValue>("received");
  const [selectedTheme, setSelectedTheme] = useState<number | null>(null);
  const [giftAmount, setGiftAmount] = useState("");
  const [giftRecipient, setGiftRecipient] = useState("");
  const [giftMessage, setGiftMessage] = useState("");
  const [splitType, setSplitType] = useState<"equal" | "random">("equal");
  const [claimId, setClaimId] = useState("");
  const [sentGift, setSentGift] = useState<{
    recipient: string;
    amount: string;
    theme: string;
    message?: string;
    txHash?: string;
  } | null>(null);

  // Multiple recipients support
  const [recipients, setRecipients] = useState<string[]>([]);
  const [recipientInput, setRecipientInput] = useState("");

  // Filter gift activities from the activity feed
  const giftActivities = activities.filter(
    (a) =>
      a.activity_type === "gift_created" || a.activity_type === "gift_claimed"
  );

  const receivedGifts = giftActivities.filter(
    (a) =>
      a.user_to === address?.toLowerCase() &&
      a.activity_type === "gift_created"
  );
  const sentGifts = giftActivities.filter(
    (a) =>
      a.user_from === address?.toLowerCase() &&
      a.activity_type === "gift_created"
  );

  const filteredGifts = activeTab === "received" ? receivedGifts : sentGifts;

  const addRecipient = () => {
    const trimmed = recipientInput.trim();
    if (!trimmed) return;
    if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return;
    if (recipients.includes(trimmed.toLowerCase())) return;
    setRecipients([...recipients, trimmed.toLowerCase()]);
    setRecipientInput("");
  };

  // ─── Send Gift ─────────────────────────────────────────────────────

  const handleSendGift = useCallback(async () => {
    if (!giftAmount || !address) return;

    // Build final recipient list
    const allRecipients =
      recipients.length > 0
        ? recipients
        : giftRecipient.trim()
          ? [giftRecipient.trim().toLowerCase()]
          : [];

    if (allRecipients.length === 0) return;

    // Validate all addresses
    for (const r of allRecipients) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(r)) return;
    }

    const shares =
      splitType === "equal"
        ? computeEqualSplits(giftAmount, allRecipients.length)
        : computeRandomSplits(giftAmount, allRecipients.length);

    const theme = themes.find((t) => t.id === selectedTheme);
    const note = giftMessage
      ? `${theme?.name || "Gift"}: ${giftMessage}`
      : theme?.name || "Gift";

    const result = await createGift(
      CONTRACTS.FHERC20Vault_USDC,
      shares,
      allRecipients,
      note
    );

    if (result) {
      setSentGift({
        recipient:
          allRecipients.length === 1
            ? `${allRecipients[0].slice(0, 6)}...${allRecipients[0].slice(-4)}`
            : `${allRecipients.length} recipients`,
        amount: parseFloat(giftAmount).toFixed(2),
        theme: theme?.name || "Gift",
        message: giftMessage || undefined,
        txHash: result,
      });
    }
  }, [
    giftAmount,
    address,
    recipients,
    giftRecipient,
    splitType,
    selectedTheme,
    giftMessage,
    createGift,
    computeEqualSplits,
    computeRandomSplits,
  ]);

  // ─── Claim Gift ────────────────────────────────────────────────────

  const handleClaim = useCallback(
    async (envelopeId: number) => {
      await claimGift(envelopeId);
    },
    [claimGift]
  );

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        {/* Page Title */}
        <div className="mb-8">
          <h1 className="text-4xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Gift Envelopes
          </h1>
          <p className="text-base text-[var(--text-primary)]/50 leading-relaxed">
            Send encrypted money gifts with style
          </p>
        </div>

        {/* Create Gift Section */}
        {sentGift ? (
          <div className="rounded-[2rem] glass-card p-12 text-center mb-6">
            <div className="w-20 h-20 rounded-full bg-emerald-50 flex items-center justify-center mx-auto mb-4">
              <CheckCircle2 size={48} className="text-emerald-500" />
            </div>
            <h3 className="text-2xl font-heading font-medium text-[var(--text-primary)] mb-2">
              Gift Sent!
            </h3>
            <p className="text-[var(--text-primary)]/60 mb-2">
              Your {sentGift.theme} gift of
            </p>
            <p className="text-4xl font-heading font-medium text-[var(--text-primary)] mb-2">
              ${sentGift.amount}
            </p>
            <p className="text-[var(--text-primary)]/60 mb-6">
              was sent to {sentGift.recipient}
            </p>
            {sentGift.message && (
              <div className="p-4 rounded-2xl bg-white/50 border border-black/5 mx-auto max-w-sm mb-4">
                <p className="italic text-[var(--text-primary)]/60">
                  &ldquo;{sentGift.message}&rdquo;
                </p>
              </div>
            )}
            {sentGift.txHash && (
              <p className="text-xs font-mono text-[var(--text-primary)]/30 mb-6 break-all">
                Tx: {sentGift.txHash}
              </p>
            )}
            <button
              onClick={() => {
                setSentGift(null);
                setGiftAmount("");
                setGiftRecipient("");
                setGiftMessage("");
                setSelectedTheme(null);
                setRecipients([]);
                reset();
              }}
              className="h-12 px-8 rounded-2xl bg-[var(--text-primary)] text-white font-medium"
            >
              Send Another Gift
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
            {/* Gift Form */}
            <div className="rounded-[2rem] glass-card p-8">
              <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-xl bg-pink-50 flex items-center justify-center">
                  <Gift size={24} className="text-pink-600" />
                </div>
                <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
                  Create Gift Envelope
                </h3>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
                    Total Amount (USDC)
                  </label>
                  <div className="relative">
                    <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-primary)]/50">
                      $
                    </span>
                    <input
                      type="text"
                      placeholder="0.00"
                      value={giftAmount}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (/^\d*\.?\d{0,6}$/.test(v) || v === "")
                          setGiftAmount(v);
                      }}
                      className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 text-lg"
                    />
                  </div>
                </div>

                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
                    Recipients
                  </label>
                  {recipients.length === 0 ? (
                    <input
                      type="text"
                      placeholder="0x... (address)"
                      value={giftRecipient}
                      onChange={(e) => setGiftRecipient(e.target.value)}
                      className="h-14 w-full px-5 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 font-mono text-sm"
                    />
                  ) : null}
                  <div className="flex gap-2 mt-2">
                    <input
                      type="text"
                      placeholder="Add another recipient 0x..."
                      value={recipientInput}
                      onChange={(e) => setRecipientInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addRecipient();
                        }
                      }}
                      className="flex-1 h-10 px-4 rounded-xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 font-mono text-xs"
                    />
                    <button
                      type="button"
                      onClick={addRecipient}
                      className="h-10 px-4 rounded-xl bg-black/5 text-[var(--text-primary)] text-xs font-medium hover:bg-black/10"
                    >
                      Add
                    </button>
                  </div>
                  {recipients.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {recipients.map((r, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-pink-50 text-xs font-mono text-pink-700"
                        >
                          {r.slice(0, 6)}...{r.slice(-4)}
                          <button
                            onClick={() =>
                              setRecipients(
                                recipients.filter((_, idx) => idx !== i)
                              )
                            }
                            className="hover:text-red-500"
                          >
                            x
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Split Type */}
                {(recipients.length > 1 ||
                  (recipients.length === 0 && giftRecipient)) && (
                  <div>
                    <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
                      Split Type
                    </label>
                    <div className="flex gap-2">
                      <button
                        onClick={() => setSplitType("equal")}
                        className={cn(
                          "flex-1 h-10 rounded-xl text-sm font-medium transition-all",
                          splitType === "equal"
                            ? "bg-[var(--text-primary)] text-white"
                            : "bg-white/60 text-[var(--text-primary)] border border-black/5"
                        )}
                      >
                        Equal Split
                      </button>
                      <button
                        onClick={() => setSplitType("random")}
                        className={cn(
                          "flex-1 h-10 rounded-xl text-sm font-medium transition-all",
                          splitType === "random"
                            ? "bg-[var(--text-primary)] text-white"
                            : "bg-white/60 text-[var(--text-primary)] border border-black/5"
                        )}
                      >
                        Random Split
                      </button>
                    </div>
                  </div>
                )}

                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">
                    Gift Message
                  </label>
                  <textarea
                    placeholder="Write a heartfelt message..."
                    rows={3}
                    value={giftMessage}
                    onChange={(e) => setGiftMessage(e.target.value)}
                    className="w-full px-5 py-4 rounded-2xl bg-white/60 border border-black/5 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 resize-none"
                  />
                </div>
              </div>
            </div>

            {/* Theme Selection */}
            <div className="rounded-[2rem] glass-card p-8">
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-6">
                Choose Theme
              </h3>

              <div className="grid grid-cols-2 gap-3 mb-6">
                {themes.map((theme) => {
                  const Icon = theme.icon;
                  const isSelected = selectedTheme === theme.id;

                  return (
                    <button
                      key={theme.id}
                      onClick={() => setSelectedTheme(theme.id)}
                      className={cn(
                        "p-6 rounded-2xl border-2 transition-all",
                        isSelected
                          ? `${theme.bgColor} ${theme.borderColor} scale-105`
                          : "bg-white/50 border-black/5 hover:bg-white/70"
                      )}
                    >
                      <div className="flex flex-col items-center text-center gap-2">
                        <div
                          className={cn(
                            "w-12 h-12 rounded-xl flex items-center justify-center",
                            theme.bgColor
                          )}
                        >
                          <Icon size={24} className={theme.color} />
                        </div>
                        <p className="text-sm font-medium text-[var(--text-primary)]">
                          {theme.name}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>

              {selectedTheme && (
                <div className="space-y-4">
                  <div className="p-6 rounded-2xl bg-white/50 border border-black/5 text-center">
                    <p className="text-sm text-[var(--text-primary)]/50 mb-2">
                      Preview
                    </p>
                    <div className="w-32 h-32 mx-auto rounded-2xl bg-gradient-to-br from-pink-100 to-purple-100 flex items-center justify-center mb-3">
                      <Mail
                        size={48}
                        className="text-[var(--text-primary)]/60"
                      />
                    </div>
                    <p className="text-lg font-heading font-medium text-[var(--text-primary)]">
                      {themes.find((t) => t.id === selectedTheme)?.name} Gift
                    </p>
                  </div>

                  {/* Processing indicator */}
                  {isProcessing && step !== "input" && step !== "success" && step !== "error" && (
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
                      isProcessing ||
                      !giftAmount ||
                      (!giftRecipient.trim() && recipients.length === 0)
                    }
                    onClick={handleSendGift}
                    className="w-full h-14 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isProcessing ? (
                      <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <Gift size={20} />
                    )}
                    <span>Send Gift Envelope</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tab Toggle for Sent/Received Gifts */}
        <div className="flex gap-3 mb-6">
          <button
            onClick={() => setActiveTab("received")}
            className={cn(
              "flex-1 h-14 px-6 rounded-2xl font-medium transition-all",
              activeTab === "received"
                ? "bg-[var(--text-primary)] text-white"
                : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80"
            )}
          >
            Received
          </button>
          <button
            onClick={() => setActiveTab("sent")}
            className={cn(
              "flex-1 h-14 px-6 rounded-2xl font-medium transition-all",
              activeTab === "sent"
                ? "bg-[var(--text-primary)] text-white"
                : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80"
            )}
          >
            Sent
          </button>
        </div>

        {/* Gift List */}
        <div className="rounded-[2rem] glass-card p-8">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
              {activeTab === "received" ? "Received Gifts" : "Sent Gifts"}
            </h3>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-pink-50 border border-pink-100">
              <Gift size={16} className="text-pink-600" />
              <span className="text-sm font-medium text-pink-600">
                {filteredGifts.length} Gifts
              </span>
            </div>
          </div>

          {filteredGifts.length === 0 ? (
            <div className="py-16 text-center">
              <div className="w-16 h-16 rounded-2xl bg-pink-50 flex items-center justify-center mx-auto mb-4">
                <Gift size={32} className="text-pink-400" />
              </div>
              <p className="text-lg font-heading font-medium text-[var(--text-primary)] mb-1">
                No {activeTab} gifts
              </p>
              <p className="text-sm text-[var(--text-primary)]/50">
                {activeTab === "received"
                  ? "Gifts you receive will appear here"
                  : "Create a gift to get started"}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredGifts.map((activity) => {
                const isSent = activeTab === "sent";
                const otherAddress = isSent
                  ? activity.user_to
                  : activity.user_from;

                return (
                  <div
                    key={activity.id}
                    className="flex items-center justify-between p-6 rounded-2xl bg-white/50 border border-black/5 hover:bg-white/70 transition-all"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-xl bg-pink-50 flex items-center justify-center">
                        <Gift size={24} className="text-pink-600" />
                      </div>
                      <div>
                        <p className="font-medium text-[var(--text-primary)]">
                          {isSent ? "To" : "From"}{" "}
                          {otherAddress.slice(0, 6)}...{otherAddress.slice(-4)}
                        </p>
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
                            "bg-emerald-50 text-emerald-700 border-emerald-100"
                          )}
                        >
                          {isSent ? "sent" : "received"}
                        </div>
                      </div>
                      {/* Claim button for received gifts -- user needs to know the envelope ID */}
                      {!isSent && (
                        <div className="flex gap-2 mt-3">
                          <input
                            type="text"
                            value={claimId}
                            onChange={(e) => setClaimId(e.target.value)}
                            placeholder="Envelope ID"
                            className="h-10 flex-1 px-3 rounded-xl bg-white/60 border border-black/5 text-sm"
                          />
                          <button
                            onClick={() => {
                              if (claimId) {
                                handleClaim(parseInt(claimId, 10));
                                setClaimId("");
                              }
                            }}
                            disabled={isProcessing || !claimId}
                            className="h-10 px-4 rounded-xl bg-emerald-500 text-white text-sm font-medium disabled:opacity-50"
                          >
                            {isProcessing ? (
                              <Loader2 size={16} className="animate-spin" />
                            ) : (
                              "Claim"
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
