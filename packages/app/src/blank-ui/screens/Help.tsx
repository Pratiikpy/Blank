import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  ChevronDown,
  Shield,
  Lock,
  Wallet,
  EyeOff,
  ArrowDownToLine,
  Github,
  ExternalLink,
  HelpCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";

interface FAQItem {
  id: string;
  icon: React.ReactNode;
  iconBg: string;
  question: string;
  answer: React.ReactNode;
}

const FAQ_ITEMS: FAQItem[] = [
  {
    id: "what-is-blank",
    icon: <Shield size={20} />,
    iconBg: "bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    question: "What is Blank?",
    answer: (
      <p>
        Blank is an encrypted payment platform built on Fhenix CoFHE and Base
        Sepolia. Transaction amounts are invisible on-chain using Fully
        Homomorphic Encryption (FHE). Social context -- who sent to whom, when,
        and why -- remains public, but financial details stay completely private.
      </p>
    ),
  },
  {
    id: "what-is-fhe",
    icon: <Lock size={20} />,
    iconBg: "bg-purple-50 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400",
    question: "What is FHE?",
    answer: (
      <p>
        Fully Homomorphic Encryption (FHE) lets smart contracts compute on
        encrypted data without ever decrypting it. This means balances,
        transfers, and amounts are processed entirely in ciphertext. Only the
        owner of the data -- you -- can decrypt and view the actual values using
        your FHE permit.
      </p>
    ),
  },
  {
    id: "getting-started",
    icon: <Wallet size={20} />,
    iconBg: "bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400",
    question: "How do I get started?",
    answer: (
      <ol className="space-y-3">
        {[
          { step: 1, text: "Connect your wallet (MetaMask, Coinbase Wallet, or any EVM wallet)" },
          { step: 2, text: "Switch to the Base Sepolia testnet if not already connected" },
          { step: 3, text: "Get test USDC from a Base Sepolia faucet" },
          { step: 4, text: "Shield your tokens to convert public USDC into encrypted USDC in your vault" },
          { step: 5, text: "Send privately -- recipients see the payment but not the amount" },
        ].map(({ step, text }) => (
          <li key={step} className="flex gap-3">
            <div className="w-7 h-7 rounded-full bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center shrink-0">
              <span className="text-xs font-semibold text-blue-600 dark:text-blue-400">
                {step}
              </span>
            </div>
            <span className="text-sm text-[var(--text-secondary)] leading-relaxed">
              {text}
            </span>
          </li>
        ))}
      </ol>
    ),
  },
  {
    id: "why-masked",
    icon: <EyeOff size={20} />,
    iconBg: "bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400",
    question: "Why do amounts show as \u2588\u2588\u2588\u2588?",
    answer: (
      <p>
        Amounts are encrypted on-chain using FHE. The masked display
        (\u2588\u2588\u2588\u2588.\u2588\u2588) indicates that the value is stored as ciphertext.
        Only you can decrypt your own balance and transaction amounts using your
        FHE permit. Tap or click the eye icon to reveal your decrypted balance
        -- it will auto-hide after 10 seconds for security.
      </p>
    ),
  },
  {
    id: "what-is-shielding",
    icon: <ArrowDownToLine size={20} />,
    iconBg: "bg-cyan-50 dark:bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
    question: "What is shielding?",
    answer: (
      <p>
        Shielding converts your public ERC-20 tokens (like USDC) into encrypted
        tokens inside the Blank vault. Once shielded, your token balance becomes
        an encrypted value that only you can read. You can unshield at any time
        to convert back to regular public tokens. Shielding is the gateway
        between the public and private worlds.
      </p>
    ),
  },
  {
    id: "contact",
    icon: <Github size={20} />,
    iconBg: "bg-gray-100 dark:bg-white/10 text-gray-600 dark:text-gray-400",
    question: "How do I report an issue or get support?",
    answer: (
      <div className="space-y-3">
        <p>
          If you encounter a bug or have a feature request, please open an issue
          on our GitHub repository. Our team actively monitors and responds to
          community feedback.
        </p>
        <a
          href="https://github.com/FhenixProtocol"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#1D1D1F] dark:bg-white/10 text-white text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <Github size={16} />
          Report Issues on GitHub
          <ExternalLink size={12} />
        </a>
      </div>
    ),
  },
];

export default function Help() {
  const navigate = useNavigate();
  const [expandedId, setExpandedId] = useState<string | null>("what-is-blank");

  const toggleItem = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate(-1)}
            className="w-11 h-11 rounded-full bg-white dark:bg-white/10 border border-black/5 dark:border-white/10 flex items-center justify-center shadow-sm"
            aria-label="Go back"
          >
            <ChevronLeft size={20} />
          </button>
          <div className="flex-1">
            <h1
              className="text-3xl font-semibold tracking-tight text-[var(--text-primary)]"
              style={{ fontFamily: "'Outfit', sans-serif" }}
            >
              Help & FAQ
            </h1>
            <p className="text-sm text-[var(--text-secondary)]">
              Frequently asked questions about Blank
            </p>
          </div>
          <div className="w-12 h-12 rounded-xl bg-emerald-50 dark:bg-emerald-500/10 flex items-center justify-center">
            <HelpCircle size={24} className="text-emerald-600 dark:text-emerald-400" />
          </div>
        </div>

        {/* FAQ Accordion */}
        <div className="space-y-3">
          {FAQ_ITEMS.map((item) => {
            const isOpen = expandedId === item.id;

            return (
              <div
                key={item.id}
                className="glass-card-static rounded-[2rem] overflow-hidden"
              >
                <button
                  onClick={() => toggleItem(item.id)}
                  className="w-full flex items-center gap-4 p-6 text-left transition-colors hover:bg-white/30 dark:hover:bg-white/5"
                  aria-expanded={isOpen}
                  aria-controls={`faq-answer-${item.id}`}
                >
                  <div
                    className={cn(
                      "w-11 h-11 rounded-xl flex items-center justify-center shrink-0",
                      item.iconBg,
                    )}
                  >
                    {item.icon}
                  </div>
                  <span className="flex-1 text-base font-semibold text-[var(--text-primary)]">
                    {item.question}
                  </span>
                  <ChevronDown
                    size={20}
                    className={cn(
                      "text-[var(--text-secondary)] shrink-0 transition-transform duration-300",
                      isOpen && "rotate-180",
                    )}
                  />
                </button>

                <div
                  id={`faq-answer-${item.id}`}
                  className={cn(
                    "overflow-hidden transition-all duration-300 ease-in-out",
                    isOpen ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0",
                  )}
                >
                  <div className="px-6 pb-6 pt-0 ml-[60px]">
                    <div className="text-sm text-[var(--text-secondary)] leading-relaxed">
                      {item.answer}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Bottom Info */}
        <div className="mt-8 p-6 glass-card-static rounded-[2rem] text-center">
          <p className="text-sm text-[var(--text-secondary)] leading-relaxed">
            Blank is built on{" "}
            <span className="font-medium text-[var(--text-primary)]">
              Fhenix CoFHE
            </span>{" "}
            and deployed on{" "}
            <span className="font-medium text-[var(--text-primary)]">
              Base Sepolia
            </span>
            . All transaction amounts are encrypted using Fully Homomorphic
            Encryption. This is a testnet application -- do not use real funds.
          </p>
        </div>
      </div>
    </div>
  );
}
