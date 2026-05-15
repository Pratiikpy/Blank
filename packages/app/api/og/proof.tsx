/**
 * /api/og/proof?id=<proofId>&chain=<chainId>
 *
 * Dynamic Open Graph image for an encrypted income/balance proof. Read
 * the proof state from PaymentReceipts.getProof on chain, render a
 * 1200x630 PNG suitable for Twitter / Slack / Discord link previews.
 *
 * Three visual states map to the contract's (isReady, isTrue) tuple:
 *   • not-ready → "Pending verification" (clock + amber)
 *   • ready && isTrue → "Verified ✓ Income ≥ $X" (check + emerald)
 *   • ready && !isTrue → "Not verified ✗ Income < $X" (x + rose)
 *
 * Why this exists alongside /verify/:proofId (the SPA route): Twitter
 * and Slack crawlers don't execute JS, so they fall back to the static
 * <meta og:image> in index.html which is generic. Sharing a proof
 * should unfurl to a per-proof preview, not the generic site card.
 *
 * Cache: 5 minutes public + 1 day stale-while-revalidate. Published
 * proofs are immutable, so caching is safe; pending proofs flip once
 * to published and stay there, so worst case the SWR pulls the fresh
 * state on the next request.
 */

import { ImageResponse } from "@vercel/og";
import {
  readProof,
  formatThresholdUSD,
  shortAddr,
  parseProofIdParam,
  parseChainIdParam,
} from "../_lib/proof-reader.js";

const WIDTH = 1200;
const HEIGHT = 630;

export default async function handler(req: any, res: any) {
  const url = new URL(req.url ?? "/", "http://x");
  const proofId = parseProofIdParam(url.searchParams.get("id"));
  const chainId = parseChainIdParam(url.searchParams.get("chain"));

  const proof = proofId !== null ? await readProof(chainId, proofId) : null;

  // Three render variants depending on the (proof, isReady, isTrue)
  // trio. Done as flat conditionals so the JSX stays readable inside
  // satori's restricted CSS subset.
  const variant: "missing" | "pending" | "verified" | "false" =
    !proof
      ? "missing"
      : !proof.isReady
        ? "pending"
        : proof.isTrue
          ? "verified"
          : "false";

  const accent =
    variant === "verified"
      ? "#10B981" // emerald-500
      : variant === "false"
        ? "#F43F5E" // rose-500
        : variant === "pending"
          ? "#F59E0B" // amber-500
          : "#64748B"; // slate-500 (missing)

  const heading =
    variant === "verified"
      ? "Verified on-chain"
      : variant === "false"
        ? "Not verified"
        : variant === "pending"
          ? "Pending verification"
          : "Proof not found";

  const claimLine = proof
    ? `${proof.kind === "balance" ? "Balance" : "Income"} ≥ ${formatThresholdUSD(proof.threshold)}`
    : "Encrypted proof";

  const symbol = variant === "verified" ? "✓" : variant === "false" ? "✗" : variant === "pending" ? "⏳" : "?";

  const proverLine = proof ? `by ${shortAddr(proof.prover)}` : "";

  const image = new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#0F172A", // slate-900
          color: "white",
          fontFamily: "Inter, system-ui, sans-serif",
          padding: "64px",
        }}
      >
        {/* Top row: brand + verdict pill */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 56,
                height: 56,
                borderRadius: 28,
                background: "#10B981",
                fontSize: 30,
                fontWeight: 700,
              }}
            >
              $
            </div>
            <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: -0.5 }}>Blank</div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 24px",
              borderRadius: 999,
              background: `${accent}22`,
              border: `2px solid ${accent}`,
              color: accent,
              fontSize: 22,
              fontWeight: 600,
            }}
          >
            <span style={{ fontSize: 28 }}>{symbol}</span>
            {heading}
          </div>
        </div>

        {/* Spacer */}
        <div style={{ flex: 1, display: "flex" }} />

        {/* Headline: the encrypted claim */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ fontSize: 22, opacity: 0.6, letterSpacing: 1.5, textTransform: "uppercase" }}>
            Encrypted proof
          </div>
          <div
            style={{
              fontSize: 96,
              fontWeight: 700,
              letterSpacing: -2,
              lineHeight: 1.02,
            }}
          >
            {claimLine}
          </div>
          {proverLine && (
            <div style={{ fontSize: 24, opacity: 0.5, marginTop: 8, fontFamily: "Courier" }}>
              {proverLine}
            </div>
          )}
        </div>

        {/* Spacer */}
        <div style={{ flex: 1, display: "flex" }} />

        {/* Bottom row: tagline + verify-link hint */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            color: "#94A3B8",
            fontSize: 22,
          }}
        >
          <div style={{ display: "flex" }}>
            The blockchain saw the comparison run inside FHE. Nobody saw the number.
          </div>
          <div
            style={{
              display: "flex",
              padding: "10px 20px",
              borderRadius: 12,
              background: "white",
              color: "#0F172A",
              fontSize: 18,
              fontWeight: 600,
            }}
          >
            Verify on-chain →
          </div>
        </div>
      </div>
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
      },
    },
  );

  const buffer = Buffer.from(await image.arrayBuffer());
  res.setHeader("Content-Type", "image/png");
  res.setHeader(
    "Cache-Control",
    "public, max-age=300, stale-while-revalidate=86400",
  );
  res.status(200);
  res.end(buffer);
}
