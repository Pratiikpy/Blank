import {
  AlertTriangle,
  Eye,
  DollarSign,
  Zap,
  Building,
  Scale,
  type LucideIcon,
} from "lucide-react";

/* ─── Types ──────────────────────────────────────────────────────── */

type Category =
  | "wallet_doxxing"
  | "salary_exposure"
  | "mev_frontrunning"
  | "business_privacy"
  | "targeted_attacks"
  | "regulatory_academic";

interface PrivacyStory {
  category: Category;
  headline: string;
  source: string;
}

interface CategoryMeta {
  label: string;
  color: string;
  Icon: LucideIcon;
}

/* ─── Category Config ────────────────────────────────────────────── */

const CATEGORY_META: Record<Category, CategoryMeta> = {
  wallet_doxxing: {
    label: "Wallet Doxxing",
    color: "#f87171",
    Icon: Eye,
  },
  salary_exposure: {
    label: "Salary Exposure",
    color: "#fbbf24",
    Icon: DollarSign,
  },
  mev_frontrunning: {
    label: "MEV Frontrunning",
    color: "#60a5fa",
    Icon: Zap,
  },
  business_privacy: {
    label: "Business Privacy",
    color: "#a78bfa",
    Icon: Building,
  },
  targeted_attacks: {
    label: "Targeted Attacks",
    color: "#f43f5e",
    Icon: AlertTriangle,
  },
  regulatory_academic: {
    label: "Regulatory & Academic",
    color: "#8b5cf6",
    Icon: Scale,
  },
};

/* ─── Story Data (30 real incidents) ─────────────────────────────── */

const STORIES: PrivacyStory[] = [
  {
    category: "wallet_doxxing",
    headline:
      "Vitalik moved $5M in ETH. PeckShield flagged it in minutes. His $400M wallet is tracked by thousands.",
    source: "cryptorank.io",
  },
  {
    category: "wallet_doxxing",
    headline:
      "Portnoy posted one screenshot. Crypto sleuths doxxed his wallet in minutes. Every trade \u2014 public forever.",
    source: "decrypt.co",
  },
  {
    category: "wallet_doxxing",
    headline:
      "BuzzFeed unmasked BAYC\u2019s anonymous founders. A $2.8B empire, tied to real names overnight.",
    source: "decrypt.co",
  },
  {
    category: "wallet_doxxing",
    headline:
      "The FBI created a fake token sting op. A Coinbase exec traced its wallets anyway. Even feds can\u2019t hide on-chain.",
    source: "beincrypto.com",
  },
  {
    category: "wallet_doxxing",
    headline:
      "Arkham launched a marketplace to identify wallet owners. The internet called it \u2018dox-to-earn.\u2019",
    source: "coindesk.com",
  },
  {
    category: "wallet_doxxing",
    headline:
      "Paid a freelancer in USDC. They looked up my wallet and asked why I had so much money.",
    source: "reddit.com",
  },
  {
    category: "salary_exposure",
    headline:
      "Ethereum co-founder sold $11M in ETH. His ENS name linked the wallet to his real identity in hours.",
    source: "cryptobriefing.com",
  },
  {
    category: "salary_exposure",
    headline:
      "Vitalik: \u2018Linking your real name to an ETH address is like someone poking inside your bank account.\u2019",
    source: "decrypt.co",
  },
  {
    category: "salary_exposure",
    headline:
      "Give your employer your wallet for crypto payroll. Now they see your portfolio, tokens, every transaction \u2014 ever.",
    source: "medium.com",
  },
  {
    category: "salary_exposure",
    headline:
      "Every DAO contributor\u2019s salary is one Etherscan search away.",
    source: "blockworks.co",
  },
  {
    category: "salary_exposure",
    headline:
      "Web3 teams with 90% of treasury on-chain leak salary data to competitors with every payroll tx.",
    source: "zengo.com",
  },
  {
    category: "mev_frontrunning",
    headline:
      "Sandwich attacks extracted $900M from DeFi users in 2023. That\u2019s $2.5 million stolen per day.",
    source: "cow.fi",
  },
  {
    category: "mev_frontrunning",
    headline:
      "One bot \u2014 jaredfromsubway.eth \u2014 profited $22M by sandwiching 106,000 victims.",
    source: "theblock.co",
  },
  {
    category: "mev_frontrunning",
    headline:
      "Solana MEV bot \u2018arsc\u2019 pocketed $30M in two months. $570K per day in stolen value.",
    source: "cointelegraph.com",
  },
  {
    category: "mev_frontrunning",
    headline:
      "Swapped $733,000 USDC. Received $19,000 USDT. A sandwich attack wiped 97% in 8 seconds.",
    source: "theblock.co",
  },
  {
    category: "mev_frontrunning",
    headline:
      "Two MIT brothers extracted $25M from Ethereum in 12 seconds. First-ever criminal MEV prosecution.",
    source: "coindesk.com",
  },
  {
    category: "business_privacy",
    headline:
      "JP Morgan forked Ethereum into a private blockchain. Public chains exposed too much.",
    source: "cointelegraph.com",
  },
  {
    category: "business_privacy",
    headline:
      "EY\u2019s blockchain chief: \u2018On a public chain, supplier A sees how much you pay supplier B.\u2019",
    source: "cointelegraph.com",
  },
  {
    category: "business_privacy",
    headline:
      "EY spent 6 years building Nightfall because B2B payments leak intelligence to competitors.",
    source: "ey.com",
  },
  {
    category: "business_privacy",
    headline:
      "Vitalik Buterin: \u2018Privacy is not a feature. Privacy is hygiene.\u2019 Committed $45M to fix it.",
    source: "vitalik.eth.limo",
  },
  {
    category: "business_privacy",
    headline:
      "If competitors see your payroll, vendors, and financial pressure \u2014 no institution uses a public chain.",
    source: "stellar.org",
  },
  {
    category: "targeted_attacks",
    headline:
      "Kidnappers severed a Ledger co-founder\u2019s finger and sent the video. Demanded $10M in Bitcoin.",
    source: "coindesk.com",
  },
  {
    category: "targeted_attacks",
    headline:
      "Amouranth posted a $20M wallet screenshot. Weeks later, intruders pistol-whipped her for crypto.",
    source: "fortune.com",
  },
  {
    category: "targeted_attacks",
    headline:
      "WonderFi CEO shoved into a car during Toronto rush hour. Released after paying $1M ransom.",
    source: "cbc.ca",
  },
  {
    category: "targeted_attacks",
    headline:
      "The 2020 Ledger breach leaked 272,000 home addresses. Five years later, victims still targeted.",
    source: "cointelegraph.com",
  },
  {
    category: "targeted_attacks",
    headline:
      "225+ verified physical attacks on crypto holders. 2025 shattered all records. $166M stolen.",
    source: "github.com/jlopp",
  },
  {
    category: "regulatory_academic",
    headline:
      "Researchers proved it: Bitcoin\u2019s \u2018anonymity\u2019 is a myth. Money flow is globally visible.",
    source: "dl.acm.org",
  },
  {
    category: "regulatory_academic",
    headline:
      "EU ruling: blockchain\u2019s immutability violates GDPR\u2019s right to be forgotten. Fines up to \u20AC20M.",
    source: "edpb.europa.eu",
  },
  {
    category: "regulatory_academic",
    headline:
      "Chainalysis clustered 1B addresses, linked $14T to real identities. Accuracy: 94.85%.",
    source: "chainalysis.com",
  },
  {
    category: "regulatory_academic",
    headline:
      "114 academic papers. One conclusion: public blockchains and privacy laws are irreconcilable.",
    source: "sciencedirect.com",
  },
];

/* ─── Story Card ─────────────────────────────────────────────────── */

function StoryCard({ story }: { story: PrivacyStory }) {
  const meta = CATEGORY_META[story.category];
  const { Icon } = meta;

  return (
    <div
      className={[
        "relative flex-shrink-0",
        "min-w-[380px] max-w-[380px]",
        "bg-gradient-to-br from-white/[0.04] to-white/[0.01] border border-white/[0.06] shadow-[0_2px_8px_rgba(0,0,0,0.3)] rounded-2xl p-5",
        "backdrop-blur-sm",
        "hover:bg-white/[0.04] hover:border-white/[0.08]",
        "transition-all duration-300",
        "select-none",
      ].join(" ")}
    >
      {/* Left accent bar */}
      <div
        className="absolute left-0 top-4 bottom-4 w-[3px] rounded-full"
        style={{
          background: `linear-gradient(to bottom, ${meta.color}60, ${meta.color}10)`,
        }}
      />

      {/* Category row */}
      <div className="flex items-center gap-2 mb-3">
        {/* Colored dot with glow */}
        <span
          className="inline-block w-2 h-2 rounded-full flex-shrink-0"
          style={{
            backgroundColor: meta.color,
            boxShadow: `0 0 6px ${meta.color}`,
          }}
        />
        <Icon
          size={11}
          className="flex-shrink-0 opacity-60"
          style={{ color: meta.color }}
        />
        <span
          className="text-[10px] font-medium uppercase tracking-widest"
          style={{ color: meta.color }}
        >
          {meta.label}
        </span>
      </div>

      {/* Headline */}
      <p className="text-[14px] font-semibold leading-[1.55] text-white/90 mb-3">
        {story.headline}
      </p>

      {/* Source */}
      <span className="text-[10px] text-gray-600 tracking-wide">
        {story.source}
      </span>
    </div>
  );
}

/* ─── PrivacyMarquee (exported) ──────────────────────────────────── */

export function PrivacyMarquee() {
  return (
    <section
      className="relative w-full overflow-hidden py-8"
      aria-label="Privacy incident stories"
      style={{
        maskImage:
          "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
        WebkitMaskImage:
          "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
      }}
    >
      {/* Scrolling track — group wrapper enables hover pause */}
      <div className="group">
        <div
          className="flex gap-5 w-max group-hover:[animation-play-state:paused]"
          style={{
            animation: "privacy-marquee-scroll 120s linear infinite",
          }}
        >
          {/* First set */}
          {STORIES.map((story, i) => (
            <StoryCard key={`a-${i}`} story={story} />
          ))}
          {/* Duplicate set for seamless loop */}
          {STORIES.map((story, i) => (
            <StoryCard key={`b-${i}`} story={story} />
          ))}
        </div>
      </div>

      {/* Inline keyframes — injected once via <style> */}
      <style>{`
        @keyframes privacy-marquee-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }

        @media (prefers-reduced-motion: reduce) {
          .group > div {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
          }
        }
      `}</style>
    </section>
  );
}

export default PrivacyMarquee;
