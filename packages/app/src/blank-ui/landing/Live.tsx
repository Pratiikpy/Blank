import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ExternalLink } from "lucide-react";
import { LandingNav } from "./LandingNav";
import { LandingFooter } from "./LandingFooter";
import { useLiveActivities, type LiveActivity } from "@/hooks/useLiveActivities";
import { getExplorerTxUrl } from "@/lib/constants";
import "./landing.css";

// ══════════════════════════════════════════════════════════════════
//  Live — public transaction ticker
//  Pulls from Supabase (activities table) + realtime INSERT subscription.
//  Every amount is shown as ████.██ — they're encrypted on-chain anyway,
//  but the placeholder makes the privacy claim visible to visitors.
//  ══════════════════════════════════════════════════════════════════

function shortAddr(a: string): string {
  if (!a || a.length < 10) return a || "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function humanType(activityType: string): string {
  // Normalize activity type strings from the DB into ticker-friendly labels
  const t = (activityType || "").toLowerCase();
  if (t.includes("shield"))     return "Shield";
  if (t.includes("unshield"))   return "Unshield";
  if (t.includes("payment"))    return "Payment";
  if (t.includes("request"))    return "Request";
  if (t.includes("tip"))        return "Tip";
  if (t.includes("group"))      return "Group";
  if (t.includes("gift"))       return "Gift";
  if (t.includes("stealth"))    return "Stealth";
  if (t.includes("invoice"))    return "Invoice";
  if (t.includes("payroll"))    return "Payroll";
  if (t.includes("escrow"))     return "Escrow";
  if (t.includes("swap"))       return "Swap";
  return activityType || "Tx";
}

function timeAgo(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const sec = Math.max(0, Math.floor((now - then) / 1000));
  if (sec < 5)    return "just now";
  if (sec < 60)   return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60)   return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)    return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7)      return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Single row
function Row({ a, now }: { a: LiveActivity; now: number }) {
  return (
    <div className={`ll-live-row${a.isNew ? " new" : ""}`}>
      <div className="ll-live-time">{timeAgo(a.created_at, now)}</div>
      <div>
        <div className="ll-live-route">
          <span className="ll-live-addr">{shortAddr(a.user_from)}</span>
          <span className="ll-live-arrow">→</span>
          <span className="ll-live-addr">{shortAddr(a.user_to)}</span>
          <span className="ll-live-type">{humanType(a.activity_type)}</span>
          <span className="ll-live-amount">████.██</span>
        </div>
        {a.note && a.note.trim() !== "" && (
          <div className="ll-live-note">"{a.note}"</div>
        )}
      </div>
      {a.tx_hash && (
        <a
          href={getExplorerTxUrl(a.tx_hash, a.chain_id)}
          target="_blank"
          rel="noopener noreferrer"
          className="ll-live-link"
          aria-label="View transaction on block explorer"
          title={a.tx_hash}
        >
          <ExternalLink size={15} strokeWidth={2} />
        </a>
      )}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────

export default function Live() {
  const { activities, isLoading, error, supabaseConfigured } = useLiveActivities(50);

  // Re-render the "time ago" column every 15s so rows update without a fetch.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="blank-landing">
      <LandingNav />
      <main>
        <section className="ll-page-hero">
          <div className="ll-section-kicker">Live</div>
          <h1 className="ll-section-title">
            Real transactions. Sealed amounts. Nothing to fake here.
          </h1>
          <p className="ll-section-lead">
            Every payment on Blank is recorded here the moment it's
            confirmed on-chain. Addresses are public — Ethereum works that
            way. The amounts are encrypted. You're looking at the actual
            ledger, minus the privacy violation.
          </p>
        </section>

        <div className="ll-live">
          <div className="ll-live-status">
            <span className="ll-live-dot" />
            {supabaseConfigured
              ? "Streaming from Base Sepolia & Ethereum Sepolia"
              : "Supabase not configured — showing empty state"}
          </div>

          {isLoading && (
            <div className="ll-live-list">
              <div className="ll-live-empty">Loading recent activity…</div>
            </div>
          )}

          {!isLoading && error && (
            <div className="ll-live-list">
              <div className="ll-live-empty">
                Couldn't load activity — {error}
              </div>
            </div>
          )}

          {!isLoading && !error && activities.length === 0 && (
            <div className="ll-live-list">
              <div className="ll-live-empty">
                No transactions yet.{" "}
                <Link to="/app" style={{ color: "var(--ll-accent-dark)", fontWeight: 600 }}>
                  Be the first
                </Link>
                .
              </div>
            </div>
          )}

          {!isLoading && !error && activities.length > 0 && (
            <div className="ll-live-list">
              {activities.map((a) => (
                <Row key={a.id} a={a} now={now} />
              ))}
            </div>
          )}
        </div>

        <section className="ll-cta">
          <h2 className="ll-cta-title">Add yours to the feed.</h2>
          <p className="ll-cta-sub">
            Launch the app, shield a bit of USDC, and send your first
            encrypted payment. You'll see it appear here.
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
