import { motion, type Variants } from "framer-motion";
import { Shield, ArrowLeftRight, Key, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/* ────────────────────────────────────────────────────────────────────────── */
/*  Step Data                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

interface Step {
  number: number;
  icon: LucideIcon;
  title: string;
  description: string;
}

const steps: Step[] = [
  {
    number: 1,
    icon: Shield,
    title: "Shield Your Tokens",
    description:
      "Deposit public ERC-20 tokens into the encrypted vault. Your balance becomes an FHE ciphertext \u2014 invisible to everyone.",
  },
  {
    number: 2,
    icon: ArrowLeftRight,
    title: "Send Privately",
    description:
      "Transfer encrypted amounts to anyone. The contract uses FHE.select() to verify your balance without revealing it \u2014 even the blockchain can\u2019t see the amount.",
  },
  {
    number: 3,
    icon: Key,
    title: "Unseal With Permit",
    description:
      "Only you can decrypt your balance using a signed permit. Share selective access with auditors or lenders \u2014 you control who sees what.",
  },
];

/* ────────────────────────────────────────────────────────────────────────── */
/*  Animation Variants                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

const sectionVariants: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.22 },
  },
};

const headingVariants: Variants = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
  },
};

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] },
  },
};

/* ────────────────────────────────────────────────────────────────────────── */
/*  StepCard                                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

function StepCard({ step }: { step: Step }) {
  const Icon = step.icon;

  return (
    <motion.div
      variants={cardVariants}
      whileHover={{
        y: -4,
        borderColor: "rgba(255, 255, 255, 0.08)",
        transition: { type: "spring", stiffness: 300, damping: 20 },
      }}
      className={cn(
        "relative rounded-2xl p-8",
        "glass-panel",
        "backdrop-blur-xl",
        "transition-colors duration-300"
      )}
    >
      {/* Icon circle with number badge */}
      <div className="relative mb-6 inline-flex">
        {/* Circle */}
        <div
          className={cn(
            "flex h-14 w-14 items-center justify-center rounded-full",
            "border border-white/[0.08] bg-white/[0.03]"
          )}
        >
          <Icon className="h-6 w-6 text-accent" strokeWidth={1.5} />
        </div>

        {/* Number badge */}
        <span
          className={cn(
            "absolute -right-1 -top-1",
            "flex h-6 w-6 items-center justify-center rounded-full",
            "bg-accent/30 border border-accent/20 text-accent",
            "text-xs font-bold"
          )}
        >
          {step.number}
        </span>
      </div>

      {/* Title */}
      <h3 className="mb-3 text-lg font-semibold text-white">{step.title}</h3>

      {/* Description */}
      <p className="text-sm leading-relaxed text-neutral-400">
        {step.description}
      </p>
    </motion.div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  HowItWorks                                                               */
/* ────────────────────────────────────────────────────────────────────────── */

interface HowItWorksProps {
  className?: string;
}

export default function HowItWorks({ className }: HowItWorksProps) {
  return (
    <motion.section
      variants={sectionVariants}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "-80px" }}
      className={cn("relative w-full", className)}
    >
      {/* ── Section Header ──────────────────────────────────────────── */}
      <motion.div variants={headingVariants} className="mb-14 text-center">
        <h2 className="font-display text-heading-1 font-bold text-white">
          How It Works
        </h2>
        <p className="mt-3 text-sm text-neutral-600">
          Three steps to private payments
        </p>
      </motion.div>

      {/* ── Steps Grid ──────────────────────────────────────────────── */}
      <div className="relative grid grid-cols-1 gap-5 md:grid-cols-3">
        {/* Connecting gradient line — desktop only */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-7 hidden md:block"
          style={{
            /* Span from center of col 1 to center of col 3.
               Each column is 1/3 width. Center of col 1 = 1/6,
               center of col 3 = 5/6. So left = ~16.67%, right = ~16.67%. */
            left: "16.667%",
            right: "16.667%",
            height: "2px",
            background:
              "linear-gradient(90deg, transparent, rgba(255,255,255,0.08), rgba(255,255,255,0.08), transparent)",
          }}
        />

        {steps.map((step) => (
          <StepCard key={step.number} step={step} />
        ))}
      </div>
    </motion.section>
  );
}
