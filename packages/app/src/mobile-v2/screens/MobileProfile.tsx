import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount, useDisconnect } from "wagmi";
import {
  Pencil,
  Eye,
  EyeOff,
  Copy,
  Check,
  ChevronRight,
  Key,
  Users,
  ShieldCheck,
  Settings,
  LogOut,
  Lock,
  BadgeCheck,
} from "lucide-react";
import { useEncryptedBalance } from "@/hooks/useEncryptedBalance";
import { ENCRYPTED_PLACEHOLDER } from "@/lib/constants";

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════

function shortenAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function deriveDisplayName(addr: string): string {
  if (!addr || addr.length < 6) return "Anonymous";
  return `User ${addr.slice(2, 6).toUpperCase()}`;
}

function deriveHandle(addr: string): string {
  if (!addr || addr.length < 8) return "@anon";
  return `@${addr.slice(2, 8).toLowerCase()}`;
}

// ═══════════════════════════════════════════════════════════════════
//  MENU DATA
// ═══════════════════════════════════════════════════════════════════

interface MenuItem {
  icon: typeof Key;
  iconBg: string;
  iconColor: string;
  label: string;
  path: string;
}

const MENU_ITEMS: MenuItem[] = [
  {
    icon: Key,
    iconBg: "rgba(108, 99, 255, 0.1)",
    iconColor: "#6C63FF",
    label: "Wallet & Keys",
    path: "/m/privacy",
  },
  {
    icon: Users,
    iconBg: "rgba(5, 150, 105, 0.08)",
    iconColor: "#059669",
    label: "Contacts",
    path: "/m/contacts",
  },
  {
    icon: ShieldCheck,
    iconBg: "rgba(217, 119, 6, 0.08)",
    iconColor: "#D97706",
    label: "Privacy Settings",
    path: "/m/privacy",
  },
  {
    icon: Settings,
    iconBg: "rgba(107, 114, 128, 0.08)",
    iconColor: "#6B7280",
    label: "Settings",
    path: "/m/settings",
  },
];

// ═══════════════════════════════════════════════════════════════════
//  MAIN SCREEN
// ═══════════════════════════════════════════════════════════════════

export function MobileProfile() {
  const navigate = useNavigate();
  const { address } = useAccount();
  const { disconnect } = useDisconnect();
  const {
    formatted: encryptedFormatted,
    isRevealed,
    isDecrypted,
    toggleReveal,
  } = useEncryptedBalance();

  const [copied, setCopied] = useState(false);

  const displayName = address ? deriveDisplayName(address) : "Anonymous";
  const handle = address ? deriveHandle(address) : "@anon";

  const handleCopyAddress = useCallback(async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may fail in insecure contexts
    }
  }, [address]);

  const handleSignOut = useCallback(() => {
    disconnect();
    navigate("/m");
  }, [disconnect, navigate]);

  return (
    <div style={{ padding: "0 16px", minHeight: "100dvh" }}>
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "20px 0 16px",
        }}
      >
        <h1
          style={{
            fontSize: 24,
            fontWeight: 700,
            color: "var(--text-primary)",
            margin: 0,
          }}
        >
          Profile
        </h1>
        <button
          className="mobile-header-back"
          aria-label="Edit profile"
        >
          <Pencil size={16} strokeWidth={2} color="var(--text-secondary)" />
        </button>
      </header>

      {/* ─── Profile Card ───────────────────────────────────────────── */}
      <div
        className="mobile-card-lg"
        style={{ textAlign: "center", position: "relative", overflow: "hidden" }}
      >
        {/* Decorative gradient */}
        <div
          style={{
            position: "absolute",
            top: -30,
            left: "50%",
            transform: "translateX(-50%)",
            width: 200,
            height: 100,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(108,99,255,0.06) 0%, transparent 70%)",
            pointerEvents: "none",
          }}
          aria-hidden="true"
        />

        {/* Avatar */}
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: "50%",
            background: "linear-gradient(135deg, var(--primary) 0%, var(--primary-light) 100%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "white",
            fontWeight: 700,
            fontSize: 24,
            margin: "0 auto 12px",
            boxShadow: "0 4px 16px rgba(108, 99, 255, 0.2)",
          }}
          aria-hidden="true"
        >
          {address ? address.slice(2, 4).toUpperCase() : "?"}
        </div>

        {/* Name */}
        <p
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: "var(--text-primary)",
            margin: "0 0 2px",
          }}
        >
          {displayName}
        </p>

        {/* Handle */}
        <p
          style={{
            fontSize: 14,
            color: "var(--text-tertiary)",
            margin: "0 0 10px",
          }}
        >
          {handle}
        </p>

        {/* Verified Badge */}
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            background: "rgba(5, 150, 105, 0.08)",
            color: "#059669",
            fontSize: 12,
            fontWeight: 600,
            padding: "4px 12px",
            borderRadius: 20,
          }}
        >
          <BadgeCheck size={14} />
          Verified
        </div>
      </div>

      {/* ─── Balance Section ────────────────────────────────────────── */}
      <div className="mobile-card" style={{ marginTop: 12, textAlign: "center", padding: "16px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
          }}
        >
          <span
            className="mobile-mono"
            style={{
              fontSize: 28,
              fontWeight: 700,
              color: "var(--text-primary)",
              letterSpacing: "-0.02em",
            }}
          >
            {isRevealed && isDecrypted && encryptedFormatted
              ? `$${encryptedFormatted}`
              : `$${ENCRYPTED_PLACEHOLDER}`}
          </span>
          <button
            onClick={toggleReveal}
            style={{
              background: "var(--primary-ghost)",
              border: "none",
              borderRadius: "50%",
              width: 32,
              height: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              flexShrink: 0,
            }}
            aria-label={isRevealed ? "Hide balance" : "Reveal balance"}
          >
            {isRevealed ? (
              <EyeOff size={16} color="var(--primary)" />
            ) : (
              <Eye size={16} color="var(--primary)" />
            )}
          </button>
        </div>

        {/* Badges */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            marginTop: 10,
          }}
        >
          <span className="mobile-badge-fhe">
            <Lock size={10} />
            FHE Encrypted
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "rgba(37, 99, 235, 0.08)",
              color: "#2563EB",
              fontSize: 11,
              fontWeight: 600,
              padding: "4px 10px",
              borderRadius: 20,
            }}
          >
            Base Sepolia
          </span>
        </div>
      </div>

      {/* ─── Wallet Address ─────────────────────────────────────────── */}
      <div className="mobile-card" style={{ marginTop: 12, padding: "14px 16px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div>
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--text-tertiary)",
                textTransform: "uppercase",
                letterSpacing: "0.04em",
                display: "block",
                marginBottom: 4,
              }}
            >
              Wallet Address
            </span>
            <span
              className="mobile-mono"
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: "var(--text-primary)",
              }}
            >
              {address ? shortenAddress(address) : "Not connected"}
            </span>
          </div>
          <button
            onClick={handleCopyAddress}
            style={{
              background: "var(--primary-ghost)",
              border: "none",
              borderRadius: 10,
              width: 36,
              height: 36,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              transition: "background 200ms ease",
            }}
            aria-label="Copy wallet address"
          >
            {copied ? (
              <Check size={16} color="var(--success-dark)" />
            ) : (
              <Copy size={16} color="var(--primary)" />
            )}
          </button>
        </div>
      </div>

      {/* ─── Menu Items ─────────────────────────────────────────────── */}
      <div className="mobile-card" style={{ marginTop: 12, padding: "2px 16px" }}>
        {MENU_ITEMS.map((item, idx) => (
          <button
            key={item.label}
            onClick={() => navigate(item.path)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              width: "100%",
              padding: "14px 0",
              borderBottom:
                idx < MENU_ITEMS.length - 1
                  ? "1px solid rgba(0,0,0,0.04)"
                  : "none",
              background: "none",
              border: idx < MENU_ITEMS.length - 1 ? undefined : "none",
              borderTop: "none",
              borderLeft: "none",
              borderRight: "none",
              cursor: "pointer",
              textAlign: "left",
              WebkitTapHighlightColor: "transparent",
            }}
            aria-label={item.label}
          >
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                background: item.iconBg,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <item.icon size={18} color={item.iconColor} strokeWidth={2} />
            </div>
            <span
              style={{
                flex: 1,
                fontSize: 15,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              {item.label}
            </span>
            <ChevronRight size={18} color="var(--text-tertiary)" />
          </button>
        ))}
      </div>

      {/* ─── Sign Out ───────────────────────────────────────────────── */}
      <button
        onClick={handleSignOut}
        className="mobile-card"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          width: "100%",
          marginTop: 12,
          padding: "14px 16px",
          cursor: "pointer",
          border: "none",
          textAlign: "center",
          WebkitTapHighlightColor: "transparent",
        }}
      >
        <LogOut size={18} color="#DC2626" />
        <span
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "#DC2626",
          }}
        >
          Sign Out
        </span>
      </button>

      {/* ─── Footer ─────────────────────────────────────────────────── */}
      <p
        style={{
          textAlign: "center",
          fontSize: 11,
          color: "var(--text-tertiary)",
          margin: "16px 0 24px",
        }}
      >
        Joined 2024 &middot; Blank Pay v1.0.0
      </p>
    </div>
  );
}

export default MobileProfile;
