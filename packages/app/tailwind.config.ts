import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  // Class-based dark mode so Tailwind's `dark:` variants align with the
  // CSS-variable-driven `.dark` class in theme.css. Without this, Tailwind
  // defaults to `media` (OS `prefers-color-scheme`), which desyncs from the
  // in-app toggle — users with OS in dark mode would see dark modals
  // overlaid on a light app because only Tailwind `dark:` classes fired.
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // ─── Background Layers — deeper, richer blacks ──────────────
        void: {
          DEFAULT: "#000000",
          base: "#030303",
          surface: "#080808",
          elevated: "#0c0c0e",
          inset: "#050507",
        },

        // ─── Glass — barely-there, premium feel ─────────────────────
        glass: {
          surface: "rgba(255, 255, 255, 0.05)",
          hover: "rgba(255, 255, 255, 0.08)",
          active: "rgba(255, 255, 255, 0.10)",
          strong: "rgba(255, 255, 255, 0.12)",
          border: "rgba(255, 255, 255, 0.08)",
          "border-subtle": "rgba(255, 255, 255, 0.03)",
          "border-hover": "rgba(255, 255, 255, 0.16)",
          "border-accent": "rgba(52, 211, 153, 0.15)",
        },

        // ─── Text — high contrast on deep black ────────────────────
        text: {
          primary: "#f4f4f5",
          secondary: "#a1a1aa",
          tertiary: "#71717a",
          muted: "#52525b",
          inverse: "#050505",
        },

        // ─── Accent — Emerald ───────────────────────────────────────
        accent: {
          DEFAULT: "#34d399",
          light: "#6ee7b7",
          dark: "#10b981",
          glow: "rgba(52, 211, 153, 0.12)",
          "glow-strong": "rgba(52, 211, 153, 0.25)",
          50: "#ecfdf5", 100: "#d1fae5", 200: "#a7f3d0",
          300: "#6ee7b7", 400: "#34d399", 500: "#10b981",
          600: "#059669", 700: "#047857", 800: "#065f46",
          900: "#064e3b", 950: "#022c22",
        },

        // ─── Encrypted — Violet ─────────────────────────────────────
        encrypted: {
          DEFAULT: "#a78bfa",
          300: "#c4b5fd", 400: "#a78bfa", 500: "#8b5cf6", 600: "#7c3aed",
          glow: "rgba(167, 139, 250, 0.12)",
          "glow-strong": "rgba(167, 139, 250, 0.2)",
        },

        // ─── Status ─────────────────────────────────────────────────
        success: { DEFAULT: "#34d399", light: "#6ee7b7", dark: "#10b981" },
        error:   { DEFAULT: "#f87171", light: "#fca5a5", dark: "#ef4444" },
        warning: { DEFAULT: "#fbbf24", light: "#fde68a", dark: "#f59e0b" },
        info:    { DEFAULT: "#60a5fa", light: "#93c5fd", dark: "#3b82f6" },

        // ─── Apple HIG System Colors (for in-app experience) ─────
        apple: {
          black: "#000000",
          gray6: "#1C1C1E",      // Cards, containers
          gray5: "#2C2C2E",      // Elevated surfaces, hover states
          gray4: "#3A3A3C",      // Active/pressed states
          gray3: "#48484A",      // Borders, separators (visible)
          label: "#F5F5F7",      // Primary text (Apple's exact off-white)
          secondary: "#86868B",  // Secondary text
          tertiary: "#636366",   // Tertiary text
          separator: "rgba(255, 255, 255, 0.05)", // Subtle dividers
          blue: "#0A84FF",       // Links, active states
          green: "#34C759",      // Success, shielded
          red: "#FF453A",        // Error, destructive
          orange: "#FF9F0A",     // Warning
          purple: "#BF5AF2",     // Encrypted/violet indicator
        },
      },

      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
        display: ["Space Grotesk", "Inter", "sans-serif"],
      },

      fontSize: {
        // ─── Display — massive, editorial ─────────────────────────
        "display-hero": ["5rem",    { lineHeight: "0.95", letterSpacing: "-0.04em", fontWeight: "700" }],
        "display-xl":   ["4rem",    { lineHeight: "0.98", letterSpacing: "-0.035em", fontWeight: "700" }],
        "display":      ["2.75rem", { lineHeight: "1.05", letterSpacing: "-0.03em", fontWeight: "700" }],
        "display-lg":   ["4rem",    { lineHeight: "0.98", letterSpacing: "-0.035em", fontWeight: "700" }],

        // ─── Headings ─────────────────────────────────────────────
        "heading-1":  ["2rem",    { lineHeight: "1.1",  letterSpacing: "-0.025em" }],
        "heading-2":  ["1.5rem",  { lineHeight: "1.15", letterSpacing: "-0.02em" }],
        "heading-3":  ["1.125rem",{ lineHeight: "1.25", letterSpacing: "-0.01em" }],
        "heading":    ["1.75rem", { lineHeight: "1.15", letterSpacing: "-0.02em" }],
        "subheading": ["1.125rem",{ lineHeight: "1.3",  letterSpacing: "-0.01em" }],

        // ─── Body ─────────────────────────────────────────────────
        "body-lg": ["1rem",     { lineHeight: "1.65" }],
        "body":    ["0.875rem", { lineHeight: "1.6" }],
        "body-sm": ["0.8125rem",{ lineHeight: "1.5", letterSpacing: "0.005em" }],

        // ─── Small ────────────────────────────────────────────────
        "caption": ["0.75rem",  { lineHeight: "1.5", letterSpacing: "0.02em" }],
        "label":   ["0.625rem", { lineHeight: "1.4", letterSpacing: "0.16em" }],

        // ─── Mono ─────────────────────────────────────────────────
        "mono-hero":    ["3.5rem", { lineHeight: "1.0", letterSpacing: "-0.02em" }],
        "mono-display": ["2.5rem", { lineHeight: "1.0", letterSpacing: "-0.02em" }],
        "mono-amount":  ["1.25rem",{ lineHeight: "1.0", letterSpacing: "-0.01em" }],
        "mono-small":   ["0.8125rem",{ lineHeight: "1.4" }],

        // ─── Stats — inspired by the 22% / 35% cards ─────────────
        "stat-hero": ["4.5rem", { lineHeight: "0.9", letterSpacing: "-0.04em", fontWeight: "700" }],
        "stat-lg":   ["3rem",   { lineHeight: "0.95", letterSpacing: "-0.03em", fontWeight: "700" }],
        "stat-md":   ["2rem",   { lineHeight: "1.0",  letterSpacing: "-0.02em", fontWeight: "600" }],
      },

      letterSpacing: {
        "ultra-wide": "0.2em",
        "mega-wide":  "0.35em",
      },

      borderRadius: {
        "2xl": "1rem",
        "3xl": "1.5rem",
        "4xl": "2rem",
        "apple": "2rem",        // 32px — iOS widget radius
        "apple-lg": "2.5rem",   // 40px — iOS hero card radius
      },

      backdropBlur: {
        "2xl": "40px",
        "3xl": "64px",
      },

      boxShadow: {
        glass:         "0 4px 12px rgba(0,0,0,0.8), 0 20px 50px -12px rgba(0,0,0,0.5)",
        "glass-hover": "0 4px 16px rgba(0,0,0,0.8), 0 25px 60px -12px rgba(0,0,0,0.6)",
        "glass-lg":    "0 4px 16px rgba(0,0,0,0.8), 0 30px 70px -15px rgba(0,0,0,0.7)",
        "accent-glow":    "0 0 30px rgba(52, 211, 153, 0.12), 0 0 60px rgba(52, 211, 153, 0.06)",
        "accent-glow-lg": "0 0 40px rgba(52, 211, 153, 0.2), 0 0 80px rgba(52, 211, 153, 0.1)",
        "accent-ring":    "0 0 0 1px rgba(52, 211, 153, 0.2), 0 4px 20px rgba(52, 211, 153, 0.1)",
        "encrypted-glow":    "0 0 30px rgba(167, 139, 250, 0.1), 0 0 60px rgba(167, 139, 250, 0.05)",
        "encrypted-glow-lg": "0 0 40px rgba(167, 139, 250, 0.18), 0 0 80px rgba(167, 139, 250, 0.08)",
      },

      animation: {
        "shimmer":          "shimmer 2.5s ease-in-out infinite",
        "glow-pulse":       "glow-pulse 3s ease-in-out infinite",
        "glow-breathe":     "glow-breathe 5s ease-in-out infinite",
        "float":            "float 8s ease-in-out infinite",
        "float-slow":       "float-slow 12s ease-in-out infinite",
        "fade-in":          "fade-in 0.6s ease-out",
        "slide-up":         "slide-up 0.6s ease-out",
        "encrypt-scramble": "encrypt-scramble 0.3s steps(8)",
        "spin-slow":        "spin 30s linear infinite",
        "spin-reverse":     "spin 22s linear infinite reverse",
        "encrypted-shimmer":"encrypted-shimmer 6s cubic-bezier(0.37, 0, 0.63, 1) infinite",
      },

      keyframes: {
        shimmer: {
          "0%":   { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(100%)" },
        },
        "glow-pulse": {
          "0%, 100%": { boxShadow: "0 0 30px rgba(52, 211, 153, 0.08)" },
          "50%":      { boxShadow: "0 0 50px rgba(52, 211, 153, 0.2)" },
        },
        "glow-breathe": {
          "0%, 100%": { opacity: "0.3", transform: "scale(1)" },
          "50%":      { opacity: "0.6", transform: "scale(1.03)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%":      { transform: "translateY(-12px)" },
        },
        "float-slow": {
          "0%, 100%": { transform: "translateY(0) translateX(0)" },
          "33%":      { transform: "translateY(-18px) translateX(10px)" },
          "66%":      { transform: "translateY(6px) translateX(-6px)" },
        },
        "fade-in": {
          "0%":   { opacity: "0" },
          "100%": { opacity: "1" },
        },
        "slide-up": {
          "0%":   { opacity: "0", transform: "translateY(16px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "encrypt-scramble": {
          "0%":   { opacity: "0.3" },
          "50%":  { opacity: "0.7" },
          "100%": { opacity: "1" },
        },
        "encrypted-shimmer": {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%":      { backgroundPosition: "100% 50%" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
