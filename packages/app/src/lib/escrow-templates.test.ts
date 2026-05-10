import { describe, it, expect } from "vitest";
import { applyTemplate, MILESTONE_TEMPLATES } from "./escrow-templates";

const single = MILESTONE_TEMPLATES.find((t) => t.id === "single")!;
const half = MILESTONE_TEMPLATES.find((t) => t.id === "50-50")!;
const thirds = MILESTONE_TEMPLATES.find((t) => t.id === "33-33-33")!;
const middle = MILESTONE_TEMPLATES.find((t) => t.id === "25-50-25")!;

// §15.x lib test for the milestone-template applier. The contract is:
// rounding errors get absorbed into the final milestone so the sum
// equals `total` exactly. UI relies on this for the "splits add up to
// 100%" badge and contract-side balance reconciliation.

describe("applyTemplate", () => {
  it("returns the full total for the single-milestone template", () => {
    const out = applyTemplate(single, 1234.56);
    expect(out).toEqual([{ name: "Full delivery", amount: 1234.56 }]);
  });

  it("splits 50-50 of $100 evenly", () => {
    const out = applyTemplate(half, 100);
    expect(out).toEqual([
      { name: "Upfront", amount: 50 },
      { name: "On delivery", amount: 50 },
    ]);
  });

  it("absorbs rounding error into the final tranche on 33/33/33 of $100", () => {
    const out = applyTemplate(thirds, 100);
    // First two milestones round to 33.33; the final must be 33.34 so
    // head + tail == 100 exactly, not 99.99.
    expect(out[0].amount).toBe(33.33);
    expect(out[1].amount).toBe(33.33);
    expect(out[2].amount).toBe(33.34);

    const sum = out.reduce((s, m) => s + m.amount, 0);
    expect(sum).toBe(100);
  });

  it("splits 25/50/25 of $100 cleanly", () => {
    const out = applyTemplate(middle, 100);
    expect(out).toEqual([
      { name: "Kickoff", amount: 25 },
      { name: "Build", amount: 50 },
      { name: "Polish", amount: 25 },
    ]);
  });

  it("preserves milestone names from the template", () => {
    const out = applyTemplate(thirds, 50);
    expect(out.map((m) => m.name)).toEqual(["Kickoff", "Midpoint", "Delivery"]);
  });

  it("handles zero total", () => {
    const out = applyTemplate(half, 0);
    expect(out).toEqual([
      { name: "Upfront", amount: 0 },
      { name: "On delivery", amount: 0 },
    ]);
  });

  it("preserves the sum invariant on awkward totals", () => {
    // 33.33 split three ways stresses the rounding-absorb path harder
    // than 100; head ends up as 11.11 + 11.11 = 22.22, so the tail
    // must be 11.11 to land at 33.33 exactly.
    const out = applyTemplate(thirds, 33.33);
    const sum = out.reduce((s, m) => s + m.amount, 0);
    expect(Math.abs(sum - 33.33)).toBeLessThan(0.001);
  });

  it("preserves the sum invariant on a fractional total across all multi-split templates", () => {
    const total = 199.99;
    for (const tpl of [half, thirds, middle]) {
      const out = applyTemplate(tpl, total);
      const sum = out.reduce((s, m) => s + m.amount, 0);
      expect(Math.abs(sum - total)).toBeLessThan(0.001);
    }
  });
});
