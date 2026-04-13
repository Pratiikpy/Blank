import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import "./landing.css";
import "./how-it-works.css";

// ══════════════════════════════════════════════════════════════════
//  HowItWorks — the "cannot exist without FHE" page.
//  One table, one job: convince a skeptical reader Blank isn't a
//  standard dApp with a marketing veneer.
//  ══════════════════════════════════════════════════════════════════

type Row = {
  feature: string;
  without: string;
  with: string;
};

const ROWS: Row[] = [
  {
    feature: "Encrypted send",
    without: "Amount visible to MEV bots — sandwich-able before landing.",
    with: "Ciphertext only. Bots see a meaningless 32-byte handle.",
  },
  {
    feature: "Encrypted payroll",
    without: "Every employee can see every other employee's paycheck.",
    with: "Employer sees total; each employee sees only their own line.",
  },
  {
    feature: "Salary / balance proof",
    without: "Reveal your full statement to rent a flat.",
    with: "Return an ebool — 'income ≥ $X' — without revealing $X.",
  },
  {
    feature: "Group expense splits",
    without: "'Alice owes Bob $80' is public to the whole group.",
    with: "Only debtor and creditor can decrypt the amount.",
  },
  {
    feature: "Gift envelopes",
    without: "Recipients see each other's share sizes in a batch transfer.",
    with: "Each recipient sees only their own share.",
  },
  {
    feature: "Stealth + encrypted",
    without: "Address linkage across sends reveals your counterparty graph.",
    with: "Addresses unlinkable AND amounts encrypted.",
  },
];

export default function HowItWorks() {
  return (
    <div className="blank-landing">
      <LandingNav />
      <main>
        <section className="ll-page-hero">
          <div className="ll-section-kicker">How Blank works</div>
          <h1 className="ll-section-title">
            Features that cannot exist without FHE.
          </h1>
          <p className="ll-section-lead">
            Every feature below is either impossible or trivially broken on a
            regular blockchain. Fully Homomorphic Encryption is not a polish
            layer — it's what makes each of these work at all.
          </p>
        </section>

        <section className="ll-section hiw-section">
          <div className="hiw-table" role="table" aria-label="FHE comparison">
            <div className="hiw-row hiw-header" role="row">
              <div role="columnheader">Feature</div>
              <div role="columnheader">Without FHE</div>
              <div role="columnheader">With FHE (Blank)</div>
            </div>
            {ROWS.map((r) => (
              <div className="hiw-row" role="row" key={r.feature}>
                <div className="hiw-feature" role="cell">{r.feature}</div>
                <div className="hiw-without" role="cell">{r.without}</div>
                <div className="hiw-with" role="cell">{r.with}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="ll-section hiw-callout">
          <p className="hiw-callout-lead">
            If you can imagine a standard contract doing the "without" column,
            you're imagining a contract that leaks every amount it touches.
            That's the default web3 ships with. Blank ships the other column.
          </p>
          <div className="ll-hero-ctas">
            <Link to="/app" className="ll-btn ll-btn--hero ll-btn--ink">
              Try it now <ArrowRight size={17} strokeWidth={2.2} />
            </Link>
            <Link to="/features" className="ll-btn ll-btn--hero ll-btn--ghost">
              See every feature
            </Link>
          </div>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
