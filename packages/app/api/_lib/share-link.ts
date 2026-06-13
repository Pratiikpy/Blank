/**
 * Resource-link OG handler — dispatched by api/share/[kind].ts for
 * kind=link. Lives in _lib so it is NOT counted as its own serverless
 * function (the project caps at 12; see #380).
 *
 * Crawler-friendly HTML wrapper for Blank's shareable resource links:
 * conditional invoices, payment links, claim links, storefronts and
 * crowdfunds. These are the links a user pastes to a counterparty, so
 * the unfurl (Slack / Discord / Twitter / iMessage) should describe the
 * resource, not show the generic site card.
 *
 * Why this exists:
 *   The SPA routes (/conditional-invoice/:chainId/:escrowId, /pay/:id,
 *   /claim/:chainId/:linkId, /shop/:chainId/:listingId,
 *   /fund/:chainId/:campaignId) are rendered client-side by React, so a
 *   crawler that doesn't run JS sees an empty index.html shell and
 *   unfurls the site-wide card. Per-resource previews need server-rendered
 *   meta tags whose values resolve without JS — that's this handler.
 *
 * No redirect loop:
 *   vercel.json rewrites the real routes here ONLY when the `app` query
 *   param is absent. This handler bounces real browsers to the same
 *   route with `?app=1`, which skips the rewrite and falls through to the
 *   SPA. Crawlers parse the meta tags and never follow the refresh.
 *
 * No chain read:
 *   v1 renders a per-resource-type card (distinct title + description per
 *   type), not per-instance detail. Amounts are encrypted anyway, so the
 *   card never claims a value. This keeps the handler dependency-free and
 *   failure-free: a previewer always gets a correct, on-brand card.
 *
 * Cache: 5 minutes public + 1 day SWR — same shape as the proof handler.
 */

// Site URL for absolute meta-tag URLs. og:image must be absolute or
// Twitter Cards rejects it. Mirrors the proof handler's resolution order:
// VERCEL_URL (set on every Vercel deploy) -> PUBLIC_APP_URL -> inbound host
// header. Fails loud rather than emit a broken og:image URL.
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

const GENERIC: Copy = {
  title: "Blank | Private Amount Payments",
  description: "Private amount payments on Ethereum testnets, built with Fhenix CoFHE. Sender and recipient stay public; the amount stays encrypted.",
};

// Per-resource-type copy. Distinct title + description per type so a
// pasted link unfurls as the right thing, not the site default.
const COPY: Record<string, Copy> = {
  "conditional-invoice": {
    title: "Conditional invoice on Blank",
    description: "An encrypted-amount invoice held in escrow. It releases on payer approval or after a deadline. The amount stays private on-chain.",
  },
  pay: {
    title: "Get paid privately on Blank",
    description: "A Blank payment link. Sender and recipient stay public; the amount you pay stays encrypted on-chain.",
  },
  claim: {
    title: "You have an encrypted payment to claim on Blank",
    description: "A Blank claim link. Claim the funds with a wallet. The amount stays private on-chain.",
  },
  shop: {
    title: "A private storefront on Blank",
    description: "Buy on Blank. The price and your payment amount stay encrypted on-chain; only the lifecycle state is public.",
  },
  fund: {
    title: "Back an encrypted crowdfund on Blank",
    description: "Contribute to a Blank campaign. Your contribution amount stays private; the goal and progress run in FHE.",
  },
};

const SEGMENT = /^[A-Za-z0-9._-]+$/;

// Build the canonical SPA path for a resource. Returns null for anything
// that doesn't validate, so a malformed link degrades to the generic card
// + a bounce to "/" instead of emitting a junk path.
function resourcePath(type: string, chainId: string | null, id: string | null): string | null {
  if (!id || !SEGMENT.test(id)) return null;
  if (type === "pay") {
    return `/pay/${id}`;
  }
  if (!chainId || !/^[0-9]+$/.test(chainId)) return null;
  return `/${type}/${chainId}/${id}`;
}

export default async function linkHandler(req: any, res: any) {
  const url = new URL(req.url ?? "/", "http://x");
  const type = url.searchParams.get("type") ?? "";
  const chainId = url.searchParams.get("chainId");
  const id = url.searchParams.get("id");

  const origin = siteOrigin(req);
  // Only emit a per-type card when the resource path validates. A known
  // type with a missing/garbage id degrades fully to the generic card +
  // a bounce to "/", rather than claiming a resource we couldn't resolve.
  const cleanPath = COPY[type] ? resourcePath(type, chainId, id) : null;
  const copy = cleanPath ? COPY[type] : GENERIC;

  // Canonical = the clean resource URL (no ?app). Redirect target = the
  // same path with ?app=1 so the rewrite is skipped and the SPA renders.
  const canonicalUrl = `${origin}${cleanPath ?? "/"}`;
  const redirectPath = cleanPath ? `${cleanPath}?app=1` : "/";
  const ogImageUrl = `${origin}/og/blank-og.png`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(copy.title)}</title>
<meta name="description" content="${escapeHtml(copy.description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${escapeHtml(copy.title)}">
<meta property="og:description" content="${escapeHtml(copy.description)}">
<meta property="og:image" content="${escapeHtml(ogImageUrl)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${escapeHtml(canonicalUrl)}">
<meta property="og:site_name" content="Blank">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(copy.title)}">
<meta name="twitter:description" content="${escapeHtml(copy.description)}">
<meta name="twitter:image" content="${escapeHtml(ogImageUrl)}">
<link rel="canonical" href="${escapeHtml(canonicalUrl)}">
<meta http-equiv="refresh" content="0; url=${escapeHtml(redirectPath)}">
</head>
<body style="font-family:system-ui,sans-serif;background:#0F172A;color:#fff;padding:48px;">
<p>Redirecting to <a style="color:#10B981" href="${escapeHtml(redirectPath)}">${escapeHtml(copy.title)}</a>…</p>
<script>window.location.replace(${JSON.stringify(redirectPath)});</script>
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
