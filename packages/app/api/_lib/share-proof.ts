/**
 * Proof-share OG handler — dispatched by api/share/[kind].ts for the
 * default (kind=proof) case. Lives in _lib so it is NOT counted as its
 * own serverless function (the project caps at 12; see #380).
 *
 * Crawler-friendly HTML wrapper for /verify/:proofId. Returns a small
 * HTML document with og:/twitter: meta tags pointing at /api/og/proof
 * for the per-proof preview image, plus a meta-refresh + JS redirect
 * that bounces real browsers to /verify/:proofId.
 *
 * Crawler vs. browser:
 *   - Crawlers parse the HTML, never follow the meta-refresh -> they see
 *     the per-proof title + description + og:image and never touch the
 *     SPA.
 *   - Browsers parse the meta-refresh / inline JS and immediately
 *     navigate to /verify/:proofId — the canonical app surface.
 *
 * URL shape:
 *   Pretty share form is /v/:proofId?chain=:chainId (rewritten by
 *   vercel.json to /api/share/proof). The Twitter/Slack share buttons
 *   build the /v/:id form.
 *
 * Cache: 5 minutes public + 1 day SWR — same as the OG image. Published
 * proofs are immutable; pending → published is monotonic.
 */

import {
  readProof,
  formatThresholdUSD,
  parseProofIdParam,
  parseChainIdParam,
  type ProofState,
} from "./proof-reader.js";

// Site URL for absolute meta-tag URLs. og:image must be absolute or
// Twitter Cards rejects it. VERCEL_URL is set on every deploy; fall
// back to PUBLIC_APP_URL, then the inbound request's headers. Fails loud
// rather than emit a broken og:image pointing at a nonexistent domain.
function siteOrigin(req: { headers?: Record<string, string | undefined> }): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  if (process.env.PUBLIC_APP_URL) return process.env.PUBLIC_APP_URL;
  const host = req.headers?.["x-forwarded-host"] || req.headers?.host;
  const proto = req.headers?.["x-forwarded-proto"] || "https";
  if (host) return `${proto}://${host}`;
  throw new Error("siteOrigin: no VERCEL_URL, PUBLIC_APP_URL, or host header — refusing to emit a broken og:image URL");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface Copy {
  title: string;
  description: string;
}

function buildCopy(proof: ProofState | null): Copy {
  if (!proof) {
    return {
      title: "Encrypted proof on Blank",
      description: "Encrypted income / balance proofs verified on-chain by Fhenix Threshold Network. Nobody learns the actual amount.",
    };
  }
  const kindLabel = proof.kind === "balance" ? "Balance" : "Income";
  const amount = formatThresholdUSD(proof.threshold);
  if (!proof.isReady) {
    return {
      title: `${kindLabel} ≥ ${amount}: Pending verification`,
      description: "Encrypted proof on Blank. Anyone can verify the verdict on-chain, without learning the actual amount.",
    };
  }
  if (proof.isTrue) {
    return {
      title: `Verified: ${kindLabel.toLowerCase()} ≥ ${amount}`,
      description: "Confirmed by Fhenix Threshold Network. The blockchain saw the comparison run inside FHE. Nobody saw the number.",
    };
  }
  return {
    title: `${kindLabel} < ${amount}`,
    description: "Disproven by Fhenix Threshold Network. No amount was leaked. Only the boolean answer.",
  };
}

export default async function proofHandler(req: any, res: any) {
  const url = new URL(req.url ?? "/", "http://x");
  const proofId = parseProofIdParam(url.searchParams.get("id"));
  const chainId = parseChainIdParam(url.searchParams.get("chain"));

  const proof = proofId !== null ? await readProof(chainId, proofId) : null;

  const origin = siteOrigin(req);
  const verifyPath = proofId !== null
    ? `/verify/${proofId.toString()}?chain=${chainId}`
    : "/";
  const verifyUrl = `${origin}${verifyPath}`;
  const ogImagePath = proofId !== null
    ? `/api/og/proof?id=${proofId.toString()}&chain=${chainId}`
    : "/api/og/proof";
  const ogImageUrl = `${origin}${ogImagePath}`;

  const { title, description } = buildCopy(proof);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:image" content="${escapeHtml(ogImageUrl)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${escapeHtml(verifyUrl)}">
<meta property="og:site_name" content="Blank">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<meta name="twitter:image" content="${escapeHtml(ogImageUrl)}">
<link rel="canonical" href="${escapeHtml(verifyUrl)}">
<meta http-equiv="refresh" content="0; url=${escapeHtml(verifyUrl)}">
</head>
<body style="font-family:system-ui,sans-serif;background:#0F172A;color:#fff;padding:48px;">
<p>Redirecting to <a style="color:#10B981" href="${escapeHtml(verifyUrl)}">${escapeHtml(verifyPath)}</a>…</p>
<script>window.location.replace(${JSON.stringify(verifyUrl)});</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    "public, max-age=300, stale-while-revalidate=86400",
  );
  res.status(200);
  res.end(html);
}
