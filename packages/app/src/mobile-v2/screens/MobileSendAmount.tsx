import { useState, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft, Lock, Delete, Shield } from "lucide-react";
import { useSendPayment } from "@/hooks/useSendPayment";

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════

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

const KEYPAD_KEYS = [
  "1", "2", "3",
  "4", "5", "6",
  "7", "8", "9",
  ".", "0", "backspace",
] as const;

// ═══════════════════════════════════════════════════════════════════
//  COMPONENT
// ═══════════════════════════════════════════════════════════════════

export function MobileSendAmount() {
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = location.state as {
    name?: string;
    handle?: string;
    address?: string;
  } | null;

  const {
    setRecipient,
    setAmount: setSendAmount,
    setNote,
  } = useSendPayment();

  // Local amount string for display (the keypad builds this)
  const [amount, setAmount] = useState("0");
  const [noteValue, setNoteValue] = useState("");

  // Set recipient from route state on first interaction
  const recipientName = routeState?.name ?? "Unknown";
  const recipientHandle = routeState?.handle ?? "";
  const recipientAddress = routeState?.address ?? "";
  const hue = stringToHue(recipientAddress);

  const handleKeyPress = useCallback((key: string) => {
    setAmount((prev) => {
      if (key === "backspace") {
        if (prev.length <= 1) return "0";
        return prev.slice(0, -1);
      }
      if (key === ".") {
        if (prev.includes(".")) return prev;
        return prev + ".";
      }
      // Limit decimal places to 2
      const dotIndex = prev.indexOf(".");
      if (dotIndex !== -1 && prev.length - dotIndex > 2) return prev;
      // Prevent leading zeros (except "0.")
      if (prev === "0" && key !== ".") return key;
      // Limit total length
      if (prev.length >= 10) return prev;
      return prev + key;
    });
  }, []);

  const handleContinue = () => {
    if (!recipientAddress || parseFloat(amount) <= 0) return;

    // Push values into the send payment hook
    setRecipient(recipientAddress);
    setSendAmount(amount);
    setNote(noteValue);

    navigate("/m/send/confirm", {
      state: {
        name: recipientName,
        handle: recipientHandle,
        address: recipientAddress,
        amount,
        note: noteValue,
      },
    });
  };

  const isValidAmount = parseFloat(amount) > 0;

  return (
    <div style={{ padding: "0 16px", paddingBottom: 16, minHeight: "100dvh", display: "flex", flexDirection: "column" }}>
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="mobile-header" style={{ padding: "12px 0" }}>
        <button
          className="mobile-header-back"
          onClick={() => navigate("/m/send")}
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
            Enter Amount
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
            <Lock size={10} color="var(--primary)" />
            <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 500 }}>
              All amounts FHE encrypted
            </span>
          </div>
        </div>
      </header>

      {/* ── Recipient Card ──────────────────────────────────────────── */}
      <div
        className="mobile-card"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginTop: 8,
          padding: "12px 16px",
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: "50%",
            background: `linear-gradient(135deg, hsl(${hue}, 60%, 55%) 0%, hsl(${hue + 30}, 50%, 65%) 100%)`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "white",
            fontWeight: 700,
            fontSize: 14,
            flexShrink: 0,
          }}
        >
          {getInitials(recipientName)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text-primary)",
              margin: 0,
            }}
          >
            {recipientName}
          </p>
          <p
            style={{
              fontSize: 12,
              color: "var(--text-tertiary)",
              margin: "2px 0 0",
            }}
          >
            {recipientHandle}
          </p>
        </div>
      </div>

      {/* ── Amount Display ──────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "24px 0 8px" }}>
        <span
          className="mobile-mono"
          style={{
            fontSize: amount.length > 7 ? 36 : 48,
            fontWeight: 700,
            color: isValidAmount ? "var(--text-primary)" : "var(--text-tertiary)",
            lineHeight: 1.1,
            letterSpacing: "-0.02em",
            transition: "font-size 200ms ease, color 200ms ease",
          }}
        >
          ${amount}
        </span>
        <div style={{ marginTop: 10 }}>
          <span className="mobile-badge-fhe">
            <Shield size={10} />
            FHE Encrypted
          </span>
        </div>
      </div>

      {/* ── Keypad ──────────────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 10,
          padding: "0 8px",
          marginBottom: 16,
        }}
      >
        {KEYPAD_KEYS.map((key) => (
          <button
            key={key}
            onClick={() => handleKeyPress(key)}
            style={{
              height: 56,
              borderRadius: 14,
              border: "none",
              background: key === "backspace" ? "transparent" : "var(--card-bg)",
              boxShadow: key === "backspace" ? "none" : "0 1px 3px rgba(0,0,0,0.06)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              fontSize: 22,
              fontWeight: 600,
              color: "var(--text-primary)",
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              WebkitTapHighlightColor: "transparent",
              transition: "transform 100ms ease, box-shadow 100ms ease",
            }}
            aria-label={key === "backspace" ? "Delete" : key}
          >
            {key === "backspace" ? (
              <Delete size={22} color="var(--text-secondary)" />
            ) : (
              key
            )}
          </button>
        ))}
      </div>

      {/* ── Note Input ──────────────────────────────────────────────── */}
      <div
        className="mobile-card"
        style={{ padding: "10px 14px", marginBottom: 12 }}
      >
        <input
          type="text"
          placeholder="Add a note (optional)"
          value={noteValue}
          onChange={(e) => setNoteValue(e.target.value.slice(0, 280))}
          maxLength={280}
          style={{
            width: "100%",
            border: "none",
            outline: "none",
            background: "transparent",
            fontSize: 14,
            color: "var(--text-primary)",
            fontFamily: "inherit",
          }}
          aria-label="Payment note"
        />
      </div>

      {/* ── Continue Button ─────────────────────────────────────────── */}
      <button
        className="mobile-btn-primary"
        disabled={!isValidAmount}
        onClick={handleContinue}
        style={{ marginBottom: 8 }}
      >
        Continue
      </button>
    </div>
  );
}

export default MobileSendAmount;
