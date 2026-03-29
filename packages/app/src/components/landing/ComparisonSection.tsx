"use client";

import { motion } from "framer-motion";
import { Eye, EyeOff, X, Check } from "lucide-react";
import { cn } from "@/lib/cn";

// ─── Data ────────────────────────────────────────────────────────────

const publicBullets = [
  "Transaction amounts visible to everyone on-chain",
  "Wallet balances exposed — net worth is public",
  "MEV bots front-run your trades using visible amounts",
  "Employer sees your entire portfolio from payroll address",
  "Competitors map your supply chain from payment flows",
  "Physical attackers use on-chain wealth to target victims",
] as const;

const fheBullets = [
  "Amounts encrypted with Fully Homomorphic Encryption",
  "Balances private — only you can unseal with a permit",
  "MEV-proof: bots can't see encrypted swap amounts",
  "Payroll amounts hidden — social context stays public",
  "Invoice amounts encrypted — only parties can decrypt",
  "No visible wealth = no target for physical attacks",
] as const;

// ─── Animation Variants ──────────────────────────────────────────────

const cardSpring = { type: "spring" as const, stiffness: 80, damping: 18, mass: 0.9 };

const leftCardVariants = {
  hidden: { opacity: 0, x: -60, scale: 0.97 },
  visible: {
    opacity: 1,
    x: 0,
    scale: 1,
    transition: { ...cardSpring, staggerChildren: 0.07, delayChildren: 0.15 },
  },
};

const rightCardVariants = {
  hidden: { opacity: 0, x: 60, scale: 0.97 },
  visible: {
    opacity: 1,
    x: 0,
    scale: 1,
    transition: { ...cardSpring, staggerChildren: 0.07, delayChildren: 0.15 },
  },
};

const bulletVariants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35 },
  },
};

const hoverLift = {
  y: -4,
  transition: { type: "spring" as const, stiffness: 300, damping: 22 },
};

// ─── Component ───────────────────────────────────────────────────────

export default function ComparisonSection() {
  return (
    <section className="relative w-full py-20 px-4 sm:px-6 lg:px-8">
      {/* Section heading */}
      <motion.div
        className="mx-auto mb-14 max-w-2xl text-center"
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        <h2 className="text-3xl sm:text-5xl font-semibold text-text-primary tracking-tight">
          Why encryption matters
        </h2>
        <p className="mt-4 text-body-lg text-text-secondary max-w-xl mx-auto">
          Your finances are an open book on public blockchains. Fully
          Homomorphic Encryption seals the book — permanently.
        </p>
      </motion.div>

      {/* Two-column grid */}
      <div className="relative mx-auto grid max-w-5xl grid-cols-1 gap-8 md:grid-cols-2">
        {/* VS badge (desktop only) */}
        <div className="hidden md:flex absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 w-10 h-10 rounded-full bg-[#0a0a0c] border border-white/[0.10] items-center justify-center">
          <span className="text-[10px] font-display font-bold text-neutral-500 tracking-wider">VS</span>
        </div>
        {/* ── LEFT: Public Blockchain (the bad) ─────────────────────── */}
        <motion.div
          className={cn(
            "group relative overflow-hidden rounded-2xl p-8",
            "backdrop-blur-2xl",
            "bg-gradient-to-br from-red-500/[0.02] to-transparent",
            "border border-white/[0.05] border-t border-t-red-500/10",
            "shadow-[0_20px_50px_-12px_rgba(0,0,0,0.5)]",
            "transition-shadow duration-300"
          )}
          variants={leftCardVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
          whileHover={hoverLift}
        >
          {/* Subtle red radial glow in top-right */}
          <div
            className="pointer-events-none absolute -top-20 -right-20 h-60 w-60 rounded-full opacity-[0.04]"
            style={{
              background:
                "radial-gradient(circle, rgba(248,113,113,0.8) 0%, transparent 70%)",
            }}
            aria-hidden="true"
          />

          {/* Header */}
          <div className="relative z-[1] mb-7 flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.04] ring-1 ring-inset ring-white/[0.06]">
              <Eye className="h-5 w-5 text-neutral-400" strokeWidth={1.6} />
            </div>
            <h3 className="text-heading-3 font-semibold text-text-primary">
              Public Blockchain
            </h3>
          </div>

          {/* Bullets */}
          <ul className="relative z-[1] space-y-4" role="list">
            {publicBullets.map((text) => (
              <motion.li
                key={text}
                variants={bulletVariants}
                className="flex items-start gap-3"
              >
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500/[0.08]">
                  <X className="h-3 w-3 text-red-400/60" strokeWidth={2.5} />
                </span>
                <span className="text-sm leading-relaxed text-neutral-500">
                  {text}
                </span>
              </motion.li>
            ))}
          </ul>
        </motion.div>

        {/* ── RIGHT: Blank + FHE (the good) ─────────────────────────── */}
        <div className="relative group">
          {/* Gradient border glow */}
          <div className="absolute -inset-[1px] bg-gradient-to-br from-accent/30 via-accent/10 to-encrypted/20 rounded-2xl opacity-50 group-hover:opacity-80 transition-opacity duration-500 blur-[0.5px]" />

          {/* Card content */}
          <motion.div
            className={cn(
              "relative overflow-hidden rounded-2xl p-8",
              "backdrop-blur-2xl",
              "bg-[#060608]",
              "bg-gradient-to-br from-accent/[0.03] to-transparent",
              "border border-white/[0.06] border-t-2 border-t-accent/30",
              "shadow-[0_20px_50px_-12px_rgba(0,0,0,0.5)]",
              "transition-all duration-300",
              "hover:border-accent/20"
            )}
            variants={rightCardVariants}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-60px" }}
            whileHover={hoverLift}
          >
            {/* Emerald gradient overlay */}
            <div
              className="pointer-events-none absolute inset-0 rounded-2xl"
              style={{
                background:
                  "linear-gradient(135deg, rgba(255,255,255,0.03) 0%, transparent 60%)",
              }}
              aria-hidden="true"
            />

            {/* Subtle emerald radial glow in top-left */}
            <div
              className="pointer-events-none absolute -top-20 -left-20 h-60 w-60 rounded-full opacity-[0.06]"
              style={{
                background:
                  "radial-gradient(circle, rgba(52,211,153,0.7) 0%, transparent 70%)",
              }}
              aria-hidden="true"
            />

            {/* Header */}
            <div className="relative z-[1] mb-7 flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 ring-1 ring-inset ring-accent/20">
                <EyeOff className="h-5 w-5 text-accent" strokeWidth={1.6} />
              </div>
              <h3 className="text-heading-3 font-semibold text-text-primary">
                Blank + FHE
              </h3>
            </div>

            {/* Bullets */}
            <ul className="relative z-[1] space-y-4" role="list">
              {fheBullets.map((text) => (
                <motion.li
                  key={text}
                  variants={bulletVariants}
                  className="flex items-start gap-3"
                >
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/10 shadow-[0_0_6px_rgba(52,211,153,0.3)]">
                    <Check className="h-3 w-3 text-accent" strokeWidth={2.5} />
                  </span>
                  <span className="text-sm leading-relaxed text-neutral-300">
                    {text}
                  </span>
                </motion.li>
              ))}
            </ul>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
