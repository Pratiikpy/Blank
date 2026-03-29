"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Lock,
  Github,
  Twitter,
  MessageCircle,
  Globe,
  Send,
  ArrowUpRight,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";

// ─── Data ────────────────────────────────────────────────────────────────────

const productLinks = [
  { label: "Dashboard", href: "/dashboard" },
  { label: "Send & Receive", href: "/send" },
  { label: "Groups", href: "/groups" },
  { label: "Creator Tips", href: "/tips" },
  { label: "Business Suite", href: "/business" },
  { label: "Exchange", href: "/exchange" },
];

const resourceLinks = [
  { label: "Documentation", href: "/docs", external: false },
  { label: "Architecture", href: "/architecture", external: false },
  { label: "Privacy Policy", href: "/privacy", external: false },
  { label: "Terms of Service", href: "/terms", external: false },
  {
    label: "Fhenix Docs",
    href: "https://docs.fhenix.zone",
    external: true,
  },
  {
    label: "Base Docs",
    href: "https://docs.base.org",
    external: true,
  },
];

const socialLinks = [
  { icon: Github, href: "https://github.com", label: "GitHub" },
  { icon: Twitter, href: "https://x.com", label: "X (Twitter)" },
  { icon: MessageCircle, href: "https://discord.gg", label: "Discord" },
  { icon: Globe, href: "https://blank.app", label: "Website" },
];

// ─── Animation Variants ──────────────────────────────────────────────────────

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08,
      delayChildren: 0.1,
    },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.5,
      ease: [0.22, 1, 0.36, 1] as const,
    },
  },
};

// ─── Subcomponents ───────────────────────────────────────────────────────────

function FooterLink({
  href,
  external,
  children,
}: {
  href: string;
  external?: boolean;
  children: React.ReactNode;
}) {
  return (
    <motion.a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      className={cn(
        "group/link flex items-center gap-1.5",
        "text-sm text-neutral-500",
        "transition-all duration-200 ease-out",
        "hover:text-white hover:translate-x-1"
      )}
      whileHover={{ x: 4 }}
      transition={{ type: "spring", stiffness: 400, damping: 20 }}
    >
      <span>{children}</span>
      {external && (
        <ArrowUpRight
          className={cn(
            "h-3 w-3 opacity-0 -translate-y-0.5",
            "transition-all duration-200",
            "group-hover/link:opacity-60 group-hover/link:translate-y-0"
          )}
        />
      )}
    </motion.a>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "block mb-5 text-[10px] font-medium uppercase tracking-[0.12em]",
        "text-neutral-600"
      )}
    >
      {children}
    </span>
  );
}

// ─── Main Footer ─────────────────────────────────────────────────────────────

export function Footer() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitted(true);
    setEmail("");
    // Reset after 4 seconds so user can subscribe again if needed
    setTimeout(() => setSubmitted(false), 4000);
  }

  return (
    <footer
      className="relative border-t border-white/[0.06]"
      role="contentinfo"
    >
      {/* ── Main Content ── */}
      <motion.div
        className="mx-auto max-w-6xl py-16 px-6 sm:px-12 lg:px-20"
        variants={containerVariants}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-60px" }}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-12">
          {/* ── Column 1: Newsletter ── */}
          <motion.div variants={itemVariants} className="relative sm:col-span-2 lg:col-span-1">
            {/* Breathing emerald glow orb */}
            <motion.div
              aria-hidden
              className={cn(
                "pointer-events-none absolute -top-8 -left-8",
                "h-40 w-40 rounded-full",
                "bg-emerald-500/[0.07] blur-3xl"
              )}
              animate={{
                scale: [1, 1.15, 1],
                opacity: [0.5, 0.8, 0.5],
              }}
              transition={{
                duration: 6,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />

            <div className="relative">
              <h3 className="text-xl font-bold tracking-tight text-white font-display">
                Stay Encrypted
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-500">
                Get updates on encrypted payment features and FHE development.
              </p>

              <form onSubmit={handleSubmit} className="mt-5 flex gap-2">
                <div className="flex-1 min-w-0">
                  <Input
                    type="email"
                    placeholder="you@email.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    aria-label="Email address for newsletter"
                    className="!h-10 !text-xs !rounded-lg"
                  />
                </div>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  icon={<Send className="h-3.5 w-3.5" />}
                  aria-label="Subscribe to newsletter"
                  className="shrink-0"
                >
                  {submitted ? "Sent!" : "Subscribe"}
                </Button>
              </form>

              {/* Success feedback */}
              <motion.p
                initial={false}
                animate={{
                  height: submitted ? "auto" : 0,
                  opacity: submitted ? 1 : 0,
                }}
                transition={{ duration: 0.3 }}
                className="overflow-hidden mt-2 text-xs text-emerald-400"
              >
                Thanks! We'll keep you in the loop.
              </motion.p>
            </div>
          </motion.div>

          {/* ── Column 2: Product ── */}
          <motion.nav variants={itemVariants} aria-label="Product links">
            <SectionLabel>Product</SectionLabel>
            <ul className="space-y-3">
              {productLinks.map((link) => (
                <li key={link.href}>
                  <FooterLink href={link.href}>{link.label}</FooterLink>
                </li>
              ))}
            </ul>
          </motion.nav>

          {/* ── Column 3: Resources ── */}
          <motion.nav variants={itemVariants} aria-label="Resources">
            <SectionLabel>Resources</SectionLabel>
            <ul className="space-y-3">
              {resourceLinks.map((link) => (
                <li key={link.href}>
                  <FooterLink href={link.href} external={link.external}>
                    {link.label}
                  </FooterLink>
                </li>
              ))}
            </ul>
          </motion.nav>

          {/* ── Column 4: Connect ── */}
          <motion.div variants={itemVariants}>
            <SectionLabel>Connect</SectionLabel>

            {/* Social icon row */}
            <div className="flex items-center gap-2">
              {socialLinks.map(({ icon: Icon, href, label }) => (
                <motion.a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className={cn(
                    "inline-flex items-center justify-center",
                    "w-10 h-10 rounded-full",
                    "bg-white/[0.04] border border-white/[0.06]",
                    "text-neutral-500",
                    "transition-all duration-200 ease-out",
                    "hover:bg-white/[0.08] hover:border-white/[0.12] hover:text-white",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-2 focus-visible:ring-offset-void"
                  )}
                  whileHover={{ scale: 1.1, y: -2 }}
                  whileTap={{ scale: 0.95 }}
                  transition={{ type: "spring", stiffness: 400, damping: 15 }}
                >
                  <Icon className="h-4 w-4" />
                </motion.a>
              ))}
            </div>

            <p className="mt-5 text-xs leading-relaxed text-neutral-600">
              Built on{" "}
              <span className="text-neutral-500 font-medium">Base</span>
              {" + "}
              <span className="text-neutral-500 font-medium">Fhenix CoFHE</span>
            </p>

            <p className="mt-3 text-[11px] leading-relaxed text-neutral-700">
              Fully homomorphic encryption for private on-chain payments.
            </p>
          </motion.div>
        </div>
      </motion.div>

      {/* ── Bottom Bar ── */}
      <div className="border-t border-white/[0.06]">
        <div
          className={cn(
            "mx-auto max-w-6xl",
            "flex flex-col sm:flex-row items-center justify-between gap-3",
            "py-6 px-6 sm:px-12 lg:px-20"
          )}
        >
          <p className="text-xs text-neutral-700">
            &copy; {new Date().getFullYear()} Blank. Social payments. Private amounts.
          </p>

          <p className="flex items-center gap-1.5 text-xs text-neutral-700">
            <Lock className="h-3 w-3" />
            <span>Powered by FHE</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
