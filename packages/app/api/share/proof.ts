/**
 * /api/share/proof — single static serverless function that fans out to
 * the per-kind OG handlers in _lib. One function, two surfaces, so the
 * resource-link previews don't push the deploy over the 12-function cap
 * (#380).
 *
 * Why a static route (not api/share/[kind].ts):
 *   A dynamic [kind] route is resolved AFTER vercel.json `rewrites`, so
 *   the catch-all `/(.*) -> /index.html` shadows it and the function is
 *   never reached (verified live: /api/share/<dynamic> returned the SPA
 *   shell). Static API files are matched in the filesystem phase, before
 *   rewrites — the same reason /api/health and the original proof route
 *   always worked. So both surfaces ride this one static path:
 *
 *     /v/:proofId            -> /api/share/proof              (kind=proof)
 *     /pay /claim /shop      -> /api/share/proof?kind=link&...(kind=link)
 *     /fund /conditional-invoice
 *
 * Vercel injects the destination query onto req.query; we read ?kind to
 * pick the handler and fall back to the proof handler (the original
 * behaviour) when it is absent.
 */

import proofHandler from "../_lib/share-proof.js";
import linkHandler from "../_lib/share-link.js";

export default async function handler(req: any, res: any) {
  const url = new URL(req.url ?? "/", "http://x");
  const kind = req.query?.kind ?? url.searchParams.get("kind");
  if (kind === "link") return linkHandler(req, res);
  return proofHandler(req, res);
}
