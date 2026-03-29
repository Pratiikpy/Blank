import { motion } from "framer-motion";
import { useState } from "react";
import { useAccount, useReadContract } from "wagmi";
import {
  ShieldCheck,
  Lock,
  Calculator,
  FileSearch,
  Info,
  XCircle,
  Loader2,
} from "lucide-react";
import { pageVariants, staggerContainer, fadeInUp } from "@/lib/animations";
import { GlassCard } from "@/components/ui/GlassCard";
import { Input } from "@/components/ui/Input";
import { ConnectPrompt } from "@/components/wallet/ConnectPrompt";
import { CONTRACTS, ENCRYPTED_PLACEHOLDER } from "@/lib/constants";
import { EncryptedFlagsAbi } from "@/lib/abis";

// ─── Status Row Component ───────────────────────────────────────────

interface StatusRowProps {
  label: string;
  description: string;
  isLoading: boolean;
  hasData: boolean;
  error: boolean;
}

function StatusRow({ label, description, isLoading, hasData, error }: StatusRowProps) {
  return (
    <div className="flex items-center justify-between px-4 py-3.5 min-h-[44px]">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="text-xs text-neutral-500 mt-0.5">{description}</p>
      </div>
      <div className="shrink-0 ml-4">
        {isLoading ? (
          <div className="flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 text-neutral-500 animate-spin" />
            <span className="text-xs text-neutral-500">Loading...</span>
          </div>
        ) : error ? (
          <div className="flex items-center gap-1.5 text-neutral-600">
            <XCircle className="w-3.5 h-3.5" />
            <span className="text-xs">Unavailable</span>
          </div>
        ) : hasData ? (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-violet-500/10 border border-violet-500/20">
            <Lock className="w-3 h-3 text-violet-400" />
            <span className="text-xs font-medium text-violet-400">
              Encrypted
            </span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-neutral-600">
            <XCircle className="w-3.5 h-3.5" />
            Not set
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Audit Bit Info ─────────────────────────────────────────────────

const AUDIT_BITS = [
  { bit: 0, label: "Transaction Amounts", description: "Encrypted transfer values" },
  { bit: 1, label: "Counterparty Identity", description: "Who you transact with" },
  { bit: 2, label: "Transaction Timestamps", description: "When transfers occur" },
  { bit: 3, label: "Token Types", description: "Which tokens are used" },
  { bit: 4, label: "Running Totals", description: "Aggregate volume data" },
  { bit: 5, label: "Balance Snapshots", description: "Point-in-time balances" },
  { bit: 6, label: "Fee Records", description: "Fee amounts paid" },
  { bit: 7, label: "Receipt Data", description: "Payment receipt details" },
];

// ─── Component ──────────────────────────────────────────────────────

export function CompliancePage() {
  const { isConnected, address } = useAccount();
  const [feeCheckAmount, setFeeCheckAmount] = useState("");

  if (!isConnected || !address) return <ConnectPrompt />;

  // ── Read encrypted flag status ──────────────────────────────────
  // These return ebool handles (uint256). The fact that we get a non-zero
  // value means the flag exists in encrypted form. The actual boolean
  // value is only visible to the user via permit-based unsealing.

  const {
    data: verifiedData,
    isLoading: verifiedLoading,
    isError: verifiedError,
  } = useReadContract({
    address: CONTRACTS.EncryptedFlags,
    abi: EncryptedFlagsAbi,
    functionName: "getMyVerifiedStatus",
    query: { enabled: !!address },
  });

  const {
    data: activeData,
    isLoading: activeLoading,
    isError: activeError,
  } = useReadContract({
    address: CONTRACTS.EncryptedFlags,
    abi: EncryptedFlagsAbi,
    functionName: "getMyActiveStatus",
    query: { enabled: !!address },
  });

  const {
    data: kycData,
    isLoading: kycLoading,
    isError: kycError,
  } = useReadContract({
    address: CONTRACTS.EncryptedFlags,
    abi: EncryptedFlagsAbi,
    functionName: "getMyKYCStatus",
    query: { enabled: !!address },
  });

  const {
    data: merchantData,
    isLoading: merchantLoading,
    isError: merchantError,
  } = useReadContract({
    address: CONTRACTS.EncryptedFlags,
    abi: EncryptedFlagsAbi,
    functionName: "getMyMerchantStatus",
    query: { enabled: !!address },
  });

  return (
    <motion.div
      variants={pageVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="space-y-6"
    >
      {/* ── Header ── */}
      <div>
        <h1 className="text-heading-1 font-semibold tracking-tight text-white">
          Compliance & Flags
        </h1>
        <p className="text-base text-apple-secondary font-medium mt-1">
          Encrypted identity verification
        </p>
      </div>

      <motion.div
        variants={staggerContainer}
        initial="initial"
        animate="animate"
        className="space-y-6"
      >
        {/* ── My Status Card ── */}
        <motion.div variants={fadeInUp}>
          <GlassCard
            variant="elevated"
            className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]"
          >
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
                <ShieldCheck className="w-5 h-5 text-violet-400" />
              </div>
              <div>
                <h3 className="text-subheading font-semibold">My Status</h3>
                <p className="text-caption text-apple-secondary">
                  Your encrypted compliance flags
                </p>
              </div>
            </div>

            <div className="rounded-xl bg-glass-surface border border-glass-border divide-y divide-glass-border overflow-hidden">
              <StatusRow
                label="Verified"
                description="Account identity verified"
                isLoading={verifiedLoading}
                hasData={!!verifiedData && BigInt(verifiedData as string | number | bigint) !== 0n}
                error={verifiedError}
              />
              <StatusRow
                label="Active"
                description="Account is active and in good standing"
                isLoading={activeLoading}
                hasData={!!activeData && BigInt(activeData as string | number | bigint) !== 0n}
                error={activeError}
              />
              <StatusRow
                label="KYC"
                description="Know Your Customer verification"
                isLoading={kycLoading}
                hasData={!!kycData && BigInt(kycData as string | number | bigint) !== 0n}
                error={kycError}
              />
              <StatusRow
                label="Merchant"
                description="Approved as a merchant account"
                isLoading={merchantLoading}
                hasData={!!merchantData && BigInt(merchantData as string | number | bigint) !== 0n}
                error={merchantError}
              />
            </div>

            {/* Privacy note */}
            <div className="mt-4 rounded-xl bg-violet-500/[0.04] border border-violet-500/15 px-4 py-3 flex items-start gap-2.5">
              <Lock className="w-4 h-4 text-violet-400 shrink-0 mt-0.5" />
              <p className="text-xs text-violet-400/80 leading-relaxed">
                Your compliance status is encrypted on-chain as{" "}
                <code className="font-mono text-violet-300 bg-violet-500/10 px-1 py-0.5 rounded">
                  ebool
                </code>{" "}
                handles. Only you can decrypt and view the actual values using
                an active FHE permit. Nobody else can see whether you are
                verified, active, KYC'd, or a merchant.
              </p>
            </div>
          </GlassCard>
        </motion.div>

        {/* ── Fee Calculator Card ── */}
        <motion.div variants={fadeInUp}>
          <GlassCard
            variant="elevated"
            className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]"
          >
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                <Calculator className="w-5 h-5 text-emerald-400" />
              </div>
              <div>
                <h3 className="text-subheading font-semibold">
                  Fee Calculator
                </h3>
                <p className="text-caption text-apple-secondary">
                  Estimate fees on encrypted amounts
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <Input
                label="Amount (USDC)"
                placeholder="1000.00"
                isAmount
                value={feeCheckAmount}
                onChange={(e) => {
                  const val = e.target.value;
                  if (val === "" || /^\d*\.?\d{0,6}$/.test(val)) {
                    setFeeCheckAmount(val);
                  }
                }}
                hint="Enter an amount to see the estimated encrypted fee"
              />

              {/* Fee display */}
              <div className="rounded-xl bg-glass-surface border border-emerald-500/10 divide-y divide-glass-border overflow-hidden">
                <div className="flex justify-between items-center px-4 py-3.5 min-h-[44px]">
                  <span className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider">
                    Estimated Fee
                  </span>
                  <div className="flex items-center gap-2">
                    <Lock className="w-3 h-3 text-emerald-400" />
                    <span className="font-mono tabular-nums text-sm text-emerald-400 tracking-wide">
                      {ENCRYPTED_PLACEHOLDER}
                    </span>
                  </div>
                </div>
                <div className="flex justify-between items-center px-4 py-3.5 min-h-[44px]">
                  <span className="text-[11px] font-semibold text-apple-secondary uppercase tracking-wider">
                    Net Amount
                  </span>
                  <div className="flex items-center gap-2">
                    <Lock className="w-3 h-3 text-emerald-400" />
                    <span className="font-mono tabular-nums text-sm text-emerald-400 tracking-wide">
                      {ENCRYPTED_PLACEHOLDER}
                    </span>
                  </div>
                </div>
              </div>

              <p className="text-xs text-neutral-500 leading-relaxed">
                Fee calculation uses{" "}
                <code className="font-mono text-neutral-400 bg-white/[0.04] px-1 py-0.5 rounded">
                  calculateFee(InEuint64)
                </code>{" "}
                which returns encrypted{" "}
                <code className="font-mono text-neutral-400 bg-white/[0.04] px-1 py-0.5 rounded">
                  euint64
                </code>{" "}
                handles for both fee and net amount. The exact fee is private
                — only the payer can decrypt with a permit.
              </p>
            </div>
          </GlassCard>
        </motion.div>

        {/* ── Audit Scope Card ── */}
        <motion.div variants={fadeInUp}>
          <GlassCard
            variant="elevated"
            className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]"
          >
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                <FileSearch className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <h3 className="text-subheading font-semibold">Audit Scope</h3>
                <p className="text-caption text-apple-secondary">
                  Encrypted bitmask-based audit permissions
                </p>
              </div>
            </div>

            <p className="text-body text-apple-secondary mb-4">
              Audit permissions are managed as encrypted{" "}
              <code className="font-mono text-neutral-400 bg-white/[0.04] px-1 py-0.5 rounded">
                euint8
              </code>{" "}
              bitmasks. Each bit grants an auditor access to a specific category
              of your encrypted data. The scope is set via{" "}
              <code className="font-mono text-neutral-400 bg-white/[0.04] px-1 py-0.5 rounded">
                setAuditScope()
              </code>{" "}
              and checked with{" "}
              <code className="font-mono text-neutral-400 bg-white/[0.04] px-1 py-0.5 rounded">
                checkAuditScope()
              </code>.
            </p>

            <div className="rounded-xl bg-glass-surface border border-glass-border overflow-hidden overflow-x-auto">
              <div className="grid grid-cols-[auto_1fr_1fr] min-w-[480px] gap-px bg-white/[0.04]">
                {/* Header */}
                <div className="bg-[#0a0a0c] px-4 py-3">
                  <span className="text-[10px] font-semibold text-apple-secondary uppercase tracking-wider">
                    Bit
                  </span>
                </div>
                <div className="bg-[#0a0a0c] px-4 py-3">
                  <span className="text-[10px] font-semibold text-apple-secondary uppercase tracking-wider">
                    Data Category
                  </span>
                </div>
                <div className="bg-[#0a0a0c] px-4 py-3">
                  <span className="text-[10px] font-semibold text-apple-secondary uppercase tracking-wider">
                    Description
                  </span>
                </div>

                {/* Rows */}
                {AUDIT_BITS.map((entry) => (
                  <motion.div
                    key={entry.bit}
                    className="contents"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: entry.bit * 0.04 }}
                  >
                    <div className="bg-[#0a0a0c] px-4 py-3 min-h-[44px] flex items-center">
                      <span className="font-mono tabular-nums text-xs text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded">
                        {entry.bit}
                      </span>
                    </div>
                    <div className="bg-[#0a0a0c] px-4 py-3 min-h-[44px] flex items-center">
                      <span className="text-sm text-white">{entry.label}</span>
                    </div>
                    <div className="bg-[#0a0a0c] px-4 py-3 min-h-[44px] flex items-center">
                      <span className="text-xs text-neutral-500">
                        {entry.description}
                      </span>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>

            {/* Info box */}
            <div className="mt-4 rounded-xl bg-blue-500/[0.04] border border-blue-500/15 px-4 py-3 flex items-start gap-2.5">
              <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
              <div className="text-xs text-blue-400/80 leading-relaxed space-y-1.5">
                <p>
                  To grant an auditor access to specific data, call{" "}
                  <code className="font-mono text-blue-300 bg-blue-500/10 px-1 py-0.5 rounded">
                    setAuditScope(auditorAddress, encryptedBitmask)
                  </code>{" "}
                  where the bitmask is an encrypted{" "}
                  <code className="font-mono text-blue-300 bg-blue-500/10 px-1 py-0.5 rounded">
                    euint8
                  </code>
                  .
                </p>
                <p>
                  For example, granting bits 0 + 2 (amounts + timestamps) =
                  bitmask value 5 (binary: 00000101).
                </p>
              </div>
            </div>
          </GlassCard>
        </motion.div>

        {/* ── How Encrypted Flags Work ── */}
        <motion.div variants={fadeInUp}>
          <GlassCard className="!bg-apple-gray6/40 !backdrop-blur-xl !border-white/[0.05] !rounded-[2rem]">
            <div className="flex items-center gap-2 mb-4">
              <Info className="w-4 h-4 text-neutral-400" />
              <h3 className="text-subheading font-semibold">
                How Encrypted Flags Work
              </h3>
            </div>
            <div className="space-y-4 text-sm text-neutral-400 leading-relaxed">
              <p>
                Traditional compliance systems store user flags in plaintext,
                letting anyone query whether an address is verified, KYC'd, or
                flagged. This leaks sensitive identity information.
              </p>
              <p>
                With Fhenix FHE, every compliance flag is stored as an{" "}
                <code className="font-mono text-violet-300 bg-violet-500/10 px-1 py-0.5 rounded">
                  ebool
                </code>{" "}
                (encrypted boolean). The contract owner can set or revoke flags,
                but the encrypted value is only visible to the user themselves
                via permit-based decryption.
              </p>
              <p>
                Fee calculations happen entirely on encrypted data. The contract
                computes{" "}
                <code className="font-mono text-violet-300 bg-violet-500/10 px-1 py-0.5 rounded">
                  fee = amount * feeRate / 10000
                </code>{" "}
                using{" "}
                <code className="font-mono text-violet-300 bg-violet-500/10 px-1 py-0.5 rounded">
                  euint64
                </code>{" "}
                arithmetic. Neither the input amount, the fee, nor the net
                amount is ever revealed on-chain.
              </p>
            </div>
          </GlassCard>
        </motion.div>
      </motion.div>
    </motion.div>
  );
}
