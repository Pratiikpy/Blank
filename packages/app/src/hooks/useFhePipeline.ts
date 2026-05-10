// Wave 4 task #245 — drive a real-step FHE progress UI off cofhesdk's
// `onStep` callback (added in @cofhe/sdk PR #239 + #251).
//
// The SDK fires callbacks for 5 encrypt phases — InitTfhe → FetchKeys →
// Pack → Prove → Verify — each with start/end timestamps and a duration.
// We add two more phases (Submit, Confirm) that we drive ourselves from
// the writeContract → waitForTransactionReceipt boundary.
//
// Consumer pattern:
//   const pipe = useFhePipeline();
//   const enc = await encryptInputsAsync(items, pipe.onEncryptStep);
//   pipe.markSubmitting();
//   const { hash } = await unifiedWriteAndWait({...});
//   pipe.markConfirming();
//   const receipt = await publicClient.waitForTransactionReceipt({hash});
//   pipe.markDone();
//
// The component <FhePipelineProgress state={pipe.state}/> renders the bar.

import { useCallback, useState, useMemo } from "react";

// ─── Public step IDs ──────────────────────────────────────────────────

export type FhePipelineStep =
  | "initTfhe"
  | "fetchKeys"
  | "pack"
  | "prove"
  | "verify"
  | "submit"
  | "confirm";

export const PIPELINE_STEPS: readonly FhePipelineStep[] = [
  "initTfhe",
  "fetchKeys",
  "pack",
  "prove",
  "verify",
  "submit",
  "confirm",
] as const;

export const STEP_LABEL: Record<FhePipelineStep, string> = {
  initTfhe: "Loading FHE module",
  fetchKeys: "Fetching encryption keys",
  pack: "Packing inputs",
  prove: "Generating ZK proof",
  verify: "Verifying with threshold network",
  submit: "Submitting on-chain",
  confirm: "Awaiting confirmation",
};

export const STEP_HINT: Record<FhePipelineStep, string> = {
  initTfhe: "First-load only — caches in this tab",
  fetchKeys: "Threshold network public keys",
  pack: "Wrapping plaintext into ciphertext",
  prove: "Proving you know the plaintext, without revealing it",
  verify: "Threshold network signs the ciphertext",
  submit: "Wallet signs + broadcasts",
  confirm: "Block inclusion",
};

export type StepStatus = "pending" | "active" | "done" | "failed";

export interface FhePipelineState {
  /** Index of the currently active step in PIPELINE_STEPS, or -1 if idle. */
  currentIndex: number;
  /** Per-step status. */
  status: Record<FhePipelineStep, StepStatus>;
  /** Per-step duration in ms (only set after done). */
  duration: Partial<Record<FhePipelineStep, number>>;
  /** Current overall state. */
  phase: "idle" | "running" | "success" | "failed";
  /** Last error message, if phase = "failed". */
  error: string | null;
}

// ─── Map SDK EncryptStep enum (string values) to our step IDs ─────────

const SDK_TO_PIPELINE: Record<string, FhePipelineStep> = {
  initTfhe: "initTfhe",
  fetchKeys: "fetchKeys",
  pack: "pack",
  prove: "prove",
  verify: "verify",
};

const initialStatus: Record<FhePipelineStep, StepStatus> = {
  initTfhe: "pending",
  fetchKeys: "pending",
  pack: "pending",
  prove: "pending",
  verify: "pending",
  submit: "pending",
  confirm: "pending",
};

const initialState: FhePipelineState = {
  currentIndex: -1,
  status: initialStatus,
  duration: {},
  phase: "idle",
  error: null,
};

// ─── Hook ─────────────────────────────────────────────────────────────

export function useFhePipeline() {
  const [state, setState] = useState<FhePipelineState>(initialState);

  // Callback compatible with @cofhe/sdk's `onStep`. Signature is
  //   (step: EncryptStep, ctx?: { isStart, isEnd, duration }) => void
  // Using `unknown` for the SDK-side enum is intentional — keeps this
  // hook independent of @cofhe/sdk's exact import path.
  const onEncryptStep = useCallback((step: unknown, ctx?: { isStart?: boolean; isEnd?: boolean; duration?: number }) => {
    const stepKey = typeof step === "string" ? step : String(step);
    const id = SDK_TO_PIPELINE[stepKey];
    if (!id) {
      // §3.6 B21 of BEST_VERSION_FULL_PLAN: unknown SDK step keys were
      // silently dropped, so a future @cofhe/sdk that adds new step names
      // would surface as "pipeline silently stalls". Warn in dev so the
      // gap is visible; production stays silent (esbuild drops the call).
      if (import.meta.env.DEV) {
        console.warn(`[useFhePipeline] unknown SDK step: ${stepKey}`);
      }
      return;
    }

    setState((prev) => {
      const idx = PIPELINE_STEPS.indexOf(id);
      const nextStatus = { ...prev.status };
      const nextDuration = { ...prev.duration };

      if (ctx?.isStart) {
        nextStatus[id] = "active";
      } else if (ctx?.isEnd) {
        nextStatus[id] = "done";
        if (typeof ctx.duration === "number") {
          nextDuration[id] = ctx.duration;
        }
      }

      return {
        ...prev,
        currentIndex: idx,
        status: nextStatus,
        duration: nextDuration,
        phase: "running",
      };
    });
  }, []);

  const _advance = useCallback((id: FhePipelineStep) => {
    setState((prev) => {
      const nextStatus: Record<FhePipelineStep, StepStatus> = { ...prev.status };
      // Mark all encrypt steps as done if we've moved past them (in case
      // the SDK didn't fire the final isEnd callback before we got here).
      for (const s of PIPELINE_STEPS) {
        if (s === id) break;
        if (nextStatus[s] !== "done" && nextStatus[s] !== "failed") {
          nextStatus[s] = "done";
        }
      }
      nextStatus[id] = "active";
      return {
        ...prev,
        status: nextStatus,
        currentIndex: PIPELINE_STEPS.indexOf(id),
        phase: "running",
      };
    });
  }, []);

  const start = useCallback(() => setState({ ...initialState, phase: "running" }), []);
  const markSubmitting = useCallback(() => _advance("submit"), [_advance]);
  const markConfirming = useCallback(() => _advance("confirm"), [_advance]);

  const markDone = useCallback(() => {
    setState((prev) => {
      const nextStatus: Record<FhePipelineStep, StepStatus> = { ...prev.status };
      for (const s of PIPELINE_STEPS) {
        if (nextStatus[s] !== "failed") nextStatus[s] = "done";
      }
      return {
        ...prev,
        status: nextStatus,
        currentIndex: PIPELINE_STEPS.length - 1,
        phase: "success",
      };
    });
  }, []);

  const markFailed = useCallback((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    setState((prev) => {
      const nextStatus: Record<FhePipelineStep, StepStatus> = { ...prev.status };
      // Mark the active step as failed, leave done ones alone.
      if (prev.currentIndex >= 0) {
        const cur = PIPELINE_STEPS[prev.currentIndex];
        if (nextStatus[cur] === "active") nextStatus[cur] = "failed";
      } else {
        // §3.6 B8 of BEST_VERSION_FULL_PLAN: pre-step failure (e.g. approval
        // revert before pipeline.start). Without this branch, all steps stay
        // "pending" while phase=failed, and the UI has nothing red. Mark the
        // first step as failed so the user sees where the flow stopped.
        const firstStep = PIPELINE_STEPS[0];
        nextStatus[firstStep] = "failed";
      }
      return { ...prev, status: nextStatus, phase: "failed", error: message };
    });
  }, []);

  const reset = useCallback(() => setState(initialState), []);

  // Convenience derived view: the currently-spotlighted step + its hint.
  const headline = useMemo(() => {
    if (state.phase === "idle") return null;
    if (state.phase === "success") return { label: "Done", hint: "Encrypted balance moved." };
    if (state.phase === "failed") return { label: "Failed", hint: state.error ?? "Something went wrong." };
    if (state.currentIndex < 0) return null;
    const id = PIPELINE_STEPS[state.currentIndex];
    return { label: STEP_LABEL[id], hint: STEP_HINT[id] };
  }, [state]);

  return {
    state,
    headline,
    onEncryptStep,
    start,
    markSubmitting,
    markConfirming,
    markDone,
    markFailed,
    reset,
  };
}
