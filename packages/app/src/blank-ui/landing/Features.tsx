import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import "./landing.css";

// ══════════════════════════════════════════════════════════════════
//  Features — full catalogue page
//  Each feature is a real section: name, pitch, scenario, Try CTA,
//  and a CSS-only UI preview card (no external images).
//  ══════════════════════════════════════════════════════════════════

type FeaturePreview =
  | { kind: "receipt"; rows: Array<{ label: string; value: string; enc?: boolean }> }
  | { kind: "group"; title: string; members: Array<{ initials: string; color: string }>; total: string }
  | { kind: "badge"; tier: string; label: string }
  | { kind: "invoice"; lines: Array<{ label: string; value: string }>; status: string }
  | { kind: "stealth"; code: string }
  | { kind: "envelope"; count: number }
  | { kind: "countdown"; heir: string; daysLeft: number }
  | { kind: "swap"; give: string; want: string };

interface Feature {
  tag: string;
  name: string;
  pitch: string;
  scenario: string;
  route: string;
  preview: FeaturePreview;
}

const FEATURES: Feature[] = [
  {
    tag: "01 — Payments",
    name: "Send",
    pitch: "Pay anyone with a wallet address. The moment you hit send, the amount becomes ciphertext — only the recipient can decrypt.",
    scenario: "Sarah pays her freelance designer $800 without anyone learning what she pays her contractors.",
    route: "/app/send",
    preview: {
      kind: "receipt",
      rows: [
        { label: "To",       value: "0xcc89…03c3" },
        { label: "Amount",   value: "████.██",  enc: true },
        { label: "Note",     value: "Thanks!" },
        { label: "Fee",      value: "0.0008 ETH" },
      ],
    },
  },
  {
    tag: "02 — Payments",
    name: "Requests",
    pitch: "Create a payment request with a memo. Share the link. Let the other person fulfill when they're ready — or cancel it anytime.",
    scenario: "Ask your roommate for their half of the electric bill without publishing the number to the whole world.",
    route: "/app/requests",
    preview: {
      kind: "receipt",
      rows: [
        { label: "Requester", value: "0xeDF5…5952" },
        { label: "Amount",    value: "████.██",  enc: true },
        { label: "Memo",      value: "April rent share" },
        { label: "Status",    value: "Pending" },
      ],
    },
  },
  {
    tag: "03 — Social",
    name: "Group Split",
    pitch: "Split bills with custom per-member shares. Disputes resolved by encrypted quadratic voting — the group approves without anyone learning who voted what.",
    scenario: "Four friends rent a cabin. Each contribution stays private; if costs change, the group votes without leaking preferences.",
    route: "/app/groups",
    preview: {
      kind: "group",
      title: "Weekend Cabin",
      members: [
        { initials: "AL", color: "#10b981" },
        { initials: "JM", color: "#3b82f6" },
        { initials: "RK", color: "#f59e0b" },
        { initials: "NS", color: "#8b5cf6" },
      ],
      total: "████.██",
    },
  },
  {
    tag: "04 — Social",
    name: "Creator Tips",
    pitch: "Support creators anonymously. Earn on-chain tier badges for cumulative support without a public donation log.",
    scenario: "Tip your favorite writer $50/month without every follower seeing your generosity.",
    route: "/app/creators",
    preview: {
      kind: "badge",
      tier: "Tier 3",
      label: "Trusted Supporter",
    },
  },
  {
    tag: "05 — Business",
    name: "Invoicing",
    pitch: "Two-phase encrypted invoices. Your client sees the amount due; the chain only sees ciphertext handles. Async FHE verification confirms the right amount was paid.",
    scenario: "A consulting firm bills $15K retainers without posting their fee structure for every competitor to read.",
    route: "/app/business",
    preview: {
      kind: "invoice",
      lines: [
        { label: "Invoice #",  value: "INV-2024-091" },
        { label: "Client",     value: "0xaBc1…fE22" },
        { label: "Amount",     value: "████.██" },
        { label: "Due",        value: "Apr 30" },
      ],
      status: "Awaiting payment",
    },
  },
  {
    tag: "06 — Business",
    name: "Batch Payroll",
    pitch: "Pay up to 30 employees in one transaction. Each salary is individually encrypted — the CEO's pay isn't visible to the intern.",
    scenario: "Run payroll for a 20-person team. Nobody except the recipient and the admin sees any number.",
    route: "/app/business",
    preview: {
      kind: "receipt",
      rows: [
        { label: "Employees",     value: "20" },
        { label: "Payroll total", value: "████████.██", enc: true },
        { label: "Period",        value: "April 2026" },
        { label: "Status",        value: "Broadcast" },
      ],
    },
  },
  {
    tag: "07 — Business",
    name: "Escrow",
    pitch: "Two-of-two approval with an arbiter. Delivery confirmation, automatic expiry, and built-in dispute resolution — without a middleman holding funds.",
    scenario: "Contract work: buyer funds the escrow, seller delivers, both approve. If it goes sideways, the arbiter decides — no platform rake.",
    route: "/app/business",
    preview: {
      kind: "invoice",
      lines: [
        { label: "Escrow",    value: "ESC-7712" },
        { label: "Buyer",     value: "0xaBc1…" },
        { label: "Seller",    value: "0xdEf2…" },
        { label: "Amount",    value: "████.██" },
      ],
      status: "2/2 approvals pending",
    },
  },
  {
    tag: "08 — Privacy",
    name: "Stealth Payments",
    pitch: "Anonymous transfers bound to a one-time claim code. The sender's wallet and the receiver's wallet never appear together on-chain. Anti-frontrunning by cryptographic design.",
    scenario: "Send $500 to someone without either wallet ever being linkable by an outside observer.",
    route: "/app/stealth",
    preview: {
      kind: "stealth",
      code: "shield-lotus-9248",
    },
  },
  {
    tag: "09 — Social",
    name: "Gift Envelopes",
    pitch: "Equal or random encrypted splits with expiry dates and auto-claim. Create an envelope, share the link, watch it get claimed.",
    scenario: "Wedding gifts for the couple — guests contribute privately, couple opens when ready, unclaimed amounts refund automatically.",
    route: "/app/gifts",
    preview: {
      kind: "envelope",
      count: 8,
    },
  },
  {
    tag: "10 — Advanced",
    name: "Inheritance",
    pitch: "A dead man's switch with encrypted vault transfer. If you stop checking in, your designated heir can claim access after a challenge period.",
    scenario: "Set a 90-day inactivity trigger. If something happens, your sister inherits your encrypted funds — no lawyer, no key ceremony.",
    route: "/app/inheritance",
    preview: {
      kind: "countdown",
      heir: "0xdEf2…9a4b",
      daysLeft: 87,
    },
  },
  {
    tag: "11 — DeFi",
    name: "P2P Exchange",
    pitch: "Atomic swaps with encrypted settlement. Trade token for token without publishing your price or your size.",
    scenario: "Swap 1,000 eUSDC for ETH without revealing which direction you think the market is headed.",
    route: "/app/swap",
    preview: {
      kind: "swap",
      give: "████ eUSDC",
      want: "████ ETH",
    },
  },
  // #86: PrivacyRouter contract is deployed but the screen-level UI isn't
  // wired yet. Card removed from the marketing list until the screen ships
  // so visitors don't hit a dead CTA. Re-add once /app/swap supports the
  // decrypt → DEX-route → re-encrypt flow.
];

// ─── Preview renderers ────────────────────────────────────────────

function Preview({ p }: { p: FeaturePreview }) {
  switch (p.kind) {
    case "receipt":
      return (
        <div className="ll-preview-card">
          <div className="ll-preview-title">Transaction</div>
          {p.rows.map((r) => (
            <div key={r.label} className="ll-preview-line">
              <span className="ll-preview-label">{r.label}</span>
              <span className={r.enc ? "ll-preview-enc" : "ll-preview-val"}>
                {r.value}
              </span>
            </div>
          ))}
        </div>
      );

    case "group":
      return (
        <div className="ll-preview-card">
          <div className="ll-preview-title">{p.title}</div>
          <div className="ll-preview-line">
            <span className="ll-preview-label">Members</span>
            <span className="ll-preview-val">{p.members.length}</span>
          </div>
          <div className="ll-preview-line" style={{ borderTop: "none", paddingTop: 0 }}>
            <div className="ll-preview-avatar-row">
              {p.members.map((m) => (
                <div
                  key={m.initials}
                  className="ll-preview-avatar"
                  style={{ background: m.color }}
                >
                  {m.initials}
                </div>
              ))}
            </div>
          </div>
          <div className="ll-preview-line">
            <span className="ll-preview-label">Total</span>
            <span className="ll-preview-enc">{p.total}</span>
          </div>
        </div>
      );

    case "badge":
      return (
        <div className="ll-preview-card" style={{ textAlign: "center" }}>
          <div className="ll-preview-title" style={{ marginBottom: "1rem" }}>Supporter tier</div>
          <div style={{ fontSize: "2.5rem", fontWeight: 700, letterSpacing: "-0.02em", color: "#0a0a0a", marginBottom: "0.4rem" }}>
            {p.tier}
          </div>
          <div style={{ marginBottom: "1rem" }}>
            <span className="ll-preview-badge">{p.label}</span>
          </div>
          <div className="ll-preview-line" style={{ borderTop: "1px solid var(--ll-line)", paddingTop: "0.8rem" }}>
            <span className="ll-preview-label">Cumulative support</span>
            <span className="ll-preview-enc">████.██</span>
          </div>
        </div>
      );

    case "invoice":
      return (
        <div className="ll-preview-card">
          <div className="ll-preview-title">{p.status}</div>
          {p.lines.map((l) => (
            <div key={l.label} className="ll-preview-line">
              <span className="ll-preview-label">{l.label}</span>
              <span className={l.value.includes("█") ? "ll-preview-enc" : "ll-preview-val"}>
                {l.value}
              </span>
            </div>
          ))}
        </div>
      );

    case "stealth":
      return (
        <div className="ll-preview-card" style={{ textAlign: "center" }}>
          <div className="ll-preview-title">Claim code</div>
          <div
            style={{
              fontFamily: "SF Mono, Menlo, monospace",
              fontSize: "1.3rem",
              fontWeight: 600,
              padding: "1.5rem 1rem",
              background: "var(--ll-surface)",
              borderRadius: "10px",
              letterSpacing: "0.06em",
              color: "#0a0a0a",
              marginBottom: "1rem",
            }}
          >
            {p.code}
          </div>
          <div className="ll-preview-line" style={{ borderTop: "1px solid var(--ll-line)", paddingTop: "0.8rem" }}>
            <span className="ll-preview-label">Recipient reveals on claim</span>
            <span className="ll-preview-enc">████</span>
          </div>
        </div>
      );

    case "envelope":
      return (
        <div className="ll-preview-card" style={{ textAlign: "center" }}>
          <div className="ll-preview-title">Gift envelope</div>
          <div style={{ fontSize: "3rem", marginBottom: "0.5rem" }}>🧧</div>
          <div className="ll-preview-line">
            <span className="ll-preview-label">Recipients</span>
            <span className="ll-preview-val">{p.count}</span>
          </div>
          <div className="ll-preview-line">
            <span className="ll-preview-label">Split type</span>
            <span className="ll-preview-val">Random · Encrypted</span>
          </div>
          <div className="ll-preview-line">
            <span className="ll-preview-label">Expires</span>
            <span className="ll-preview-val">Apr 30</span>
          </div>
        </div>
      );

    case "countdown":
      return (
        <div className="ll-preview-card">
          <div className="ll-preview-title">Dead man's switch</div>
          <div style={{ fontSize: "2.5rem", fontWeight: 700, letterSpacing: "-0.02em", color: "#0a0a0a", marginBottom: "0.25rem" }}>
            {p.daysLeft} days
          </div>
          <div style={{ fontSize: "0.85rem", color: "var(--ll-muted)", marginBottom: "1rem" }}>
            until heir can claim
          </div>
          <div className="ll-preview-line">
            <span className="ll-preview-label">Heir</span>
            <span className="ll-preview-val" style={{ fontFamily: "SF Mono, monospace" }}>
              {p.heir}
            </span>
          </div>
          <div className="ll-preview-line">
            <span className="ll-preview-label">Vault balance</span>
            <span className="ll-preview-enc">████.██</span>
          </div>
        </div>
      );

    case "swap":
      return (
        <div className="ll-preview-card">
          <div className="ll-preview-title">Encrypted swap</div>
          <div className="ll-preview-line">
            <span className="ll-preview-label">You give</span>
            <span className="ll-preview-enc">{p.give}</span>
          </div>
          <div className="ll-preview-line">
            <span className="ll-preview-label">You want</span>
            <span className="ll-preview-enc">{p.want}</span>
          </div>
          <div className="ll-preview-line">
            <span className="ll-preview-label">Settlement</span>
            <span className="ll-preview-val">Atomic · on-chain</span>
          </div>
        </div>
      );
  }
}

// ─── Page ─────────────────────────────────────────────────────────

export default function Features() {
  return (
    <div className="blank-landing">
      <LandingNav />
      <main>
        <section className="ll-page-hero">
          <div className="ll-section-kicker">Twelve private tools</div>
          <h1 className="ll-section-title">
            Everything you'd do with Venmo. With the amounts sealed shut.
          </h1>
          <p className="ll-section-lead">
            One encrypted vault. Twelve product surfaces. Every feature ships
            in the app today — real contracts, real FHE, live on Ethereum
            Sepolia.
          </p>
        </section>

        <div className="ll-feature-list">
          {FEATURES.map((f, i) => (
            <div
              key={f.name}
              className={`ll-feature-row${i % 2 === 1 ? " reversed" : ""}`}
            >
              <div className="ll-feature-copy">
                <div className="ll-feature-tag">{f.tag}</div>
                <h2 className="ll-feature-name-lg">{f.name}</h2>
                <p className="ll-feature-pitch">{f.pitch}</p>
                <div className="ll-feature-scenario">{f.scenario}</div>
                <Link to={f.route} className="ll-feature-cta">
                  Try {f.name} <ArrowRight size={16} strokeWidth={2.2} />
                </Link>
              </div>
              <div className="ll-feature-visual">
                <Preview p={f.preview} />
              </div>
            </div>
          ))}
        </div>

        <section className="ll-cta">
          <h2 className="ll-cta-title">One vault. Twelve ways in.</h2>
          <p className="ll-cta-sub">
            Shield some USDC. Pick any feature. Ship your first private
            payment in under a minute.
          </p>
          <Link to="/app" className="ll-btn ll-btn--hero ll-btn--ink">
            Launch Blank <ArrowRight size={17} strokeWidth={2.2} />
          </Link>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
