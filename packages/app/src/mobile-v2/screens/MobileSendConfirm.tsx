import { useState, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  ArrowLeft,
  Lock,
  Shield,
  Info,
  Loader2,
} from "lucide-react";
import { useSendPayment } from "@/hooks/useSendPayment";
import { ENCRYPTED_PLACEHOLDER } from "@/lib/constants";

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════

function shortenAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function stringToHue(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ═══════════════════════════════════════════════════════════════════
//  COMPONENT
// ═══════════════════════════════════════════════════════════════════

export function MobileSendConfirm() {
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = location.state as {
    name?: string;
    handle?: string;
    address?: string;
    amount?: string;
    note?: string;
  } | null;

  const { confirmSend, isEncrypting, isSending, step } = useSendPayment();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const recipientName = routeState?.name ?? "Unknown";
  const recipientHandle = routeState?.handle ?? "";
  const recipientAddress = routeState?.address ?? "";
  const noteText = routeState?.note ?? "";
  const hue = stringToHue(recipientAddress);

  const isProcessing = isSubmitting || isEncrypting || isSending || step === "sending" || step === "encrypting";

  const handleConfirm = useCallback(async () => {
    if (isProcessing) return;
    setIsSubmitting(true);
    try {
      await confirmSend();
      // Navigate to success on completion
      navigate("/m/send/success", {
        state: {
          name: recipientName,
          address: recipientAddress,
        },
      });
    } catch {
      // Error is handled by the hook (toast + state)
      setIsSubmitting(false);
    }
  }, [isProcessing, confirmSend, navigate, recipientName, recipientAddress]);

  const statusLabel = isEncrypting
    ? "Encrypting..."
    : isSending || step === "sending"
      ? "Broadcasting..."
      : "Confirm & Send";

  return (
    <div style={{ padding: "0 16px", paddingBottom: 16, minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="mobile-header" style={{ padding: "12px 0" }}>
        <button
          className="mobile-header-back"
          onClick={() => navigate(-1)}
          disabled={isProcessing}
          aria-label="Go back"
        >
          <ArrowLeft size={18} strokeWidth={2} color="var(--text-primary)" />
        </button>
        <div style={{ flex: 1 }}>
          <h1
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: "var(--text-primary)",
              margin: 0,
              lineHeight: 1.3,
            }}
          >
            Confirm Payment
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
            <Lock size={10} color="var(--primary)" />
            <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 500 }}>
              All amounts FHE encrypted
            </span>
          </div>
        </div>
      </header>

      {/* ── Details Card ────────────────────────────────────────────── */}
      <div
        className="mobile-card-lg"
        style={{ marginTop: 12 }}
      >
        {/* Recipient row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            paddingBottom: 16,
            borderBottom: "1px solid rgba(0,0,0,0.06)",
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: "50%",
              background: `linear-gradient(135deg, hsl(${hue}, 60%, 55%) 0%, hsl(${hue + 30}, 50%, 65%) 100%)`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "white",
              fontWeight: 700,
              fontSize: 15,
              flexShrink: 0,
            }}
          >
            {getInitials(recipientName)}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
              {recipientName}
            </p>
            <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "2px 0 0" }}>
              {recipientHandle}
            </p>
          </div>
        </div>

        {/* Detail rows */}
        <div style={{ paddingTop: 12 }}>
          {/* To */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }}>
            <span style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 500 }}>To</span>
            <span
              className="mobile-mono"
              style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600 }}
            >
              {shortenAddress(recipientAddress)}
            </span>
          </div>

          {/* Amount (masked) */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 0",
              borderTop: "1px solid rgba(0,0,0,0.04)",
            }}
          >
            <span style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 500 }}>Amount</span>
            <span
              className="mobile-mono"
              style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 600 }}
            >
              ${ENCRYPTED_PLACEHOLDER}
            </span>
          </div>

          {/* Encryption */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 0",
              borderTop: "1px solid rgba(0,0,0,0.04)",
            }}
          >
            <span style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 500 }}>Encryption</span>
            <span className="mobile-badge-fhe">
              <Shield size={10} />
              FHE Encrypted
            </span>
          </div>

          {/* Gas */}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 0",
              borderTop: "1px solid rgba(0,0,0,0.04)",
            }}
          >
            <span style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 500 }}>Est. Gas</span>
            <span
              className="mobile-mono"
              style={{ fontSize: 13, color: "var(--text-tertiary)", fontWeight: 500 }}
            >
              ~1.2M gas
            </span>
          </div>

          {/* Note (if any) */}
          {noteText && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                padding: "10px 0",
                borderTop: "1px solid rgba(0,0,0,0.04)",
              }}
            >
              <span style={{ fontSize: 13, color: "var(--text-secondary)", fontWeight: 500, flexShrink: 0 }}>Note</span>
              <span
                style={{
                  fontSize: 13,
                  color: "var(--text-primary)",
                  fontWeight: 500,
                  textAlign: "right",
                  marginLeft: 16,
                  wordBreak: "break-word",
                }}
              >
                {noteText}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Info Banner ─────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          padding: "12px 14px",
          marginTop: 12,
          borderRadius: 12,
          background: "rgba(108, 99, 255, 0.06)",
        }}
      >
        <Info size={16} color="var(--primary)" style={{ flexShrink: 0, marginTop: 1 }} />
        <p style={{ fontSize: 12, color: "var(--primary)", margin: 0, lineHeight: 1.5, fontWeight: 500 }}>
          The exact amount will be encrypted client-side before submission. Only the recipient can decrypt it.
        </p>
      </div>

      {/* ── Spacer ──────────────────────────────────────────────────── */}
      <div style={{ flex: 1 }} />

      {/* ── Confirm Button ──────────────────────────────────────────── */}
      <button
        className="mobile-btn-primary"
        disabled={isProcessing}
        onClick={handleConfirm}
        style={{ marginTop: 24, marginBottom: 8 }}
      >
        {isProcessing && (
          <Loader2
            size={18}
            style={{
              animation: "spin 0.7s linear infinite",
              flexShrink: 0,
            }}
          />
        )}
        {statusLabel}
      </button>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default MobileSendConfirm;
