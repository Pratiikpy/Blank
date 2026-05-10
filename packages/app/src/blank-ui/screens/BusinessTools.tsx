import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Receipt,
  DollarSign,
  Lock,
  FileText,
  CheckCircle2,
  Plus,
  X,
  Loader2,
  AlertTriangle,
  Info,
  Repeat,
  ExternalLink,
} from "lucide-react";
import { formatDistanceToNowStrict } from "date-fns";
import { cn } from "@/lib/cn";
import { truncateAddress } from "@/lib/address";
import toast from "react-hot-toast";
import { isAddress, parseUnits, formatUnits } from "viem";
import { usePublicClient } from "wagmi";
import { useBusinessHub } from "@/hooks/useBusinessHub";
import { EmptyState } from "@/components/common/EmptyState";
import { MILESTONE_TEMPLATES } from "@/lib/escrow-templates";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useChain } from "@/providers/ChainProvider";
import { CopyInvoiceLink } from "@/blank-ui/components/CopyInvoiceLink";
import {
  KNOWN_TOKENS,
  POOL_FEE,
  QuoterV2Abi,
  UNISWAP_QUOTER_V2,
  UNISWAP_SWAP_ROUTER_02,
  applySlippage,
  type TokenInfo,
} from "@/lib/uniswap";
import {
  fetchVendorInvoices,
  fetchClientInvoices,
  fetchUserEscrows,
  type InvoiceRow,
  type EscrowRow,
} from "@/lib/supabase";
import { useActivityFeed } from "@/hooks/useActivityFeed";
import { useRealtime } from "@/providers/RealtimeProvider";
import { log } from "@/lib/log";

const MAX_PAYROLL_SIZE = 30;
const INVOICE_PAGE_SIZE = 10;
const ESCROW_PAGE_SIZE = 10;

type TabValue = "invoices" | "payroll" | "escrow";
type EscrowFilter = "all" | "mine" | "arbitrating";

const getStatusBadge = (status: string) => {
  const styles: Record<string, string> = {
    paid: "bg-emerald-50 text-emerald-700 border-emerald-100",
    pending: "bg-amber-50 text-amber-700 border-amber-100",
    overdue: "bg-red-50 text-red-700 border-red-100",
    scheduled: "bg-blue-50 text-blue-700 border-blue-100",
    active: "bg-purple-50 text-purple-700 border-purple-100",
    completed: "bg-emerald-50 text-emerald-700 border-emerald-100",
    released: "bg-emerald-50 text-emerald-700 border-emerald-100",
    disputed: "bg-red-50 text-red-700 border-red-100",
    expired: "bg-gray-50 text-gray-700 border-gray-100",
    payment_pending: "bg-amber-50 text-amber-700 border-amber-100",
  };
  return styles[status] || "bg-gray-50 text-gray-700 border-gray-100";
};

// ---------------------------------------------------------------
//  MAIN SCREEN
// ---------------------------------------------------------------

export default function BusinessTools() {
  const { effectiveAddress: address } = useEffectiveAddress();
  const { activeChainId, contracts } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { step, createInvoice, runPayroll, createEscrow, finalizeInvoice, markDelivered, approveRelease, disputeEscrow, payInvoice, payInvoiceWithSwap, payInvoiceWithOracleQuote, cancelInvoice, arbiterDecide, claimExpiredEscrow } = useBusinessHub();
  const { activities } = useActivityFeed();
  const payrollActivities = useMemo(
    () => activities.filter((a) => a.activity_type === "payroll"),
    [activities],
  );

  const [activeTab, setActiveTab] = useState<TabValue>("invoices");
  const [escrowFilter, setEscrowFilter] = useState<EscrowFilter>("all");
  const [showModal, setShowModal] = useState(false);
  const [visibleInvoiceCount, setVisibleInvoiceCount] = useState(INVOICE_PAGE_SIZE);
  const [visibleEscrowCount, setVisibleEscrowCount] = useState(ESCROW_PAGE_SIZE);
  const { subscribe } = useRealtime();

  // Real data from Supabase
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [escrows, setEscrows] = useState<EscrowRow[]>([]);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [confirmDisputeId, setConfirmDisputeId] = useState<number | null>(null);
  const [payInvoiceId, setPayInvoiceId] = useState<number | null>(null);
  const [payInvoiceAmount, setPayInvoiceAmount] = useState("");
  // Phase 5.6 / 5.7 — three-mode pay flow:
  //   "standard" → existing FHE-encrypted-vault path (default).
  //   "swap"     → Uniswap-routed swap-then-pay (Phase 5.6).
  //   "oracle"   → Backend-signed price quote (Phase 5.7) for tokens
  //                Uniswap doesn't have a pool for. Each mode shows its
  //                own panel + has its own CTA + handler.
  type PayMode = "standard" | "swap" | "oracle";
  const [payMode, setPayMode] = useState<PayMode>("standard");
  const [payAltToken, setPayAltToken] = useState<TokenInfo | null>(null);
  const [payAltSlippageBps, setPayAltSlippageBps] = useState(50); // 0.5%
  const [payAltQuoteIn, setPayAltQuoteIn] = useState<bigint | null>(null);
  const [payAltQuoteLoading, setPayAltQuoteLoading] = useState(false);
  const [payAltQuoteError, setPayAltQuoteError] = useState<string | null>(null);
  // Phase 5.7 — oracle-quote state. Distinct from the swap-quote state
  // because the oracle path's quote is server-signed (not derived
  // client-side from a Uniswap simulation).
  interface OracleQuote {
    expectedUsdcOut: string;
    ratePpm: string;
    expiresAt: number;
    nonce: `0x${string}`;
    signature: `0x${string}`;
    payToken: `0x${string}`;
    payAmountIn: string;
  }
  const [oracleQuote, setOracleQuote] = useState<OracleQuote | null>(null);
  const [oracleFetching, setOracleFetching] = useState(false);
  const [oracleError, setOracleError] = useState<string | null>(null);
  // Backwards-compat shim — keep legacy `payAltMode` boolean alive for
  // any downstream code paths that haven't been migrated yet.
  const payAltMode = payMode === "swap";
  const [confirmCancelInvoiceId, setConfirmCancelInvoiceId] = useState<number | null>(null);
  const [confirmArbiterEscrow, setConfirmArbiterEscrow] = useState<{ id: number; release: boolean } | null>(null);
  const [confirmClaimExpiredId, setConfirmClaimExpiredId] = useState<number | null>(null);

  // Invoice form
  const [invoiceClient, setInvoiceClient] = useState("");
  const [invoiceClientEmail, setInvoiceClientEmail] = useState("");
  const [invoiceAmount, setInvoiceAmount] = useState("");
  const [invoiceDesc, setInvoiceDesc] = useState("");
  const [invoiceDueDays, setInvoiceDueDays] = useState("30");

  // Payroll form
  const [payAddresses, setPayAddresses] = useState("");
  const [payAmounts, setPayAmounts] = useState("");

  // Escrow form
  const [escrowBeneficiary, setEscrowBeneficiary] = useState("");
  const [escrowAmount, setEscrowAmount] = useState("");
  const [escrowDesc, setEscrowDesc] = useState("");
  const [escrowArbiter, setEscrowArbiter] = useState("");
  const [escrowDeadlineDays, setEscrowDeadlineDays] = useState("30");
  const [escrowTemplateId, setEscrowTemplateId] = useState("single");
  const [escrowFile, setEscrowFile] = useState<File | null>(null);

  const isProcessing = step === "approving" || step === "encrypting" || step === "sending";

  // Load real data
  const loadData = useCallback(async () => {
    if (!address) return;
    setIsLoadingData(true);
    setDataError(null);
    try {
      const addr = address.toLowerCase();
      const [vendorInv, clientInv, userEscrows] = await Promise.all([
        fetchVendorInvoices(addr),
        fetchClientInvoices(addr),
        fetchUserEscrows(addr),
      ]);
      // Merge vendor and client invoices, deduplicate by id
      const allInvoices = [...vendorInv, ...clientInv];
      const seen = new Set<string>();
      const deduped = allInvoices.filter((inv) => {
        if (seen.has(inv.id)) return false;
        seen.add(inv.id);
        return true;
      });
      setInvoices(deduped);
      setEscrows(userEscrows);
    } catch (err) {
      log.warn("businessTools.loadData.failed", err instanceof Error ? err : new Error(String(err)));
      setDataError("Failed to load data. Tap to retry.");
    } finally {
      setIsLoadingData(false);
    }
  }, [address]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Reload data after successful operations
  useEffect(() => {
    if (step === "success") {
      loadData();
    }
  }, [step, loadData]);

  // Realtime: refetch escrows when this address is added/updated as arbiter,
  // depositor, or beneficiary. Without the arbiter subscription, Carol's
  // client never learns Alice named her as arbiter until a manual reload.
  useEffect(() => {
    if (!address) return;
    const addr = address.toLowerCase();
    const unsubs = [
      subscribe("escrows", { event: "INSERT", filter: { column: "arbiter_address", value: addr } }, () => loadData()),
      subscribe("escrows", { event: "UPDATE", filter: { column: "arbiter_address", value: addr } }, () => loadData()),
      subscribe("escrows", { event: "INSERT", filter: { column: "depositor_address", value: addr } }, () => loadData()),
      subscribe("escrows", { event: "UPDATE", filter: { column: "depositor_address", value: addr } }, () => loadData()),
      subscribe("escrows", { event: "INSERT", filter: { column: "beneficiary_address", value: addr } }, () => loadData()),
      subscribe("escrows", { event: "UPDATE", filter: { column: "beneficiary_address", value: addr } }, () => loadData()),
    ];
    return () => { for (const u of unsubs) u(); };
  }, [address, subscribe, loadData]);

  const handleCreateInvoice = async () => {
    if (!invoiceClient || !invoiceAmount) { toast.error("Enter client address and amount"); return; }
    if (!isAddress(invoiceClient)) {
      toast.error("Invalid Ethereum address");
      return;
    }
    const trimmedEmail = invoiceClientEmail.trim();
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      toast.error("Client email looks invalid");
      return;
    }
    try {
      const dueDate = Math.floor(Date.now() / 1000) + parseInt(invoiceDueDays) * 86400;
      await createInvoice(
        invoiceClient,
        invoiceAmount,
        invoiceDesc || "Invoice",
        dueDate,
        trimmedEmail || undefined,
      );
      setShowModal(false);
      setInvoiceClient("");
      setInvoiceClientEmail("");
      setInvoiceAmount("");
      setInvoiceDesc("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Operation failed");
    }
  };

  // Phase 3.4: when the user picks a milestone template, prepend the
  // milestone label to the description so the on-chain note carries that
  // context. The on-chain Escrow struct is single-milestone, so for now
  // each template just suggests a label — multi-milestone escrows live
  // in the Wave 3 contract upgrade pass.
  const applyEscrowTemplate = useCallback((id: string) => {
    setEscrowTemplateId(id);
    if (id === "single") return;
    const tpl = MILESTONE_TEMPLATES.find((t) => t.id === id);
    if (!tpl) return;
    const firstStep = tpl.splits[0]?.name ?? "Milestone";
    setEscrowDesc((prev) => {
      const stripped = prev.replace(/^\[[^\]]+\]\s*/, "");
      return `[${firstStep}] ${stripped}`.trim();
    });
  }, []);

  const handleRunPayroll = async () => {
    const addresses = payAddresses.split(",").map((a) => a.trim()).filter(Boolean);
    const amounts = payAmounts.split(",").map((a) => a.trim()).filter(Boolean);
    if (addresses.length === 0) { toast.error("Enter at least one employee address"); return; }
    if (addresses.length !== amounts.length) { toast.error("Number of addresses must match number of amounts"); return; }
    if (addresses.length > MAX_PAYROLL_SIZE) {
      toast.error(`Maximum ${MAX_PAYROLL_SIZE} employees per payroll batch`);
      return;
    }
    const invalidAddr = addresses.find((a) => !isAddress(a));
    if (invalidAddr) {
      toast.error(`Invalid address: ${invalidAddr}`);
      return;
    }
    try {
      await runPayroll(addresses, amounts);
      setShowModal(false);
      setPayAddresses("");
      setPayAmounts("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Operation failed");
    }
  };

  const handleCreateEscrowReset = () => {
    setEscrowBeneficiary("");
    setEscrowAmount("");
    setEscrowDesc("");
    setEscrowArbiter("");
    setEscrowTemplateId("single");
    setEscrowFile(null);
  };

  const handleCreateEscrow = async () => {
    if (!escrowBeneficiary || !escrowAmount) { toast.error("Enter beneficiary address and amount"); return; }
    if (!isAddress(escrowBeneficiary)) {
      toast.error("Invalid beneficiary address");
      return;
    }
    if (escrowArbiter && !isAddress(escrowArbiter)) {
      toast.error("Invalid arbiter address");
      return;
    }
    try {
      const deadline = Math.floor(Date.now() / 1000) + parseInt(escrowDeadlineDays) * 86400;
      await createEscrow(
        escrowBeneficiary,
        escrowAmount,
        escrowDesc || "Escrow",
        escrowArbiter,
        deadline,
        escrowFile,
      );
      setShowModal(false);
      handleCreateEscrowReset();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Operation failed");
    }
  };

  const handleFinalizeInvoice = async (invoiceId: number) => {
    await finalizeInvoice(invoiceId);
  };

  const handlePayInvoice = async () => {
    if (payInvoiceId === null || !payInvoiceAmount) return;
    try {
      await payInvoice(payInvoiceId, payInvoiceAmount);
      setPayInvoiceId(null);
      setPayInvoiceAmount("");
      setPayMode("standard");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Payment failed");
    }
  };

  // Phase 5.7 — fetch a backend-signed price quote. Caller must have
  // already entered a recipient amount (mirrors invoice amount). The
  // quote is bound to (account, invoiceId, payToken, payAmountIn,
  // contractAddr, chainId, msg.sender) so substitution attacks fail.
  const handleFetchOracleQuote = async () => {
    if (payInvoiceId === null || !payInvoiceAmount || !payAltToken || !address) {
      toast.error("Pick a token + enter the invoice amount first");
      return;
    }
    setOracleFetching(true);
    setOracleError(null);
    try {
      // For MVP the oracle path expects 1:1 stable — payAmountIn equals
      // the invoice amount in the same decimals. Future allowlist entries
      // could change the rate; this endpoint handles that server-side.
      const payAmountIn = parseUnits(payInvoiceAmount, payAltToken.decimals);
      const res = await fetch("/api/oracle/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payer: address,
          invoiceId: String(payInvoiceId),
          payToken: payAltToken.address,
          payAmountIn: payAmountIn.toString(),
          chainId: activeChainId,
          businessHub: contracts.BusinessHub,
        }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(errJson.error ?? `Backend rejected: ${res.status}`);
      }
      const json = (await res.json()) as {
        expectedUsdcOut: string;
        ratePpm: string;
        expiresAt: number;
        nonce: `0x${string}`;
        signature: `0x${string}`;
      };
      setOracleQuote({
        ...json,
        payToken: payAltToken.address,
        payAmountIn: payAmountIn.toString(),
      });
    } catch (err) {
      setOracleError(err instanceof Error ? err.message : String(err));
      setOracleQuote(null);
    } finally {
      setOracleFetching(false);
    }
  };

  // Phase 5.7 — submit the signed oracle quote on chain. Must be
  // preceded by a successful handleFetchOracleQuote.
  const handlePayInvoiceWithOracleQuote = async () => {
    if (payInvoiceId === null || !payInvoiceAmount || !oracleQuote) return;
    try {
      await payInvoiceWithOracleQuote({
        invoiceId: payInvoiceId,
        payToken: oracleQuote.payToken,
        payAmountIn: BigInt(oracleQuote.payAmountIn),
        expectedUsdcOut: BigInt(oracleQuote.expectedUsdcOut),
        ratePpm: BigInt(oracleQuote.ratePpm),
        expiresAt: oracleQuote.expiresAt,
        nonce: oracleQuote.nonce,
        signature: oracleQuote.signature,
        amount: payInvoiceAmount,
      });
      // Clean up modal state on success.
      setPayInvoiceId(null);
      setPayInvoiceAmount("");
      setPayMode("standard");
      setPayAltToken(null);
      setOracleQuote(null);
      setOracleError(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Oracle-pay failed");
    }
  };

  // Phase 5.6 — pay invoice with a different token. Mirrors the legacy
  // payInvoice handler; routes through the new contract entrypoint.
  const handlePayInvoiceWithSwap = async () => {
    if (payInvoiceId === null || !payInvoiceAmount || !payAltToken) return;
    if (payAltQuoteIn === null) {
      toast.error("Wait for the quote to load");
      return;
    }
    try {
      // Apply slippage budget to the quote so the contract has room to
      // succeed under thin testnet pool depth. The contract refunds any
      // unused payToken.
      const slippageBuffered = payAltQuoteIn + (payAltQuoteIn * BigInt(payAltSlippageBps)) / 10_000n;
      await payInvoiceWithSwap({
        invoiceId: payInvoiceId,
        payToken: payAltToken.address,
        payAmountInMax: slippageBuffered,
        amount: payInvoiceAmount,
        fee: POOL_FEE.MEDIUM,
        swapRouter: UNISWAP_SWAP_ROUTER_02[activeChainId],
      });
      setPayInvoiceId(null);
      setPayInvoiceAmount("");
      setPayMode("standard");
      setPayAltToken(null);
      setPayAltQuoteIn(null);
      setPayAltQuoteError(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Swap-pay failed");
    }
  };

  // Quote fetch: when the modal is open in alt-token mode AND we have
  // both an amount and a payToken, hit QuoterV2.quoteExactOutputSingle to
  // tell the user how much payToken they'll spend. Debounced 500ms so
  // typing in the amount field doesn't fire an RPC every keystroke.
  useEffect(() => {
    if (!payAltMode || payInvoiceId === null || !payAltToken || !payInvoiceAmount) {
      setPayAltQuoteIn(null);
      setPayAltQuoteError(null);
      return;
    }
    if (!publicClient) return;
    // The on-chain swap targets `vault.underlyingToken()` which is
    // `contracts.TestUSDC` on testnet. NB: TestUSDC has NO Uniswap v3
    // liquidity on testnet — every quote will revert with "no pool" and
    // the user will see the "No X/USDC pool" error. Fix at the operational
    // level: seed a TestUSDC/WETH v3 pool via an LP-add hardhat task before
    // running the demo. The contract code itself is mainnet-ready (Circle
    // USDC.e has plenty of liquidity).
    let cancelled = false;
    setPayAltQuoteError(null);
    const timer = setTimeout(async () => {
      try {
        setPayAltQuoteLoading(true);
        const amountOut = parseUnits(payInvoiceAmount, 6);
        const result = (await publicClient.simulateContract({
          address: UNISWAP_QUOTER_V2[activeChainId],
          abi: QuoterV2Abi,
          functionName: "quoteExactOutputSingle",
          args: [
            {
              tokenIn: payAltToken.address,
              tokenOut: contracts.TestUSDC,
              amount: amountOut,
              fee: POOL_FEE.MEDIUM,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })).result as readonly [bigint, bigint, number, bigint];
        if (cancelled) return;
        setPayAltQuoteIn(result[0]);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setPayAltQuoteError(
          /execution reverted|VM Exception/.test(msg)
            ? `No ${payAltToken.symbol}/USDC pool at 0.30% fee — try a different token.`
            : msg.slice(0, 200),
        );
        setPayAltQuoteIn(null);
      } finally {
        if (!cancelled) setPayAltQuoteLoading(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [payAltMode, payInvoiceId, payAltToken, payInvoiceAmount, publicClient, activeChainId, contracts.TestUSDC, contracts.FHERC20Vault_USDC]);

  const handleCancelInvoice = async (invoiceId: number) => {
    try {
      await cancelInvoice(invoiceId);
      setConfirmCancelInvoiceId(null);
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    }
  };

  const handleArbiterDecide = async (escrowId: number, release: boolean) => {
    try {
      await arbiterDecide(escrowId, release);
      setConfirmArbiterEscrow(null);
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Decision failed");
    }
  };

  const handleClaimExpired = async (escrowId: number) => {
    try {
      await claimExpiredEscrow(escrowId);
      setConfirmClaimExpiredId(null);
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Claim failed");
    }
  };

  const handleReleaseFunds = async (escrowId: number) => {
    // Route by role: beneficiary marks delivered; depositor (after
    // delivery) approves the release. Calling both unconditionally breaks
    // the depositor path — markDelivered reverts with "not beneficiary".
    const escrow = escrows.find((e) => e.escrow_id === escrowId);
    if (!escrow || !address) {
      toast.error("Escrow not found");
      return;
    }
    const me = address.toLowerCase();
    const isBeneficiary = escrow.beneficiary_address?.toLowerCase() === me;
    const isDepositor = escrow.depositor_address?.toLowerCase() === me;
    try {
      if (isBeneficiary) {
        await markDelivered(escrowId);
      } else if (isDepositor) {
        await approveRelease(escrowId);
      } else {
        toast.error("You are neither beneficiary nor depositor of this escrow");
        return;
      }
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Release failed");
    }
  };

  const handleDisputeEscrow = async (escrowId: number) => {
    try {
      await disputeEscrow(escrowId);
      setConfirmDisputeId(null);
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Dispute failed");
    }
  };

  const tabs: { id: TabValue; label: string; icon: typeof Receipt }[] = [
    { id: "invoices", label: "Invoices", icon: Receipt },
    { id: "payroll", label: "Payroll", icon: DollarSign },
    { id: "escrow", label: "Escrow", icon: Lock },
  ];

  // Filter escrows by user role (mine = depositor/beneficiary,
  // arbitrating = named as arbiter). "all" returns every row the user can see.
  const filteredEscrows = useMemo(() => {
    if (!address) return escrows;
    const addr = address.toLowerCase();
    if (escrowFilter === "mine") {
      return escrows.filter(
        (e) =>
          e.depositor_address.toLowerCase() === addr ||
          e.beneficiary_address.toLowerCase() === addr,
      );
    }
    if (escrowFilter === "arbitrating") {
      return escrows.filter(
        (e) => e.arbiter_address && e.arbiter_address.toLowerCase() === addr,
      );
    }
    return escrows;
  }, [escrows, escrowFilter, address]);

  const arbitratingCount = useMemo(() => {
    if (!address) return 0;
    const addr = address.toLowerCase();
    return escrows.filter(
      (e) => e.arbiter_address && e.arbiter_address.toLowerCase() === addr,
    ).length;
  }, [escrows, address]);

  const formatDate = (iso: string | null) => {
    if (!iso) return "No date";
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  // #216: due-dates / deadlines must read identically across timezones for
  // both parties (vendor + client, depositor + arbiter). The naive
  // `toLocaleDateString` shows each viewer their own day boundary, which
  // means "due today" can disagree by 24h between Tokyo and LA. We render
  // a relative phrase ("in 2 days", "5 hours ago") + the canonical UTC
  // absolute timestamp so both sides always have a shared reference.
  const formatDeadline = (iso: string | null): string => {
    if (!iso) return "No deadline";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "Invalid date";
    const relative = formatDistanceToNowStrict(d, { addSuffix: true });
    const utc = d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    });
    return `${relative} (${utc} UTC)`;
  };

  const truncateAddr = truncateAddress;

  return (
    <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl sm:text-5xl font-heading font-semibold text-[var(--text-primary)] tracking-tight mb-2">
            Business Tools
          </h1>
          <p className="text-sm sm:text-base text-[var(--text-primary)]/50 leading-relaxed">
            Manage invoices, payroll, and escrow with financial privacy
          </p>
        </div>

        {/* Step Indicator */}
        {isProcessing && (
          <div className="mb-6 p-4 rounded-2xl bg-amber-50 border border-amber-100 flex items-center gap-3">
            <Loader2 size={20} className="text-amber-600 animate-spin" />
            <p className="text-sm font-medium text-amber-900">
              {step === "approving" && "Approving vault access..."}
              {step === "encrypting" && "Encrypting amounts with FHE..."}
              {step === "sending" && "Submitting transaction..."}
            </p>
          </div>
        )}

        {/* Tab Navigation */}
        <div className="flex gap-3 mb-6 overflow-x-auto" role="tablist" aria-label="Business tools tabs">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              role="tab"
              aria-selected={activeTab === id}
              aria-label={label}
              className={cn(
                "flex items-center gap-2 h-12 px-6 rounded-2xl font-medium transition-all whitespace-nowrap",
                activeTab === id
                  ? "bg-[var(--text-primary)] text-white"
                  : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80",
              )}
            >
              <Icon size={20} />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {/* Invoices Tab */}
        {activeTab === "invoices" && (
          <div className="space-y-6">
            <div className="flex justify-end">
              <button
                onClick={() => setShowModal(true)}
                className="h-12 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center gap-2"
              >
                <Plus size={20} />
                <span>New Invoice</span>
              </button>
            </div>

            <div className="rounded-[2rem] glass-card p-4 sm:p-8">
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-6">Recent Invoices</h3>

              {isLoadingData ? (
                <div className="flex items-center justify-center py-8 gap-3">
                  <Loader2 size={24} className="animate-spin text-[var(--text-primary)]/40" />
                  <span className="text-[var(--text-primary)]/50">Loading invoices...</span>
                </div>
              ) : dataError ? (
                <button onClick={loadData} className="w-full text-center py-8 text-red-500 hover:bg-red-50/50 rounded-2xl transition-colors">
                  <AlertTriangle size={40} className="mx-auto mb-3 opacity-60" />
                  <p className="font-medium mb-1">{dataError}</p>
                </button>
              ) : invoices.length === 0 ? (
                <EmptyState
                  icon={FileText}
                  tone="slate"
                  title="No invoices yet"
                  body="Send your first private invoice. Amounts stay encrypted on-chain. Only you and your client see them."
                  cta={{ label: "Create your first invoice", onClick: () => setShowModal(true) }}
                />
              ) : (
                <div className="space-y-3">
                  {invoices.slice(0, visibleInvoiceCount).map((invoice) => (
                    <div
                      key={invoice.id}
                      className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-4 sm:p-6 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10 hover:bg-white/70 transition-all"
                    >
                      <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                        <div className="w-12 h-12 rounded-xl bg-[#007AFF]/10 flex items-center justify-center shrink-0">
                          <FileText size={24} className="text-[#007AFF]" />
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium text-[var(--text-primary)] truncate">{truncateAddr(invoice.client_address)}</p>
                          <p className="text-sm text-[var(--text-primary)]/50">
                            {formatDate(invoice.created_at)} &middot; Due {formatDeadline(invoice.due_date)}
                          </p>
                          {invoice.description && <p className="text-xs text-[var(--text-primary)]/40 truncate">{invoice.description}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 sm:gap-4 justify-between sm:justify-end">
                        <div className="text-right">
                          <p className="text-lg font-heading font-medium encrypted-text">
                            ${"\u2022\u2022\u2022\u2022\u2022.\u2022\u2022"}
                          </p>
                          <div className={cn("inline-flex px-2 py-1 rounded-full text-xs font-medium border", getStatusBadge(invoice.status))}>
                            {invoice.status}
                          </div>
                        </div>
                        {invoice.status === "pending" && invoice.client_address?.toLowerCase() === address?.toLowerCase() && (
                          <button
                            onClick={() => setPayInvoiceId(invoice.invoice_id)}
                            disabled={isProcessing}
                            className="h-10 px-4 rounded-xl bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"
                          >
                            Pay
                          </button>
                        )}
                        {invoice.status === "pending" && invoice.vendor_address?.toLowerCase() === address?.toLowerCase() && (
                          <>
                            {/* PR-C step 3: shareable invoice link → public escrow page */}
                            <CopyInvoiceLink
                              chainId={activeChainId}
                              invoiceId={invoice.invoice_id}
                              variant="icon"
                            />
                            {/* PR-D: vendor preview — open the same link
                                the client sees, in a new tab. */}
                            <a
                              href={`/app/invoice/${activeChainId}/${invoice.invoice_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label="Preview public invoice page"
                              data-testid={`invoice-preview-${invoice.invoice_id}`}
                              className="h-9 w-9 rounded-lg flex items-center justify-center bg-black/5 hover:bg-black/10 dark:bg-white/5 dark:hover:bg-white/10 text-[var(--text-primary)] transition-colors"
                            >
                              <ExternalLink size={14} />
                            </a>
                            <button
                              onClick={() => setConfirmCancelInvoiceId(invoice.invoice_id)}
                              disabled={isProcessing}
                              className="h-10 px-4 rounded-xl bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 transition-all active:scale-95 disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </>
                        )}
                        {invoice.status === "payment_pending" && invoice.client_address?.toLowerCase() === address?.toLowerCase() && (
                          <button
                            onClick={() => handleFinalizeInvoice(invoice.invoice_id)}
                            disabled={isProcessing}
                            className="h-10 px-4 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"
                          >
                            {isProcessing && <Loader2 size={14} className="animate-spin" />}
                            Finalize
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                  {visibleInvoiceCount < invoices.length && (
                    <button
                      onClick={() => setVisibleInvoiceCount((c) => c + INVOICE_PAGE_SIZE)}
                      className="w-full h-12 rounded-2xl bg-white/50 border border-black/5 text-sm font-medium text-[var(--text-secondary)] hover:bg-white/70 transition-all mt-3"
                    >
                      Load more ({invoices.length - visibleInvoiceCount} remaining)
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Payroll Tab */}
        {activeTab === "payroll" && (
          <div className="space-y-6">
            <div className="flex justify-end">
              <button
                onClick={() => setShowModal(true)}
                className="h-12 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center gap-2"
              >
                <Plus size={20} />
                <span>Run Payroll</span>
              </button>
            </div>

            <div className="rounded-[2rem] glass-card p-4 sm:p-8">
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-6">Payroll</h3>
              <EmptyState
                icon={DollarSign}
                tone="emerald"
                title="Run encrypted payroll"
                body="Send salaries to multiple employees in a single transaction. Each amount is FHE-encrypted client-side. Every employee only sees their own pay. Upload a CSV or paste a list."
                cta={{ label: "Run Payroll", onClick: () => setShowModal(true) }}
              />
            </div>
            <div className={cn("rounded-[2rem] glass-card p-4 sm:p-8", payrollActivities.length === 0 && "hidden")}>

              {/* Payroll History */}
              {payrollActivities.length > 0 && (
                <div className="mt-6">
                  <p className="text-xs font-semibold tracking-widest uppercase text-[var(--text-secondary)] mb-3">
                    Payroll History
                  </p>
                  {payrollActivities.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center justify-between p-3 rounded-xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10 mb-2"
                    >
                      <span className="text-sm text-[var(--text-primary)]">
                        {a.note || "Payroll"}
                      </span>
                      <span className="text-xs text-[var(--text-tertiary)]">
                        {new Date(a.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Escrow Tab */}
        {activeTab === "escrow" && (
          <div className="space-y-6">
            <div className="flex flex-wrap gap-3 items-center justify-between">
              {/* Role filter: "All" / "Mine" / "Arbitrating" */}
              <div className="flex gap-2" role="tablist" aria-label="Escrow role filter">
                {(["all", "mine", "arbitrating"] as EscrowFilter[]).map((f) => (
                  <button
                    key={f}
                    onClick={() => setEscrowFilter(f)}
                    role="tab"
                    aria-selected={escrowFilter === f}
                    className={cn(
                      "h-10 px-4 rounded-2xl text-sm font-medium transition-all whitespace-nowrap",
                      escrowFilter === f
                        ? "bg-[var(--text-primary)] text-white"
                        : "bg-white/60 backdrop-blur-2xl text-[var(--text-primary)] border border-white/60 hover:bg-white/80",
                    )}
                  >
                    {f === "all" ? "All" : f === "mine" ? "Mine" : "Arbitrating"}
                    {f === "arbitrating" && arbitratingCount > 0 && (
                      <span className={cn(
                        "ml-2 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-xs font-semibold",
                        escrowFilter === f ? "bg-white/20 text-white" : "bg-purple-100 text-purple-700",
                      )}>
                        {arbitratingCount}
                      </span>
                    )}
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowModal(true)}
                className="h-12 px-6 rounded-2xl bg-[var(--text-primary)] text-white font-medium transition-transform active:scale-95 hover:bg-[#000000] flex items-center gap-2"
              >
                <Plus size={20} />
                <span>New Escrow</span>
              </button>
            </div>

            {isLoadingData ? (
              <div className="flex items-center justify-center py-8 gap-3">
                <Loader2 size={24} className="animate-spin text-[var(--text-primary)]/40" />
                <span className="text-[var(--text-primary)]/50">Loading escrows...</span>
              </div>
            ) : dataError ? (
              <div className="rounded-[2rem] glass-card p-4 sm:p-8">
                <button onClick={loadData} className="w-full text-center py-8 text-red-500 hover:bg-red-50/50 rounded-2xl transition-colors">
                  <AlertTriangle size={40} className="mx-auto mb-3 opacity-60" />
                  <p className="font-medium mb-1">{dataError}</p>
                </button>
              </div>
            ) : filteredEscrows.length === 0 ? (
              <div className="rounded-[2rem] glass-card p-4 sm:p-8">
                <div className="text-center py-8 text-[var(--text-primary)]/40">
                  <Lock size={40} className="mx-auto mb-3 opacity-30" />
                  <p className="font-medium mb-1">
                    {escrowFilter === "arbitrating"
                      ? "No escrows to arbitrate"
                      : escrowFilter === "mine"
                        ? "No escrows you created or are receiving"
                        : "No escrows yet"}
                  </p>
                  <p className="text-sm">
                    {escrowFilter === "arbitrating"
                      ? "You'll see escrows here when someone names you as their arbiter"
                      : "Create your first escrow to get started"}
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {filteredEscrows.slice(0, visibleEscrowCount).map((escrow) => {
                  const isArbiter =
                    !!address &&
                    !!escrow.arbiter_address &&
                    escrow.arbiter_address.toLowerCase() === address.toLowerCase();
                  return (
                  <div
                    key={escrow.id}
                    className="rounded-[2rem] glass-card p-4 sm:p-8 hover:-translate-y-1 transition-all duration-300"
                  >
                    <div className="flex items-start justify-between mb-6">
                      <div>
                        <h3 className="text-xl font-heading font-medium text-[var(--text-primary)] mb-1">{escrow.description}</h3>
                        <p className="text-sm text-[var(--text-primary)]/50">
                          Beneficiary: {truncateAddr(escrow.beneficiary_address)}
                        </p>
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          <div className={cn("inline-flex px-2 py-1 rounded-full text-xs font-medium border", getStatusBadge(escrow.status))}>
                            {escrow.status}
                          </div>
                          {isArbiter && (
                            <div className="inline-flex px-2 py-1 rounded-full text-xs font-medium border bg-purple-50 text-purple-700 border-purple-100">
                              You are arbiter
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="w-12 h-12 rounded-xl bg-purple-50 flex items-center justify-center">
                        <Lock size={24} className="text-purple-600" />
                      </div>
                    </div>

                    <div className="p-4 rounded-2xl bg-white/50 dark:bg-white/5 border border-black/5 dark:border-white/10 mb-4">
                      <p className="text-xs text-[var(--text-primary)]/50 font-medium tracking-wide uppercase mb-1">Escrow Amount</p>
                      <p className="text-2xl font-heading font-medium encrypted-text">
                        ${"\u2022\u2022\u2022\u2022\u2022\u2022.\u2022\u2022"}
                      </p>
                    </div>

                    <div className="text-sm text-[var(--text-primary)]/50">
                      <p>Deadline: {formatDeadline(escrow.deadline)}</p>
                      {escrow.arbiter_address && escrow.arbiter_address !== "" && (
                        <p>Arbiter: {truncateAddr(escrow.arbiter_address)}</p>
                      )}
                    </div>

                    {escrow.status === "active" && (
                      <div className="flex gap-2 mt-4">
                        <button
                          onClick={() => handleReleaseFunds(escrow.escrow_id)}
                          disabled={isProcessing}
                          className="h-10 px-4 rounded-xl bg-emerald-50 text-emerald-600 text-sm font-medium hover:bg-emerald-100 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"
                        >
                          {isProcessing && <Loader2 size={14} className="animate-spin" />}
                          Release Funds
                        </button>
                        <button
                          onClick={() => setConfirmDisputeId(escrow.escrow_id)}
                          disabled={isProcessing}
                          className="h-10 px-4 rounded-xl bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 transition-all active:scale-95 disabled:opacity-50"
                        >
                          Dispute
                        </button>
                      </div>
                    )}

                    {escrow.status === "released" && (
                      <div className="mt-4 flex items-center justify-center gap-2 text-emerald-600">
                        <CheckCircle2 size={20} />
                        <span className="text-sm font-medium">Released</span>
                      </div>
                    )}

                    {escrow.status === "disputed" && escrow.arbiter_address === address?.toLowerCase() && (
                      <div className="flex gap-2 mt-4">
                        <button
                          onClick={() => setConfirmArbiterEscrow({ id: escrow.escrow_id, release: true })}
                          disabled={isProcessing}
                          className="h-10 px-4 rounded-xl bg-emerald-50 text-emerald-600 text-sm font-medium hover:bg-emerald-100 transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"
                        >
                          Release to Beneficiary
                        </button>
                        <button
                          onClick={() => setConfirmArbiterEscrow({ id: escrow.escrow_id, release: false })}
                          disabled={isProcessing}
                          className="h-10 px-4 rounded-xl bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 transition-all active:scale-95 disabled:opacity-50"
                        >
                          Return to Depositor
                        </button>
                      </div>
                    )}

                    {escrow.status === "active" && escrow.depositor_address === address?.toLowerCase() && escrow.deadline && new Date(escrow.deadline).getTime() < Date.now() && (
                      <button
                        onClick={() => setConfirmClaimExpiredId(escrow.escrow_id)}
                        disabled={isProcessing}
                        className="h-10 px-4 rounded-xl bg-amber-50 text-amber-700 text-sm font-medium hover:bg-amber-100 transition-all active:scale-95 disabled:opacity-50 mt-4 flex items-center gap-1"
                      >
                        Claim Expired
                      </button>
                    )}
                  </div>
                  );
                })}
                {visibleEscrowCount < filteredEscrows.length && (
                  <div className="col-span-full">
                    <button
                      onClick={() => setVisibleEscrowCount((c) => c + ESCROW_PAGE_SIZE)}
                      className="w-full h-12 rounded-2xl bg-white/50 border border-black/5 text-sm font-medium text-[var(--text-secondary)] hover:bg-white/70 transition-all mt-3"
                    >
                      Load more ({filteredEscrows.length - visibleEscrowCount} remaining)
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-2xl font-heading font-medium text-[var(--text-primary)]">
                {activeTab === "invoices" ? "New Invoice" : activeTab === "payroll" ? "Run Payroll" : "New Escrow"}
              </h3>
              <button onClick={() => setShowModal(false)} className="p-2 hover:bg-black/5 rounded-xl" aria-label="Close">
                <X size={24} className="text-[var(--text-primary)]/50" />
              </button>
            </div>

            {activeTab === "invoices" && (
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Client Wallet Address</label>
                  <input type="text" value={invoiceClient} onChange={(e) => setInvoiceClient(e.target.value)} placeholder="0x..." className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none font-mono text-sm" />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Client Email (optional)</label>
                  <input type="email" value={invoiceClientEmail} onChange={(e) => setInvoiceClientEmail(e.target.value)} placeholder="client@company.com" className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none text-sm" />
                  <p className="text-xs text-[var(--text-primary)]/40 mt-2">Adds a PDF invoice to your client's inbox with a one-click pay link.</p>
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Amount (USDC)</label>
                  <div className="relative">
                    <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-primary)]/50">$</span>
                    <input type="number" value={invoiceAmount} onChange={(e) => setInvoiceAmount(e.target.value)} placeholder="0.00" className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none text-lg" />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Description</label>
                  <input type="text" value={invoiceDesc} onChange={(e) => setInvoiceDesc(e.target.value)} placeholder="Services rendered" className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none" />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Due in (days)</label>
                  <select value={invoiceDueDays} onChange={(e) => setInvoiceDueDays(e.target.value)} className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none">
                    <option value="7">7 days</option>
                    <option value="14">14 days</option>
                    <option value="30">30 days</option>
                    <option value="60">60 days</option>
                    <option value="90">90 days</option>
                  </select>
                </div>
                <div className="flex gap-3 pt-2">
                  <button onClick={() => setShowModal(false)} className="flex-1 h-14 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium">Cancel</button>
                  <button
                    onClick={handleCreateInvoice}
                    disabled={!invoiceClient || !invoiceAmount || isProcessing}
                    className="flex-1 h-14 rounded-2xl bg-[var(--text-primary)] text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isProcessing ? <Loader2 size={20} className="animate-spin" /> : <Plus size={20} />}
                    {isProcessing ? "Creating..." : "Create Invoice"}
                  </button>
                </div>
              </div>
            )}

            {activeTab === "payroll" && (
              <div className="space-y-4">
                {/* Wave 4 #256 — drag-drop CSV upload that fills the comma-list
                    fields below. CSV format: one row per employee,
                    `address,amount` (header row optional). Comments OK. */}
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">
                    Upload CSV (optional)
                  </label>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = () => {
                        const text = String(reader.result ?? "");
                        const rows = text.split(/\r?\n/)
                          .map((l) => l.trim())
                          .filter((l) => l.length > 0 && !l.startsWith("#"));
                        // Skip header if first cell is non-hex/non-numeric
                        const firstFirstCell = rows[0]?.split(",")[0]?.trim() ?? "";
                        const startsWithHeader = !firstFirstCell.startsWith("0x") && !/^[0-9.]/.test(firstFirstCell);
                        const dataRows = startsWithHeader ? rows.slice(1) : rows;
                        const addrs: string[] = [];
                        const amts: string[] = [];
                        for (const row of dataRows) {
                          const [a, amt] = row.split(",").map((s) => s.trim());
                          if (a && amt) {
                            addrs.push(a);
                            amts.push(amt);
                          }
                        }
                        if (addrs.length === 0) {
                          toast.error("CSV had no valid rows");
                          return;
                        }
                        setPayAddresses(addrs.join(", "));
                        setPayAmounts(amts.join(", "));
                        toast.success(`Loaded ${addrs.length} row${addrs.length === 1 ? "" : "s"} from CSV`);
                      };
                      reader.readAsText(file);
                      // reset input so re-selecting the same file fires onChange
                      e.target.value = "";
                    }}
                    className="block w-full text-sm text-[var(--text-secondary)] file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-medium file:bg-[var(--surface-2)] file:text-[var(--text-primary)] hover:file:bg-[var(--surface-3)] cursor-pointer"
                  />
                  <p className="text-xs text-[var(--text-tertiary)] mt-2">
                    One row per employee: <code className="font-mono">address,amount</code>. Header row optional.
                  </p>
                </div>

                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Employee Addresses (comma-separated)</label>
                  <textarea
                    value={payAddresses}
                    onChange={(e) => setPayAddresses(e.target.value)}
                    placeholder="0xabc..., 0xdef..., 0x123..."
                    rows={3}
                    className="w-full px-5 py-4 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none font-mono text-sm resize-none"
                  />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Amounts in USDC (comma-separated, same order)</label>
                  <textarea
                    value={payAmounts}
                    onChange={(e) => setPayAmounts(e.target.value)}
                    placeholder="5000, 8000, 3500"
                    rows={2}
                    className="w-full px-5 py-4 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none resize-none"
                  />
                </div>
                {/* Live preview */}
                {(() => {
                  const addrs = payAddresses.split(",").map((s) => s.trim()).filter(Boolean);
                  const amts = payAmounts.split(",").map((s) => s.trim()).filter(Boolean);
                  const rows = Math.max(addrs.length, amts.length);
                  if (rows === 0) return null;
                  return (
                    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden">
                      <div className="px-4 py-2 text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)] border-b border-[var(--border)] flex justify-between">
                        <span>Preview ({rows} {rows === 1 ? "employee" : "employees"})</span>
                        <span>{addrs.length === amts.length ? "✓ counts match" : "✗ count mismatch"}</span>
                      </div>
                      <div className="max-h-48 overflow-y-auto divide-y divide-[var(--border)]">
                        {Array.from({ length: rows }).map((_, i) => {
                          const a = addrs[i] ?? "(missing)";
                          const amt = amts[i] ?? "(missing)";
                          const valid = !!addrs[i] && !!amts[i] && isAddress(addrs[i]);
                          return (
                            <div key={i} className="flex items-center justify-between px-4 py-2 text-xs font-mono">
                              <span className={cn("truncate", !valid && "text-amber-600")}>{a}</span>
                              <span className="ml-3 tabular-nums">{amt} USDC</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
                <div className="p-4 rounded-2xl bg-blue-50 border border-blue-100 text-sm text-blue-700">
                  Each amount will be individually encrypted with FHE before sending. Employees only see their own salary.
                </div>
                <div className="flex gap-3 pt-2">
                  <button onClick={() => setShowModal(false)} className="flex-1 h-14 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium">Cancel</button>
                  <button
                    onClick={handleRunPayroll}
                    disabled={!payAddresses || !payAmounts || isProcessing}
                    className="flex-1 h-14 rounded-2xl bg-[var(--text-primary)] text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isProcessing ? <Loader2 size={20} className="animate-spin" /> : <DollarSign size={20} />}
                    {isProcessing ? "Processing..." : "Run Payroll"}
                  </button>
                </div>
              </div>
            )}

            {activeTab === "escrow" && (
              <div className="space-y-4">
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Milestone template</label>
                  <select
                    value={escrowTemplateId}
                    onChange={(e) => applyEscrowTemplate(e.target.value)}
                    className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none"
                  >
                    {MILESTONE_TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </select>
                  <p className="text-xs text-[var(--text-primary)]/40 mt-2">
                    {MILESTONE_TEMPLATES.find((t) => t.id === escrowTemplateId)?.description}
                  </p>
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Beneficiary Address</label>
                  <input type="text" value={escrowBeneficiary} onChange={(e) => setEscrowBeneficiary(e.target.value)} placeholder="0x..." className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none font-mono text-sm" />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Escrow Amount (USDC)</label>
                  <div className="relative">
                    <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-primary)]/50">$</span>
                    <input type="number" value={escrowAmount} onChange={(e) => setEscrowAmount(e.target.value)} placeholder="0.00" className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none text-lg" />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Description</label>
                  <input type="text" value={escrowDesc} onChange={(e) => setEscrowDesc(e.target.value)} placeholder="Project milestone" className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none" />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Arbiter Address (optional)</label>
                  <input type="text" value={escrowArbiter} onChange={(e) => setEscrowArbiter(e.target.value)} placeholder="0x... (leave empty for no arbiter)" className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none font-mono text-sm" />
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Deadline (days from now)</label>
                  <select value={escrowDeadlineDays} onChange={(e) => setEscrowDeadlineDays(e.target.value)} className="h-14 w-full px-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none">
                    <option value="7">7 days</option>
                    <option value="14">14 days</option>
                    <option value="30">30 days</option>
                    <option value="60">60 days</option>
                    <option value="90">90 days</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Attachment (optional)</label>
                  <input
                    type="file"
                    accept="application/pdf,image/*,.txt,.md,.docx"
                    onChange={(e) => setEscrowFile(e.target.files?.[0] ?? null)}
                    className="block w-full text-sm text-[var(--text-primary)]/70 file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:bg-black/5 file:text-[var(--text-primary)] file:font-medium hover:file:bg-black/10"
                  />
                  <p className="text-xs text-[var(--text-primary)]/40 mt-2">
                    Project brief, contract, or deliverable spec — pinned to IPFS, anchored to this escrow.
                  </p>
                </div>
                <div className="flex gap-3 pt-2">
                  <button onClick={() => setShowModal(false)} className="flex-1 h-14 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium">Cancel</button>
                  <button
                    onClick={handleCreateEscrow}
                    disabled={!escrowBeneficiary || !escrowAmount || isProcessing}
                    className="flex-1 h-14 rounded-2xl bg-[var(--text-primary)] text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {isProcessing ? <Loader2 size={20} className="animate-spin" /> : <Plus size={20} />}
                    {isProcessing ? "Creating..." : "Create Escrow"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Dispute Confirmation Dialog */}
      {confirmDisputeId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex flex-col items-center text-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-red-50 flex items-center justify-center">
                <AlertTriangle size={28} className="text-red-500" />
              </div>
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">Dispute Escrow?</h3>
              <p className="text-sm text-[var(--text-primary)]/60">
                This action cannot be undone. The escrow will be flagged as disputed and may require arbiter resolution.
              </p>
              <div className="flex gap-3 w-full pt-2">
                <button
                  onClick={() => setConfirmDisputeId(null)}
                  className="flex-1 h-12 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleDisputeEscrow(confirmDisputeId)}
                  disabled={isProcessing}
                  className="flex-1 h-12 rounded-2xl bg-red-500 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isProcessing && <Loader2 size={16} className="animate-spin" />}
                  Confirm Dispute
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Pay Invoice Dialog */}
      {payInvoiceId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm overflow-y-auto">
          <div className="w-full max-w-sm rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-6 sm:p-8 my-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex flex-col gap-4">
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">Pay Invoice #{payInvoiceId}</h3>
              <div>
                <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-2 block">Amount (USDC)</label>
                <div className="relative">
                  <span className="absolute left-5 top-1/2 -translate-y-1/2 text-lg text-[var(--text-primary)]/50">$</span>
                  <input
                    type="number"
                    value={payInvoiceAmount}
                    onChange={(e) => setPayInvoiceAmount(e.target.value)}
                    placeholder="0.00"
                    className="h-14 w-full pl-10 pr-5 rounded-2xl bg-white/60 dark:bg-white/10 border border-black/10 dark:border-white/10 focus:border-black/20 dark:focus:border-white/20 focus:ring-4 focus:ring-black/5 dark:focus:ring-white/5 dark:text-white outline-none text-lg"
                  />
                </div>
              </div>

              {/* Phase 5.6 / 5.7 — three-mode pay selector. Default
                  "standard" preserves the existing FHE-encrypted-vault
                  flow; "swap" routes through Uniswap (5.6); "oracle"
                  uses a backend-signed price quote (5.7) for tokens
                  that don't have a Uniswap pool. */}
              <div
                role="tablist"
                aria-label="Pay method"
                className="grid grid-cols-3 gap-1 p-1 rounded-2xl bg-black/5 dark:bg-white/5"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={payMode === "standard"}
                  data-testid="pay-mode-standard"
                  onClick={() => setPayMode("standard")}
                  className={cn(
                    "h-10 rounded-xl text-xs font-medium transition-all",
                    payMode === "standard"
                      ? "bg-white dark:bg-white/10 text-[var(--text-primary)] shadow-sm"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                  )}
                >
                  Standard
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={payMode === "swap"}
                  data-testid="pay-mode-swap"
                  onClick={() => setPayMode("swap")}
                  className={cn(
                    "h-10 rounded-xl text-xs font-medium transition-all flex items-center justify-center gap-1.5",
                    payMode === "swap"
                      ? "bg-white dark:bg-white/10 text-[var(--text-primary)] shadow-sm"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                  )}
                >
                  <Repeat size={12} />
                  Swap
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={payMode === "oracle"}
                  data-testid="pay-mode-oracle"
                  onClick={() => setPayMode("oracle")}
                  className={cn(
                    "h-10 rounded-xl text-xs font-medium transition-all",
                    payMode === "oracle"
                      ? "bg-white dark:bg-white/10 text-[var(--text-primary)] shadow-sm"
                      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
                  )}
                >
                  Oracle
                </button>
              </div>

              {payAltMode && (
                <div className="space-y-3 pt-2 border-t border-black/5 dark:border-white/5">
                  <div className="rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 p-3 flex gap-2">
                    <Info size={14} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <div className="text-xs text-amber-900 dark:text-amber-200 leading-snug space-y-1">
                      <p>
                        Amount briefly visible during the Uniswap transit. Vendor
                        receives plaintext USDC (they can shield it after).
                      </p>
                      <p className="text-amber-800/80 dark:text-amber-300/80">
                        Testnet caveat: TestUSDC has no Uniswap pool depth by
                        default. If quotes keep failing, the operator needs to
                        seed a TestUSDC/WETH v3 pool first.
                      </p>
                    </div>
                  </div>

                  {/* Token picker — pulls from KNOWN_TOKENS, excludes USDC
                      (the invoice's underlying token; same-token defeats
                      the purpose of this mode). */}
                  <div>
                    <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-1.5 block">
                      Pay with
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {(KNOWN_TOKENS[activeChainId] ?? [])
                        // Address-based filter (NOT symbol) so a future
                        // chain with multiple USDC variants doesn't slip
                        // through. The contract's same-token check uses
                        // payToken == vault.underlyingToken() which is
                        // contracts.TestUSDC on testnet.
                        .filter(
                          (t) =>
                            t.address.toLowerCase() !==
                            contracts.TestUSDC.toLowerCase(),
                        )
                        .map((t) => (
                          <button
                            key={t.address}
                            data-testid={`pay-alt-token-${t.symbol}`}
                            onClick={() => setPayAltToken(t)}
                            className={cn(
                              "h-12 rounded-xl border text-sm font-medium transition-all",
                              payAltToken?.address === t.address
                                ? "bg-violet-50 border-violet-300 text-violet-900 dark:bg-violet-500/10 dark:border-violet-500/30 dark:text-violet-200"
                                : "bg-white border-black/10 text-[var(--text-primary)] hover:bg-black/[0.02] dark:bg-white/5 dark:border-white/10",
                            )}
                          >
                            {t.symbol}
                          </button>
                        ))}
                    </div>
                  </div>

                  {/* Slippage */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase">
                        Slippage
                      </label>
                      <span className="text-xs font-mono tabular-nums text-[var(--text-primary)]">
                        {(payAltSlippageBps / 100).toFixed(2)}%
                      </span>
                    </div>
                    <div className="flex gap-1.5">
                      {[10, 50, 100, 300].map((bps) => (
                        <button
                          key={bps}
                          data-testid={`pay-alt-slippage-${bps}`}
                          onClick={() => setPayAltSlippageBps(bps)}
                          className={cn(
                            "flex-1 h-8 rounded-lg text-xs font-medium transition-all",
                            payAltSlippageBps === bps
                              ? "bg-[#1D1D1F] dark:bg-white text-white dark:text-[#0A0A0A]"
                              : "bg-black/5 dark:bg-white/5 text-[var(--text-secondary)] hover:bg-black/10",
                          )}
                        >
                          {(bps / 100).toFixed(2)}%
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Quote display */}
                  {payAltToken && payInvoiceAmount && (
                    <div className="rounded-xl bg-black/[0.03] dark:bg-white/[0.03] p-3 text-sm">
                      {payAltQuoteLoading ? (
                        <div className="flex items-center gap-2 text-[var(--text-tertiary)]">
                          <Loader2 size={14} className="animate-spin" />
                          <span className="text-xs">Loading quote…</span>
                        </div>
                      ) : payAltQuoteError ? (
                        <p className="text-xs text-rose-600 dark:text-rose-400 leading-snug">
                          {payAltQuoteError}
                        </p>
                      ) : payAltQuoteIn !== null ? (
                        <div className="flex items-center justify-between">
                          <span className="text-[var(--text-secondary)] text-xs">You pay (max)</span>
                          <span className="font-mono tabular-nums text-[var(--text-primary)]">
                            {Number(
                              formatUnits(
                                applySlippage(
                                  // Quote is the EXACT amount needed; we add
                                  // the slippage buffer on top so the swap has
                                  // headroom under thin testnet pool depth.
                                  payAltQuoteIn + (payAltQuoteIn * BigInt(payAltSlippageBps)) / 10_000n,
                                  0,
                                ),
                                payAltToken.decimals,
                              ),
                            ).toLocaleString(undefined, { maximumFractionDigits: 6 })}{" "}
                            {payAltToken.symbol}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
              )}

              {/* Phase 5.7 — Oracle quote panel. Active when payMode === "oracle".
                  Lets the caller pick a payToken from KNOWN_TOKENS, fetches a
                  signed quote from /api/oracle/quote, displays the quote, and
                  the parent CTA submits via payInvoiceWithOracleQuote. */}
              {payMode === "oracle" && (
                <div className="space-y-3 pt-2 border-t border-black/5 dark:border-white/5">
                  <div className="rounded-xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 p-3 flex gap-2">
                    <Info size={14} className="text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <div className="text-xs text-amber-900 dark:text-amber-200 leading-snug space-y-1">
                      <p>
                        For tokens Uniswap doesn't have a pool for. The backend
                        signs a price quote that the contract verifies on chain.
                      </p>
                      <p className="text-amber-800/80 dark:text-amber-300/80">
                        Allowlist + rate set by operator. The contract enforces
                        ratePpm ∈ [1, 1e8] as a sanity bound on top of the
                        signature check.
                      </p>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-[var(--text-primary)]/50 font-medium uppercase mb-1.5 block">
                      Pay with
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {(KNOWN_TOKENS[activeChainId] ?? [])
                        .filter(
                          (t) =>
                            t.address.toLowerCase() !== contracts.TestUSDC.toLowerCase(),
                        )
                        .map((t) => (
                          <button
                            key={t.address}
                            data-testid={`pay-oracle-token-${t.symbol}`}
                            onClick={() => {
                              setPayAltToken(t);
                              setOracleQuote(null);
                              setOracleError(null);
                            }}
                            className={cn(
                              "h-12 rounded-xl border text-sm font-medium transition-all",
                              payAltToken?.address === t.address
                                ? "bg-violet-50 border-violet-300 text-violet-900 dark:bg-violet-500/10 dark:border-violet-500/30 dark:text-violet-200"
                                : "bg-white border-black/10 text-[var(--text-primary)] hover:bg-black/[0.02] dark:bg-white/5 dark:border-white/10",
                            )}
                          >
                            {t.symbol}
                          </button>
                        ))}
                    </div>
                  </div>

                  {payAltToken && payInvoiceAmount && (
                    <button
                      onClick={() => void handleFetchOracleQuote()}
                      disabled={oracleFetching}
                      data-testid="fetch-oracle-quote"
                      className="w-full h-10 rounded-xl bg-black/5 dark:bg-white/5 text-[var(--text-primary)] text-sm font-medium hover:bg-black/10 dark:hover:bg-white/10 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                      {oracleFetching ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : null}
                      <span>
                        {oracleQuote ? "Refresh quote" : "Fetch signed quote"}
                      </span>
                    </button>
                  )}

                  {oracleError && (
                    <p className="text-xs text-rose-600 dark:text-rose-400 leading-snug">
                      {oracleError}
                    </p>
                  )}

                  {oracleQuote && payAltToken && (
                    <div className="rounded-xl bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-100 dark:border-emerald-500/20 p-3 text-sm space-y-1">
                      <div className="flex justify-between">
                        <span className="text-[var(--text-secondary)] text-xs">You pay</span>
                        <span className="font-mono tabular-nums">
                          {Number(
                            formatUnits(
                              BigInt(oracleQuote.payAmountIn),
                              payAltToken.decimals,
                            ),
                          ).toLocaleString(undefined, {
                            maximumFractionDigits: 6,
                          })}{" "}
                          {payAltToken.symbol}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--text-secondary)] text-xs">
                          Rate (ppm)
                        </span>
                        <span className="font-mono tabular-nums">
                          {oracleQuote.ratePpm}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-[var(--text-secondary)] text-xs">
                          Quote valid until
                        </span>
                        <span className="font-mono tabular-nums">
                          {new Date(oracleQuote.expiresAt * 1000).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => {
                    setPayInvoiceId(null);
                    setPayInvoiceAmount("");
                    setPayMode("standard");
                    setPayAltToken(null);
                    setPayAltQuoteIn(null);
                    setPayAltQuoteError(null);
                    setOracleQuote(null);
                    setOracleError(null);
                  }}
                  className="flex-1 h-12 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={
                    payMode === "swap"
                      ? handlePayInvoiceWithSwap
                      : payMode === "oracle"
                        ? handlePayInvoiceWithOracleQuote
                        : handlePayInvoice
                  }
                  disabled={
                    !payInvoiceAmount ||
                    isProcessing ||
                    (payMode === "swap" &&
                      (!payAltToken || payAltQuoteIn === null || payAltQuoteLoading)) ||
                    (payMode === "oracle" && !oracleQuote)
                  }
                  className={cn(
                    "flex-1 h-12 rounded-2xl text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50",
                    payMode === "swap" || payMode === "oracle"
                      ? "bg-violet-600 hover:bg-violet-700"
                      : "bg-emerald-500",
                  )}
                >
                  {isProcessing && <Loader2 size={16} className="animate-spin" />}
                  {payMode === "swap" && payAltToken
                    ? `Swap & Pay ${payAltToken.symbol}`
                    : payMode === "oracle" && payAltToken
                      ? `Pay with ${payAltToken.symbol}`
                      : "Pay"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cancel Invoice Confirmation */}
      {confirmCancelInvoiceId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex flex-col items-center text-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-red-50 flex items-center justify-center">
                <AlertTriangle size={28} className="text-red-500" />
              </div>
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">Cancel Invoice?</h3>
              <p className="text-sm text-[var(--text-primary)]/60">
                This will permanently cancel the invoice. This action cannot be undone.
              </p>
              <div className="flex gap-3 w-full pt-2">
                <button
                  onClick={() => setConfirmCancelInvoiceId(null)}
                  className="flex-1 h-12 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium"
                >
                  Keep
                </button>
                <button
                  onClick={() => handleCancelInvoice(confirmCancelInvoiceId)}
                  disabled={isProcessing}
                  className="flex-1 h-12 rounded-2xl bg-red-500 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isProcessing && <Loader2 size={16} className="animate-spin" />}
                  Cancel Invoice
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Arbiter Decision Confirmation */}
      {confirmArbiterEscrow !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex flex-col items-center text-center gap-4">
              <div className={cn("w-14 h-14 rounded-2xl flex items-center justify-center", confirmArbiterEscrow.release ? "bg-emerald-50" : "bg-red-50")}>
                <AlertTriangle size={28} className={confirmArbiterEscrow.release ? "text-emerald-500" : "text-red-500"} />
              </div>
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">
                {confirmArbiterEscrow.release ? "Release to Beneficiary?" : "Return to Depositor?"}
              </h3>
              <p className="text-sm text-[var(--text-primary)]/60">
                As arbiter, your decision is final and cannot be reversed.
              </p>
              <div className="flex gap-3 w-full pt-2">
                <button
                  onClick={() => setConfirmArbiterEscrow(null)}
                  className="flex-1 h-12 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleArbiterDecide(confirmArbiterEscrow.id, confirmArbiterEscrow.release)}
                  disabled={isProcessing}
                  className={cn(
                    "flex-1 h-12 rounded-2xl text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50",
                    confirmArbiterEscrow.release ? "bg-emerald-500" : "bg-red-500",
                  )}
                >
                  {isProcessing && <Loader2 size={16} className="animate-spin" />}
                  Confirm
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Claim Expired Escrow Confirmation */}
      {confirmClaimExpiredId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-[2rem] bg-white dark:bg-gray-900 shadow-2xl p-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
            <div className="flex flex-col items-center text-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-amber-50 flex items-center justify-center">
                <AlertTriangle size={28} className="text-amber-500" />
              </div>
              <h3 className="text-xl font-heading font-medium text-[var(--text-primary)]">Claim Expired Escrow?</h3>
              <p className="text-sm text-[var(--text-primary)]/60">
                The escrow deadline has passed. You can reclaim the deposited funds.
              </p>
              <div className="flex gap-3 w-full pt-2">
                <button
                  onClick={() => setConfirmClaimExpiredId(null)}
                  className="flex-1 h-12 rounded-2xl bg-black/5 text-[var(--text-primary)] font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={() => handleClaimExpired(confirmClaimExpiredId)}
                  disabled={isProcessing}
                  className="flex-1 h-12 rounded-2xl bg-amber-500 text-white font-medium flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isProcessing && <Loader2 size={16} className="animate-spin" />}
                  Claim Funds
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
