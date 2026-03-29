import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useCallback } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { useNavigate } from "react-router-dom";
import { Heart, Plus, Crown, Medal, Award, ArrowRight, RefreshCw, Shield } from "lucide-react";
import { pageVariants, staggerContainer, fadeInUp } from "@/lib/animations";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { useTipCreator } from "@/hooks/useTipCreator";
import { useEncryptedBalance } from "@/hooks/useEncryptedBalance";
import { CONTRACTS } from "@/lib/constants";
import { CreatorHubAbi } from "@/lib/abis";
import { fetchCreatorProfiles, upsertCreatorProfile, type CreatorProfileRow } from "@/lib/supabase";
import toast from "react-hot-toast";

type Tab = "browse" | "my-profile" | "supporting";

export function CreatorsPage() {
  const { isConnected, address } = useAccount();
  const { hasBalance } = useEncryptedBalance();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("browse");
  const [showSetup, setShowSetup] = useState(false);
  const { tip, isTipping } = useTipCreator();
  const { writeContractAsync } = useWriteContract();

  // Profile form state
  const [profileName, setProfileName] = useState("");
  const [profileBio, setProfileBio] = useState("");
  const [tier1, setTier1] = useState("10");
  const [tier2, setTier2] = useState("50");
  const [tier3, setTier3] = useState("200");

  // Tip form state
  const [tipCreator, setTipCreator] = useState("");
  const [tipAmount, setTipAmount] = useState("");
  const [tipMessage, setTipMessage] = useState("");

  // Data
  const [profiles, setProfiles] = useState<CreatorProfileRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshData = useCallback(async () => {
    setLoading(true);
    const data = await fetchCreatorProfiles();
    setProfiles(data);
    setLoading(false);
  }, []);

  // Fetch on mount + poll every 30s
  useEffect(() => {
    refreshData();
    const interval = setInterval(() => refreshData(), 30000);
    return () => clearInterval(interval);
  }, [refreshData]);

  if (!isConnected) return <ConnectPrompt />;

  const handleCreateProfile = async () => {
    if (!profileName.trim() || !address) return;
    try {
      const t1 = BigInt(parseFloat(tier1) * 1e6);
      const t2 = BigInt(parseFloat(tier2) * 1e6);
      const t3 = BigInt(parseFloat(tier3) * 1e6);

      await writeContractAsync({
        address: CONTRACTS.CreatorHub as `0x${string}`,
        abi: CreatorHubAbi,
        functionName: "setProfile",
        args: [profileName, profileBio, t1, t2, t3],
      });

      await upsertCreatorProfile({
        address,
        name: profileName,
        bio: profileBio,
        avatar_url: "",
        tier1_threshold: Number(t1),
        tier2_threshold: Number(t2),
        tier3_threshold: Number(t3),
        supporter_count: 0,
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      toast.success("Profile created!");
      setShowSetup(false);
      await refreshData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create profile");
    }
  };

  const handleTip = async () => {
    if (!tipCreator || !tipAmount) return;
    await tip(tipCreator, tipAmount, tipMessage);
    setTipCreator("");
    setTipAmount("");
    setTipMessage("");
  };

  return (
    <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit" className="space-y-6">
      {!hasBalance && (
        <GlassCard className="!rounded-[2rem] !bg-warning/5 !border-warning/20">
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 text-warning shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-semibold text-warning">Shield tokens first</p>
              <p className="text-xs text-warning/70 mt-1">You need to shield USDC into your encrypted vault before tipping creators. Go to Dashboard and click &ldquo;Shield Tokens&rdquo;.</p>
              <Button variant="secondary" size="sm" className="mt-3" onClick={() => navigate("/")}>
                Go to Dashboard
              </Button>
            </div>
          </div>
        </GlassCard>
      )}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-white">Creator Tips</h1>
          <p className="text-base text-apple-secondary font-medium mt-1">Support creators with encrypted amounts</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refreshData} className="text-xs text-apple-secondary hover:text-white transition-colors flex items-center gap-1">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
          <Button variant="primary" size="md" icon={<Plus className="w-4 h-4" />} onClick={() => setShowSetup(!showSetup)}>
            Create Profile
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-glass-surface border border-glass-border rounded-xl p-1">
        {(["browse", "supporting", "my-profile"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className="relative flex-1 py-2 text-sm font-medium rounded-lg transition-colors">
            {tab === t && (
              <motion.div layoutId="creator-tab" className="absolute inset-0 bg-glass-hover border border-glass-border-hover rounded-lg"
                transition={{ type: "spring", stiffness: 400, damping: 30 }} />
            )}
            <span className={`relative z-10 capitalize ${tab === t ? "text-white" : "text-sm font-medium text-apple-secondary"}`}>{t.replace("-", " ")}</span>
          </button>
        ))}
      </div>

      {/* Create Profile Form */}
      <AnimatePresence>
        {showSetup && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            <GlassCard variant="elevated" className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl bg-pink-500/10 border border-pink-500/20 flex items-center justify-center">
                  <Heart className="w-5 h-5 text-pink-400" />
                </div>
                <div>
                  <h3 className="text-subheading font-semibold">Create Creator Profile</h3>
                  <p className="text-caption text-apple-secondary">Set up your tip page and tier badges</p>
                </div>
              </div>
              <div className="space-y-4">
                <Input label="Display Name" placeholder="Your creator name" value={profileName} onChange={(e) => setProfileName(e.target.value)} />
                <Input label="Bio" placeholder="Short description" value={profileBio} onChange={(e) => setProfileBio(e.target.value)} />
                <div className="grid grid-cols-3 gap-3">
                  <Input label="Bronze" placeholder="10" value={tier1} onChange={(e) => setTier1(e.target.value)}
                    hint="USDC" rightElement={<Medal className="w-3.5 h-3.5 text-orange-400" />} />
                  <Input label="Silver" placeholder="50" value={tier2} onChange={(e) => setTier2(e.target.value)}
                    rightElement={<Award className="w-3.5 h-3.5 text-neutral-400" />} />
                  <Input label="Gold" placeholder="200" value={tier3} onChange={(e) => setTier3(e.target.value)}
                    rightElement={<Crown className="w-3.5 h-3.5 text-yellow-400" />} />
                </div>
                <Button variant="primary" size="lg" className="w-full" icon={<ArrowRight className="w-4 h-4" />}
                  onClick={handleCreateProfile} disabled={!profileName.trim()}>
                  Create Profile
                </Button>
              </div>
            </GlassCard>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Browse tab — show creators + tip form */}
      {tab === "browse" && (
        <div className="space-y-4">
          {/* Tip form */}
          <GlassCard>
            <h3 className="text-subheading font-semibold mb-4">Tip a Creator</h3>
            <div className="space-y-3">
              <Input label="Creator Address" placeholder="0x..." value={tipCreator} onChange={(e) => setTipCreator(e.target.value)} />
              <Input label="Amount (USDC)" placeholder="5.00" value={tipAmount} onChange={(e) => setTipAmount(e.target.value)} />
              <Input label="Message (optional)" placeholder="Love your work!" value={tipMessage} onChange={(e) => setTipMessage(e.target.value)} />
              <Button variant="primary" size="md" icon={<Heart className="w-4 h-4" />}
                onClick={handleTip} loading={isTipping} disabled={!tipCreator || !tipAmount}>
                Send Tip
              </Button>
            </div>
          </GlassCard>

          {/* Creator list */}
          <motion.div variants={staggerContainer} initial="initial" animate="animate" className="space-y-2">
            {loading ? (
              [1, 2, 3].map((i) => <div key={i} className="shimmer h-20 rounded-xl" style={{ animationDelay: `${i * 0.15}s` }} />)
            ) : profiles.length > 0 ? (
              profiles.map((p) => (
                <motion.div key={p.address} variants={fadeInUp}>
                  <GlassCard variant="interactive" className="flex items-center justify-between !rounded-[2rem]"
                    onClick={() => { setTipCreator(p.address); setTab("browse"); }}>
                    <div>
                      <p className="text-sm font-semibold text-white">{p.name}</p>
                      <p className="text-caption text-apple-secondary">{p.bio}</p>
                      <p className="text-caption text-neutral-600">{p.supporter_count} supporters</p>
                    </div>
                    <Button variant="secondary" size="sm" icon={<Heart className="w-3 h-3" />}
                      onClick={(e) => { e.stopPropagation(); setTipCreator(p.address); }}>
                      Tip
                    </Button>
                  </GlassCard>
                </motion.div>
              ))
            ) : (
              <GlassCard className="py-12">
                <div className="flex flex-col items-center justify-center">
                  <div className="relative mb-6">
                    <motion.div
                      animate={{ scale: [1, 1.3, 1], opacity: [0.15, 0.05, 0.15] }}
                      transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                      className="absolute inset-0 rounded-2xl bg-accent/20"
                      style={{ filter: "blur(16px)" }}
                      aria-hidden="true"
                    />
                    <div className="relative w-16 h-16 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                      <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}>
                        <Heart className="w-8 h-8 text-text-muted" />
                      </motion.div>
                    </div>
                  </div>
                  <p className="text-heading-3 font-semibold text-text-secondary mb-1.5">No creators yet</p>
                  <p className="text-body text-text-muted text-center max-w-xs mb-6">Create a profile to start receiving tips from supporters</p>
                  <Button variant="primary" size="md" icon={<Plus className="w-4 h-4" />} onClick={() => setShowSetup(true)}>
                    Create Your Profile
                  </Button>
                </div>
              </GlassCard>
            )}
          </motion.div>
        </div>
      )}

      {/* Other tabs — placeholder for now */}
      {tab !== "browse" && (
        <GlassCard className="py-12">
          <div className="flex flex-col items-center justify-center">
            <div className="relative mb-6">
              <motion.div
                animate={{ scale: [1, 1.3, 1], opacity: [0.15, 0.05, 0.15] }}
                transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                className="absolute inset-0 rounded-2xl bg-accent/20"
                style={{ filter: "blur(16px)" }}
                aria-hidden="true"
              />
              <div className="relative w-16 h-16 rounded-2xl bg-white/[0.04] border border-white/[0.08] flex items-center justify-center">
                <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}>
                  <Heart className="w-8 h-8 text-text-muted" />
                </motion.div>
              </div>
            </div>
            <p className="text-heading-3 font-semibold text-text-secondary mb-1.5">
              {tab === "supporting" ? "Not supporting anyone yet" : "No profile created"}
            </p>
            <p className="text-body text-text-muted text-center max-w-xs mb-6">
              {tab === "supporting" ? "Browse creators and send your first tip" : "Set up your creator profile to receive tips"}
            </p>
            <Button variant="primary" size="md" icon={<Plus className="w-4 h-4" />}
              onClick={() => tab === "supporting" ? setTab("browse") : setShowSetup(true)}>
              {tab === "supporting" ? "Browse Creators" : "Create Your Profile"}
            </Button>
          </div>
        </GlassCard>
      )}
    </motion.div>
  );
}
