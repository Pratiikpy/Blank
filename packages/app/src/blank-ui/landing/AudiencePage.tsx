import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check } from "lucide-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import "./landing.css";
import "./audience.css";

// ──────────────────────────────────────────────────────────────────
//  AudiencePage — one component, four audiences (`/for/<who>`).
//  Shared layout, distinct hero + lead use case + bullets + CTA.
//  Generic "privacy for everyone" pages convert nobody.
//  Specific "here's what YOU do with Blank" pages convert.
// ──────────────────────────────────────────────────────────────────

export type Audience = "individuals" | "creators" | "businesses" | "daos";

interface AudienceContent {
  kicker: string;
  headline: string;
  subhead: string;
  leadFeature: {
    title: string;
    body: string;
    cta: { label: string; to: string };
  };
  why: string[];
  proof: { stat: string; label: string }[];
  primaryCta: { label: string; to: string };
  secondaryCta: { label: string; to: string };
}

const CONTENT: Record<Audience, AudienceContent> = {
  individuals: {
    kicker: "For individuals",
    headline: "Your salary is your business. Not the blockchain's.",
    subhead:
      "Get paid in private. Prove your income to a landlord without exposing the number. Send rent without doxxing your wallet to a building manager. Take back the basic dignity that web3 took away.",
    leadFeature: {
      title: "Encrypted income proof",
      body: "Generate a one-link proof that your income is at least $X. The landlord verifies on-chain. They never see the actual amount. You never hand over a paystub.",
      cta: { label: "Try the proof flow", to: "/app/proofs" },
    },
    why: [
      "Send and receive USDC where the amount is invisible to MEV bots, blockchain analytics, and your contacts list.",
      "Prove income or balance thresholds without revealing the underlying number — share a verification link, done.",
      "Encrypted gift envelopes for birthdays, weddings, condolences. Each recipient sees only their own share.",
      "AI agent helps you derive splits and salaries from natural language. The agent's address is on-chain — fully auditable.",
    ],
    proof: [
      { stat: "ebool", label: "What your income comparison actually returns" },
      { stat: "$0", label: "Of your private data leaked when you share a proof" },
    ],
    primaryCta: { label: "Launch Blank", to: "/app" },
    secondaryCta: { label: "How does this work?", to: "/how-it-works" },
  },
  creators: {
    kicker: "For creators",
    headline: "Accept tips. Hit tier badges. Keep supporter counts private.",
    subhead:
      "Your audience size is leverage. Don't let your tip totals become a public dashboard for sponsors, competitors, and the algorithm. Run your creator economy on encrypted rails.",
    leadFeature: {
      title: "Tier badges without surveillance",
      body: "Set bronze / silver / gold thresholds. Supporters tip you encrypted USDC; the contract privately tracks contribution and returns an encrypted tier badge. You see who supports you and at what level. The internet doesn't.",
      cta: { label: "Set up CreatorHub", to: "/app/creators" },
    },
    why: [
      "Tip amounts are encrypted on-chain. No public leaderboard of who paid you and how much.",
      "Tier badges (bronze / silver / gold) computed via FHE.gte — supporters know they qualify without anyone seeing the numbers.",
      "Receipts are first-class: every tip generates an encrypted receipt only you and the supporter can unseal.",
      "Multi-chain ready: same supporter base, Eth Sepolia or Base Sepolia.",
    ],
    proof: [
      { stat: "0", label: "Sponsors who can scrape your tip totals from chain data" },
      { stat: "FHE.gte", label: "How tier qualification is computed without revealing balance" },
    ],
    primaryCta: { label: "Launch Blank", to: "/app" },
    secondaryCta: { label: "See features", to: "/features" },
  },
  businesses: {
    kicker: "For businesses",
    headline: "Pay your team without leaking comp bands to your investors.",
    subhead:
      "Onchain payroll today is a leaderboard of every salary you've ever paid. Cap tables, treasuries, vendor invoices — all visible. Blank fixes the privacy half so your business operations stop being an open book.",
    leadFeature: {
      title: "Encrypted payroll batches",
      body: "Send up to 30 employees in one transaction. Each salary line is individually encrypted. The CFO sees the total. Each employee sees only their own line. The intern doesn't see the senior engineer's pay.",
      cta: { label: "Open BusinessTools", to: "/app/business" },
    },
    why: [
      "Encrypted invoice line-items: total + per-line breakdowns visible only to vendor and client.",
      "Escrow with encrypted amounts and on-chain dispute resolution. Arbiter decides without seeing the underlying value.",
      "AI agents derive payroll lines from role + region context, sign attestations on-chain — auditable forever, never custodial.",
      "All operations encrypted, but social context (who, when, what) stays public for accountability.",
    ],
    proof: [
      { stat: "30", label: "Encrypted salary lines per single batch transaction" },
      { stat: "0", label: "Employees who can see another employee's pay" },
    ],
    primaryCta: { label: "Launch Blank", to: "/app" },
    secondaryCta: { label: "AI agents demo", to: "/app/agents" },
  },
  daos: {
    kicker: "For DAOs",
    headline: "Treasury operations your token holders can audit. Not surveil.",
    subhead:
      "Your DAO needs accountability — every contributor grant, every operations payment, every vendor invoice. It does not need every token holder to see exactly what every other contributor earns. Blank lets you keep both.",
    leadFeature: {
      title: "Encrypted grant payments",
      body: "Pay contributors with encrypted amounts. Aggregate spend is publicly verifiable on-chain (anyone can decrypt the total via FHE.allowGlobal). Per-contributor amounts stay between the DAO and the recipient.",
      cta: { label: "Try a payment", to: "/app/send" },
    },
    why: [
      "Public aggregate volume + tx count via FHE.allowGlobal — token holders verify treasury health without surveilling individual contributors.",
      "Stealth payments break the address-correlation problem: payouts can't be traced back to recipients via on-chain analysis.",
      "P2P exchange for OTC grants — public order sizes for discovery, encrypted settlement.",
      "Inheritance + multisig recovery for treasury continuity if signers go inactive or are compromised.",
    ],
    proof: [
      { stat: "FHE.allowGlobal", label: "How treasury totals stay public while individual payouts stay private" },
      { stat: "16", label: "Encrypted contracts on Eth + Base Sepolia, all UUPS-upgradeable" },
    ],
    primaryCta: { label: "Launch Blank", to: "/app" },
    secondaryCta: { label: "Read the manifesto", to: "/manifesto" },
  },
};

interface AudiencePageProps {
  audience: Audience;
}

export default function AudiencePage({ audience }: AudiencePageProps) {
  const c = CONTENT[audience];

  // Reset scroll position when navigating between audience pages — otherwise
  // readers land halfway down the new page where the previous one was scrolled.
  useEffect(() => {
    if (typeof window !== "undefined") window.scrollTo(0, 0);
  }, [audience]);

  return (
    <div className="blank-landing">
      <LandingNav />
      <main>
        {/* Hero */}
        <section className="aud-hero">
          <div className="aud-kicker">{c.kicker}</div>
          <h1 className="aud-headline">{c.headline}</h1>
          <p className="aud-subhead">{c.subhead}</p>
          <div className="aud-cta-row">
            <Link to={c.primaryCta.to} className="ll-btn ll-btn--hero ll-btn--ink">
              {c.primaryCta.label} <ArrowRight size={16} strokeWidth={2.2} />
            </Link>
            <Link to={c.secondaryCta.to} className="ll-btn ll-btn--hero ll-btn--ghost">
              {c.secondaryCta.label}
            </Link>
          </div>
        </section>

        {/* Lead feature */}
        <section className="aud-lead">
          <div className="aud-lead-card">
            <div className="aud-lead-eyebrow">Lead use case</div>
            <h2 className="aud-lead-title">{c.leadFeature.title}</h2>
            <p className="aud-lead-body">{c.leadFeature.body}</p>
            <Link to={c.leadFeature.cta.to} className="ll-btn ll-btn--ink">
              {c.leadFeature.cta.label} <ArrowRight size={14} strokeWidth={2.2} />
            </Link>
          </div>
        </section>

        {/* Why bullets */}
        <section className="aud-why">
          <h2 className="aud-section-title">What you get</h2>
          <ul className="aud-bullets">
            {c.why.map((b, i) => (
              <li key={i} className="aud-bullet">
                <Check size={18} className="aud-bullet-icon" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Proof stats */}
        <section className="aud-proof">
          {c.proof.map((p, i) => (
            <div key={i} className="aud-proof-card">
              <div className="aud-proof-stat">{p.stat}</div>
              <div className="aud-proof-label">{p.label}</div>
            </div>
          ))}
        </section>

        {/* Cross-sell */}
        <section className="aud-cross">
          <div className="aud-cross-grid">
            {(["individuals", "creators", "businesses", "daos"] as Audience[])
              .filter((a) => a !== audience)
              .map((a) => (
                <Link key={a} to={`/for/${a}`} className="aud-cross-link">
                  <span className="aud-cross-arrow">→</span>
                  <div>
                    <div className="aud-cross-kicker">For {a}</div>
                    <div className="aud-cross-tagline">
                      {CONTENT[a].headline.split(".")[0]}.
                    </div>
                  </div>
                </Link>
              ))}
          </div>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}

// Tiny wrapper components for the 4 routes — each is its own bundle chunk.
export function ForIndividuals() { return <AudiencePage audience="individuals" />; }
export function ForCreators()    { return <AudiencePage audience="creators" />; }
export function ForBusinesses()  { return <AudiencePage audience="businesses" />; }
export function ForDaos()        { return <AudiencePage audience="daos" />; }
