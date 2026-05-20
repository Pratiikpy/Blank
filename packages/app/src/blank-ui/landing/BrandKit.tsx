import { useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Circle,
  Download,
  KeyRound,
  Lock,
  MinusCircle,
  Receipt,
  Send,
  Shield,
  X,
} from "lucide-react";
import { BlankLogo } from "./BlankLogo";
import { LandingFooter } from "./LandingFooter";
import { LandingNav } from "./LandingNav";
import "./landing.css";
import "./brand-kit.css";

const MARK_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512" aria-label="Blank mark">
  <rect x="8" y="4" width="14" height="54" rx="1.5" fill="#0A0A0A"/>
  <circle cx="36" cy="41" r="17" fill="#0A0A0A"/>
</svg>
`;

const TOKENS_CSS = `:root {
  --ink: #0A0A0A;
  --stone: #1D1D1F;
  --graphite: #6B7280;
  --fog: #9CA3AF;
  --line: #E5E7EB;
  --veil: #F8FAFC;
  --halo: #FAFAF7;
  --paper: #FFFFFF;
  --cipher: #059669;
  --cipher-soft: #E7F6EF;
  --redline: #C2410C;
  --sans: "Outfit", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --r-sm: 8px;
  --r-md: 12px;
  --r-lg: 20px;
}
`;

const TOKENS_JSON = JSON.stringify(
  {
    color: {
      ink: "#0A0A0A",
      stone: "#1D1D1F",
      graphite: "#6B7280",
      fog: "#9CA3AF",
      line: "#E5E7EB",
      veil: "#F8FAFC",
      halo: "#FAFAF7",
      paper: "#FFFFFF",
      cipher: "#059669",
      cipherSoft: "#E7F6EF",
      redline: "#C2410C",
    },
    typography: {
      sans: "Outfit",
      mono: "JetBrains Mono",
    },
    radius: { sm: 8, md: 12, lg: 20 },
  },
  null,
  2,
);

const markHref = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(MARK_SVG)}`;
const tokensCssHref = `data:text/css;charset=utf-8,${encodeURIComponent(TOKENS_CSS)}`;
const tokensJsonHref = `data:application/json;charset=utf-8,${encodeURIComponent(TOKENS_JSON)}`;

const colors = [
  { role: "Core", name: "Ink", hex: "#0A0A0A", use: "Type, primary CTAs, mark", dark: true },
  { role: "Core", name: "Stone", hex: "#1D1D1F", use: "Hover states, deep ground", dark: true },
  { role: "Accent", name: "Cipher", hex: "#059669", use: "Proof, live, verified", dark: true },
  { role: "Signal", name: "Redline", hex: "#C2410C", use: "Risk and errors", dark: true },
  { role: "Surface", name: "Paper", hex: "#FFFFFF", use: "Default surface" },
  { role: "Surface", name: "Halo", hex: "#FAFAF7", use: "Warm surface" },
  { role: "Surface", name: "Veil", hex: "#F8FAFC", use: "Cards and fields" },
  { role: "Line", name: "Line", hex: "#E5E7EB", use: "Borders" },
  { role: "Neutral", name: "Fog", hex: "#9CA3AF", use: "Muted UI" },
  { role: "Neutral", name: "Graphite", hex: "#6B7280", use: "Secondary text", dark: true },
];

const typeScale = [
  { label: "Display", spec: "88 / 84 · 600", sample: "Private by design." },
  { label: "H1", spec: "56 / 58 · 600", sample: "Send a private invoice. Get paid privately." },
  { label: "H2", spec: "40 / 44 · 600", sample: "Not a roadmap. Working software." },
  { label: "H3", spec: "24 / 29 · 600", sample: "Shielded amounts, public receipts." },
  {
    label: "Body",
    spec: "18 / 28 · 400",
    sample: "Encrypted invoices. Trustless escrow with on-chain proof. Built on FHE. What stays private is the amount, not the math.",
  },
  { label: "Kicker", spec: "13 / 20 · 600", sample: "PROOF OF PRODUCT" },
  { label: "Mono", spec: "13 / 18 · 400", sample: "TX · 0x7e9a · CONFIRMED · BLOCK 8442901" },
];

const iconTiles = [
  { name: "Mark", icon: <BlankLogo variant="mark" size={72} /> },
  { name: "Lock", icon: <Lock size={72} strokeWidth={1.9} /> },
  { name: "Key", icon: <KeyRound size={72} strokeWidth={1.9} /> },
  { name: "Shield", icon: <Shield size={72} strokeWidth={1.9} /> },
  { name: "Echo", icon: <Circle size={72} strokeWidth={1.9} /> },
  { name: "Send", icon: <Send size={72} strokeWidth={1.9} /> },
  { name: "Receipt", icon: <Receipt size={72} strokeWidth={1.9} /> },
  { name: "Stamp", icon: <MinusCircle size={72} strokeWidth={1.9} /> },
];

function DownloadLink({
  href,
  download,
  children,
}: {
  href: string;
  download: string;
  children: ReactNode;
}) {
  return (
    <a className="bk-download" href={href} download={download}>
      <Download size={13} strokeWidth={2.2} />
      {children}
    </a>
  );
}

function Section({
  number,
  label,
  title,
  lead,
  children,
}: {
  number: string;
  label: string;
  title: string;
  lead: string;
  children: ReactNode;
}) {
  return (
    <section className="bk-section">
      <div className="bk-section-meta">{number} / {label}</div>
      <div className="bk-section-body">
        <h2>{title}</h2>
        <p>{lead}</p>
        {children}
      </div>
    </section>
  );
}

function RedactedLine() {
  return (
    <span className="bk-redacted-line" aria-label="redacted text">
      <span />
      <span className="wide" />
      <span />
      <span className="wide" />
    </span>
  );
}

export default function BrandKit() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Blank Brand Kit";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <div className="blank-landing">
      <LandingNav />

      <main className="bk-page">
        <header className="bk-hero">
          <div className="bk-topline">
            <span><span className="bk-dot" /> Brand kit · V1.0</span>
            <span>2026 · Private by design</span>
          </div>
          <p className="bk-kicker">Blank / Identity system</p>
          <h1>
            The brand kit for <span>blank.</span>
          </h1>
          <p className="bk-hero-copy">
            An identity system for a privacy-first payments protocol. Wordmark, mark, palette,
            type, motif, voice, components, and downloadable base assets.
          </p>
          <div className="bk-hero-mark">
            <span>Blank /</span>
            <RedactedLine />
            <span>/ Encrypted by default</span>
          </div>
        </header>

        <Section
          number="01"
          label="Logo and mark"
          title="The mark is a vault. The wordmark is a sentence."
          lead="A solid bar plus a filled disc. It can read as a key, a column, or a vault door. The trailing period is part of the name."
        >
          <div className="bk-card bk-lockup-card">
            <DownloadLink href={markHref} download="blank-mark.svg">SVG</DownloadLink>
            <BlankLogo variant="lockup" size={60} wordmarkSize="4.25rem" />
            <div className="bk-card-caption">Primary lockup · mark + wordmark</div>
          </div>

          <div className="bk-logo-grid">
            <div className="bk-card bk-logo-tile">
              <DownloadLink href="/logo-png/favicon-512.png" download="blank-app-icon.png">PNG</DownloadLink>
              <BlankLogo variant="contained" size={88} />
              <p>Mark only · app icon</p>
            </div>
            <div className="bk-card bk-logo-tile dark">
              <DownloadLink href={markHref} download="blank-mark.svg">SVG</DownloadLink>
              <BlankLogo variant="lockup" size={42} wordmarkSize="2.2rem" />
              <p>Dark · reverse</p>
            </div>
            <div className="bk-card bk-logo-tile cipher">
              <DownloadLink href={markHref} download="blank-mark.svg">SVG</DownloadLink>
              <BlankLogo variant="lockup" size={42} wordmarkSize="2.2rem" />
              <p>Cipher · one color</p>
            </div>
          </div>

          <div className="bk-do-not">
            {[
              "Do not skew or rotate",
              "Do not recolor off-system",
              "Do not reset the typeface",
              "Do not capitalize Blank",
              "Do not drop the period",
              "No shadows, effects, or gradients",
            ].map((rule) => (
              <div className="bk-card bk-rule" key={rule}>
                <X size={16} strokeWidth={2.6} />
                <BlankLogo variant="wordmark" wordmarkSize="1.55rem" />
                <span>{rule}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          number="02"
          label="Color"
          title="Mostly nothing. A little ink. A whisper of green."
          lead="White space first. Near-black for structure. Cipher Green is reserved for proof, live state, and confirmation."
        >
          <div className="bk-ratio bk-card">
            <span>Paper / Veil · 60%</span>
            <span>Ink · 33%</span>
            <span>Cipher · 7%</span>
          </div>
          <div className="bk-color-grid">
            {colors.map((color) => (
              <div
                className={`bk-color-card${color.dark ? " dark" : ""}`}
                style={{ background: color.hex }}
                key={color.name}
              >
                <span>{color.role}</span>
                <strong>{color.name}</strong>
                <code>{color.hex}</code>
                <small>{color.use}</small>
              </div>
            ))}
          </div>
          <div className="bk-download-row">
            <DownloadLink href={tokensCssHref} download="blank-tokens.css">tokens.css</DownloadLink>
            <DownloadLink href={tokensJsonHref} download="blank-tokens.json">tokens.json</DownloadLink>
          </div>
        </Section>

        <Section
          number="03"
          label="Typography"
          title="One typeface. One mono. No exceptions."
          lead="Outfit carries the brand. JetBrains Mono handles labels, transaction IDs, proof states, and redacted treatments."
        >
          <div className="bk-type-family-grid">
            <div className="bk-card bk-type-card">
              <span>Primary · Sans</span>
              <strong>Outfit</strong>
              <p>300 Light · 400 Regular · 500 Medium · 600 SemiBold · 800 ExtraBold</p>
            </div>
            <div className="bk-card bk-type-card mono">
              <span>Support · Monospace</span>
              <strong>JetBrains Mono</strong>
              <p>400 Regular · 500 Medium · 600 SemiBold</p>
            </div>
          </div>
          <div className="bk-card bk-type-scale">
            {typeScale.map((item) => (
              <div className="bk-type-row" key={item.label}>
                <div>
                  <span>{item.label}</span>
                  <small>{item.spec}</small>
                </div>
                <p>{item.sample}</p>
              </div>
            ))}
          </div>
        </Section>

        <Section
          number="04"
          label="Motif"
          title="The redaction is the brand."
          lead="Parentheses frame what is private. Asterisks and black bars show confidentiality without making the interface noisy."
        >
          <div className="bk-motif-grid">
            <div className="bk-card bk-motif">
              <span>Parens + asterisk</span>
              <strong>(confide*tial)</strong>
              <small>Spacing: 0.04em · asterisk fill: Cipher</small>
            </div>
            <div className="bk-card bk-motif inverse">
              <span>Inverse</span>
              <strong>(shielded)</strong>
              <small>Use for heroes, social cards, and print</small>
            </div>
            <div className="bk-card bk-copy-redaction">
              <span>Redaction in copy</span>
              <p>
                paid <i /> USDC to <i className="wide" /> invoice <i /> confirmed block <i /> hash <i className="wide" />
              </p>
              <small>Keep bars rare. They are punctuation, not a pattern.</small>
            </div>
            <div className="bk-card bk-receipt">
              <span>blank. receipt</span>
              <strong>VERIFIED</strong>
              <dl>
                <dt>From</dt><dd>0x4f...b29c</dd>
                <dt>To</dt><dd>0x9c1a...aa07</dd>
                <dt>Amount</dt><dd>hidden</dd>
                <dt>Status</dt><dd>Settled</dd>
              </dl>
            </div>
          </div>
        </Section>

        <Section
          number="05"
          label="Components"
          title="A small kit. Every part earns its place."
          lead="Buttons, pills, stat cards, feature cards, and proof blocks. Corners are deliberate. Borders are sharp. Motion is short."
        >
          <div className="bk-card bk-components">
            <div className="bk-button-row">
              <Link to="/app" className="ll-btn ll-btn--ink">
                Launch Blank <ArrowRight size={15} strokeWidth={2.3} />
              </Link>
              <Link to="/live" className="ll-btn ll-btn--ghost">See it live</Link>
              <Link to="/manifesto" className="bk-text-link">Read manifesto</Link>
            </div>
            <div className="bk-pill-row">
              <span className="bk-pill live">Live</span>
              <span className="bk-pill">Open source</span>
              <span className="bk-pill danger">Without FHE</span>
            </div>
          </div>
          <div className="bk-stat-grid">
            <div className="bk-card bk-stat-sample">
              <strong>Live</strong>
              <p>Private amount payments with public receipts.</p>
            </div>
            <div className="bk-card bk-stat-sample">
              <strong>100%</strong>
              <p>On-chain settlement. No custodian.</p>
            </div>
            <div className="bk-card bk-stat-sample">
              <strong>0 bytes</strong>
              <p>Of amount data leaves the browser unencrypted.</p>
            </div>
          </div>
        </Section>

        <Section
          number="06"
          label="Voice and tone"
          title="Terse. Declarative. Slightly conspiratorial."
          lead="Blank sounds like someone leaving a note on a kitchen counter: short, specific, and confident that you can fill in the rest."
        >
          <div className="bk-voice-grid">
            <div className="bk-card bk-voice-card good">
              <span>Do write like this</span>
              <ul>
                <li>Your money is nobody else's business.</li>
                <li>Send a private invoice. Get paid privately.</li>
                <li>Public tx. Private amount. Verified by math.</li>
                <li>Encrypted by default. Decrypted only by you.</li>
              </ul>
            </div>
            <div className="bk-card bk-voice-card bad">
              <span>Do not write like this</span>
              <ul>
                <li>Revolutionizing finance for everyone.</li>
                <li>Advanced next-generation solution platform.</li>
                <li>Privacy reimagined for builders.</li>
                <li>Join the movement. Welcome to Blank 2.0.</li>
              </ul>
            </div>
          </div>
        </Section>

        <Section
          number="07"
          label="In the wild"
          title="One sample. The whole system at work."
          lead="A single hero composition that uses the mark, wordmark, kicker, redaction motif, parens, and ink-on-paper pairing together."
        >
          <div className="bk-sample-hero">
            <div>
              <span className="bk-pill live">Private by design</span>
              <h3>Your money is <em>nobody else's</em> business.</h3>
              <p>Encrypted invoices. Trustless escrow. On-chain proof, off-record amounts.</p>
              <Link to="/app" className="ll-btn ll-btn--ink">Launch Blank</Link>
            </div>
            <div className="bk-sample-brand">
              <BlankLogo variant="lockup" size={42} wordmarkSize="2.5rem" />
              <strong>(p*ivate)</strong>
            </div>
          </div>
        </Section>

        <Section
          number="08"
          label="Iconography"
          title="The mark, multiplied."
          lead="Solid fills, generous corners, and simple geometry keep the visual system useful at product scale."
        >
          <div className="bk-icon-grid">
            {iconTiles.map((tile) => (
              <div className="bk-card bk-icon-tile" key={tile.name}>
                {tile.icon}
                <span>{tile.name}</span>
              </div>
            ))}
          </div>
        </Section>

        <Section
          number="09"
          label="Social and stationery"
          title="Wherever the link is pasted, it looks like Blank."
          lead="Default link previews, profile images, banners, and simple cards should all use the same lockup, palette, and tone."
        >
          <div className="bk-social-stack">
            <div className="bk-social-card">
              <BlankLogo variant="lockup" size={38} wordmarkSize="2rem" />
              <h3>Your money is <span>nobody else's</span> business.</h3>
              <small>Private by design · encrypted by default</small>
            </div>
            <div className="bk-stationery-grid">
              <div className="bk-card bk-business-card">
                <BlankLogo variant="mark" size={42} />
                <div>
                  <strong>Blank</strong>
                  <span>Private amount payments</span>
                  <span>Encrypted by default</span>
                </div>
              </div>
              <div className="bk-card bk-business-card reverse">
                <BlankLogo variant="wordmark" wordmarkSize="2rem" />
                <span>Private by design</span>
                <span>Encrypted by default</span>
              </div>
            </div>
          </div>
        </Section>
      </main>

      <LandingFooter />
    </div>
  );
}
