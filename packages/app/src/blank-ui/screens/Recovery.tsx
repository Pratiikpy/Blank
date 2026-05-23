import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, AlertOctagon, ShieldCheck, Clock } from "lucide-react";
import toast from "react-hot-toast";

import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useHandleResolver } from "@/hooks/useHandleResolver";
import { useGuardianRecovery } from "@/hooks/useGuardianRecovery";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Wave 5 Block 3 — public recovery screen.
 *
 * /recover/:handle resolves the handle's owner, then drives the
 * GuardianModule flow. Three personas hit this screen:
 *
 *   1. The recovering user (lost passkey, new device). They paste
 *      their NEW smart-account address into the form. The actual
 *      transaction is signed by a GUARDIAN, not the user, because
 *      the user has no working key yet.
 *   2. A guardian. They approve or veto an existing request.
 *   3. Anyone. After the window expires and the threshold is met,
 *      anyone can call finalizeRecovery to emit the event.
 *
 * Wave 5 v1 ships the on-chain state machine. The actual rotation
 * of BlankAccount.owner happens in Wave 5.5 (separate UUPS upgrade).
 * The honest banner says so.
 */
export default function Recovery() {
  const { handle: rawHandle } = useParams<{ handle: string }>();
  const cleanHandle = useMemo(() => (rawHandle ?? "").replace(/^@/, ""), [rawHandle]);
  const { activeChain } = useChain();
  const { effectiveAddress } = useEffectiveAddress();

  const handles = useHandleResolver();
  const guardian = useGuardianRecovery();

  const [targetAccount, setTargetAccount] = useState<`0x${string}` | null>(null);
  const [newOwnerInput, setNewOwnerInput] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  // Live countdown
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);

  // Resolve handle → owner
  useEffect(() => {
    let cancelled = false;
    handles.lookup(cleanHandle).then((r) => {
      if (!cancelled) setTargetAccount(r?.owner ?? null);
    });
    return () => { cancelled = true; };
  }, [handles, cleanHandle]);

  // Once targetAccount is known, refresh the guardian module against it
  useEffect(() => {
    if (targetAccount) guardian.refresh(targetAccount);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetAccount]);

  if (handles.deploy.status !== "live" || guardian.deploy.status !== "live") {
    return <Shell>
      <Banner kind="amber">
        <strong>Recovery not yet live on {activeChain.name}.</strong>{" "}
        Operator must run pnpm hardhat deploy-blank-handles + deploy-guardian-module.
      </Banner>
    </Shell>;
  }

  if (!targetAccount || targetAccount === ZERO) {
    return <Shell>
      <Banner kind="amber">
        <strong>No one owns @{cleanHandle} on this chain.</strong>
      </Banner>
    </Shell>;
  }

  const isGuardian = effectiveAddress
    ? guardian.guardians.some((g) => g.toLowerCase() === effectiveAddress.toLowerCase())
    : false;
  const r = guardian.activeRequest;
  const hasActive = r && r.requestedAt > 0 && !r.finalized;
  const unlockTs = r ? r.requestedAt + guardian.windowSec : 0;
  const secsUntilUnlock = Math.max(0, unlockTs - now);
  const meetsThreshold = r ? r.approvals >= guardian.threshold : false;

  const submitRequest = async () => {
    if (!targetAccount) return;
    if (!/^0x[0-9a-fA-F]{40}$/.test(newOwnerInput)) {
      toast.error("New owner must be a 0x address.");
      return;
    }
    await guardian.requestRecovery(targetAccount, newOwnerInput as `0x${string}`);
  };

  return (
    <Shell>
      <header className="mb-6">
        <h1 className="text-3xl font-heading font-semibold mb-1">
          Recover <span className="text-[var(--text-secondary)]">@</span>{cleanHandle}
        </h1>
        <p className="text-sm text-[var(--text-secondary)] max-w-xl">
          Guardian-based social recovery for <code className="font-mono text-xs">{targetAccount}</code>.
          Threshold {guardian.threshold} of {guardian.guardians.length} on this chain.
        </p>
      </header>

      <Banner kind="blue">
        <strong>Wave 5 v1 ships the state machine.</strong>{" "}
        On finalize the contract emits RecoveryFinalized. BlankAccount
        owner-rotation hook lands in Wave 5.5 alongside a UUPS upgrade.
      </Banner>

      {guardian.guardians.length === 0 ? (
        <div data-testid="recovery-no-guardians" className="glass-card-static rounded-2xl p-6 mt-6">
          <div className="text-sm text-[var(--text-secondary)]">
            This account has no guardians configured. The owner must
            add at least 3 guardians (threshold 2) from Settings →
            Recovery before this flow is usable.
          </div>
        </div>
      ) : !hasActive ? (
        <div className="glass-card-static rounded-2xl p-6 mt-6">
          <h2 className="text-lg font-semibold mb-3">Request recovery</h2>
          <p className="text-sm text-[var(--text-secondary)] mb-4">
            A guardian submits the recovery request on behalf of the
            recovering user. Paste the user's NEW smart-account address.
            After the window ({Math.floor(guardian.windowSec / 60)} min) any
            guardian can veto. After window + threshold ({guardian.threshold}),
            anyone can finalize.
          </p>
          <input
            data-testid="recovery-new-owner-input"
            value={newOwnerInput}
            onChange={(e) => setNewOwnerInput(e.target.value)}
            placeholder="0x... (new smart-account address)"
            className="w-full h-11 px-3 rounded-xl bg-white/60 border border-black/5 font-mono text-sm mb-3"
          />
          <button
            data-testid="recovery-submit-request"
            disabled={!isGuardian}
            onClick={submitRequest}
            className="w-full h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black disabled:opacity-40"
          >
            {isGuardian ? "Submit recovery request" : "Connect a guardian wallet to submit"}
          </button>
        </div>
      ) : (
        <ActiveRequest
          newOwner={r!.newOwner}
          approvals={r!.approvals}
          threshold={guardian.threshold}
          vetoed={r!.vetoed}
          secsUntilUnlock={secsUntilUnlock}
          meetsThreshold={meetsThreshold}
          isGuardian={isGuardian}
          onApprove={() => guardian.approveRecovery(targetAccount)}
          onVeto={() => guardian.vetoRecovery(targetAccount)}
          onFinalize={() => guardian.finalizeRecovery(targetAccount)}
        />
      )}
    </Shell>
  );
}

function ActiveRequest({
  newOwner, approvals, threshold, vetoed, secsUntilUnlock, meetsThreshold, isGuardian,
  onApprove, onVeto, onFinalize,
}: {
  newOwner: `0x${string}`; approvals: number; threshold: number;
  vetoed: boolean; secsUntilUnlock: number; meetsThreshold: boolean; isGuardian: boolean;
  onApprove: () => Promise<unknown>;
  onVeto: () => Promise<unknown>;
  onFinalize: () => Promise<unknown>;
}) {
  return (
    <div className="glass-card-static rounded-2xl p-6 mt-6 space-y-4">
      <div className="flex items-center gap-2">
        <ShieldCheck size={18} className={vetoed ? "text-rose-600" : "text-blue-600"} />
        <h2 className="text-lg font-semibold">
          {vetoed ? "Recovery vetoed" : "Active recovery request"}
        </h2>
      </div>
      <div className="text-sm text-[var(--text-secondary)]">
        New owner pending: <code className="font-mono text-xs">{newOwner}</code>
      </div>
      <div className="text-sm">
        Approvals: <span className="font-medium">{approvals}/{threshold}</span>
        {vetoed && <span className="ml-2 text-rose-600">(vetoed)</span>}
      </div>
      <div className="text-sm flex items-center gap-1">
        <Clock size={14} className="text-[var(--text-secondary)]" />
        {secsUntilUnlock > 0
          ? `Window: ${Math.ceil(secsUntilUnlock / 60)} min remaining`
          : "Window closed"}
      </div>

      {!vetoed && (
        <>
          {isGuardian && (
            <div className="flex gap-2">
              <button
                data-testid="recovery-approve"
                onClick={onApprove}
                className="flex-1 h-12 rounded-2xl bg-emerald-600 text-white font-medium hover:bg-emerald-700"
              >
                Approve
              </button>
              <button
                data-testid="recovery-veto"
                onClick={onVeto}
                className="flex-1 h-12 rounded-2xl bg-rose-600 text-white font-medium hover:bg-rose-700"
              >
                Veto
              </button>
            </div>
          )}
          <button
            data-testid="recovery-finalize"
            disabled={!meetsThreshold || secsUntilUnlock > 0}
            onClick={onFinalize}
            className="w-full h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black disabled:opacity-40"
          >
            {secsUntilUnlock > 0
              ? `Finalize in ${Math.ceil(secsUntilUnlock / 60)} min`
              : !meetsThreshold
                ? `Need ${threshold - approvals} more approval(s)`
                : "Finalize recovery"}
          </button>
        </>
      )}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F9FAFB] py-10 px-4">
      <div className="max-w-xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-1 text-sm text-[var(--text-secondary)] mb-6 hover:text-[var(--text-primary)]">
          <ArrowLeft size={14} /> Home
        </Link>
        {children}
      </div>
    </div>
  );
}

function Banner({ kind, children }: { kind: "amber" | "blue"; children: React.ReactNode }) {
  const tone = kind === "amber"
    ? "border-amber-500/30 bg-amber-500/5 text-amber-700"
    : "border-blue-500/30 bg-blue-500/5 text-blue-700";
  return (
    <div className={`rounded-2xl border px-4 py-3 flex items-start gap-3 ${tone}`}>
      <AlertOctagon size={18} className="shrink-0 mt-0.5" />
      <div className="text-sm">{children}</div>
    </div>
  );
}
