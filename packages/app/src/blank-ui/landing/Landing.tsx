import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { DecodeWord } from "./DecodeWord";
import { XRaySlider } from "./XRaySlider";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { LiveDemo } from "./LiveDemo";
import "./landing.css";

// ══════════════════════════════════════════════════════════════════
//  Landing — hero + pitch + short narrative
//  Depth lives on dedicated pages (/features, /live, /manifesto).
//  This page's job is to get you interested enough to click one of them.
//  ══════════════════════════════════════════════════════════════════

const BILL_BASE =
  "https://cdn.prod.website-files.com/6864e9aed9e0a3fac7810db8/686b7511a47aef2bb401430f_Obverse_of_the_series_2009_%24100_Federal_Reserve_Note%201.webp";
const BILL_REVEAL =
  "https://cdn.prod.website-files.com/6864e9aed9e0a3fac7810db8/69087b27ac99aa214e875a63_Frame%202147258940.avif";

function Hero() {
  return (
    <section className="ll-hero">
      <p className="ll-eyebrow">Your salary is your business. Not the blockchain's.</p>
      <DecodeWord />
      <p className="ll-subline">
        Every transaction amount is invisible on-chain. Social context stays
        public for accountability. Financial details stay private for safety.
      </p>
      <div className="ll-hero-ctas">
        <Link to="/app" className="ll-btn ll-btn--hero ll-btn--ink">
          Launch Blank <ArrowRight size={17} strokeWidth={2.2} />
        </Link>
        <Link to="/live" className="ll-btn ll-btn--hero ll-btn--ghost">
          See it live
        </Link>
      </div>

      <XRaySlider
        baseSrc={BILL_BASE}
        baseAlt="A standard US hundred dollar bill — public money, fully visible"
        revealSrc={BILL_REVEAL}
        revealAlt="The same bill rendered as FHE ciphertext — what the blockchain sees"
      />
    </section>
  );
}

function Problem() {
  const stats = [
    {
      num: "$900M+",
      label:
        "extracted from users by MEV sandwich bots in 2023 — they exploit visible swap amounts",
    },
    {
      num: "272K",
      label:
        "home addresses leaked from hardware-wallet breaches, enabling physical attacks on holders",
    },
    {
      num: "0",
      label:
        "enterprises deployed treasuries onchain because competitors can map their supply chains",
    },
  ];
  return (
    <section className="ll-section" id="problem">
      <div className="ll-section-kicker">The cost of public money</div>
      <h2 className="ll-section-title">
        Every transaction you make is a postcard. Anyone can read it.
      </h2>
      <p className="ll-section-lead">
        Public blockchains made trustlessness possible and transparency the
        default. That default has a cost — and the cost is piling up.
      </p>
      <div className="ll-stats-grid">
        {stats.map((s) => (
          <div key={s.num} className="ll-stat">
            <div className="ll-stat-number">{s.num}</div>
            <div className="ll-stat-label">{s.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function HowItWorks() {
  const steps = [
    {
      n: "01",
      title: "Shield",
      body: "Deposit USDC into your encrypted vault. Public tokens become encrypted eUSDC — balances stored as ciphertext on-chain.",
    },
    {
      n: "02",
      title: "Send",
      body: "Pay anyone. The recipient, timestamp, and memo stay visible. The amount becomes a cipher handle that only sender and receiver can decrypt.",
    },
    {
      n: "03",
      title: "Receive",
      body: "Payments arrive in seconds. Unshield back to public USDC anytime, or keep spending privately across every feature in the app.",
    },
  ];
  return (
    <section className="ll-section" id="how">
      <div className="ll-section-kicker">How it works</div>
      <h2 className="ll-section-title">
        Shield. Send. Decrypt. Three steps, one private payment.
      </h2>
      <p className="ll-section-lead">
        Under the surface there's Fully Homomorphic Encryption, zero-knowledge
        proofs, and a threshold network. You don't think about any of it.
      </p>
      <div className="ll-steps">
        {steps.map((s) => (
          <div key={s.n} className="ll-step">
            <div className="ll-step-num">{s.n}</div>
            <div className="ll-step-title">{s.title}</div>
            <div className="ll-step-body">{s.body}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

// Short "explore more" block that replaces the in-page feature grid + tech
// sections. Each card links to a dedicated page so the topic gets the room
// it deserves instead of competing for hero attention.
function ExploreLinks() {
  const links = [
    {
      kicker: "Twelve tools",
      title: "Every way to pay privately",
      body: "Send, split, tip, invoice, payroll, escrow, stealth, gift, inherit, swap. Twelve product surfaces, one encrypted vault.",
      to: "/features",
      cta: "See all features",
    },
    {
      kicker: "Live",
      title: "The real transaction feed",
      body: "Public transactions with their amounts sealed. Updates in realtime. Verifiable on Etherscan. Impossible to fake.",
      to: "/live",
      cta: "Open the ticker",
    },
    {
      kicker: "Manifesto",
      title: "Why this has to exist",
      body: "$900M in MEV, 272K leaked addresses, enterprises that won't come on-chain. The case for private-by-default, in plain English.",
      to: "/manifesto",
      cta: "Read the manifesto",
    },
  ];
  return (
    <section className="ll-section">
      <div className="ll-section-kicker">Dig deeper</div>
      <h2 className="ll-section-title">Three more places to look.</h2>
      <div className="ll-steps">
        {links.map((l) => (
          <Link
            key={l.to}
            to={l.to}
            className="ll-step"
            style={{ textDecoration: "none", display: "block" }}
          >
            <div
              className="ll-step-num"
              style={{
                background: "var(--ll-surface)",
                color: "var(--ll-accent-dark)",
                fontSize: "0.7rem",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                width: "auto",
                height: "auto",
                padding: "0.45rem 0.8rem",
                borderRadius: "6px",
                fontWeight: 700,
              }}
            >
              {l.kicker}
            </div>
            <div className="ll-step-title">{l.title}</div>
            <div className="ll-step-body">{l.body}</div>
            <div
              style={{
                marginTop: "1.25rem",
                display: "inline-flex",
                alignItems: "center",
                gap: "0.4rem",
                color: "var(--ll-ink-2)",
                fontWeight: 600,
                fontSize: "0.95rem",
              }}
            >
              {l.cta}{" "}
              <ArrowRight size={15} strokeWidth={2.3} />
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="ll-cta">
      <h2 className="ll-cta-title">
        Your money is nobody else's business.
      </h2>
      <p className="ll-cta-sub">
        Launch Blank. Mint some test USDC. Shield it. Send a private payment
        in under a minute.
      </p>
      <Link to="/app" className="ll-btn ll-btn--hero ll-btn--ink">
        Launch Blank <ArrowRight size={17} strokeWidth={2.2} />
      </Link>
    </section>
  );
}

export default function Landing() {
  return (
    <div className="blank-landing">
      <LandingNav />
      <main>
        <Hero />
        <LiveDemo />
        <Problem />
        <HowItWorks />
        <ExploreLinks />
        <CTA />
      </main>
      <LandingFooter />
    </div>
  );
}
