import { useNavigate } from "react-router-dom";
import {
  Users,
  Zap,
  Gift,
  Star,
  Building2,
  ArrowLeftRight,
  Heart,
  BarChart3,
  ShieldCheck,
  ChevronRight,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ═══════════════════════════════════════════════════════════════════
//  FEATURE DIRECTORY DATA
// ═══════════════════════════════════════════════════════════════════

interface FeatureItem {
  icon: LucideIcon;
  iconBg: string;
  iconColor: string;
  title: string;
  subtitle: string;
  path: string;
}

interface FeatureSection {
  label: string;
  items: FeatureItem[];
}

const SECTIONS: FeatureSection[] = [
  {
    label: "PAYMENTS",
    items: [
      {
        icon: Users,
        iconBg: "rgba(108, 99, 255, 0.1)",
        iconColor: "#6C63FF",
        title: "Group Expenses",
        subtitle: "Split costs privately",
        path: "/m/groups",
      },
      {
        icon: Zap,
        iconBg: "rgba(26, 26, 46, 0.08)",
        iconColor: "#1A1A2E",
        title: "Stealth Payments",
        subtitle: "Anonymous claim codes",
        path: "/m/stealth",
      },
      {
        icon: Gift,
        iconBg: "rgba(220, 38, 38, 0.08)",
        iconColor: "#DC2626",
        title: "Gift Envelopes",
        subtitle: "Encrypted gift money",
        path: "/m/gifts",
      },
    ],
  },
  {
    label: "CREATOR & BUSINESS",
    items: [
      {
        icon: Star,
        iconBg: "rgba(217, 119, 6, 0.08)",
        iconColor: "#D97706",
        title: "Creator Hub",
        subtitle: "Support creators privately",
        path: "/m/creators",
      },
      {
        icon: Building2,
        iconBg: "rgba(37, 99, 235, 0.08)",
        iconColor: "#2563EB",
        title: "Business Hub",
        subtitle: "Invoices, payroll, escrow",
        path: "/m/business",
      },
    ],
  },
  {
    label: "ADVANCED",
    items: [
      {
        icon: ArrowLeftRight,
        iconBg: "rgba(5, 150, 105, 0.08)",
        iconColor: "#059669",
        title: "Token Swap",
        subtitle: "P2P encrypted exchange",
        path: "/m/swap",
      },
      {
        icon: Heart,
        iconBg: "rgba(220, 38, 38, 0.08)",
        iconColor: "#DC2626",
        title: "Inheritance Switch",
        subtitle: "Dead man's switch",
        path: "/m/inheritance",
      },
      {
        icon: BarChart3,
        iconBg: "rgba(108, 99, 255, 0.1)",
        iconColor: "#6C63FF",
        title: "Private Analytics",
        subtitle: "Your financial insights",
        path: "/m/analytics",
      },
    ],
  },
  {
    label: "SECURITY",
    items: [
      {
        icon: ShieldCheck,
        iconBg: "rgba(107, 114, 128, 0.08)",
        iconColor: "#6B7280",
        title: "Privacy Settings",
        subtitle: "Control your data",
        path: "/m/privacy",
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════
//  FEATURE ROW
// ═══════════════════════════════════════════════════════════════════

function FeatureRow({ item, isLast }: { item: FeatureItem; isLast: boolean }) {
  const navigate = useNavigate();

  return (
    <button
      onClick={() => navigate(item.path)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        width: "100%",
        padding: "14px 0",
        borderBottom: isLast ? "none" : "1px solid rgba(0,0,0,0.04)",
        background: "none",
        border: isLast ? "none" : undefined,
        borderTop: "none",
        borderLeft: "none",
        borderRight: "none",
        cursor: "pointer",
        textAlign: "left",
        WebkitTapHighlightColor: "transparent",
        transition: "background 150ms ease",
      }}
      aria-label={`${item.title}: ${item.subtitle}`}
    >
      {/* Icon */}
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          background: item.iconBg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <item.icon size={20} color={item.iconColor} strokeWidth={2} />
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--text-primary)",
            display: "block",
          }}
        >
          {item.title}
        </span>
        <span
          style={{
            fontSize: 12,
            color: "var(--text-tertiary)",
            display: "block",
            marginTop: 2,
          }}
        >
          {item.subtitle}
        </span>
      </div>

      {/* Chevron */}
      <ChevronRight size={18} color="var(--text-tertiary)" style={{ flexShrink: 0 }} />
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN SCREEN
// ═══════════════════════════════════════════════════════════════════

export function MobileExplore() {
  return (
    <div style={{ padding: "0 16px", minHeight: "100dvh" }}>
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <header style={{ padding: "20px 0 8px" }}>
        <h1
          style={{
            fontSize: 24,
            fontWeight: 700,
            color: "var(--text-primary)",
            margin: "0 0 4px",
          }}
        >
          Explore
        </h1>
        <p
          style={{
            fontSize: 13,
            color: "var(--text-tertiary)",
            margin: 0,
          }}
        >
          All features &middot; powered by FHE privacy
        </p>
      </header>

      {/* ─── Feature Sections ───────────────────────────────────────── */}
      {SECTIONS.map((section) => (
        <div key={section.label} style={{ marginTop: 20 }}>
          {/* Section Header */}
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--text-tertiary)",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              display: "block",
              marginBottom: 8,
              paddingLeft: 4,
            }}
          >
            {section.label}
          </span>

          {/* Section Card */}
          <div className="mobile-card" style={{ padding: "2px 16px" }}>
            {section.items.map((item, idx) => (
              <FeatureRow
                key={item.path}
                item={item}
                isLast={idx === section.items.length - 1}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Bottom spacer */}
      <div style={{ height: 24 }} />
    </div>
  );
}

export default MobileExplore;
