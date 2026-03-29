import { useState, useEffect } from "react";
import {
  Heart,
  Star,
  Crown,
  Sparkles,
  TrendingUp,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useTipCreator } from "@/hooks/useTipCreator";
import { useAccount, useWriteContract, usePublicClient } from "wagmi";
import { CreatorHubAbi } from "@/lib/abis";
import { CONTRACTS } from "@/lib/constants";
import {
  fetchCreatorProfiles,
  fetchCreatorSupporters,
  upsertCreatorProfile,
  type CreatorProfileRow,
  type CreatorSupporterRow,
} from "@/lib/supabase";

// ---------------------------------------------------------------
//  TIER OPTIONS
// ---------------------------------------------------------------

interface TierOption {
  id: number;
  name: string;
  amount: string;
  icon: typeof Heart;
  color: string;
  bgColor: string;
  borderColor: string;
}

const tiers: TierOption[] = [
  { id: 1, name: "Supporter", amount: "5", icon: Heart, color: "text-pink-600", bgColor: "bg-pink-50", borderColor: "border-pink-100" },
  { id: 2, name: "Fan", amount: "15", icon: Star, color: "text-amber-600", bgColor: "bg-amber-50", borderColor: "border-amber-100" },
  { id: 3, name: "Super Fan", amount: "50", icon: Sparkles, color: "text-purple-600", bgColor: "bg-purple-50", borderColor: "border-purple-100" },
  { id: 4, name: "Patron", amount: "100", icon: Crown, color: "text-blue-600", bgColor: "bg-blue-50", borderColor: "border-blue-100" },
];

// ---------------------------------------------------------------
//  MAIN SCREEN
// ---------------------------------------------------------------

export default function CreatorSupport() {
  const { address } = useAccount();
  const { isTipping, tip } = useTipCreator();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  const [selectedTier, setSelectedTier] = useState<number | null>(null);
  const [selectedCreator, setSelectedCreator] = useState<CreatorProfileRow | null>(null);
  const [creators, setCreators] = useState<CreatorProfileRow[]>([]);
  const [supporters, setSupporters] = useState<CreatorSupporterRow[]>([]);
  const [isLoadingCreators, setIsLoadingCreators] = useState(false);
  const [tipMessage, setTipMessage] = useState("");

  // Creator registration state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [creatorName, setCreatorName] = useState("");
  const [creatorBio, setCreatorBio] = useState("");
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);

  // Check if current user is already a creator
  const isCreator = creators.some(
    (c) => c.address.toLowerCase() === address?.toLowerCase(),
  );

  const handleCreateProfile = async () => {
    if (!address || !creatorName.trim() || !publicClient) return;
    setIsCreatingProfile(true);
    try {
      // Call contract to set profile (tier amounts as uint64 in micro-units)
      const hash = await writeContractAsync({
        address: CONTRACTS.CreatorHub,
        abi: CreatorHubAbi,
        functionName: "setProfile",
        args: [creatorName.trim(), creatorBio.trim(), BigInt(5_000000), BigInt(15_000000), BigInt(50_000000)],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      if (receipt.status === "reverted") throw new Error("Transaction reverted");

      // Write to Supabase
      await upsertCreatorProfile({
        address: address.toLowerCase(),
        name: creatorName.trim(),
        bio: creatorBio.trim(),
        avatar_url: "",
        tier1_threshold: 5,
        tier2_threshold: 15,
        tier3_threshold: 50,
        supporter_count: 0,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Refresh creators list
      const updated = await fetchCreatorProfiles();
      setCreators(updated);
      setShowCreateForm(false);
      setCreatorName("");
      setCreatorBio("");
    } catch (err) {
      console.error("Failed to create profile:", err);
    } finally {
      setIsCreatingProfile(false);
    }
  };

  // Fetch real creator profiles from Supabase
  useEffect(() => {
    setIsLoadingCreators(true);
    fetchCreatorProfiles()
      .then(setCreators)
      .finally(() => setIsLoadingCreators(false));
  }, []);

  // Fetch supporters for connected address
  useEffect(() => {
    if (!address) return;
    fetchCreatorSupporters(address.toLowerCase()).then(setSupporters);
  }, [address]);

  const handleSupport = async () => {
    if (!selectedCreator || !selectedTier) return;
    const tier = tiers.find((t) => t.id === selectedTier);
    if (!tier) return;
    await tip(selectedCreator.address, tier.amount, tipMessage || `${tier.name} tier support`);
    // Refresh supporters list after successful tip
    if (address) {
      fetchCreatorSupporters(address.toLowerCase()).then(setSupporters);
    }
    setSelectedTier(null);
    setSelectedCreator(null);
    setTipMessage("");
  };

  const getInitials = (name: string) =>
    name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2);

  const gradients = [
    "from-pink-400 to-rose-500",
    "from-violet-400 to-purple-500",
    "from-amber-400 to-orange-500",
    "from-emerald-400 to-teal-500",
    "from-cyan-400 to-blue-500",
    "from-rose-400 to-pink-500",
  ];

  const getGradient = (index: number) => gradients[index % gradients.length];

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <h1 className="text-4xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Creator Support
          </h1>
          <p className="text-base text-[var(--text-primary)]/50 leading-relaxed">
            Support your favorite creators with private tipping
          </p>
        </div>

        {/* Become a Creator */}
        {!isCreator && (
          <div className="rounded-[2rem] glass-card p-6 mb-8">
            <h3 className="text-lg font-heading font-semibold text-[var(--text-primary)] mb-2">
              Become a Creator
            </h3>
            <p className="text-sm text-[var(--text-primary)]/50 mb-4">
              Set up your profile to receive encrypted tips
            </p>
            {showCreateForm ? (
              <div className="space-y-3">
                <input
                  value={creatorName}
                  onChange={(e) => setCreatorName(e.target.value)}
                  placeholder="Your name"
                  className="h-12 w-full px-4 rounded-xl bg-white/60 border border-black/5 outline-none"
                />
                <input
                  value={creatorBio}
                  onChange={(e) => setCreatorBio(e.target.value)}
                  placeholder="Bio (optional)"
                  className="h-12 w-full px-4 rounded-xl bg-white/60 border border-black/5 outline-none"
                />
                <button
                  onClick={handleCreateProfile}
                  disabled={!creatorName.trim() || isCreatingProfile}
                  className="h-12 w-full rounded-xl bg-[#1D1D1F] text-white font-medium disabled:opacity-30"
                >
                  {isCreatingProfile ? "Creating..." : "Create Profile"}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowCreateForm(true)}
                className="h-12 px-6 rounded-xl bg-[#1D1D1F] text-white font-medium"
              >
                Set Up Profile
              </button>
            )}
          </div>
        )}

        {/* Loading State */}
        {isLoadingCreators && (
          <div className="flex items-center justify-center py-16 gap-3">
            <Loader2 size={24} className="animate-spin text-[var(--text-primary)]/40" />
            <span className="text-[var(--text-primary)]/50">Loading creators...</span>
          </div>
        )}

        {/* Empty State */}
        {!isLoadingCreators && creators.length === 0 && (
          <div className="rounded-[2rem] glass-card p-8 mb-8">
            <div className="text-center py-8 text-[var(--text-primary)]/40">
              <Heart size={48} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium text-lg mb-2">No creators registered yet</p>
              <p className="text-sm">Creator profiles will appear here once they register on the platform</p>
            </div>
          </div>
        )}

        {/* Featured Creators */}
        {creators.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            {creators.map((creator, index) => (
              <div
                key={creator.address}
                onClick={() => setSelectedCreator(creator)}
                className={cn(
                  "rounded-[2rem] glass-card p-6 hover:-translate-y-1 transition-all duration-300 cursor-pointer relative",
                  selectedCreator?.address === creator.address && "ring-2 ring-[var(--text-primary)]",
                )}
              >
                <div className="flex flex-col items-center text-center">
                  {selectedCreator?.address === creator.address && (
                    <div className="absolute top-4 right-4">
                      <CheckCircle2 size={24} className="text-[var(--text-primary)]" />
                    </div>
                  )}
                  <div className={cn("w-24 h-24 rounded-full bg-gradient-to-br flex items-center justify-center text-white text-2xl font-bold mb-4 border-4 border-white shadow-lg", getGradient(index))}>
                    {creator.avatar_url ? (
                      <img src={creator.avatar_url} alt={creator.name} className="w-full h-full rounded-full object-cover" />
                    ) : (
                      getInitials(creator.name)
                    )}
                  </div>
                  <h3 className="text-lg font-heading font-medium text-[var(--text-primary)] mb-1">{creator.name}</h3>
                  <p className="text-sm text-[var(--text-primary)]/50 mb-4 line-clamp-2">{creator.bio || "Creator"}</p>

                  <div className="w-full grid grid-cols-2 gap-3 mb-4">
                    <div className="p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10">
                      <p className="text-xs text-[var(--text-primary)]/50 mb-1">Supporters</p>
                      <p className="text-sm font-medium text-[var(--text-primary)]">{creator.supporter_count.toLocaleString()}</p>
                    </div>
                    <div className="p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10">
                      <p className="text-xs text-[var(--text-primary)]/50 mb-1">Earnings</p>
                      <p className="text-sm font-medium encrypted-text">{"\u2588\u2588\u2588\u2588\u2588"}</p>
                    </div>
                  </div>

                  <button
                    onClick={(e) => { e.stopPropagation(); setSelectedCreator(creator); }}
                    className={cn(
                      "w-full h-12 px-6 rounded-2xl font-medium transition-transform active:scale-95 flex items-center justify-center gap-2",
                      selectedCreator?.address === creator.address
                        ? "bg-emerald-500 text-white hover:bg-emerald-600"
                        : "bg-[var(--text-primary)] text-white hover:bg-[#000000]",
                    )}
                  >
                    <Heart size={18} />
                    <span>{selectedCreator?.address === creator.address ? "Selected" : "Support"}</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Support Tiers */}
        <div className="rounded-[2rem] glass-card p-8 mb-6">
          <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-2">Choose Support Tier</h3>
          {selectedCreator && (
            <p className="text-sm text-[var(--text-primary)]/50 mb-6">
              Supporting: <strong className="text-[var(--text-primary)]">{selectedCreator.name}</strong>
            </p>
          )}
          {!selectedCreator && (
            <p className="text-sm text-amber-600 mb-6">Select a creator above first</p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
            {tiers.map((tier) => {
              const Icon = tier.icon;
              const isSelected = selectedTier === tier.id;
              return (
                <button
                  key={tier.id}
                  onClick={() => setSelectedTier(tier.id)}
                  className={cn(
                    "p-6 rounded-2xl border-2 transition-all",
                    isSelected
                      ? `${tier.bgColor} ${tier.borderColor} scale-105`
                      : "bg-white/50 border-black/5 hover:bg-white/70",
                  )}
                >
                  <div className="flex flex-col items-center text-center">
                    <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center mb-3", tier.bgColor)}>
                      <Icon size={24} className={tier.color} />
                    </div>
                    <p className="text-sm font-medium text-[var(--text-primary)] mb-1">{tier.name}</p>
                    <p className="text-2xl font-heading font-medium text-[var(--text-primary)]">${tier.amount}</p>
                  </div>
                </button>
              );
            })}
          </div>

          {selectedTier && (
            <div className="space-y-4">
              <div>
                <label className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-2 block">Custom Message (Optional)</label>
                <textarea
                  value={tipMessage}
                  onChange={(e) => setTipMessage(e.target.value)}
                  placeholder="Say something nice..."
                  rows={3}
                  className="w-full px-5 py-4 rounded-2xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 focus:border-black/20 focus:ring-4 focus:ring-black/5 outline-none transition-all placeholder:text-black/30 resize-none"
                />
              </div>

              <button
                onClick={handleSupport}
                disabled={isTipping || !selectedCreator}
                className="w-full h-14 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center justify-center gap-2 disabled:opacity-60"
              >
                {isTipping ? <Loader2 size={20} className="animate-spin" /> : <Heart size={20} />}
                <span>{isTipping ? "Sending encrypted tip..." : `Send $${tiers.find((t) => t.id === selectedTier)?.amount} Support`}</span>
              </button>
            </div>
          )}
        </div>

        {/* My Supported Creators */}
        <div className="rounded-[2rem] glass-card p-8">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">My Supported Creators</h3>
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-50 border border-emerald-100">
              <TrendingUp size={16} className="text-emerald-600" />
              <span className="text-sm font-medium text-emerald-600">{supporters.length} Supported</span>
            </div>
          </div>

          {supporters.length === 0 ? (
            <div className="text-center py-8 text-[var(--text-primary)]/40">
              <Heart size={40} className="mx-auto mb-3 opacity-30" />
              <p>No creators supported yet</p>
            </div>
          ) : (
            <div className="space-y-3">
              {supporters.map((support, index) => (
                <div
                  key={support.id}
                  className="flex items-center justify-between p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10"
                >
                  <div className="flex items-center gap-4">
                    <div className={cn("w-12 h-12 rounded-full bg-gradient-to-br flex items-center justify-center text-white text-sm font-bold", getGradient(index))}>
                      {support.creator_address.slice(2, 4).toUpperCase()}
                    </div>
                    <div>
                      <p className="font-medium text-[var(--text-primary)] font-mono text-sm">
                        {support.creator_address.slice(0, 6)}...{support.creator_address.slice(-4)}
                      </p>
                      <p className="text-sm text-[var(--text-primary)]/50">
                        {support.message || "Supporter"} &middot; {new Date(support.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-medium encrypted-text">
                      ${"\u2588\u2588\u2588.\u2588\u2588"}
                    </p>
                    <p className="text-sm text-emerald-600">Active</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
