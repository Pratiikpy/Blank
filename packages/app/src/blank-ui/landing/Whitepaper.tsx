import { useEffect } from "react";
import { ArrowDownToLine, ExternalLink } from "lucide-react";
import { LandingFooter } from "./LandingFooter";
import { LandingNav } from "./LandingNav";
import "./landing.css";

export default function Whitepaper() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Blank Whitepaper";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <div className="blank-landing">
      <LandingNav />

      <main className="ll-section" style={{ paddingTop: "7.5rem" }}>
        <div className="ll-container">
          <div className="ll-section-head" style={{ marginBottom: "2rem" }}>
            <p className="ll-kicker">Whitepaper</p>
            <h1>Blank: Private Amount Payments on Ethereum</h1>
            <p>
              A concise product paper covering Blank's privacy model,
              CoFHE architecture, product surface, security posture, and
              public testnet scope.
            </p>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.75rem",
              marginBottom: "1.25rem",
            }}
          >
            <a className="ll-btn ll-btn--ink" href="/whitepaper.pdf">
              Open PDF <ExternalLink size={16} strokeWidth={2.2} />
            </a>
            <a className="ll-btn" href="/whitepaper.pdf" download>
              Download <ArrowDownToLine size={16} strokeWidth={2.2} />
            </a>
          </div>

          <div className="ll-stats-grid" style={{ alignItems: "stretch", marginTop: "2rem" }}>
            {[
              {
                title: "Privacy model",
                body: "Sender and receiver stay public. Amounts, balances, bids, payroll values, contributions, and thresholds are encrypted.",
              },
              {
                title: "Architecture",
                body: "Browser encryption, Fhenix CoFHE verification, ciphertext state, permit-based decryption, and chain-authoritative settlement.",
              },
              {
                title: "Product surface",
                body: "Send, invoices, requests, payroll, gifts, groups, proofs, claim links, storefront, crowdfund, escrow, swap, bridge, P2P exchange, and P2P offramp.",
              },
            ].map((item) => (
              <div key={item.title} className="ll-stat" style={{ textAlign: "left" }}>
                <div
                  style={{
                    fontSize: "1.2rem",
                    fontWeight: 700,
                    color: "var(--ll-ink-1)",
                    marginBottom: "0.6rem",
                  }}
                >
                  {item.title}
                </div>
                <div className="ll-stat-label">{item.body}</div>
              </div>
            ))}
          </div>

          <div className="ll-step" style={{ textAlign: "left", marginTop: "1rem" }}>
            <div className="ll-step-title">Public testnet scope</div>
            <div className="ll-step-body">
              Live on Base Sepolia and Ethereum Sepolia. Standard EVM wallets
              are supported on both chains; Blank passkey smart accounts are
              available when sponsorship is available. Mobile UI is live across
              the route map, with expanded mobile transaction coverage next.
            </div>
          </div>

          <div className="ll-step" style={{ textAlign: "left", marginTop: "1rem" }}>
            <div className="ll-step-title">Testnet demo controls</div>
            <div className="ll-step-body">
              Wave 5 P2P offramp and recovery contracts are live on both
              testnets. Offramp disputes currently use a deployer-operated
              arbiter and Reclaim proof checks use an operator-signed mock
              verifier so the demo can run while provider approvals are still
              pending. Those are testnet controls. Mainnet requires a 3-of-5
              Safe arbiter, live Reclaim provider IDs, third-party contract
              audit, and a decentralized threshold operator set.
            </div>
          </div>
        </div>
      </main>

      <LandingFooter />
    </div>
  );
}
