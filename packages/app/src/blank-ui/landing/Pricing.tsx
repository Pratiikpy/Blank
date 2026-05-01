import { Link } from "react-router-dom";
import { ArrowRight, Check } from "lucide-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import "./landing.css";

// ══════════════════════════════════════════════════════════════════
//  Pricing — the SHAPE, not the numbers.
//
//  Why this page exists: every visitor evaluating Blank as a real
//  product (vs a hackathon project) lands on /pricing eventually.
//  Silence reads as "they haven't thought about it." A page that
//  says "free during testnet, here's how mainnet pricing will be
//  shaped, here's our reasoning" reads as "they have."
//
//  Design constraints kept in mind while writing this:
//   - No numbers. We don't know mainnet costs yet (audit, infra,
//     threshold-network fees, regulatory). Committing to a number
//     now would be either dishonest or a lie we'd have to revise.
//   - Show the SHAPE: per-tx fee on the vendor side, capped, free
//     for under-$N invoices. Mirrors Stripe/Square.
//   - Be explicit about what's free forever (the protocol surface,
//     receiving payments, viewing your own data).
//   - Be explicit about what we'll charge for (settlement on the
//     happy path, paid only by the party who gets paid).
//   - Honest about why the number isn't there yet.
//  ══════════════════════════════════════════════════════════════════

interface PricingTier {
  name: string;
  audience: string;
  status: "live" | "shape" | "later";
  pitch: string;
  bullets: string[];
}

const TIERS: PricingTier[] = [
  {
    name: "Personal",
    audience: "Anyone with a wallet",
    status: "live",
    pitch: "Free, forever. No fee, no upsell, no asterisk.",
    bullets: [
      "Send and receive encrypted payments",
      "Create unlimited invoices and payment requests",
      "Stealth + gift envelope flows",
      "Group expenses, splits, settlement",
      "Export your activity to CSV",
      "All future privacy-preserving primitives",
    ],
  },
  {
    name: "Vendor",
    audience: "Freelancers, agencies, small businesses",
    status: "shape",
    pitch:
      "Per-settled-invoice fee on the vendor side. Free until your first paid invoice clears mainnet.",
    bullets: [
      "Everything in Personal",
      "Invoice escrow with auto-refund-on-mismatch",
      "Confidential payroll for up to 30 employees",
      "Embeddable checkout widgets (Wave 4)",
      "Webhook events for paid / disputed / refunded",
      "Custom branding on the public invoice page",
    ],
  },
  {
    name: "Platform",
    audience: "Apps that want privacy as a feature",
    status: "later",
    pitch: "Per-call API pricing for the embeddable SDK. Volume discounts.",
    bullets: [
      "Programmatic invoice + escrow creation",
      "Embeddable checkout component",
      "Webhook + reconciliation API",
      "Branded developer portal",
      "Priority support + uptime guarantees",
      "Audit trail export for compliance",
    ],
  },
];

function StatusBadge({ status }: { status: PricingTier["status"] }) {
  if (status === "live") {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.35rem",
          background: "rgba(16, 185, 129, 0.12)",
          color: "rgb(5, 150, 105)",
          fontSize: "0.7rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          padding: "0.3rem 0.6rem",
          borderRadius: "5px",
          fontWeight: 700,
        }}
      >
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            background: "rgb(5, 150, 105)",
          }}
        />
        Live now
      </span>
    );
  }
  if (status === "shape") {
    return (
      <span
        style={{
          background: "var(--ll-surface)",
          color: "var(--ll-accent-dark)",
          fontSize: "0.7rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          padding: "0.3rem 0.6rem",
          borderRadius: "5px",
          fontWeight: 700,
        }}
      >
        Mainnet shape
      </span>
    );
  }
  return (
    <span
      style={{
        background: "rgba(0,0,0,0.04)",
        color: "var(--ll-ink-2)",
        fontSize: "0.7rem",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        padding: "0.3rem 0.6rem",
        borderRadius: "5px",
        fontWeight: 700,
      }}
    >
      Wave 4 →
    </span>
  );
}

export default function Pricing() {
  return (
    <div className="blank-landing">
      <LandingNav />
      <main>
        {/* Hero */}
        <section className="ll-hero">
          <p className="ll-eyebrow">Pricing — shape, not numbers</p>
          <h1 className="ll-hero-h1">
            Free during testnet.
            <br />
            Honest about mainnet.
          </h1>
          <p className="ll-subline">
            Blank is testnet-only today and free for everyone, forever.
            Below is how mainnet pricing will be shaped — and the
            reasoning behind the shape. We don't show numbers because
            we don't know them yet, and we'd rather say that than guess.
          </p>
        </section>

        {/* Tiers */}
        <section className="ll-section">
          <div className="ll-stats-grid" style={{ alignItems: "stretch" }}>
            {TIERS.map((t) => (
              <div
                key={t.name}
                className="ll-stat"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.9rem",
                  textAlign: "left",
                  alignItems: "flex-start",
                }}
              >
                <StatusBadge status={t.status} />
                <div
                  style={{
                    fontSize: "1.65rem",
                    fontWeight: 700,
                    letterSpacing: "-0.01em",
                    color: "var(--ll-ink-1)",
                  }}
                >
                  {t.name}
                </div>
                <div
                  style={{
                    fontSize: "0.85rem",
                    color: "var(--ll-ink-2)",
                    fontWeight: 500,
                    marginTop: "-0.4rem",
                  }}
                >
                  {t.audience}
                </div>
                <div
                  style={{
                    fontSize: "1rem",
                    color: "var(--ll-ink-1)",
                    lineHeight: 1.5,
                  }}
                >
                  {t.pitch}
                </div>
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: "0.55rem",
                    width: "100%",
                  }}
                >
                  {t.bullets.map((b) => (
                    <li
                      key={b}
                      style={{
                        display: "flex",
                        gap: "0.55rem",
                        alignItems: "flex-start",
                        fontSize: "0.92rem",
                        color: "var(--ll-ink-2)",
                        lineHeight: 1.5,
                      }}
                    >
                      <Check
                        size={15}
                        strokeWidth={2.4}
                        style={{
                          color: "var(--ll-accent-dark)",
                          marginTop: "3px",
                          flexShrink: 0,
                        }}
                      />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* Reasoning */}
        <section className="ll-section">
          <div className="ll-section-kicker">The reasoning</div>
          <h2 className="ll-section-title">Why we won't put a number on this yet.</h2>
          <p className="ll-section-lead">
            We've watched too many projects publish mainnet pricing
            during testnet, then have to walk it back when the actual
            costs land. We'd rather say "we don't know yet" honestly
            than pick a number we'll regret.
          </p>
          <div
            style={{
              maxWidth: "780px",
              margin: "2rem auto 0",
              display: "flex",
              flexDirection: "column",
              gap: "1.5rem",
              fontSize: "1rem",
              lineHeight: 1.7,
              color: "var(--ll-ink-1)",
              textAlign: "left",
            }}
          >
            <div>
              <strong>The protocol surface stays free, forever.</strong>{" "}
              Sending and receiving encrypted payments is the core
              capability. Charging for it would defeat the wedge.
              Think Signal, not Slack.
            </div>
            <div>
              <strong>Vendors pay because vendors get paid.</strong>{" "}
              The business case for Blank is "I run a freelance
              practice and I need invoicing that doesn't expose my
              rates." That vendor is the one realising revenue
              through the platform. They pay a small per-settled-invoice
              fee, capped, with the first $N free per month so a
              one-off side hustle never gets a bill.
            </div>
            <div>
              <strong>Platforms pay because platforms multiply.</strong>{" "}
              When apps embed Blank's checkout via the SDK (Wave 4+),
              they get programmatic API access, webhooks, branded
              portals, and priority support. That's a different
              product than the consumer surface and it'll have its
              own pricing.
            </div>
            <div>
              <strong>Why we can't tell you the numbers yet.</strong>{" "}
              Three unknowns: (1) Fhenix mainnet threshold-decrypt
              economics, which we don't control. (2) Audit costs and
              ongoing security work, which scale with surface area.
              (3) Regulatory clarity around private-amount
              transactions, which may require us to build features
              we haven't scoped. Until those settle, any number we
              publish would be wrong.
            </div>
          </div>
        </section>

        {/* What's free forever */}
        <section className="ll-section">
          <div className="ll-section-kicker">Always free</div>
          <h2 className="ll-section-title">What we will never charge for.</h2>
          <div
            style={{
              maxWidth: "780px",
              margin: "1.5rem auto 0",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0.75rem",
              fontSize: "0.95rem",
            }}
          >
            {[
              "Receiving encrypted payments",
              "Sending encrypted payments to people you know",
              "Viewing your own activity feed",
              "Exporting your data to CSV",
              "The smart-wallet passkey signup flow",
              "Reading public invoice pages",
              "Stealth claim codes for one-off transfers",
              "Reading the source code on GitHub",
            ].map((b) => (
              <div
                key={b}
                style={{
                  display: "flex",
                  gap: "0.5rem",
                  alignItems: "flex-start",
                  color: "var(--ll-ink-2)",
                }}
              >
                <Check
                  size={15}
                  strokeWidth={2.4}
                  style={{
                    color: "var(--ll-accent-dark)",
                    marginTop: "3px",
                    flexShrink: 0,
                  }}
                />
                <span>{b}</span>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="ll-cta">
          <h2 className="ll-cta-title">Use it free during testnet.</h2>
          <p className="ll-cta-sub">
            Mainnet pricing will be announced when we have honest numbers.
            Until then, every flow is free for everyone, with no asterisk.
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
