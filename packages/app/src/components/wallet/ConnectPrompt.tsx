import { motion, AnimatePresence } from "framer-motion";
import { Shield, Lock, Eye, Key, Link2, ArrowRight } from "lucide-react";
import { useConnect } from "wagmi";
import { useState, useMemo, useCallback } from "react";
import { staggerContainer, fadeInUp } from "@/lib/animations";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { TiltCard } from "@/components/ui/TiltCard";
import { ParticleScene } from "@/components/three/ParticleScene";
import { EtherealBeams } from "@/components/three/EtherealBeams";
import FloatingLabels from "@/components/landing/FloatingLabels";
import { PrivacyMarquee } from "@/components/landing/PrivacyMarquee";
import HowItWorks from "@/components/landing/HowItWorks";
import ComparisonSection from "@/components/landing/ComparisonSection";
import { OrbitalDiagram } from "@/components/landing/OrbitalDiagram";
import CycleText from "@/components/landing/CycleText";
import { Footer } from "@/components/layout/Footer";
import { AnimatedCounter } from "@/components/common/AnimatedCounter";

// ─── Fake encryption for demo ────────────────────────────────────────
function fakeEncrypt(input: string): string {
  if (!input) return "";
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c * (i + 1);
    h2 = Math.imul(h2, 0x5bd1e995);
  }
  const a = (h1 >>> 0).toString(16).padStart(8, "0");
  const b = (h2 >>> 0).toString(16).padStart(8, "0");
  const c2 = ((h1 ^ h2) >>> 0).toString(16).padStart(8, "0");
  const d = (Math.imul(h1, h2) >>> 0).toString(16).padStart(8, "0");
  return `0x${a}${b}${c2}${d}`;
}

const springHover = { type: "spring" as const, stiffness: 400, damping: 15 };

// ─── Feature data ────────────────────────────────────────────────────
const features = [
  { icon: Lock, title: "FHE Encrypted", desc: "Every amount encrypted with Fully Homomorphic Encryption. Contracts compute on ciphertext." },
  { icon: Eye, title: "Social Context", desc: "Who paid whom, when, and why is public. Only amounts stay private." },
  { icon: Shield, title: "Self-Custody", desc: "Non-custodial. Your keys, your money. Permits control who sees your data." },
  { icon: Key, title: "Permit System", desc: "7-day expiry permits. Share selective access with auditors or lenders." },
  { icon: ArrowRight, title: "Batch Payments", desc: "Pay up to 30 recipients in a single encrypted transaction." },
  { icon: Link2, title: "Built on Base", desc: "Fast, cheap L2 transactions on Base Sepolia with Fhenix CoFHE coprocessor." },
];

// ═══════════════════════════════════════════════════════════════════════
//  8-SECTION NARRATIVE LANDING PAGE
// ═══════════════════════════════════════════════════════════════════════

export function ConnectPrompt() {
  const { connect, connectors, isPending } = useConnect();
  const [demoInput, setDemoInput] = useState("");

  const encryptedHex = useMemo(() => fakeEncrypt(demoInput), [demoInput]);
  const maskedAmount = demoInput ? "\u2588\u2588\u2588\u2588.\u2588\u2588" : "";

  const handleDemoInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      if (/^[0-9]*\.?[0-9]*$/.test(v) || v === "") setDemoInput(v);
    },
    [],
  );

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#000000]">
      {/* ─── Global background layers ──────────────────────────────── */}
      <ParticleScene />
      <EtherealBeams beamNumber={10} speed={1.8} lightColor="#34d399" rotation={40} noiseIntensity={1.2} />
      <div className="absolute inset-0 grid-pattern opacity-30 pointer-events-none" aria-hidden="true" />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `
            radial-gradient(ellipse 80% 50% at 50% 0%, rgba(52,211,153,0.05) 0%, transparent 60%),
            radial-gradient(ellipse 50% 40% at 80% 80%, rgba(139,92,246,0.03) 0%, transparent 50%),
            linear-gradient(180deg, #000000 0%, transparent 20%, transparent 80%, #000000 100%)
          `,
        }}
        aria-hidden="true"
      />

      {/* ─── SECTION 1: Nav ────────────────────────────────────────── */}
      <motion.nav
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-20 flex items-center justify-between px-6 sm:px-12 lg:px-20 py-6"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-white/[0.03] border border-white/[0.08] flex items-center justify-center group cursor-pointer">
            <Shield className="w-[18px] h-[18px] text-white/60 group-hover:rotate-12 transition-transform duration-500" strokeWidth={1.5} />
          </div>
          <span className="text-[13px] font-display font-medium text-white/80 tracking-[0.25em]">BLANK</span>
        </div>
        <div className="hidden sm:flex items-center gap-8">
          {["Features", "How It Works", "Privacy", "Launch App"].map((item) => (
            <span key={item} className="text-[12px] text-neutral-500 font-medium tracking-[0.14em] uppercase hover:text-neutral-400 transition-colors cursor-pointer">
              {item}
            </span>
          ))}
        </div>
      </motion.nav>

      {/* ─── SECTION 2: Hero ───────────────────────────────────────── */}
      <section className="relative z-10 flex flex-col items-center pt-16 sm:pt-24 lg:pt-32 pb-24 px-6">
        {/* Floating FHE labels around particle sphere */}
        <FloatingLabels className="absolute inset-0 opacity-50" />

        <motion.div
          initial={{ opacity: 0, y: 60, filter: "blur(12px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          className="text-center max-w-5xl mx-auto relative"
        >
          {/* Decorative crosshair */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3, duration: 0.8 }}
            className="flex items-center justify-center gap-2 mb-10"
          >
            <div className="w-3 h-3 border border-neutral-700 rounded-sm" />
            <div className="w-10 h-px bg-neutral-700" />
            <span className="text-[10px] text-neutral-600 tracking-[0.2em] uppercase font-display">Encrypted Finance</span>
            <div className="w-10 h-px bg-neutral-700" />
            <div className="w-3 h-3 border border-neutral-700 rounded-sm" />
          </motion.div>

          {/* Headline */}
          <h1 className="font-display font-black text-white leading-[0.92]">
            {/* Line 1: cycling verb + PRIVATELY */}
            <span className="flex items-baseline justify-center gap-[0.25em] text-[clamp(3.2rem,11vw,7.5rem)]">
              <span className="inline-block h-[1.05em] overflow-hidden">
                <CycleText
                  words={["SEND", "SPLIT", "INVOICE", "TIP", "PAY"]}
                  interval={2800}
                  className="text-accent"
                />
              </span>
              <span>PRIVATELY.</span>
            </span>
            {/* Line 2: ████████ AMOUNTS — animated emerald→violet shimmer */}
            <span className="block text-[clamp(3.2rem,11vw,7.5rem)] mt-1">
              <span
                className="inline-flex gap-[3px] tracking-[0.08em]"
                style={{
                  fontSize: "0.75em",
                }}
              >
                {Array.from({ length: 8 }).map((_, i) => (
                  <span
                    key={i}
                    className="inline-block w-[0.65em] h-[0.85em] rounded-[3px]"
                    style={{
                      background: `linear-gradient(135deg,
                        ${i < 4 ? '#34d399' : '#a78bfa'} 0%,
                        ${i < 4 ? '#a78bfa' : '#8b5cf6'} 100%)`,
                      opacity: 0.7 + (i * 0.04),
                      animation: `block-shimmer 2.5s ease-in-out infinite`,
                      animationDelay: `${i * 0.15}s`,
                    }}
                  />
                ))}
              </span>{" "}
              <span
                style={{
                  background: "linear-gradient(135deg, #ffffff 0%, #e4e4e7 60%, #a1a1aa 100%)",
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent",
                }}
              >
                AMOUNTS.
              </span>
            </span>
          </h1>

          {/* Curved SVG underline */}
          <svg className="w-[320px] h-[20px] mx-auto mt-4 opacity-30" viewBox="0 0 280 20" fill="none">
            <path d="M10 18 C70 2, 210 2, 270 18" stroke="url(#curve-grad)" strokeWidth="2.5" strokeLinecap="round" />
            <defs>
              <linearGradient id="curve-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="transparent" />
                <stop offset="30%" stopColor="#34d399" stopOpacity="0.5" />
                <stop offset="70%" stopColor="#a78bfa" stopOpacity="0.3" />
                <stop offset="100%" stopColor="transparent" />
              </linearGradient>
            </defs>
          </svg>

          {/* Subtitle */}
          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5, duration: 0.8 }}
            className="text-lg sm:text-xl text-neutral-400 mt-10 max-w-xl mx-auto leading-[1.65] font-light"
          >
            Everyone sees who paid whom. Nobody sees how much. That&rsquo;s{" "}
            <span className="text-white font-medium">Blank</span>.
          </motion.p>

          {/* CTA buttons */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7, duration: 0.6 }}
            className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-10"
          >
            {connectors.slice(0, 2).map((connector, idx) => (
              <motion.div
                key={connector.uid}
                whileHover={{ scale: 1.02, y: -2, transition: springHover }}
                whileTap={{ scale: 0.98, transition: springHover }}
              >
                <Button
                  variant={idx === 0 ? "primary" : "secondary"}
                  size="lg"
                  onClick={() => connect({ connector })}
                  loading={isPending}
                  icon={idx === 0 ? <ArrowRight className="w-4 h-4" /> : undefined}
                  className="min-w-[200px]"
                >
                  {idx === 0 ? "Launch App" : `Connect ${connector.name}`}
                </Button>
              </motion.div>
            ))}
          </motion.div>
        </motion.div>

        {/* Scroll indicator */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1.5, duration: 0.8 }}
          className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2"
        >
          <span className="text-[9px] text-neutral-700 tracking-[0.3em] uppercase">Scroll</span>
          <motion.div
            animate={{ y: [0, 6, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
            className="w-5 h-8 rounded-full border border-white/[0.12] flex items-start justify-center pt-1.5"
          >
            <motion.div
              animate={{ opacity: [0.5, 1, 0.5], height: [4, 8, 4] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
              className="w-0.5 bg-accent/60 rounded-full"
            />
          </motion.div>
        </motion.div>
      </section>

      {/* ─── SECTION 3: Problem — Privacy Horror Stories ───────────── */}
      <section className="relative z-10 py-20 border-t border-white/[0.08]">
        <div className="text-center px-6 mb-12">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
          >
            <span className="text-[10px] text-neutral-700 tracking-[0.2em] uppercase font-display">The Problem</span>
            <h2 className="font-display font-bold text-2xl sm:text-4xl text-white mt-3"
              style={{
                background: "linear-gradient(135deg, #ffffff 0%, #71717a 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              Public Ledgers Expose Everything
            </h2>
            <p className="text-sm text-neutral-600 mt-3 max-w-xl mx-auto">
              Real stories. Real losses. Real danger. This is what happens when transaction amounts are visible to the world.
            </p>
          </motion.div>
        </div>
        <PrivacyMarquee />
      </section>

      {/* ─── SECTION 4: What is Blank? — Feature Bento ─────────────── */}
      <section className="relative z-10 py-12 sm:py-20 px-6 sm:px-12 lg:px-20 border-t border-white/[0.08]">
        <div className="max-w-6xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="text-center mb-16"
          >
            <span className="text-[10px] text-neutral-700 tracking-[0.2em] uppercase font-display">The Solution</span>
            <h2 className="font-display font-bold text-2xl sm:text-4xl text-white mt-3"
              style={{
                background: "linear-gradient(135deg, #ffffff 0%, #71717a 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              What is Blank?
            </h2>
            <p className="text-sm text-neutral-600 mt-3 max-w-xl mx-auto">
              A full-stack encrypted payment super-app. Social context is public. Financial amounts are private.
            </p>
          </motion.div>

          <motion.div
            variants={staggerContainer}
            initial="initial"
            whileInView="animate"
            viewport={{ once: true, amount: 0.2 }}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5"
          >
            {features.map((f, idx) => {
              const isLarge = idx === 0;
              const isWide = idx === 1;
              return (
                <motion.div
                  key={f.title}
                  variants={fadeInUp}
                  whileHover={{ y: -6, transition: { type: "spring", stiffness: 400, damping: 25 } }}
                  className={cn(
                    "group",
                    isLarge && "lg:col-span-2 lg:row-span-2",
                    isWide && "lg:col-span-2",
                  )}
                >
                  <div
                    className={cn(
                      "glass-panel h-full cursor-default transition-all duration-300 hover:border-white/[0.08] relative overflow-hidden",
                      isLarge ? "p-8 sm:p-10" : "p-6 sm:p-8",
                      isWide && "flex items-center gap-6",
                    )}
                  >
                    {/* Subtle emerald radial glow for the large card */}
                    {isLarge && (
                      <div
                        className="absolute top-0 right-0 w-2/3 h-2/3 pointer-events-none"
                        style={{
                          background: "radial-gradient(ellipse at 100% 0%, rgba(52,211,153,0.04) 0%, transparent 70%)",
                        }}
                        aria-hidden="true"
                      />
                    )}

                    <div
                      className={cn(
                        "rounded-xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center transition-all duration-300 group-hover:border-white/[0.12] group-hover:bg-white/[0.06] shrink-0",
                        isLarge ? "w-14 h-14 mb-6" : "w-11 h-11",
                        !isWide && !isLarge && "mb-5",
                      )}
                    >
                      <f.icon
                        className={cn(
                          "text-neutral-600 group-hover:text-accent transition-colors duration-300",
                          isLarge ? "w-6 h-6" : "w-5 h-5",
                        )}
                        strokeWidth={1.5}
                      />
                    </div>

                    <div className={isWide ? "flex-1" : undefined}>
                      <h3
                        className={cn(
                          "text-white mb-2",
                          isLarge ? "text-lg font-bold" : isWide ? "text-base font-semibold" : "text-sm font-semibold",
                        )}
                      >
                        {f.title}
                      </h3>
                      <p
                        className={cn(
                          "leading-relaxed",
                          isLarge ? "text-sm text-neutral-400" : "text-[12px] text-neutral-500",
                        )}
                      >
                        {f.desc}
                      </p>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        </div>
      </section>

      {/* ─── SECTION 5: Live Encryption Demo ──────────────────────── */}
      <section className="relative z-10 py-12 sm:py-20 px-6 sm:px-12 lg:px-20 border-t border-white/[0.08]">
        <div className="max-w-4xl mx-auto">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="text-center mb-12"
          >
            <span className="text-[10px] text-neutral-700 tracking-[0.2em] uppercase font-display">Try It</span>
            <h2 className="font-display font-bold text-2xl sm:text-3xl text-white mt-3">See Encryption Live</h2>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.7 }}
          >
            <TiltCard maxTilt={8} glareOpacity={0.08}>
              <div className="p-8 sm:p-10">
                <div className="flex items-center gap-2 mb-8">
                  <Lock className="w-3 h-3 text-accent/50" strokeWidth={2} />
                  <span className="text-[10px] font-medium text-neutral-600 uppercase tracking-[0.2em]">Encryption Preview</span>
                </div>
                <div className="flex items-stretch gap-6 min-h-[100px]">
                  <div className="flex-1 flex flex-col justify-center">
                    <span className="text-[10px] text-neutral-700 uppercase tracking-[0.2em] mb-3 block">You type</span>
                    <div className="relative">
                      <span className="absolute left-0 top-1/2 -translate-y-1/2 text-neutral-700 font-mono text-4xl sm:text-5xl select-none font-light">$</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={demoInput}
                        onChange={handleDemoInput}
                        aria-label="Enter an amount to see encryption"
                        className="w-full bg-transparent border-none outline-none text-white font-mono text-4xl sm:text-5xl pl-8 sm:pl-12 placeholder:text-neutral-800 caret-accent font-light"
                      />
                    </div>
                  </div>
                  <div className="w-px bg-gradient-to-b from-transparent via-white/[0.06] to-transparent self-stretch" />
                  <div className="flex-1 flex flex-col justify-center gap-4">
                    <div>
                      <span className="text-[10px] text-neutral-700 uppercase tracking-[0.2em] mb-2 block">Everyone sees</span>
                      <AnimatePresence mode="wait">
                        <motion.span
                          key={maskedAmount || "e"}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                          className="font-mono text-xl sm:text-2xl text-encrypted/80 tracking-widest block"
                        >
                          {maskedAmount || <span className="text-neutral-800">{"\u2588\u2588\u2588\u2588.\u2588\u2588"}</span>}
                        </motion.span>
                      </AnimatePresence>
                    </div>
                    <div>
                      <span className="text-[10px] text-neutral-700 uppercase tracking-[0.2em] mb-2 block">Contract sees</span>
                      <AnimatePresence mode="wait">
                        <motion.span
                          key={encryptedHex || "h"}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className="font-mono text-[11px] text-accent/40 break-all block leading-relaxed"
                        >
                          {encryptedHex || <span className="text-neutral-800">0x{"\u2022".repeat(24)}</span>}
                        </motion.span>
                      </AnimatePresence>
                    </div>
                  </div>
                </div>
              </div>
            </TiltCard>
          </motion.div>
        </div>
      </section>

      {/* ─── SECTION 6: How It Works (3 steps) ────────────────────── */}
      <section className="relative z-10 py-12 sm:py-20 px-6 sm:px-12 lg:px-20 border-t border-white/[0.08]">
        <HowItWorks />
      </section>

      {/* ─── SECTION 7: FHE Architecture + Comparison ─────────────── */}
      <section className="relative z-10 py-12 sm:py-20 px-6 sm:px-12 lg:px-20 border-t border-white/[0.08]">
        <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-12 items-center">
          {/* Left: Orbital diagram */}
          <motion.div
            initial={{ opacity: 0, x: -40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8 }}
            className="flex items-center justify-center"
          >
            <OrbitalDiagram />
          </motion.div>

          {/* Right: Architecture description */}
          <motion.div
            initial={{ opacity: 0, x: 40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, delay: 0.2 }}
          >
            <span className="text-[10px] text-neutral-700 tracking-[0.2em] uppercase font-display">Architecture</span>
            <h2 className="font-display font-bold text-2xl sm:text-4xl text-white mt-3 mb-6"
              style={{
                background: "linear-gradient(135deg, #ffffff 0%, #71717a 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              Powered by Fhenix CoFHE
            </h2>
            <p className="text-sm text-neutral-500 leading-relaxed mb-8">
              The CoFHE coprocessor enables smart contracts to <span className="text-white font-medium">compute on encrypted data</span> without
              ever decrypting it. Amounts stay encrypted through the entire transaction lifecycle &mdash; from shield to transfer to unseal.
            </p>
            <div className="space-y-3">
              {[
                { label: "25 FHE Operations", desc: "add, sub, mul, select, gte, eq, min, max, and more" },
                { label: "12 Smart Contracts", desc: "Payments, groups, invoicing, escrow, exchange, inheritance" },
                { label: "Async Decryption", desc: "Two-step unseal: request decrypt, then poll for result" },
              ].map((item) => (
                <div key={item.label} className="flex items-start gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/[0.08]">
                  <div className="w-1.5 h-1.5 rounded-full bg-accent mt-1.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-white">{item.label}</p>
                    <p className="text-xs text-neutral-600">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      {/* ─── SECTION 7b: Comparison — Public vs Encrypted ─────────── */}
      <section className="relative z-10 py-12 sm:py-20 px-6 sm:px-12 lg:px-20 border-t border-white/[0.08]">
        <ComparisonSection />
      </section>

      {/* ─── SECTION 8: Stats + Final CTA ─────────────────────────── */}
      <section className="relative z-10 py-12 sm:py-20 px-6 sm:px-12 lg:px-20 border-t border-white/[0.08]">
        <div className="max-w-4xl mx-auto text-center">
          {/* Stats row */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="grid grid-cols-2 sm:grid-cols-4 gap-5 mb-16 max-w-2xl mx-auto"
          >
            {[
              { value: 25, label: "FHE Operations" },
              { value: 12, label: "Smart Contracts" },
              { value: 30, label: "Max Batch Size" },
              { value: 0, label: "Amounts Exposed" },
            ].map((stat) => (
              <div key={stat.label} className="glass-panel glass-highlight p-5 sm:p-6">
                <AnimatedCounter value={stat.value} className="text-stat-lg font-display font-bold text-white block" />
                <p className="text-[10px] text-neutral-600 uppercase tracking-[0.15em] mt-2">{stat.label}</p>
              </div>
            ))}
          </motion.div>

          {/* Final CTA */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.7 }}
          >
            <h2
              className="font-display font-black text-3xl sm:text-5xl text-white mb-4"
              style={{
                background: "linear-gradient(135deg, #ffffff 0%, #a1a1aa 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
              }}
            >
              Ready to Go Private?
            </h2>
            <p className="text-sm text-neutral-500 max-w-md mx-auto mb-8 leading-relaxed">
              Your payments. Your amounts. Nobody else&rsquo;s business. Start using encrypted transactions on Base today.
            </p>
            {connectors[0] && (
              <motion.div
                whileHover={{ scale: 1.02, y: -2, transition: springHover }}
                whileTap={{ scale: 0.98 }}
                className="inline-block"
              >
                <Button
                  variant="primary"
                  size="lg"
                  onClick={() => connect({ connector: connectors[0] })}
                  loading={isPending}
                  icon={<ArrowRight className="w-4 h-4" />}
                  className="w-full sm:w-auto sm:min-w-[280px]"
                >
                  Launch Blank
                </Button>
              </motion.div>
            )}
            <p className="text-[10px] text-neutral-700 tracking-[0.15em] uppercase mt-8">
              Building the Private Economy on Base + Fhenix
            </p>
          </motion.div>
        </div>
      </section>

      {/* ─── Premium Footer ──────────────────────────────────────────── */}
      <div className="relative z-10">
        <Footer />
      </div>
    </div>
  );
}
