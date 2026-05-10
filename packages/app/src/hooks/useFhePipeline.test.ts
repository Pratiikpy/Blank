import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFhePipeline, PIPELINE_STEPS } from "./useFhePipeline";

describe("useFhePipeline", () => {
  it("starts idle", () => {
    const { result } = renderHook(() => useFhePipeline());
    expect(result.current.state.phase).toBe("idle");
    expect(result.current.state.currentIndex).toBe(-1);
  });

  it("translates SDK encrypt callbacks into step status", () => {
    const { result } = renderHook(() => useFhePipeline());

    // Simulate the SDK firing initTfhe start.
    act(() => {
      result.current.start();
      result.current.onEncryptStep("initTfhe", { isStart: true, isEnd: false, duration: 0 });
    });
    expect(result.current.state.status.initTfhe).toBe("active");
    expect(result.current.state.phase).toBe("running");

    // SDK fires initTfhe end with duration.
    act(() => {
      result.current.onEncryptStep("initTfhe", { isStart: false, isEnd: true, duration: 1234 });
    });
    expect(result.current.state.status.initTfhe).toBe("done");
    expect(result.current.state.duration.initTfhe).toBe(1234);
  });

  it("walks through all 5 SDK steps then submit + confirm + done", () => {
    const { result } = renderHook(() => useFhePipeline());

    act(() => result.current.start());
    for (const step of ["initTfhe", "fetchKeys", "pack", "prove", "verify"]) {
      act(() => {
        result.current.onEncryptStep(step, { isStart: true, isEnd: false, duration: 0 });
      });
      act(() => {
        result.current.onEncryptStep(step, { isStart: false, isEnd: true, duration: 50 });
      });
    }
    act(() => result.current.markSubmitting());
    expect(result.current.state.status.submit).toBe("active");

    act(() => result.current.markConfirming());
    expect(result.current.state.status.submit).toBe("done");
    expect(result.current.state.status.confirm).toBe("active");

    act(() => result.current.markDone());
    expect(result.current.state.phase).toBe("success");
    for (const id of PIPELINE_STEPS) {
      expect(result.current.state.status[id]).toBe("done");
    }
  });

  it("marks active step as failed on markFailed", () => {
    const { result } = renderHook(() => useFhePipeline());
    act(() => {
      result.current.start();
      result.current.onEncryptStep("prove", { isStart: true, isEnd: false, duration: 0 });
    });
    expect(result.current.state.status.prove).toBe("active");

    act(() => result.current.markFailed(new Error("zk proof failed")));
    expect(result.current.state.phase).toBe("failed");
    expect(result.current.state.status.prove).toBe("failed");
    expect(result.current.state.error).toBe("zk proof failed");
  });

  // §3.6 B8 of BEST_VERSION_FULL_PLAN: pre-step failure marks first step.
  it("marks first step as failed when markFailed fires before any step started", () => {
    const { result } = renderHook(() => useFhePipeline());
    act(() => {
      result.current.start();
      // No step.start() yet; approval reverted before pipeline began.
      result.current.markFailed(new Error("approval reverted"));
    });
    expect(result.current.state.phase).toBe("failed");
    // First step in PIPELINE_STEPS gets the failure marker so the UI
    // has somewhere visibly red.
    expect(result.current.state.status[PIPELINE_STEPS[0]]).toBe("failed");
    expect(result.current.state.error).toBe("approval reverted");
  });

  it("ignores unknown SDK step values", () => {
    const { result } = renderHook(() => useFhePipeline());
    act(() => {
      result.current.start();
      result.current.onEncryptStep("garbage_step", { isStart: true });
    });
    // No status flipped to active — unknown step rejected.
    for (const id of PIPELINE_STEPS) {
      expect(result.current.state.status[id]).toBe("pending");
    }
  });

  it("reset returns to idle", () => {
    const { result } = renderHook(() => useFhePipeline());
    act(() => {
      result.current.start();
      result.current.markDone();
    });
    expect(result.current.state.phase).toBe("success");
    act(() => result.current.reset());
    expect(result.current.state.phase).toBe("idle");
    expect(result.current.state.currentIndex).toBe(-1);
  });
});
