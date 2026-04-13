import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import "./landing.css";

// ══════════════════════════════════════════════════════════════════
//  Manifesto — personal-voice positioning page
//  Long-form reading experience. Typographic discipline above all else.
//  ══════════════════════════════════════════════════════════════════

export default function Manifesto() {
  return (
    <div className="blank-landing">
      <LandingNav />
      <main>
        <section className="ll-page-hero">
          <div className="ll-section-kicker">Manifesto</div>
          <h1 className="ll-section-title">
            Your money is nobody else's business.
          </h1>
        </section>

        <article className="ll-manifesto">
          <p className="ll-intro">
            Every payment you've ever made on a public blockchain has been a
            postcard. Your rent. Your salary. Your donation to that cause you
            don't talk about at dinner. Visible to anyone who knows how to
            read an address.
          </p>

          <p>
            I spent months building a payment app where that's not true
            anymore. This isn't a feature. It's a correction.
          </p>

          <h2>The bill is coming due for public money</h2>

          <p>
            When I started Blank, I thought on-chain privacy was a
            nice-to-have — something enterprise might care about eventually.
            Then I looked at what transparency had actually cost in 2023 alone:
          </p>

          <ul>
            <li>
              <strong>$900M+</strong> extracted by MEV sandwich bots who could
              read every swap amount before the transaction landed
            </li>
            <li>
              <strong>272,000</strong> home addresses leaked from a single
              hardware-wallet breach — used to physically target holders
            </li>
            <li>
              <strong>Zero</strong> enterprise treasuries on-chain, because a
              public ledger is a map of your supply chain
            </li>
            <li>
              Every DAO contributor's salary, visible to every governance
              token holder forever
            </li>
          </ul>

          <p>
            Public money has a cost. We just weren't counting it.
          </p>

          <hr />

          <h2>FHE isn't a buzzword</h2>

          <p>
            Blank is built on Fhenix CoFHE — Fully Homomorphic Encryption.
            Smart contracts that compute on encrypted data without ever
            decrypting it.
          </p>

          <p>
            What that means in practice: your balance is a number the
            blockchain literally cannot read. Your send amount is a cipher.
            Addition happens on ciphertexts. Comparisons happen on
            ciphertexts. Access control is enforced on ciphertexts.
          </p>

          <p>
            Only two people can ever decrypt your balance: you, and whoever
            you explicitly give a permit to. The contract doesn't qualify.
            Neither does the indexer. Neither does the person running the
            node.
          </p>

          <hr />

          <h2>Private payments aren't a feature</h2>

          <p>
            I built twelve features in Blank — P2P send, requests, group
            bills, creator tips, invoicing, batch payroll, escrow with
            arbiter, stealth transfers, gift envelopes, inheritance, atomic
            swaps, and a privacy router for existing DEXs.
          </p>

          <p>
            Because private payments aren't just a P2P transfer. It's the
            full surface area of what a person or a business does with money.
            If any one of those surfaces leaks the amount, the privacy claim
            collapses everywhere else.
          </p>

          <p>
            So all twelve had to exist. All twelve had to share one encrypted
            vault. All twelve had to use the same access-control primitive so
            permits compose. That was the hard part — not the cryptography.
            The system design.
          </p>

          <hr />

          <h2>What's next</h2>

          <p>
            Mainnet, when Fhenix's infrastructure is ready. Multi-token
            vaults for ETH, DAI, USDT. Real-time balance decryption gated by
            biometric permits. Cross-chain encrypted transfers via bridge
            adapters.
          </p>

          <p>
            And audit permits — so regulators and auditors can verify
            compliance without ever seeing individual amounts. Selective
            disclosure as a first-class primitive, not a workaround.
          </p>

          <p>
            The next generation of financial apps won't be
            transparent-by-default with a privacy mode bolted on. They'll be
            private-by-default with transparency opt-in, selective, and
            provable. Blank is my attempt at proving that's not only
            possible — it's shippable today.
          </p>

          <p className="ll-signature">— Pratik, the builder</p>

          <div className="ll-manifesto-ctas">
            <Link to="/app" className="ll-btn ll-btn--hero ll-btn--ink">
              Launch Blank <ArrowRight size={17} strokeWidth={2.2} />
            </Link>
            <Link to="/live" className="ll-btn ll-btn--hero ll-btn--ghost">
              See it live
            </Link>
          </div>
        </article>
      </main>
      <LandingFooter />
    </div>
  );
}
