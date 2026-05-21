import { Link } from "react-router-dom";
import { ArrowRight, Check, Clock, AlertCircle } from "lucide-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import "./landing.css";

// ══════════════════════════════════════════════════════════════════
//  Roadmap - what's shipped, what's next, what blocks each step.
//
//  Why this page exists: "testnet only" is a brand liability that
//  grows by the week if you don't show what gates mainnet. Hiding
//  the dependency reads as stalling. Showing the dependency reads
//  as understanding what real readiness means.
//
//  Three explicit categories:
//   - Shipped (what's live now, with verifiable links)
//   - Next (what we're working on, no dates)
//   - Blocked (things we can't ship until something external happens)
//
//  No quarter labels. No "Q4 2026 - mainnet." We'll ship when the
//  blockers clear, not when we promised a date a year ago.
//  ══════════════════════════════════════════════════════════════════

interface RoadmapItem {
  title: string;
  detail: string;
}

interface BlockedItem extends RoadmapItem {
  blockedBy: string[];
}

const SHIPPED: RoadmapItem[] = [
  {
    title: "Encrypted P2P payments",
    detail:
      "Send + receive amounts that the chain processes but nobody else can read. The core primitive. Every other feature builds on this.",
  },
  {
    title: "Private invoice escrow",
    detail:
      "Vendor + client + auto-refund-on-mismatch. Public invoice link, FHE-verified amount match, settlement proof on-chain.",
  },
  {
    title: "Workspace modes",
    detail:
      "Freelancer / Business / Privacy / Full. Single source of truth in nav-registry. Adapts the entire app to the user's role.",
  },
  {
    title: "Stealth payments + meta-addresses",
    detail:
      "ERC-5564 / 6538 stealth flows with claim-code-bound recipients. Encrypted-at-rest keystore (AES-GCM) for stealth keys.",
  },
  {
    title: "Group expenses + gift envelopes",
    detail:
      "Splitwise-shape with encrypted shares. Quadratic voting on disputes. Gift envelopes with equal or random splits.",
  },
  {
    title: "Confidential payroll",
    detail:
      "Up to 30 employees in a single batch. Nobody sees each other's pay. Per-recipient PaymentReceipts for income proofs.",
  },
  {
    title: "Verifiable balance proofs",
    detail:
      "Generate a shareable URL that proves 'balance ≥ $X' without revealing the actual balance. Threshold-network signed.",
  },
  {
    title: "Passkey smart wallets + paymaster",
    detail:
      "ERC-4337 accounts signed by P-256 passkeys. Gas sponsored via BlankPaymaster when sponsorship is available. Standard EVM wallet path also works.",
  },
  {
    title: "Dead-man's-switch inheritance",
    detail:
      "Heir claims after N days inactive. Encrypted beneficiary amounts. Capped at 20 vaults to prevent claim-lockout via gas-limit.",
  },
  {
    title: "Dual-chain (Base + Eth Sepolia)",
    detail:
      "Same contracts deployed on both. Per-chain activity feeds + explorer links. Chain switch is a UI affordance, not a separate build.",
  },
];

const NEXT: RoadmapItem[] = [
  {
    title: "Design system extraction",
    detail:
      "One source of truth for buttons, empty states, loading states, error states. Refactor the polished screens to use it; new screens stay consistent automatically.",
  },
  {
    title: "Trust layer",
    detail:
      "/security page, status page, public bug bounty, third-party audit booking. The boring work that turns 'project that ships' into 'product you can rely on'.",
  },
  {
    title: "SDK + embeddable checkout",
    detail:
      "@blankpay/sdk on npm. <BlankCheckout> React component. developers.myblank.app with three guides. Privacy-as-infrastructure for any payment flow.",
  },
  {
    title: "X-Ray reveal in-app",
    detail:
      "The brand moment from the landing page extends into every balance-reveal in the app. Cipher → plaintext animated like decryption, not a fade.",
  },
  {
    title: "Optimistic balance + caching",
    detail:
      "Show the last-known plaintext immediately on page load while the threshold-decrypt runs in background. Kills the worst part of the perceived latency story.",
  },
  {
    title: "Universal /receive page",
    detail:
      "Canonical 'give me money' link with QR + optional amount + memo. Same surface as the public invoice page, for ad-hoc requests.",
  },
];

const BLOCKED: BlockedItem[] = [
  {
    title: "Mainnet",
    detail:
      "Real-money usage requires three things to land in order. We don't speculate on dates because two of them are external dependencies and one is a security review whose duration we can't predict.",
    blockedBy: [
      "Fhenix CoFHE mainnet release (external, on Fhenix's roadmap)",
      "Third-party audit of every Blank contract",
      "Decentralization of the threshold operator set",
    ],
  },
  {
    title: "More chains beyond Base + Eth Sepolia",
    detail:
      "We pick two chains and ship them well rather than seven and ship them badly. Adding a third happens when one of the existing two hits product-market fit, not before.",
    blockedBy: [
      "Sustained traction on at least one current chain",
      "Threshold-decrypt operator presence on the new chain",
    ],
  },
  {
    title: "Mobile app (native)",
    detail:
      "The PWA renders across the mobile route map today. A native app is appealing but it's a separate codebase and a different distribution problem (App Store review, push notification entitlements, biometric authentication).",
    blockedBy: [
      "Real demand from current users (we'll ask, not assume)",
      "Fhenix SDK that compiles to React Native or native iOS/Android",
    ],
  },
];

function StatusBadge({ kind }: { kind: "shipped" | "next" | "blocked" }) {
  const cfg = {
    shipped: {
      label: "Shipped",
      bg: "rgba(16, 185, 129, 0.12)",
      fg: "rgb(5, 150, 105)",
      Icon: Check,
    },
    next: {
      label: "Next up",
      bg: "rgba(59, 130, 246, 0.12)",
      fg: "rgb(37, 99, 235)",
      Icon: Clock,
    },
    blocked: {
      label: "Blocked on dependencies",
      bg: "rgba(245, 158, 11, 0.12)",
      fg: "rgb(180, 83, 9)",
      Icon: AlertCircle,
    },
  }[kind];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.4rem",
        background: cfg.bg,
        color: cfg.fg,
        fontSize: "0.7rem",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        padding: "0.35rem 0.7rem",
        borderRadius: "5px",
        fontWeight: 700,
        marginBottom: "1rem",
      }}
    >
      <cfg.Icon size={11} strokeWidth={2.6} />
      {cfg.label}
    </span>
  );
}

function ItemList({ items }: { items: RoadmapItem[] }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr",
        gap: "1rem",
        maxWidth: "780px",
        margin: "0 auto",
      }}
    >
      {items.map((it) => (
        <div
          key={it.title}
          className="ll-step"
          style={{ textAlign: "left" }}
        >
          <div className="ll-step-title">{it.title}</div>
          <div className="ll-step-body">{it.detail}</div>
        </div>
      ))}
    </div>
  );
}

function BlockedList({ items }: { items: BlockedItem[] }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr",
        gap: "1rem",
        maxWidth: "780px",
        margin: "0 auto",
      }}
    >
      {items.map((it) => (
        <div
          key={it.title}
          className="ll-step"
          style={{ textAlign: "left" }}
        >
          <div className="ll-step-title">{it.title}</div>
          <div className="ll-step-body" style={{ marginBottom: "0.8rem" }}>
            {it.detail}
          </div>
          <div
            style={{
              fontSize: "0.8rem",
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              color: "var(--ll-ink-2)",
              fontWeight: 600,
              marginBottom: "0.4rem",
            }}
          >
            Blocked by
          </div>
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.4rem",
            }}
          >
            {it.blockedBy.map((b) => (
              <li
                key={b}
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "flex-start",
                  fontSize: "0.92rem",
                  color: "var(--ll-ink-2)",
                  lineHeight: 1.5,
                }}
              >
                <span style={{ flexShrink: 0, marginTop: "2px" }}>•</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export default function Roadmap() {
  return (
    <div className="blank-landing">
      <LandingNav />
      <main>
        <section className="ll-hero">
          <p className="ll-eyebrow">Roadmap</p>
          <h1 className="ll-hero-h1">
            What's shipped. What's next.
            <br />
            What's waiting on someone else.
          </h1>
          <p className="ll-subline">
            We don't publish dates because most of the dates other
            people publish turn out to be wrong. We publish what's
            done, what we're working on, and the explicit dependencies
            that block the things we can't ship yet.
          </p>
        </section>

        <section className="ll-section">
          <StatusBadge kind="shipped" />
          <h2 className="ll-section-title">Shipped. Live on testnet today.</h2>
          <p className="ll-section-lead">
            Sixteen product surfaces, one encrypted vault, two chains.
            Core desktop flows have live testnet receipts on Base Sepolia
            and Ethereum Sepolia. Long-duration close, release, and refund
            paths are covered by contract tests.
          </p>
          <div style={{ marginTop: "2rem" }}>
            <ItemList items={SHIPPED} />
          </div>
        </section>

        <section className="ll-section">
          <StatusBadge kind="next" />
          <h2 className="ll-section-title">Next up. Product hardening.</h2>
          <p className="ll-section-lead">
            Things in active scoping. We don't commit to all of them,
            and the order will shift as we learn what actually matters.
            But this is the honest list of what's on our minds.
          </p>
          <div style={{ marginTop: "2rem" }}>
            <ItemList items={NEXT} />
          </div>
        </section>

        <section className="ll-section">
          <StatusBadge kind="blocked" />
          <h2 className="ll-section-title">Blocked. We can't ship these yet.</h2>
          <p className="ll-section-lead">
            Three things that aren't on the active roadmap because
            they're gated on something outside our team's control.
            We're not hiding the gates; we're stating them.
          </p>
          <div style={{ marginTop: "2rem" }}>
            <BlockedList items={BLOCKED} />
          </div>
        </section>

        <section className="ll-cta">
          <h2 className="ll-cta-title">
            Want to know when something moves?
          </h2>
          <p className="ll-cta-sub">
            Every roadmap change shows up in the changelog on our blog.
            No newsletter sign-up, no notification spam. Just open
            the blog when you want an update.
          </p>
          <Link to="/blog" className="ll-btn ll-btn--hero ll-btn--ink">
            Read the blog <ArrowRight size={17} strokeWidth={2.2} />
          </Link>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
