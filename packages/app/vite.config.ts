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
        manualChunks: {
          // Core React
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          // Wagmi + Viem (blockchain)
          "vendor-web3": ["wagmi", "viem", "@tanstack/react-query"],
          // Framer Motion (animations)
          "vendor-motion": ["framer-motion"],
          // Three.js (3D effects - lazy loaded anyway)
          "vendor-three": ["three", "@react-three/fiber", "@react-three/drei"],
          // Recharts (charts)
          "vendor-charts": ["recharts"],
          // Date utilities
          "vendor-date": ["date-fns"],
          // Cofhe SDK
          "vendor-cofhe": ["@cofhe/sdk", "@cofhe/react"],
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
