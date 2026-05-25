import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import fs from "node:fs";
import path from "path";
import { apiRoutesPlugin } from "./vite-plugin-api";

interface RouteShell {
  file: string;
  title: string;
  description: string;
  canonical: string;
}

const ROUTE_SHELLS: RouteShell[] = [
  {
    file: "app",
    title: "Blank App | Private Amount Payments",
    description: "Send and receive private amount payments on supported Ethereum testnets.",
    canonical: "https://app.myblank.app",
  },
  {
    file: "features",
    title: "Features | Blank",
    description: "Private payment, commerce, proof and exchange surfaces on Blank testnet.",
    canonical: "https://www.myblank.app/features",
  },
  {
    file: "how-it-works",
    title: "How Blank Works | Fhenix CoFHE Payments",
    description: "How Blank keeps payment amounts encrypted while transactions settle on public chains.",
    canonical: "https://www.myblank.app/how-it-works",
  },
  {
    file: "roadmap",
    title: "Roadmap | Blank",
    description: "What Blank has shipped on testnet and what remains gated before mainnet.",
    canonical: "https://www.myblank.app/roadmap",
  },
  {
    file: "live",
    title: "Live Activity | Blank",
    description: "Public testnet activity for Blank with encrypted payment amounts and explorer-linked settlement.",
    canonical: "https://www.myblank.app/live",
  },
  {
    file: "manifesto",
    title: "Manifesto | Blank",
    description: "Why public settlement should not require permanently public payment amounts.",
    canonical: "https://www.myblank.app/manifesto",
  },
  {
    file: "pricing",
    title: "Pricing | Blank",
    description: "Testnet access and intended pricing direction for private amount payments on Blank.",
    canonical: "https://www.myblank.app/pricing",
  },
  {
    file: "for-individuals",
    title: "Blank For Individuals | Private Payments",
    description: "Private amount payments for everyday transfers and shared expenses.",
    canonical: "https://www.myblank.app/for/individuals",
  },
  {
    file: "for-creators",
    title: "Blank For Creators | Private Payments",
    description: "Private tips, storefront payments and supporter flows for creators.",
    canonical: "https://www.myblank.app/for/creators",
  },
  {
    file: "for-businesses",
    title: "Blank For Businesses | Private Payments",
    description: "Private invoice, payroll and vendor payment workflows for businesses.",
    canonical: "https://www.myblank.app/for/businesses",
  },
  {
    file: "for-daos",
    title: "Blank For DAOs | Private Payments",
    description: "Private contributor payments and treasury workflows for on-chain organizations.",
    canonical: "https://www.myblank.app/for/daos",
  },
  {
    file: "status",
    title: "Blank Status | Testnet Health",
    description: "Live health for Blank on Base Sepolia and Ethereum Sepolia.",
    canonical: "https://www.myblank.app/status",
  },
  {
    file: "whitepaper",
    title: "Blank Whitepaper | Private Amount Payments",
    description: "Blank's privacy model, CoFHE architecture, product surface and testnet security boundary.",
    canonical: "https://docs.myblank.app/whitepaper",
  },
  {
    file: "brand-kit",
    title: "Blank Brand Kit",
    description: "The identity system and public brand assets for Blank.",
    canonical: "https://brand.myblank.app/brand-kit",
  },
  {
    file: "blog",
    title: "Blank Blog | Private Payments and FHE",
    description: "Technical writing and product decisions behind confidential payments built with Fhenix CoFHE.",
    canonical: "https://blog.myblank.app/blog",
  },
  {
    file: "blog-why-fhenix-cofhe",
    title: "Why Blank Chose Fhenix CoFHE Over FHE L1s | Blank",
    description: "Why Blank uses the Fhenix CoFHE co-processor model for private amount payments on Ethereum.",
    canonical: "https://blog.myblank.app/blog/why-fhenix-cofhe",
  },
  {
    file: "blog-fhe-vs-zk",
    title: "FHE And Zero-Knowledge For Private Payments | Blank",
    description: "Why computation on encrypted payment values requires a different primitive from proving statements.",
    canonical: "https://blog.myblank.app/blog/fhe-vs-zk",
  },
  {
    file: "blog-wave-3-shipped",
    title: "Wave 3 Shipped | Blank",
    description: "Workspace modes, private invoice escrow and proof-of-payment features shipped on Blank testnet.",
    canonical: "https://blog.myblank.app/blog/wave-3-shipped",
  },
  {
    file: "blog-why-no-token-ever",
    title: "Why Blank Has No Token | Blank",
    description: "Why Blank is building private payment infrastructure without issuing a token.",
    canonical: "https://blog.myblank.app/blog/why-no-token-ever",
  },
];

function routeMetadataShells(): Plugin {
  return {
    name: "route-metadata-shells",
    apply: "build",
    closeBundle() {
      const dist = path.resolve(__dirname, "dist");
      const base = fs.readFileSync(path.join(dist, "index.html"), "utf8");
      const shellDir = path.join(dist, "route-shells");
      fs.mkdirSync(shellDir, { recursive: true });

      for (const shell of ROUTE_SHELLS) {
        const html = base
          .replace(/<title>[^<]*<\/title>/, `<title>${shell.title}</title>`)
          .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${shell.description}" />`)
          .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${shell.title}" />`)
          .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${shell.description}" />`)
          .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${shell.canonical}" />`)
          .replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${shell.canonical}" />`)
          .replace(/<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${shell.title}" />`)
          .replace(/<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${shell.description}" />`);
        fs.writeFileSync(path.join(shellDir, `${shell.file}.html`), html);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait(), apiRoutesPlugin(), routeMetadataShells()],
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
