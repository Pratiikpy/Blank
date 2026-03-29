import { motion, AnimatePresence } from "framer-motion";
import { useState } from "react";
import { useAccount } from "wagmi";
import { ArrowLeftRight, Plus, ArrowRight, RefreshCw, X, Clock, Loader2 } from "lucide-react";
import { pageVariants, staggerContainer, fadeInUp } from "@/lib/animations";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { PillTabs } from "@/components/ui/PillTabs";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { GradientAvatar } from "@/components/common/GradientAvatar";
import { GradientSearchBar } from "@/components/ui/GradientSearchBar";
import { useExchange } from "@/hooks/useExchange";
import { isOfflineMode } from "@/lib/supabase";

type Tab = "offers" | "my-offers";

const tabs = [
  { id: "offers" as Tab, label: "All Offers" },
  { id: "my-offers" as Tab, label: "My Offers" },
];

export function ExchangePage() {
  const { isConnected, address } = useAccount();
  const { offers, isLoadingOffers, createOffer, fillOffer, cancelOffer, step, error, reset } = useExchange();
  const [tab, setTab] = useState<Tab>("offers");
  const [showCreate, setShowCreate] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [giveAmount, setGiveAmount] = useState("");
  const [wantAmount, setWantAmount] = useState("");
  const [expiry, setExpiry] = useState("");

  if (!isConnected) return <ConnectPrompt />;

  const myOffers = offers.filter((o) => o.maker_address.toLowerCase() === address?.toLowerCase());
  const baseOffers = tab === "my-offers" ? myOffers : offers;
  const displayOffers = searchQuery.trim()
    ? baseOffers.filter((o) => {
        // Filter expired offers
        if (o.expiry && new Date(o.expiry) < new Date()) return false;
        const q = searchQuery.toLowerCase();
        return (
          o.maker_address.toLowerCase().includes(q) ||
          String(o.amount_give).toLowerCase().includes(q) ||
          String(o.amount_want).toLowerCase().includes(q)
        );
      })
    : baseOffers.filter((o) => !o.expiry || new Date(o.expiry) >= new Date());

  const handleCreate = async () => {
    if (!giveAmount || !wantAmount || !expiry) return;
    await createOffer(giveAmount, wantAmount, expiry);
    // Clear unconditionally — createOffer only returns on success (errors caught internally)
    setGiveAmount("");
    setWantAmount("");
    setExpiry("");
    setShowCreate(false);
  };

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit" className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">P2P Exchange</h1>
          <p className="text-base text-apple-secondary font-medium mt-1">Swap tokens directly with other users</p>
        </div>
        <Button
          variant="primary"
          size="md"
          icon={showCreate ? <X className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
          onClick={() => { setShowCreate(!showCreate); reset(); }}
        >
          {showCreate ? "Cancel" : "Create Offer"}
        </Button>
      </div>

      {/* Create Offer Form */}
      <AnimatePresence>
        {showCreate && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <GlassCard variant="elevated" className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                  <ArrowLeftRight className="w-5 h-5 text-cyan-400" />
                </div>
                <div>
                  <h3 className="text-subheading font-semibold">Create Swap Offer</h3>
                  <p className="text-caption text-apple-secondary">Order size is public, settlement is encrypted</p>
                </div>
              </div>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <Input
                    label="You Give (USDC)"
                    placeholder="100"
                    value={giveAmount}
                    onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setGiveAmount(v); }}
                    isAmount
                  />
                  <Input
                    label="You Want (USDC)"
                    placeholder="95"
                    value={wantAmount}
                    onChange={(e) => { const v = e.target.value; if (/^\d*\.?\d{0,6}$/.test(v) || v === "") setWantAmount(v); }}
                    isAmount
                  />
                </div>
                <div className="flex justify-center">
                  <button
                    onClick={() => { const tmp = giveAmount; setGiveAmount(wantAmount); setWantAmount(tmp); }}
                    className="w-8 h-8 rounded-full bg-glass-strong flex items-center justify-center hover:rotate-180 transition-transform duration-300 cursor-pointer"
                  >
                    <RefreshCw className="w-4 h-4 text-neutral-500" />
                  </button>
                </div>
                <Input
                  label="Expiry"
                  type="datetime-local"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                />
                {error && (
                  <p className="text-sm text-error">{error}</p>
                )}
                <Button
                  variant="primary"
                  size="lg"
                  className="w-full"
                  icon={step === "sending" || step === "approving" ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowRight className="w-4 h-4" />}
                  onClick={handleCreate}
                  loading={step === "sending" || step === "approving"}
                  disabled={!giveAmount || !wantAmount || !expiry}
                >
                  {step === "approving" ? "Approving..." : step === "sending" ? "Creating..." : "Post Offer"}
                </Button>
              </div>
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tabs */}
      <PillTabs
        tabs={tabs}
        activeTab={tab}
        onTabChange={(t) => setTab(t as Tab)}
        layoutId="exchange-tab"
      />

      {/* Search */}
      <GradientSearchBar
        value={searchQuery}
        onChange={setSearchQuery}
        placeholder="Search by address or amount..."
      />

      {/* Offers List */}
      <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-3">
        {isLoadingOffers ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="shimmer h-20 rounded-2xl" style={{ animationDelay: `${i * 0.15}s` }} />
            ))}
          </div>
        ) : displayOffers.length > 0 ? (
          displayOffers.map((offer, index) => (
            <motion.div key={offer.id || index} variants={fadeInUp}>
              <GlassCard className="flex items-center gap-4">
                <GradientAvatar address={offer.maker_address} size="md" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="font-medium text-white">
                      {offer.maker_address.slice(0, 6)}...{offer.maker_address.slice(-4)}
                    </span>
                    <span className="text-neutral-600">offers</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-xs">
                    <span className="font-mono tabular-nums text-accent">{offer.amount_give} USDC</span>
                    <ArrowRight className="w-3 h-3 text-neutral-600" />
                    <span className="font-mono tabular-nums text-cyan-400">{offer.amount_want} USDC</span>
                  </div>
                </div>
                <div className="text-right shrink-0 flex flex-col items-end gap-1">
                  {offer.expiry && (
                    <div className="flex items-center gap-1 text-[10px] text-neutral-600">
                      <Clock className="w-3 h-3" />
                      {new Date(offer.expiry).toLocaleDateString()}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    {offer.status === "active" && offer.maker_address.toLowerCase() !== address?.toLowerCase() && (
                      <Button variant="primary" size="sm" onClick={() => fillOffer(offer.offer_id)} loading={step === "sending"}>
                        Accept
                      </Button>
                    )}
                    {tab === "my-offers" && offer.status === "active" ? (
                      <Button variant="danger" size="sm" onClick={() => { if (window.confirm("Cancel this offer? This is an on-chain transaction.")) cancelOffer(offer.offer_id); }}>
                        Cancel
                      </Button>
                    ) : (
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        offer.status === "active" ? "bg-accent/10 text-accent" :
                        offer.status === "filled" ? "bg-blue-400/10 text-blue-400" :
                        "bg-neutral-500/10 text-neutral-500"
                      }`}>
                        {offer.status}
                      </span>
                    )}
                  </div>
                </div>
              </GlassCard>
            </motion.div>
          ))
        ) : (
          <motion.div variants={fadeInUp}>
            <GlassCard className="py-12">
              <div className="flex flex-col items-center justify-center">
                <div className="relative mb-6">
                  <motion.div
                    animate={{ scale: [1, 1.3, 1], opacity: [0.15, 0.05, 0.15] }}
                    transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                    className="absolute inset-0 rounded-2xl bg-cyan-400/20"
                    style={{ filter: "blur(16px)" }}
                    aria-hidden="true"
                  />
                  <div className="relative w-16 h-16 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                    <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}>
                      <ArrowLeftRight className="w-8 h-8 text-neutral-600" />
                    </motion.div>
                  </div>
                </div>
                <p className="text-lg font-semibold text-neutral-300 mb-1.5">No offers yet</p>
                <p className="text-sm text-neutral-500 text-center max-w-xs mb-6">Create an offer to start trading</p>
                {isOfflineMode() && (
                  <p className="text-xs text-warning text-center max-w-xs mb-4">P2P Exchange requires Supabase configuration for offer discovery.</p>
                )}
                <Button
                  variant="primary"
                  size="md"
                  icon={<Plus className="w-4 h-4" />}
                  onClick={() => setShowCreate(true)}
                >
                  Create First Offer
                </Button>
              </div>
            </GlassCard>
          </motion.div>
        )}
      </motion.div>
    </motion.div>
  );
}
