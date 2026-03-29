import { motion } from "framer-motion";
import { useState } from "react";
import { useAccount } from "wagmi";
import { Link2, Copy, Check, QrCode, Share2, Lock, Store, Hash } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { pageVariants, staggerContainer, fadeInUp } from "@/lib/animations";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { APP_NAME } from "@/lib/constants";
import { copyToClipboard as clipboardCopy } from "@/lib/clipboard";

function generateOrderId(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function ReceivePage() {
  const { isConnected, address } = useAccount();
  const [copied, setCopied] = useState<"address" | "link" | "merchant" | null>(null);
  const [suggestedAmount, setSuggestedAmount] = useState("");
  const [note, setNote] = useState("");

  // Merchant link state
  const [merchantName, setMerchantName] = useState("");
  const [merchantAmount, setMerchantAmount] = useState("");
  const [merchantOrderId, setMerchantOrderId] = useState(() => generateOrderId());

  if (!isConnected || !address) return <ConnectPrompt />;

  const paymentUrl = `${window.location.origin}/pay?to=${address}${suggestedAmount ? `&suggestedAmount=${suggestedAmount}` : ""}${note ? `&note=${encodeURIComponent(note)}` : ""}`;

  const copyToClipboard = async (text: string, type: "address" | "link" | "merchant") => {
    await clipboardCopy(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <motion.div
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="max-w-lg mx-auto space-y-6"
    >
      {/* Header */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}>
        <h1 className="text-3xl font-semibold tracking-tight text-white">Receive</h1>
        <p className="text-base text-apple-secondary font-medium mt-1">
          Share your address or QR code to receive encrypted payments
        </p>
      </motion.div>

      {/* QR Code Hero Card */}
      <GlassCard variant="elevated" className="relative overflow-hidden text-center !bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
        {/* Decorative glow */}
        <div
          className="absolute -top-16 -right-16 w-48 h-48 rounded-full pointer-events-none"
          style={{ background: "radial-gradient(circle, rgba(139,92,246,0.08) 0%, transparent 70%)" }}
          aria-hidden="true"
        />

        <div className="relative">
          {/* QR label */}
          <div className="flex items-center justify-center gap-2 mb-4">
            <QrCode className="w-4 h-4 text-accent/60" />
            <span className="label">Scan to Pay</span>
          </div>

          {/* QR Code */}
          <div className="inline-block p-5 bg-white rounded-2xl shadow-[0_0_20px_rgba(255,255,255,0.1)]">
            <QRCodeSVG
              value={paymentUrl}
              size={180}
              level="H"
              bgColor="#ffffff"
              fgColor="#000000"
            />
          </div>

          {/* Address */}
          <div className="mt-5">
            <p className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider mb-2">Your address</p>
            <button
              onClick={() => copyToClipboard(address, "address")}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-glass-surface border border-glass-border hover:border-glass-border-hover hover:bg-glass-hover transition-all duration-200 text-sm font-mono text-neutral-300 group"
            >
              {address.slice(0, 8)}...{address.slice(-6)}
              <span className="text-neutral-600 group-hover:text-neutral-400 transition-colors">
                {copied === "address" ? (
                  <Check className="w-3.5 h-3.5 text-accent" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </span>
            </button>
          </div>

          {/* Privacy note */}
          <div className="flex items-center justify-center gap-1.5 mt-4 text-caption text-encrypted/50">
            <Lock className="w-3 h-3" />
            All payment amounts are FHE-encrypted
          </div>
        </div>
      </GlassCard>

      {/* Payment Link Customization */}
      <GlassCard className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
        <div className="flex items-center gap-2 mb-4">
          <Share2 className="w-4 h-4 text-accent/60" />
          <h3 className="text-subheading font-semibold">Payment Link</h3>
        </div>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          animate="animate"
          className="space-y-4"
        >
          <motion.div variants={fadeInUp}>
            <Input
              label="Suggested Amount (optional)"
              placeholder="25.00"
              value={suggestedAmount}
              onChange={(e) => setSuggestedAmount(e.target.value)}
              hint="The payer can change this — it's just a suggestion"
            />
          </motion.div>

          <motion.div variants={fadeInUp}>
            <Input
              label="Note (optional)"
              placeholder="Coffee money, rent, etc."
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </motion.div>

          <motion.div variants={fadeInUp}>
            <div className="rounded-xl bg-void-surface border border-glass-border p-3.5">
              <p className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider mb-1.5">Generated link</p>
              <p className="text-xs font-mono text-apple-secondary break-all leading-relaxed">
                {paymentUrl}
              </p>
            </div>
          </motion.div>

          <motion.div variants={fadeInUp}>
            <Button
              variant="secondary"
              size="lg"
              className="w-full"
              onClick={() => copyToClipboard(paymentUrl, "link")}
              icon={copied === "link" ? <Check className="w-4 h-4 text-accent" /> : <Link2 className="w-4 h-4" />}
            >
              {copied === "link" ? "Copied!" : "Copy Payment Link"}
            </Button>
          </motion.div>
        </motion.div>
      </GlassCard>

      {/* ─── Merchant Checkout Link ────────────────────────────────────── */}
      <GlassCard className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
        <div className="flex items-center gap-2 mb-4">
          <Store className="w-4 h-4 text-accent/60" />
          <h3 className="text-subheading font-semibold">Merchant Checkout Link</h3>
        </div>
        <p className="text-xs text-neutral-500 mb-4 leading-relaxed">
          Generate a checkout URL that anyone can use to pay you. Share it on your website, social media, or in messages.
        </p>

        <motion.div
          variants={staggerContainer}
          initial="initial"
          animate="animate"
          className="space-y-4"
        >
          <motion.div variants={fadeInUp}>
            <Input
              label="Merchant / Business Name"
              placeholder="CoffeeShop, MyStore, etc."
              value={merchantName}
              onChange={(e) => setMerchantName(e.target.value)}
            />
          </motion.div>

          <motion.div variants={fadeInUp}>
            <Input
              label="Amount (USDC)"
              placeholder="25.00"
              value={merchantAmount}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "" || /^\d*\.?\d{0,6}$/.test(v)) {
                  setMerchantAmount(v);
                }
              }}
              isAmount
            />
          </motion.div>

          <motion.div variants={fadeInUp}>
            <div className="flex items-center gap-3">
              <div className="flex-1">
                <Input
                  label="Order ID"
                  value={merchantOrderId}
                  onChange={(e) => setMerchantOrderId(e.target.value)}
                  rightElement={<Hash className="w-3.5 h-3.5" />}
                />
              </div>
              <button
                onClick={() => setMerchantOrderId(generateOrderId())}
                className="mt-6 h-12 px-3 rounded-xl bg-white/[0.04] border border-white/[0.08] text-xs text-neutral-400 hover:bg-white/[0.08] hover:border-white/[0.14] transition-all"
                aria-label="Generate new order ID"
              >
                New ID
              </button>
            </div>
          </motion.div>

          {/* Generated checkout URL */}
          <motion.div variants={fadeInUp}>
            {(() => {
              const checkoutUrl = `${window.location.origin}/checkout?to=${address}${merchantAmount ? `&amount=${merchantAmount}` : ""}${merchantName ? `&merchant=${encodeURIComponent(merchantName)}` : ""}&token=USDC${merchantOrderId ? `&orderId=${encodeURIComponent(merchantOrderId)}` : ""}`;
              return (
                <>
                  <div className="rounded-xl bg-void-surface border border-glass-border p-3.5">
                    <p className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider mb-1.5">
                      Checkout URL
                    </p>
                    <p className="text-xs font-mono text-apple-secondary break-all leading-relaxed">
                      {checkoutUrl}
                    </p>
                  </div>

                  {/* QR Code for merchant link */}
                  <div className="flex justify-center mt-4">
                    <div className="inline-block p-4 bg-white rounded-2xl shadow-[0_0_20px_rgba(255,255,255,0.08)]">
                      <QRCodeSVG
                        value={checkoutUrl}
                        size={160}
                        level="H"
                        bgColor="#ffffff"
                        fgColor="#000000"
                      />
                    </div>
                  </div>

                  <Button
                    variant="secondary"
                    size="lg"
                    className="w-full mt-4"
                    onClick={() => copyToClipboard(checkoutUrl, "merchant")}
                    icon={
                      copied === "merchant" ? (
                        <Check className="w-4 h-4 text-accent" />
                      ) : (
                        <Link2 className="w-4 h-4" />
                      )
                    }
                  >
                    {copied === "merchant" ? "Copied!" : "Copy Checkout Link"}
                  </Button>
                </>
              );
            })()}
          </motion.div>
        </motion.div>
      </GlassCard>

      {/* Info footer */}
      <div className="text-center pb-4">
        <p className="text-caption text-neutral-700">
          {APP_NAME} uses Fhenix CoFHE for end-to-end amount encryption
        </p>
      </div>
    </motion.div>
  );
}
