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
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Cofhe runtime. MUI / Emotion were dropped in the P3 cleanup —
          // they were unused in src/, and the previous group existed only
          // to avoid an isValidElementType error from a half-imported MUI.
          if (id.includes("@cofhe/")) {
            return "vendor-cofhe";
          }
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/") || id.includes("react-router-dom") || id.includes("react-is")) {
            return "vendor-react";
          }
          if (id.includes("viem") || id.includes("@tanstack/react-query")) {
            return "vendor-viem";
          }
          if (id.includes("wagmi") || id.includes("@wagmi/") || id.includes("@walletconnect/") || id.includes("@coinbase/")) {
            return "vendor-wallet";
          }
          if (id.includes("lucide-react")) {
            return "vendor-icons";
          }
          if (id.includes("framer-motion")) {
            return "vendor-motion";
          }
          if (id.includes("recharts")) {
            return "vendor-charts";
          }
          if (id.includes("date-fns")) {
            return "vendor-date";
          }
        },
      },
    },
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
