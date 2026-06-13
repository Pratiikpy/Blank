/**
 * /api/share/:kind — single serverless function that fans out to the
 * per-kind OG handlers in _lib. One function, two surfaces, so the
 * resource-link previews don't push the deploy over the 12-function cap
 * (see #380).
 *
 *   kind=proof (default)  -> /v/:proofId unfurl + bounce to /verify/:id
 *   kind=link             -> /pay /claim /shop /fund /conditional-invoice
 *                            unfurl + bounce to the SPA route
 *
 * vercel.json rewrites resolve /api/share/proof and /api/share/link to
 * this dynamic route; Vercel injects the matched segment as req.query.kind.
 * Fall back to parsing the path so the function is correct even if the
 * query param is absent.
 */

import proofHandler from "../_lib/share-proof.js";
import linkHandler from "../_lib/share-link.js";

export default async function handler(req: any, res: any) {
  let kind: string | undefined = req.query?.kind;
  if (!kind) {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    kind = path.split("/").filter(Boolean).pop();
  }
  if (kind === "link") return linkHandler(req, res);
  return proofHandler(req, res);
}
