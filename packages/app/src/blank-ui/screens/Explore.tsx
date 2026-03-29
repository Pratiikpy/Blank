import { useNavigate } from "react-router-dom";
import {
  Send,
  ArrowDownLeft,
  Receipt,
  Users,
  Gift,
  Briefcase,
  FileText,
  Ghost,
  Shield,
  ChevronRight,
  ArrowLeftRight,
  Heart,
  Clock,
} from "lucide-react";
import { cn } from "@/lib/cn";

interface FeatureItem {
  icon: React.ReactNode;
  iconBg: string;
  title: string;
  subtitle: string;
  route: string;
}

interface FeatureSection {
  heading: string;
  items: FeatureItem[];
}

const sections: FeatureSection[] = [
  {
    heading: "PAYMENTS",
    items: [
      {
        icon: <Send size={20} />,
        iconBg: "bg-[#007AFF]/10 text-[#007AFF]",
        title: "Send Money",
        subtitle: "FHE-encrypted P2P payments",
        route: "/send",
      },
      {
        icon: <ArrowDownLeft size={20} />,
        iconBg: "bg-emerald-50 text-emerald-600",
        title: "Receive Money",
        subtitle: "QR codes and payment links",
        route: "/receive",
      },
      {
        icon: <Receipt size={20} />,
        iconBg: "bg-orange-50 text-orange-600",
        title: "Payment Requests",
        subtitle: "Request encrypted payments",
        route: "/requests",
      },
    ],
  },
  {
    heading: "SOCIAL",
    items: [
      {
        icon: <Users size={20} />,
        iconBg: "bg-cyan-50 text-cyan-600",
        title: "Group Splits",
        subtitle: "Split bills with encrypted amounts",
        route: "/groups",
      },
      {
        icon: <Gift size={20} />,
        iconBg: "bg-pink-50 text-pink-600",
        title: "Gift Envelopes",
        subtitle: "Send surprise encrypted gifts",
        route: "/gifts",
      },
      {
        icon: <Heart size={20} />,
        iconBg: "bg-red-50 text-red-600",
        title: "Creator Support",
        subtitle: "Tip creators with private amounts",
        route: "/creators",
      },
    ],
  },
  {
    heading: "ADVANCED",
    items: [
      {
        icon: <Ghost size={20} />,
        iconBg: "bg-purple-50 text-purple-600",
        title: "Stealth Payments",
        subtitle: "Anonymous claim codes",
        route: "/stealth",
      },
      {
        icon: <ArrowLeftRight size={20} />,
        iconBg: "bg-amber-50 text-amber-600",
        title: "P2P Exchange",
        subtitle: "Trade tokens with privacy",
        route: "/swap",
      },
      {
        icon: <Briefcase size={20} />,
        iconBg: "bg-blue-50 text-blue-600",
        title: "Business Tools",
        subtitle: "Invoicing, payroll, and escrow",
        route: "/business",
      },
    ],
  },
  {
    heading: "SECURITY",
    items: [
      {
        icon: <Clock size={20} />,
        iconBg: "bg-amber-50 text-amber-600",
        title: "Beneficiary Planning",
        subtitle: "Automatic fund transfer to trusted contacts",
        route: "/inheritance",
      },
      {
        icon: <Shield size={20} />,
        iconBg: "bg-violet-50 text-violet-600",
        title: "Privacy Controls",
        subtitle: "Manage permits and sharing",
        route: "/profile",
      },
      {
        icon: <FileText size={20} />,
        iconBg: "bg-slate-50 text-slate-600",
        title: "Export Statements",
        subtitle: "CSV/PDF encrypted reports",
        route: "/profile",
      },
    ],
  },
];

export default function Explore() {
  const navigate = useNavigate();

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-5xl mx-auto">
        {/* Page Title */}
        <div className="mb-8">
          <h1 className="text-4xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Explore
          </h1>
          <p className="text-base text-[var(--text-primary)]/50 leading-relaxed">
            Discover all BlankPay features
          </p>
        </div>

        {/* Feature Sections */}
        <div className="space-y-8">
          {sections.map((section) => (
            <div key={section.heading}>
              <p className="text-xs font-medium tracking-wide text-[var(--text-primary)]/50 uppercase mb-4 px-1">
                {section.heading}
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {section.items.map((item) => (
                  <button
                    key={item.title}
                    onClick={() => navigate(item.route)}
                    className="rounded-[2rem] glass-card p-6 hover:-translate-y-1 transition-all duration-300 text-left group"
                  >
                    <div className="flex items-start gap-4">
                      <div
                        className={cn(
                          "w-12 h-12 rounded-xl flex items-center justify-center shrink-0",
                          item.iconBg,
                        )}
                      >
                        {item.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <p className="font-medium text-[var(--text-primary)]">
                            {item.title}
                          </p>
                          <ChevronRight
                            size={18}
                            className="text-[var(--text-primary)]/30 group-hover:translate-x-0.5 transition-transform shrink-0"
                          />
                        </div>
                        <p className="text-sm text-[var(--text-primary)]/50 mt-1">
                          {item.subtitle}
                        </p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
