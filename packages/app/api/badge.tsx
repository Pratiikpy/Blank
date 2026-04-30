/**
 * /api/badge?for=<identifier>
 *
 * Server-rendered "Pay me on Blank" PNG used as the inline image in email
 * signatures, social bios, embed widgets, etc. The identifier is whatever
 * the recipient wants the badge to point at — usually their ENS name (best
 * branding) or a 0x address.
 *
 * The badge links to /pay/<identifier> on the same origin, so users put it
 * inside an `<a href>` wrapper:
 *
 *   <a href="https://blank.app/pay/pratik.eth">
 *     <img src="https://blank.app/api/badge?for=pratik.eth" width="240" />
 *   </a>
 *
 * We use a query-string identifier (rather than a path segment) because the
 * local dev API plugin doesn't support `[param]`-style dynamic routes —
 * static path + query is the lowest-friction shape that works in both dev
 * and Vercel production.
 *
 * Cache: 1h public, 24h SWR. The badge is deterministic for an identifier
 * so this is safe; users can purge by appending `?v=<n>` to bust caches.
 */

import { ImageResponse } from "@vercel/og";

const WIDTH = 480;
const HEIGHT = 120;
const ALLOWED = /[^a-zA-Z0-9.\-_]/g;

function sanitize(input: string | undefined): string {
  if (!input) return "Blank";
  // Allow only chars that appear in addresses / ENS names / Basenames —
  // alphanumerics, dot, hyphen, underscore. Everything else (including
  // whitespace and HTML special chars) is stripped. Cap length so a 200KB
  // identifier can't blow up the renderer.
  const cleaned = input.replace(ALLOWED, "").slice(0, 64);
  return cleaned || "Blank";
}

export default async function handler(req: any, res: any) {
  // Support `?for=` and `?to=` for convenience.
  const url = new URL(req.url ?? "/", "http://x");
  const identifier = sanitize(url.searchParams.get("for") ?? url.searchParams.get("to") ?? "");

  const image = new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          padding: "0 32px",
          background: "#1D1D1F",
          color: "white",
          fontFamily: "Inter, system-ui, sans-serif",
        }}
      >
        {/* "$" glyph in an emerald circle — avoids needing an SVG font load. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 48,
            height: 48,
            borderRadius: 24,
            background: "#10B981",
            marginRight: 20,
            fontSize: 28,
          }}
        >
          {"$"}
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span style={{ fontSize: 16, opacity: 0.7, letterSpacing: 1.2, textTransform: "uppercase" }}>
            Pay me on Blank
          </span>
          <span style={{ fontSize: 28, fontWeight: 600, marginTop: 4, letterSpacing: -0.4 }}>
            {identifier}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "10px 18px",
            borderRadius: 12,
            background: "white",
            color: "#1D1D1F",
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          Pay
        </div>
      </div>
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      headers: {
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    },
  );

  // Convert the Web Response to a Node-style write so this works in both
  // Vercel Node Functions and our vite-plugin-api dev shim. Edge Functions
  // would let us return the Response directly, but Node handlers need to
  // pipe the bytes to `res` themselves.
  const buffer = Buffer.from(await image.arrayBuffer());
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  res.status(200);
  res.end(buffer);
}
