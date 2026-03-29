import { useNavigate, useLocation } from "react-router-dom";
import { Lock, ShieldCheck } from "lucide-react";
import { useSendPayment } from "@/hooks/useSendPayment";

// ═══════════════════════════════════════════════════════════════════
//  COMPONENT
// ═══════════════════════════════════════════════════════════════════

export function MobileSendSuccess() {
  const navigate = useNavigate();
  const location = useLocation();
  const { reset } = useSendPayment();

  const routeState = location.state as {
    name?: string;
    address?: string;
  } | null;

  const recipientName = routeState?.name ?? "recipient";

  const handleBackHome = () => {
    reset();
    navigate("/m");
  };

  return (
    <div
      style={{
        padding: "0 16px",
        paddingBottom: 16,
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* ── Success Icon ────────────────────────────────────────────── */}
      <div
        style={{
          width: 96,
          height: 96,
          borderRadius: "50%",
          background: "linear-gradient(135deg, #34D399 0%, #059669 100%)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "0 8px 32px rgba(52, 211, 153, 0.3)",
          marginBottom: 24,
          position: "relative",
        }}
      >
        {/* Lock icon in top-right */}
        <div
          style={{
            position: "absolute",
            top: 2,
            right: 2,
            width: 28,
            height: 28,
            borderRadius: "50%",
            background: "white",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
          }}
        >
          <Lock size={14} color="#059669" />
        </div>
        <ShieldCheck size={44} color="white" strokeWidth={2} />
      </div>

      {/* ── Heading ─────────────────────────────────────────────────── */}
      <h1
        style={{
          fontSize: 24,
          fontWeight: 700,
          color: "var(--text-primary)",
          margin: "0 0 8px",
          textAlign: "center",
        }}
      >
        Payment Sent
      </h1>

      <p
        style={{
          fontSize: 14,
          color: "var(--text-secondary)",
          margin: "0 0 16px",
          textAlign: "center",
          lineHeight: 1.5,
          maxWidth: 280,
        }}
      >
        Amount encrypted with FHE and broadcast to Base Sepolia
        {recipientName !== "recipient" ? ` for ${recipientName}` : ""}
      </p>

      {/* ── FHE Badge ───────────────────────────────────────────────── */}
      <span className="mobile-badge-fhe" style={{ padding: "6px 14px", fontSize: 12 }}>
        <ShieldCheck size={12} />
        FHE Encrypted
      </span>

      {/* ── Spacer ──────────────────────────────────────────────────── */}
      <div style={{ flex: 1, minHeight: 48 }} />

      {/* ── Back to Home Button ─────────────────────────────────────── */}
      <button
        className="mobile-btn-primary"
        onClick={handleBackHome}
        style={{ width: "100%", marginBottom: 8 }}
      >
        Back to Home
      </button>
    </div>
  );
}

export default MobileSendSuccess;
