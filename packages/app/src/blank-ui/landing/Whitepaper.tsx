import { ArrowDownToLine, ExternalLink } from "lucide-react";
import { LandingFooter } from "./LandingFooter";
import { LandingNav } from "./LandingNav";

export default function Whitepaper() {
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

          <div
            style={{
              border: "1px solid rgba(0,0,0,0.08)",
              borderRadius: "1.5rem",
              overflow: "hidden",
              background: "#F5F5F7",
              minHeight: "78vh",
              boxShadow: "0 24px 80px rgba(0,0,0,0.08)",
            }}
          >
            <iframe
              title="Blank whitepaper PDF"
              src="/whitepaper.pdf"
              style={{
                width: "100%",
                height: "78vh",
                border: 0,
                display: "block",
              }}
            />
          </div>
        </div>
      </main>

      <LandingFooter />
    </div>
  );
}
