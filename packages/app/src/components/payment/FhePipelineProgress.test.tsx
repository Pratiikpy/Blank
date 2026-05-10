import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FhePipelineProgress } from "./FhePipelineProgress";
import {
  PIPELINE_STEPS,
  STEP_LABEL,
  type FhePipelineState,
} from "@/hooks/useFhePipeline";

// §15.x test for the FhePipelineProgress component (Wave 4 #245).
// Visual companion to useFhePipeline; the only feedback the user
// gets during the 30s encryption window. Pin the idle/compact/full
// render branches + the failed-state error display.

function baseState(overrides: Partial<FhePipelineState> = {}): FhePipelineState {
  const status = Object.fromEntries(
    PIPELINE_STEPS.map((id) => [id, "pending"]),
  ) as FhePipelineState["status"];
  const duration = Object.fromEntries(
    PIPELINE_STEPS.map((id) => [id, 0]),
  ) as FhePipelineState["duration"];
  return {
    phase: "running",
    currentIndex: 0,
    status,
    duration,
    error: null,
    ...overrides,
  };
}

describe("FhePipelineProgress (§15.x)", () => {
  it("renders nothing when phase is 'idle'", () => {
    const { container } = render(
      <FhePipelineProgress state={baseState({ phase: "idle", currentIndex: -1 })} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the full step list by default", () => {
    const { getByText } = render(
      <FhePipelineProgress state={baseState()} />,
    );
    // Every step label must appear in the list.
    for (const id of PIPELINE_STEPS) {
      expect(getByText(STEP_LABEL[id])).toBeDefined();
    }
  });

  it("compact mode renders one-line 'Step X of N' summary", () => {
    const { getByText, queryByText } = render(
      <FhePipelineProgress state={baseState()} compact />,
    );
    // The "Step 1 of N" footer shows.
    expect(getByText(/Step 1 of \d+/)).toBeDefined();
    // The first step's label appears (compact mode shows the active label).
    expect(getByText(STEP_LABEL[PIPELINE_STEPS[0]])).toBeDefined();
    // The other step labels do NOT appear (compact UI suppresses the full list).
    const otherLabel = STEP_LABEL[PIPELINE_STEPS[PIPELINE_STEPS.length - 1]];
    if (otherLabel !== STEP_LABEL[PIPELINE_STEPS[0]]) {
      expect(queryByText(otherLabel)).toBeNull();
    }
  });

  it("compact mode shows 'Done' label when phase is success", () => {
    const { getByText } = render(
      <FhePipelineProgress
        state={baseState({ phase: "success", currentIndex: -1 })}
        compact
      />,
    );
    expect(getByText("Done")).toBeDefined();
  });

  it("renders error message when state.error is set", () => {
    const errMsg = "encryption failed: zk proof rejected";
    const { getByText } = render(
      <FhePipelineProgress
        state={baseState({ phase: "failed", error: errMsg })}
      />,
    );
    expect(getByText(errMsg)).toBeDefined();
  });

  it("does NOT render error block when error is null", () => {
    const { queryByText } = render(
      <FhePipelineProgress state={baseState({ phase: "running", error: null })} />,
    );
    // No "encryption failed" or similar text appears.
    expect(queryByText(/encryption failed/i)).toBeNull();
  });

  it("aria-label includes the current step number for screen readers", () => {
    const { getByRole } = render(
      <FhePipelineProgress state={baseState({ currentIndex: 2 })} />,
    );
    const status = getByRole("status");
    expect(status.getAttribute("aria-label")).toMatch(/step 3 of \d+/i);
  });

  it("hides durations when showDurations=false", () => {
    const status = Object.fromEntries(
      PIPELINE_STEPS.map((id, i) => [id, i === 0 ? "done" : "pending"]),
    ) as FhePipelineState["status"];
    const duration = Object.fromEntries(
      PIPELINE_STEPS.map((id, i) => [id, i === 0 ? 1234 : 0]),
    ) as FhePipelineState["duration"];

    const { container, rerender } = render(
      <FhePipelineProgress
        state={baseState({ status, duration, currentIndex: 1 })}
        showDurations={false}
      />,
    );
    // No "1.2 s" or similar duration text.
    expect(container.textContent).not.toMatch(/1\.2 s/);

    rerender(
      <FhePipelineProgress
        state={baseState({ status, duration, currentIndex: 1 })}
        showDurations={true}
      />,
    );
    expect(container.textContent).toMatch(/1\.2 s/);
  });
});
