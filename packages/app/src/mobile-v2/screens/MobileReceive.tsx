import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowLeft,
  Lock,
  Shield,
  Copy,
  Check,
  Share2,
} from "lucide-react";
import toast from "react-hot-toast";

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════

function shortenAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function getInitials(addr: string): string {
  if (!addr || addr.length < 4) return "??";
  return addr.slice(2, 4).toUpperCase();
}

// ═══════════════════════════════════════════════════════════════════
//  COMPONENT
// ═══════════════════════════════════════════════════════════════════

export function MobileReceive() {
  const navigate = useNavigate();
  const { address } = useAccount();
  const [copiedField, setCopiedField] = useState<"address" | "link" | null>(null);

  const displayAddress = address ?? "0x0000...0000";
  const paymentLink = `https://blankpay.app/pay/${address ?? ""}`;

  const handleCopy = useCallback(async (text: string, field: "address" | "link") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      toast.error("Failed to copy");
    }
  }, []);

  const handleShare = useCallback(async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Pay me on BlankPay",
          text: "Send me an encrypted payment on BlankPay",
          url: paymentLink,
        });
      } catch {
        // User cancelled share
      }
    } else {
      handleCopy(paymentLink, "link");
    }
  }, [paymentLink, handleCopy]);

  return (
    <div style={{ padding: "0 16px", paddingBottom: 16 }}>
      {/* ── Header ──────────────────────────────────────────────────── */}
      <header className="mobile-header" style={{ padding: "12px 0" }}>
        <button
          className="mobile-header-back"
          onClick={() => navigate("/m")}
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
            Receive Money
          </h1>
          <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 2 }}>
            <Lock size={10} color="var(--primary)" />
            <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontWeight: 500 }}>
              Share your QR or payment link
            </span>
          </div>
        </div>
      </header>

      {/* ── QR Code Card ────────────────────────────────────────────── */}
      <div
        className="mobile-card-lg"
        style={{
          marginTop: 12,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "24px 20px",
        }}
      >
        {/* QR Code */}
        <div
          style={{
            padding: 16,
            background: "white",
            borderRadius: 16,
            boxShadow: "0 2px 12px rgba(0,0,0,0.06)",
          }}
        >
          <QRCodeSVG
            value={paymentLink}
            size={200}
            level="M"
            bgColor="#FFFFFF"
            fgColor="#1A1A2E"
            style={{ display: "block" }}
          />
        </div>

        {/* Name + handle */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 20,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: "linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "white",
              fontWeight: 700,
              fontSize: 13,
            }}
          >
            {getInitials(displayAddress)}
          </div>
          <div>
            <p style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>
              My Wallet
            </p>
            <p
              className="mobile-mono"
              style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "2px 0 0" }}
            >
              {shortenAddress(displayAddress)}
            </p>
          </div>
        </div>

        {/* FHE Badge */}
        <div style={{ marginTop: 12 }}>
          <span className="mobile-badge-fhe">
            <Shield size={10} />
            FHE Encrypted
          </span>
        </div>
      </div>

      {/* ── Wallet Address Section ──────────────────────────────────── */}
      <div style={{ marginTop: 20 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-tertiary)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            display: "block",
            marginBottom: 8,
          }}
        >
          Wallet Address
        </span>
        <div
          className="mobile-card"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            padding: "12px 14px",
          }}
        >
          <span
            className="mobile-mono"
            style={{
              fontSize: 13,
              color: "var(--text-primary)",
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
          >
            {displayAddress}
          </span>
          <button
            onClick={() => handleCopy(displayAddress, "address")}
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "var(--primary-ghost)",
              border: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              flexShrink: 0,
              transition: "background 150ms ease",
              WebkitTapHighlightColor: "transparent",
            }}
            aria-label="Copy wallet address"
          >
            {copiedField === "address" ? (
              <Check size={16} color="var(--success-dark)" />
            ) : (
              <Copy size={16} color="var(--primary)" />
            )}
          </button>
        </div>
      </div>

      {/* ── Payment Link Section ────────────────────────────────────── */}
      <div style={{ marginTop: 16 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-tertiary)",
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            display: "block",
            marginBottom: 8,
          }}
        >
          Payment Link
        </span>
        <div
          className="mobile-card"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            padding: "12px 14px",
          }}
        >
          <span
            style={{
              fontSize: 13,
              color: "var(--primary)",
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flex: 1,
            }}
          >
            blankpay.app/pay/{shortenAddress(displayAddress)}
          </span>
          <button
            onClick={() => handleCopy(paymentLink, "link")}
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "var(--primary-ghost)",
              border: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              flexShrink: 0,
              transition: "background 150ms ease",
              WebkitTapHighlightColor: "transparent",
            }}
            aria-label="Copy payment link"
          >
            {copiedField === "link" ? (
              <Check size={16} color="var(--success-dark)" />
            ) : (
              <Copy size={16} color="var(--primary)" />
            )}
          </button>
        </div>
      </div>

      {/* ── Share Button ────────────────────────────────────────────── */}
      <button
        className="mobile-btn-primary"
        onClick={handleShare}
        style={{ marginTop: 24, marginBottom: 8 }}
      >
        <Share2 size={18} />
        Share Payment Link
      </button>
    </div>
  );
}

export default MobileReceive;
