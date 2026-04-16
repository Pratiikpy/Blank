import type { Plugin } from "vite";
import { loadEnv } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import { readdirSync, existsSync, readFileSync } from "fs";
import { resolve, relative, join } from "path";

/**
 * Dev-only Vite plugin that serves the Vercel-style API routes under `api/`
 * via Vite's middleware. In production these run on Vercel's serverless
 * runtime; locally we mount them on /api/* so Playwright can exercise the
 * full stack (including /api/relay) without requiring `vercel dev`.
 *
 * Conventions:
 *   - Each `.ts` file under `./api/` exports a default handler(req, res)
 *     with the Vercel Edge/Node shape.
 *   - Nested folders map to URL paths: api/agent/derive.ts → /api/agent/derive
 *   - Files named `_lib/*` are shared helpers, never mounted.
 *
 * The plugin uses Vite's ssrLoadModule so the handlers benefit from HMR
 * and TypeScript compilation on demand (no separate build step).
 */
export function apiRoutesPlugin(apiDir = "api"): Plugin {
  const apiRoot = resolve(apiDir);

  function collectRoutes(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith("_")) continue; // skip _lib etc.
        out.push(...collectRoutes(fullPath));
      } else if (entry.isFile() && /\.(ts|mjs|js)$/.test(entry.name)) {
        out.push(fullPath);
      }
    }
    return out;
  }

  return {
    name: "vite-plugin-api",
    apply: "serve",
    configureServer(server) {
      // Inject non-VITE_ env vars (RELAYER_PRIVATE_KEY, SEPOLIA_RPC_URL,
      // SUPABASE_SERVICE_ROLE_KEY, etc.) into process.env so API handlers
      // can read them via `process.env.XXX`. Vite's client-side env
      // loader only exposes VITE_* vars to import.meta.env — serverless
      // code needs process.env populated separately.
      try {
        const cwd = process.cwd();
        const all = loadEnv("development", cwd, "");
        for (const [k, v] of Object.entries(all)) {
          if (k.startsWith("VITE_")) continue; // already handled by Vite
          if (process.env[k] === undefined) process.env[k] = v;
        }
        // loadEnv ignores .env.local in some configs; load it explicitly.
        const localPath = join(cwd, ".env.local");
        if (existsSync(localPath)) {
          for (const line of readFileSync(localPath, "utf8").split("\n")) {
            const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
            if (m && process.env[m[1]] === undefined) {
              process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
            }
          }
        }
      } catch (err) {
        console.warn("[vite-plugin-api] env load failed:", err);
      }

      const routes = collectRoutes(apiRoot);
      // Map URL path → filesystem path
      const routeMap = new Map<string, string>();
      for (const file of routes) {
        const rel = relative(apiRoot, file).replace(/\\/g, "/").replace(/\.(ts|mjs|js)$/, "");
        const urlPath = `/api/${rel}`;
        routeMap.set(urlPath, file);
      }
      console.log(
        `[vite-plugin-api] registered ${routeMap.size} route(s):`,
        [...routeMap.keys()].sort().join(", "),
      );

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next) => {
        const url = req.url?.split("?")[0];
        if (!url || !url.startsWith("/api/")) return next();

        const filePath = routeMap.get(url);
        if (!filePath) return next();

        try {
          // Parse JSON body so handlers get req.body
          let body: unknown = undefined;
          if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
            }
            const raw = Buffer.concat(chunks).toString("utf8");
            if (raw.length > 0) {
              try { body = JSON.parse(raw); } catch { body = raw; }
            }
          }
          (req as any).body = body;

          // Dynamic import through Vite's SSR loader so the handler gets
          // full TS + env-var access. Pass the raw absolute path — NOT a
          // pathToFileURL result, which percent-encodes spaces in
          // directory names ("fhenix builder" → "fhenix%20builder") and
          // then breaks Vite's resolver on Windows.
          const mod = await server.ssrLoadModule(filePath);
          const handler = (mod as any).default;
          if (typeof handler !== "function") {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: `no default export in ${filePath}` }));
            return;
          }

          // Wrap res to give it the Vercel-shape .json() / .status()
          const vercelRes = res as unknown as {
            status(code: number): typeof vercelRes;
            json(body: unknown): void;
            setHeader(name: string, value: string): void;
          };
          (res as any).status = function (code: number) { this.statusCode = code; return vercelRes; };
          (res as any).json = function (body: unknown) {
            const json = JSON.stringify(body);
            if (this.statusCode >= 400) {
              console.log(`[api-error-body ${url} status=${this.statusCode}]`, json.slice(0, 1500));
            }
            if (!this.headersSent) this.setHeader("Content-Type", "application/json");
            this.end(json);
          };

          console.log(`[api] -> ${req.method} ${url}${body ? ` (body=${JSON.stringify(body).length}B)` : ""}`);
          if (url === "/api/relay" && body) {
            console.log("  RELAY-BODY:", JSON.stringify(body).slice(0, 3000));
          }
          await handler(req, res);
          console.log(`[api] <- ${url} status=${res.statusCode}`);
        } catch (err) {
          console.error(`[vite-plugin-api] ${url} threw:`, err instanceof Error ? err.stack || err.message : err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
        }
      });
    },
  };
}
