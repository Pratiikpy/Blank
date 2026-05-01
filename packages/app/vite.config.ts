import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import path from "path";
import { apiRoutesPlugin } from "./vite-plugin-api";

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait(), apiRoutesPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@cofhe/react": path.resolve(__dirname, "./src/lib/cofhe-shim.ts"),
    },
  },
  server: {
    port: 3000,
    fs: {
      // Allow access to the monorepo root (one level above packages/app)
      // AND the user's home node_modules where pnpm symlinks live.
      // Without this, Vite returns "403 Restricted" HTML when tfhe tries
      // to fetch its WASM from .pnpm/tfhe@x.y.z/node_modules/tfhe/.
      allow: ["..", "../..", path.resolve(__dirname, "..", "..")],
      strict: false,
    },
    headers: {
      // Required for TFHE WASM SharedArrayBuffer
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Cross-Origin-Opener-Policy": "same-origin",
    },
  },
  esbuild: {
    drop: ["debugger"],
  },
  build: {
    outDir: "dist",
    target: "esnext",
    chunkSizeWarningLimit: 800,
    // Manual chunking removed.
    //
    // Why: splitting React + web3 (wagmi/viem/react-query) into separate
    // chunks repeatedly produced "Cannot access 'X' before initialization"
    // TDZ errors in production. The web3 stack imports React internals at
    // module scope; whichever chunk loaded second would attempt to read a
    // symbol from the other chunk before its module body finished
    // initialising, freezing the app on a white screen.
    //
    // Vite's default chunking (one chunk per entry + one chunk per
    // dynamic-import boundary) is robust against this — it lets Rollup
    // figure out a safe topological order rather than fighting it.
    //
    // Trade-off: the main bundle is bigger than the hand-tuned split, but
    // it works. Re-introducing chunk splits should only happen if we
    // verify production load on Vercel after each change — local
    // `pnpm preview` does NOT reproduce this class of error reliably.
  },
  optimizeDeps: {
    exclude: ["tfhe"],
    // Scan lazy-loaded screens at startup so Vite discovers their deps
    // upfront. Without this, navigating to a lazy route makes Vite
    // discover a new dep mid-flight and bump the optimizer's ?v= hash —
    // any in-flight request for the OLD hash returns 504 Outdated Optimize
    // Dep. We only scan screens (not lib/hooks/everything) to avoid
    // pulling in worker files (e.g. @cofhe/sdk's zkProve.worker) that
    // the dep optimizer can't handle.
    entries: ["index.html", "src/blank-ui/screens/*.tsx"],
    include: [
      "date-fns",
      "date-fns/format",
      "date-fns/formatDistanceToNow",
      "date-fns/formatDistanceToNowStrict",
      "date-fns/parseISO",
    ],
    esbuildOptions: {
      target: "esnext",
    },
  },
  assetsInclude: ["**/*.wasm"],
  define: {
    global: "globalThis",
  },
  worker: {
    format: "es",
  },
});
