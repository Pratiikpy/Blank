import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, AlertOctagon, ShieldCheck, Clock, Copy, KeyRound, Loader2, Trash2, UserPlus } from "lucide-react";
import toast from "react-hot-toast";
import { isAddress, type Address } from "viem";
import { usePublicClient } from "wagmi";

import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "@/hooks/useEffectiveAddress";
import { useHandleResolver } from "@/hooks/useHandleResolver";
import { useUnifiedWrite } from "@/hooks/useUnifiedWrite";
import { useAccountGasFunds, SELF_PAID_SETTINGS_OP_WEI } from "@/hooks/useAccountGasFunds";
import { useSelfCallSponsorship } from "@/hooks/useSelfCallSponsorship";
import {
  useGuardianRecovery,
  formatRecoveryKey,
  parseRecoveryKey,
  recoveryKeyHashOf,
  type RecoveryKey,
} from "@/hooks/useGuardianRecovery";
import { BlankAccountAbi, BlankAccountFactoryAbi } from "@/lib/abis";
import {
  createPasskey,
  getPasskeyPubkey,
  getRecoveredAccount,
  hasPasskey,
  setRecoveredAccount,
} from "@/lib/passkey";
import { broadcastAction } from "@/lib/cross-tab";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * /recover/:handle: guardian social recovery for a BlankAccount.
 *
 *   1. The account owner (before anything is lost) connects the guardian
 *      module to the account and adds 3+ guardians with a majority
 *      threshold.
 *   2. The recovering user, on a browser with no passkey for this chain,
 *      creates a NEW passkey here. It is bound to the account and its
 *      public key is shown as a recovery key to send to a guardian.
 *   3. A guardian pastes that key and opens the request. The contract
 *      commits the key's hash. Other guardians approve or veto; a veto
 *      takes vetoQuorum votes, not one.
 *   4. After the window (at least 24 hours) and with the threshold met, an
 *      approving guardian finalizes with the same key. The account's owner
 *      key rotates to the new passkey and every session key is revoked.
 */
export default function Recovery() {
  const { handle: rawHandle } = useParams<{ handle: string }>();
  const cleanHandle = useMemo(() => (rawHandle ?? "").replace(/^@/, ""), [rawHandle]);
  const { activeChain, activeChainId, contracts } = useChain();
  const { effectiveAddress } = useEffectiveAddress();
  const publicClient = usePublicClient({ chainId: activeChainId });

  const handles = useHandleResolver();
  const guardian = useGuardianRecovery();

  const [targetAccount, setTargetAccount] = useState<`0x${string}` | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    handles.lookup(cleanHandle).then((r) => {
      if (!cancelled) setTargetAccount(r?.owner ?? null);
    });
    return () => { cancelled = true; };
  }, [handles, cleanHandle]);

  useEffect(() => {
    if (targetAccount) guardian.refresh(targetAccount);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetAccount, effectiveAddress]);

  const run = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try { await fn(); } catch { /* the hook already toasted */ } finally { setBusy(null); }
  }, []);

  if (handles.deploy.status !== "live" || guardian.deploy.status !== "live") {
    return <Shell>
      <Banner kind="amber">
        <strong>Recovery is not live on {activeChain.name}.</strong>{" "}
        The handle registry or the guardian module is not deployed on this chain.
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

  const isOwner = !!effectiveAddress && effectiveAddress.toLowerCase() === targetAccount.toLowerCase();
  const isGuardian = effectiveAddress
    ? guardian.guardians.some((g) => g.toLowerCase() === effectiveAddress.toLowerCase())
    : false;
  const r = guardian.activeRequest;
  const hasActive = !!r && r.requestedAt > 0 && !r.finalized && guardian.committedKeyHash !== null;
  const unlockTs = r ? r.requestedAt + guardian.windowSec : 0;
  const secsUntilUnlock = Math.max(0, unlockTs - now);
  const meetsThreshold = r ? r.approvals >= guardian.threshold : false;
  const parsedKey = parseRecoveryKey(keyInput);
  const keyMatchesCommit =
    !!parsedKey && !!guardian.committedKeyHash &&
    recoveryKeyHashOf(parsedKey).toLowerCase() === guardian.committedKeyHash.toLowerCase();

  const submitRequest = () => {
    if (!parsedKey) {
      toast.error("Paste the recovery key the recovering user shared (blank-recovery-key:...).");
      return;
    }
    void run("request", () => guardian.requestRecovery(targetAccount, parsedKey));
  };

  const submitFinalize = () => {
    if (!parsedKey || !keyMatchesCommit) {
      toast.error("That key does not match the one this request committed.");
      return;
    }
    void run("finalize", () => guardian.finalizeRecovery(targetAccount, parsedKey));
  };

  return (
    <Shell>
      <header className="mb-6">
        <h1 className="text-3xl font-heading font-semibold mb-1">
          Recover <span className="text-[var(--text-secondary)]">@</span>{cleanHandle}
        </h1>
        <p className="text-sm text-[var(--text-secondary)] max-w-xl break-all">
          Guardian recovery for <code className="font-mono text-xs">{targetAccount}</code>.
          Threshold {guardian.threshold} of {guardian.guardians.length} on {activeChain.name}.
        </p>
      </header>

      <Banner kind="blue">
        Finalizing moves the account to the recovering user's new passkey and
        revokes every session key. The request waits at least{" "}
        {Math.max(1, Math.round(guardian.windowSec / 3600))} hours so the owner
        or the guardians can stop it.
      </Banner>

      {isOwner && (
        <OwnerPanel
          account={targetAccount}
          guardianModule={guardian.deploy.address as Address}
          guardians={guardian.guardians}
          threshold={guardian.threshold}
          hasActive={hasActive}
          busy={busy}
          run={run}
          onAdd={(g) => guardian.addGuardian(g)}
          onRemove={(g) => guardian.removeGuardian(g)}
          onThreshold={(t) => guardian.setThreshold(t)}
          onCancel={() => guardian.cancelRecovery()}
          refresh={() => guardian.refresh(targetAccount)}
        />
      )}

      {!isOwner && !isGuardian && (
        <RecoveringUserPanel
          account={targetAccount}
          chainId={activeChainId}
          factory={contracts.BlankAccountFactory as Address}
          publicClient={publicClient}
        />
      )}

      {guardian.guardians.length === 0 ? (
        <div data-testid="recovery-no-guardians" className="glass-card-static rounded-2xl p-6 mt-6">
          <div className="text-sm text-[var(--text-secondary)]">
            This account has no guardians. The owner must add at least 3
            guardians and set a majority threshold on this page before
            recovery can work.
          </div>
        </div>
      ) : !hasActive ? (
        isGuardian && (
          <div className="glass-card-static rounded-2xl p-6 mt-6">
            <h2 className="text-lg font-semibold mb-3">Open a recovery request</h2>
            <p className="text-sm text-[var(--text-secondary)] mb-4">
              Paste the recovery key the user sent you. Check with them in
              person or by call that it is really theirs: the account moves
              to whoever holds that passkey.
            </p>
            <textarea
              data-testid="recovery-new-owner-input"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="blank-recovery-key:0x…:0x…"
              rows={3}
              className="w-full px-3 py-2 rounded-xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 font-mono text-xs mb-2 break-all"
            />
            {keyInput && !parsedKey && (
              <p className="text-xs text-rose-600 mb-2">Not a valid recovery key.</p>
            )}
            <button
              data-testid="recovery-submit-request"
              disabled={!parsedKey || busy !== null}
              onClick={submitRequest}
              className="w-full h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {busy === "request" && <Loader2 size={16} className="animate-spin" />}
              Submit recovery request
            </button>
          </div>
        )
      ) : (
        <div className="glass-card-static rounded-2xl p-6 mt-6 space-y-4">
          <div className="flex items-center gap-2">
            <ShieldCheck size={18} className={r!.vetoed ? "text-rose-600" : "text-blue-600"} />
            <h2 className="text-lg font-semibold">
              {r!.vetoed ? "Recovery vetoed" : "Active recovery request"}
            </h2>
          </div>
          <div className="text-xs text-[var(--text-secondary)] break-all">
            Committed key hash: <code className="font-mono">{guardian.committedKeyHash}</code>
          </div>
          <div className="text-sm">
            Approvals: <span className="font-medium">{r!.approvals}/{guardian.threshold}</span>
            <span className="text-[var(--text-secondary)]"> · a veto needs {guardian.vetoQuorum} guardian vote(s)</span>
          </div>
          <div className="text-sm flex items-center gap-1">
            <Clock size={14} className="text-[var(--text-secondary)]" />
            {secsUntilUnlock > 0
              ? `Window: ${formatDuration(secsUntilUnlock)} remaining`
              : "Window closed"}
          </div>

          {!r!.vetoed && isGuardian && (
            <>
              {!guardian.myApproval.approved && !guardian.myApproval.vetoed ? (
                <div className="flex flex-col sm:flex-row gap-2">
                  <button
                    data-testid="recovery-approve"
                    disabled={busy !== null}
                    onClick={() => void run("approve", () => guardian.approveRecovery(targetAccount))}
                    className="flex-1 h-12 rounded-2xl bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Approve
                  </button>
                  <button
                    data-testid="recovery-veto"
                    disabled={busy !== null}
                    onClick={() => void run("veto", () => guardian.vetoRecovery(targetAccount))}
                    className="flex-1 h-12 rounded-2xl bg-rose-600 text-white font-medium hover:bg-rose-700 disabled:opacity-50"
                  >
                    Vote to veto
                  </button>
                </div>
              ) : (
                <p className="text-sm text-[var(--text-secondary)]">
                  You {guardian.myApproval.approved ? "approved" : "voted to veto"} this request.
                </p>
              )}

              {guardian.myApproval.approved && (
                <div className="space-y-2">
                  <label className="text-sm font-medium block">Recovery key to finalize with</label>
                  <textarea
                    data-testid="recovery-finalize-key"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder="blank-recovery-key:0x…:0x…"
                    rows={3}
                    className="w-full px-3 py-2 rounded-xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 font-mono text-xs break-all"
                  />
                  {keyInput && !keyMatchesCommit && (
                    <p className="text-xs text-rose-600">This key does not match the committed hash.</p>
                  )}
                  <button
                    data-testid="recovery-finalize"
                    disabled={!meetsThreshold || secsUntilUnlock > 0 || !keyMatchesCommit || busy !== null}
                    onClick={submitFinalize}
                    className="w-full h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black disabled:opacity-40 flex items-center justify-center gap-2"
                  >
                    {busy === "finalize" && <Loader2 size={16} className="animate-spin" />}
                    {secsUntilUnlock > 0
                      ? `Finalize in ${formatDuration(secsUntilUnlock)}`
                      : !meetsThreshold
                        ? `Need ${guardian.threshold - r!.approvals} more approval(s)`
                        : "Finalize and rotate the owner key"}
                  </button>
                </div>
              )}
            </>
          )}
          {!isGuardian && !r!.vetoed && (
            <p className="text-sm text-[var(--text-secondary)]">
              Only an approving guardian can finalize. Share the recovery key with them.
            </p>
          )}
        </div>
      )}
    </Shell>
  );
}

// ─── Owner: connect the module, manage guardians ────────────────────────

function OwnerPanel(props: {
  account: `0x${string}`;
  guardianModule: Address;
  guardians: `0x${string}`[];
  threshold: number;
  hasActive: boolean;
  busy: string | null;
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  onAdd: (g: `0x${string}`) => Promise<unknown>;
  onRemove: (g: `0x${string}`) => Promise<unknown>;
  onThreshold: (t: number) => Promise<unknown>;
  onCancel: () => Promise<unknown>;
  refresh: () => Promise<unknown>;
}) {
  const { activeChainId } = useChain();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { unifiedWriteAndWait } = useUnifiedWrite();
  const funds = useAccountGasFunds(props.account);
  const [moduleOnAccount, setModuleOnAccount] = useState<string | null>(null);
  const [newGuardian, setNewGuardian] = useState("");
  const n = props.guardians.length;
  const minThreshold = Math.max(2, Math.floor(n / 2) + 1);
  const [threshold, setThreshold] = useState<number>(minThreshold);

  useEffect(() => { setThreshold((t) => Math.min(Math.max(t, minThreshold), Math.max(n, minThreshold))); }, [minThreshold, n]);

  const readModule = useCallback(async () => {
    if (!publicClient) return;
    try {
      const m = (await publicClient.readContract({
        address: props.account, abi: BlankAccountAbi, functionName: "recoveryModule",
      })) as string;
      setModuleOnAccount(m);
    } catch {
      setModuleOnAccount(null);
    }
  }, [publicClient, props.account]);
  useEffect(() => { void readModule(); }, [readModule]);

  const connected = !!moduleOnAccount && moduleOnAccount.toLowerCase() === props.guardianModule.toLowerCase();
  const canSelfPay = funds.totalWei !== null && funds.totalWei >= SELF_PAID_SETTINGS_OP_WEI;
  const sponsored = useSelfCallSponsorship("recoveryModule", props.guardianModule);
  const canConnect = sponsored === true || canSelfPay;

  const connect = () => props.run("connect", async () => {
    // A call into the account: sponsored when the paymaster approves this
    // module, otherwise paid from the account's own gas.
    await unifiedWriteAndWait({
      address: props.account,
      abi: BlankAccountAbi,
      functionName: "setRecoveryModule",
      args: [props.guardianModule],
      gas: 150_000n,
    });
    await readModule();
    toast.success("Guardian module connected");
  });

  return (
    <div className="glass-card-static rounded-2xl p-6 mt-6 space-y-5" data-testid="recovery-owner-panel">
      <h2 className="text-lg font-semibold">Your recovery setup</h2>

      <div className="text-sm">
        {connected ? (
          <p className="text-emerald-700 dark:text-emerald-400">Guardian module connected to your account.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-[var(--text-secondary)]">
              Your account does not point at the guardian module yet, so a
              finalized recovery could not rotate your key.{" "}
              {sponsored === true
                ? "Connecting is an account change. Gas is sponsored by Blank."
                : "Connecting is an account change and pays its own gas while sponsorship is unavailable."}
            </p>
            {!canConnect && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Add a little ETH on the <Link to="/app/wallet" className="underline">Smart wallet</Link> screen first.
              </p>
            )}
            <button
              data-testid="recovery-connect-module"
              disabled={!canConnect || props.busy !== null}
              onClick={() => void connect()}
              className="h-11 px-4 rounded-xl bg-[#1D1D1F] text-white text-sm font-medium hover:bg-black disabled:opacity-40 flex items-center gap-2"
            >
              {props.busy === "connect" && <Loader2 size={14} className="animate-spin" />}
              Connect guardian module
            </button>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Guardians ({n})</h3>
        {n === 0 && <p className="text-xs text-[var(--text-secondary)]">None yet. Add at least 3 people or wallets you trust.</p>}
        <ul className="space-y-1">
          {props.guardians.map((g) => (
            <li key={g} className="flex items-center gap-2 text-xs font-mono break-all">
              <span className="flex-1">{g}</span>
              <button
                aria-label={`Remove guardian ${g}`}
                disabled={props.busy !== null || props.hasActive}
                onClick={() => void props.run("remove", () => props.onRemove(g))}
                className="w-9 h-9 rounded-lg hover:bg-rose-500/10 text-rose-600 flex items-center justify-center disabled:opacity-40 shrink-0"
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            data-testid="recovery-add-guardian-input"
            value={newGuardian}
            onChange={(e) => setNewGuardian(e.target.value.trim())}
            placeholder="0x… guardian address"
            className="flex-1 h-11 px-3 rounded-xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 font-mono text-sm"
          />
          <button
            disabled={!isAddress(newGuardian) || props.busy !== null || n >= 10}
            onClick={() => void props.run("add", async () => { await props.onAdd(newGuardian as `0x${string}`); setNewGuardian(""); })}
            className="h-11 px-4 rounded-xl bg-[#1D1D1F] text-white text-sm font-medium hover:bg-black disabled:opacity-40 flex items-center justify-center gap-1.5"
          >
            {props.busy === "add" ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
            Add guardian
          </button>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Approvals needed: {props.threshold || "not set"}</h3>
        {n < 3 ? (
          <p className="text-xs text-[var(--text-secondary)]">Add {3 - n} more guardian(s) to set a threshold.</p>
        ) : (
          <div className="flex items-center gap-2">
            <select
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="h-11 px-3 rounded-xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 text-sm"
            >
              {Array.from({ length: n - minThreshold + 1 }, (_, i) => minThreshold + i).map((t) => (
                <option key={t} value={t}>{t} of {n}</option>
              ))}
            </select>
            <button
              disabled={props.busy !== null || threshold === props.threshold}
              onClick={() => void props.run("threshold", () => props.onThreshold(threshold))}
              className="h-11 px-4 rounded-xl bg-[#1D1D1F] text-white text-sm font-medium hover:bg-black disabled:opacity-40"
            >
              Save threshold
            </button>
          </div>
        )}
      </div>

      {props.hasActive && (
        <div className="pt-2 border-t border-black/5 dark:border-white/10">
          <p className="text-sm mb-2">
            A recovery request is open on your account. If you did not ask for
            it and still have your passkey, cancel it now.
          </p>
          <button
            data-testid="recovery-cancel"
            disabled={props.busy !== null}
            onClick={() => void props.run("cancel", props.onCancel)}
            className="h-11 px-4 rounded-xl bg-rose-600 text-white text-sm font-medium hover:bg-rose-700 disabled:opacity-40"
          >
            Cancel the recovery request
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Recovering user: make a new passkey bound to the account ───────────

function RecoveringUserPanel(props: {
  account: `0x${string}`;
  chainId: number;
  factory: Address;
  publicClient: ReturnType<typeof usePublicClient>;
}) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "none" }
    | { kind: "other-passkey" }
    | { kind: "bound"; key: RecoveryKey }
  >({ kind: "loading" });
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    if (!(await hasPasskey(props.chainId))) return setState({ kind: "none" });
    const [pub, bound] = await Promise.all([getPasskeyPubkey(props.chainId), getRecoveredAccount(props.chainId)]);
    if (pub && bound && bound.address.toLowerCase() === props.account.toLowerCase()) {
      return setState({ kind: "bound", key: { x: BigInt(pub.pubX), y: BigInt(pub.pubY) } });
    }
    setState({ kind: "other-passkey" });
  }, [props.chainId, props.account]);
  useEffect(() => { void load(); }, [load]);

  // The sponsor re-derives the account's CREATE2 address from the keys it
  // was created with: read them from the factory's AccountCreated event,
  // falling back to the current owner key (the same thing unless the
  // account was recovered before).
  const readInitKeys = async (): Promise<{ x: `0x${string}`; y: `0x${string}` }> => {
    const pc = props.publicClient;
    if (!pc) throw new Error("Network not ready");
    const hex = (v: bigint) => ("0x" + v.toString(16).padStart(64, "0")) as `0x${string}`;
    try {
      const logs = await pc.getContractEvents({
        address: props.factory,
        abi: BlankAccountFactoryAbi,
        eventName: "AccountCreated",
        args: { account: props.account },
        fromBlock: "earliest",
        toBlock: "latest",
      });
      const first = logs[0] as { args?: { ownerX?: bigint; ownerY?: bigint } } | undefined;
      if (first?.args?.ownerX !== undefined && first.args.ownerY !== undefined) {
        return { x: hex(first.args.ownerX), y: hex(first.args.ownerY) };
      }
    } catch { /* RPC log range limits: fall through */ }
    const [x, y] = (await Promise.all([
      pc.readContract({ address: props.account, abi: BlankAccountAbi, functionName: "ownerX" }),
      pc.readContract({ address: props.account, abi: BlankAccountAbi, functionName: "ownerY" }),
    ])) as [bigint, bigint];
    return { x: hex(x), y: hex(y) };
  };

  const create = async () => {
    if (pass1.length < 12) return toast.error("Use at least 12 characters.");
    if (pass1 !== pass2) return toast.error("The passphrases do not match.");
    setCreating(true);
    try {
      const init = await readInitKeys();
      const pub = await createPasskey(props.chainId, pass1, "Recovery");
      await setRecoveredAccount(props.chainId, {
        address: props.account,
        initOwnerX: init.x,
        initOwnerY: init.y,
      });
      broadcastAction("aa_passkey_changed", { chainId: props.chainId });
      setState({ kind: "bound", key: { x: BigInt(pub.pubX), y: BigInt(pub.pubY) } });
      setPass1("");
      setPass2("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="glass-card-static rounded-2xl p-6 mt-6 space-y-3" data-testid="recovery-user-panel">
      <div className="flex items-center gap-2">
        <KeyRound size={18} className="text-blue-600" />
        <h2 className="text-lg font-semibold">Lost your passkey?</h2>
      </div>
      {state.kind === "loading" && <p className="text-sm text-[var(--text-secondary)]">Checking this browser…</p>}
      {state.kind === "other-passkey" && (
        <p className="text-sm text-[var(--text-secondary)]">
          This browser already holds a passkey for another account on this
          chain. Open this page in a browser profile without one to create
          your recovery passkey.
        </p>
      )}
      {state.kind === "none" && (
        <>
          <p className="text-sm text-[var(--text-secondary)]">
            Create a new passkey on this device. Your guardians will move the
            account to it. Pick a passphrase of 12+ characters: it unlocks the
            key on this device.
          </p>
          <input
            type="password"
            value={pass1}
            onChange={(e) => setPass1(e.target.value)}
            placeholder="New passphrase"
            autoComplete="new-password"
            className="w-full h-11 px-3 rounded-xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 text-sm"
          />
          <input
            type="password"
            value={pass2}
            onChange={(e) => setPass2(e.target.value)}
            placeholder="Repeat passphrase"
            autoComplete="new-password"
            className="w-full h-11 px-3 rounded-xl bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 text-sm"
          />
          <button
            data-testid="recovery-create-passkey"
            disabled={creating}
            onClick={() => void create()}
            className="w-full h-12 rounded-2xl bg-[#1D1D1F] text-white font-medium hover:bg-black disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {creating && <Loader2 size={16} className="animate-spin" />}
            Create recovery passkey
          </button>
        </>
      )}
      {state.kind === "bound" && (
        <>
          <p className="text-sm text-[var(--text-secondary)]">
            Send this recovery key to one of your guardians. It is a public
            key: sharing it is safe, but confirm with them that it came from you.
          </p>
          <code data-testid="recovery-key" className="block p-3 rounded-xl bg-black/[0.04] dark:bg-white/[0.05] font-mono text-[11px] break-all">
            {formatRecoveryKey(state.key)}
          </code>
          <button
            onClick={() => {
              navigator.clipboard.writeText(formatRecoveryKey(state.key))
                .then(() => toast.success("Recovery key copied"))
                .catch(() => toast.error("Couldn't copy. Select the text instead."));
            }}
            className="h-11 px-4 rounded-xl bg-[#1D1D1F] text-white text-sm font-medium hover:bg-black flex items-center gap-2"
          >
            <Copy size={14} /> Copy recovery key
          </button>
          <p className="text-xs text-[var(--text-secondary)]">
            Once a guardian finalizes, this browser uses the recovered account.
          </p>
        </>
      )}
    </div>
  );
}

function formatDuration(secs: number): string {
  if (secs >= 3600) return `${Math.floor(secs / 3600)}h ${Math.ceil((secs % 3600) / 60)}m`;
  return `${Math.ceil(secs / 60)} min`;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F9FAFB] dark:bg-[#0A0A0A] py-10 px-4">
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
