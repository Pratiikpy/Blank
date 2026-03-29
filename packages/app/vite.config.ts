import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import path from "path";

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    fs: {
      allow: [".."],
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
          // Keep cofhe + its MUI/emotion deps together with React to avoid isValidElementType error
          if (id.includes("@cofhe/") || id.includes("@mui/") || id.includes("@emotion/")) {
            return "vendor-cofhe";
          }
          if (id.includes("node_modules/react/") || id.includes("node_modules/react-dom/") || id.includes("react-router-dom") || id.includes("react-is")) {
            return "vendor-react";
          }
          if (id.includes("wagmi") || id.includes("viem") || id.includes("@tanstack/react-query")) {
            return "vendor-web3";
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
