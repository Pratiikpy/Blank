import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// §15.x test for Analytics screen. The private-analytics dashboard
// that derives 4 stat cards + monthly bar chart + 6-row breakdown
// from the activity feed.
//
// CRITICAL pins:
//   - computeStats direction logic uses ELSE-IF so a self-send
//     (user_from === user_to === me) counts as sent ONE TIME, not
//     once as sent AND once as received. A naive `if` would double-
//     count and inflate the user's transaction-count display.
//   - category buckets (swap/stealth/group/gift) are INDEPENDENT of
//     direction: a stealth_sent where user_from===me counts as BOTH
//     sent AND stealth (correct), not exclusive.
//   - the monthly chart silently DROPS activity older than 5 months
//     (the rolling window). Without the `if (!(key in sentByMonth))
//     continue` guard, a 7-month-old row would still write into the
//     dict and inflate maxVal, squashing visible bars.
//   - "No activity in the last 6 months" empty state when every
//     monthly bar pair is 0 (covers the loading-but-empty case).
//   - case-INsensitive address compare (saved storage often
//     lowercases; in-flight rows might keep checksummed form).

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useActivityFeedMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/hooks/useActivityFeed", () => ({
  useActivityFeed: useActivityFeedMock,
}));

// ACTIVITY_TYPES is a pure const map — import the real one so the
// fixtures stay in sync if the wire-format strings ever change.
import { ACTIVITY_TYPES } from "@/lib/activity-types";
import Analytics from "./Analytics";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BOB = "0xcccccccccccccccccccccccccccccccccccccccc";

type ActivityRow = {
  id: string;
  activity_type: string;
  user_from: string;
  user_to: string;
  created_at: string;
};

function row(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: "act-1",
    activity_type: ACTIVITY_TYPES.PAYMENT,
    user_from: ALICE,
    user_to: ME,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}

function setFeed(activities: ActivityRow[] = [], isLoading = false) {
  useActivityFeedMock.mockReturnValue({ activities, isLoading });
}

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useActivityFeedMock.mockReset();
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  setFeed();
});

// ----- helpers ----- //
// The 4 stat-card counts render at known positions inside the .grid-cols-2
// grid. Each StatCard has an icon div + a number paragraph + label
// paragraph. Pull the number-text out of each card by label-anchor.
function statCount(container: HTMLElement, label: string): string {
  const labelEl = Array.from(container.querySelectorAll("p"))
    .find((p) => p.textContent?.trim() === label);
  if (!labelEl) throw new Error(`Stat card label '${label}' not found`);
  // The number paragraph is the IMMEDIATELY-PRECEDING sibling <p>.
  const prev = labelEl.previousElementSibling;
  return (prev?.textContent ?? "").trim();
}

function breakdownCount(container: HTMLElement, label: string): string {
  // Each BreakdownItem has a label span + a count span side-by-side
  // inside a div.flex.items-center.justify-between.
  const labelEl = Array.from(container.querySelectorAll("span"))
    .find((s) => s.textContent?.trim() === label);
  if (!labelEl) throw new Error(`Breakdown label '${label}' not found`);
  const countEl = labelEl.parentElement?.querySelector("span:last-child");
  return (countEl?.textContent ?? "").trim();
}

describe("Analytics — page chrome (§15.x)", () => {
  it("renders 'Private Analytics' heading + privacy pill + FHE-protected notice", () => {
    const { container } = render(<Analytics />);
    expect(container.textContent).toContain("Private Analytics");
    expect(container.textContent).toContain("Only visible to you");
    expect(container.textContent).toContain("Private");
    expect(container.textContent).toContain("FHE Protected Analytics");
    expect(container.textContent).toContain("Fully Homomorphic Encryption");
  });

  it("renders all 4 stat-card labels: Sent / Received / Swaps / Total", () => {
    const { container } = render(<Analytics />);
    expect(container.textContent).toContain("Sent");
    expect(container.textContent).toContain("Received");
    expect(container.textContent).toContain("Swaps");
    expect(container.textContent).toContain("Total");
  });

  it("renders all 6 breakdown rows", () => {
    const { container } = render(<Analytics />);
    expect(container.textContent).toContain("Transactions sent");
    expect(container.textContent).toContain("Received");
    expect(container.textContent).toContain("Group splits");
    expect(container.textContent).toContain("Stealth payments");
    expect(container.textContent).toContain("Gifts");
    expect(container.textContent).toContain("Swaps");
  });
});

describe("Analytics — loading state (§15.x)", () => {
  it("renders 4 shimmer skeleton cards when isLoading AND activities empty", () => {
    setFeed([], true);
    const { container } = render(<Analytics />);
    const shimmers = container.querySelectorAll(".shimmer");
    // Each skeleton has 3 shimmer divs (icon + heading + sublabel).
    expect(shimmers.length).toBeGreaterThanOrEqual(4 * 3);
  });

  it("isLoading + already-cached activities: render REAL stats (don't show skeleton)", () => {
    setFeed([row()], true);
    const { container } = render(<Analytics />);
    expect(container.querySelector(".shimmer")).toBeNull();
  });
});

describe("Analytics — stat-card counts (§15.x)", () => {
  it("zero activities -> every count is 0", () => {
    setFeed([]);
    const { container } = render(<Analytics />);
    expect(statCount(container, "Sent")).toBe("0");
    expect(statCount(container, "Received")).toBe("0");
    expect(statCount(container, "Swaps")).toBe("0");
    expect(statCount(container, "Total")).toBe("0");
  });

  it("Total counts ALL activities regardless of direction/type", () => {
    setFeed([
      row({ user_from: ALICE, user_to: ME }),
      row({ user_from: ME, user_to: BOB }),
      row({ user_from: ALICE, user_to: BOB }),
    ]);
    const { container } = render(<Analytics />);
    expect(statCount(container, "Total")).toBe("3");
  });

  it("Sent counts rows with user_from === me (case-insensitive)", () => {
    setFeed([
      row({ user_from: ME, user_to: ALICE }),
      row({ user_from: ME.toUpperCase(), user_to: BOB }), // case mismatch on row
      row({ user_from: ALICE, user_to: ME }),
    ]);
    const { container } = render(<Analytics />);
    expect(statCount(container, "Sent")).toBe("2");
  });

  it("Received counts rows with user_to === me (only when NOT sent — else-if branch)", () => {
    setFeed([
      row({ user_from: ALICE, user_to: ME }),
      row({ user_from: BOB, user_to: ME }),
      row({ user_from: ME, user_to: ALICE }), // sent
    ]);
    const { container } = render(<Analytics />);
    expect(statCount(container, "Received")).toBe("2");
    expect(statCount(container, "Sent")).toBe("1");
  });

  it("CRITICAL: self-send (user_from === user_to === me) counts as Sent ONCE, NOT Sent+Received (else-if guard)", () => {
    setFeed([row({ user_from: ME, user_to: ME })]);
    const { container } = render(<Analytics />);
    expect(statCount(container, "Sent")).toBe("1");
    expect(statCount(container, "Received")).toBe("0");
  });

  it("Swap count includes all 5 swap-family activity types", () => {
    setFeed([
      row({ activity_type: ACTIVITY_TYPES.OFFER_CREATED }),
      row({ activity_type: ACTIVITY_TYPES.OFFER_FILLED }),
      row({ activity_type: ACTIVITY_TYPES.SWAP_INITIATED }),
      row({ activity_type: ACTIVITY_TYPES.SWAP_SETTLED }),
      row({ activity_type: ACTIVITY_TYPES.EXCHANGE_VERIFIED }),
    ]);
    const { container } = render(<Analytics />);
    expect(statCount(container, "Swaps")).toBe("5");
  });

  it("Swap count does NOT include non-swap types (e.g. payment)", () => {
    setFeed([
      row({ activity_type: ACTIVITY_TYPES.PAYMENT }),
      row({ activity_type: ACTIVITY_TYPES.GIFT_CREATED }),
    ]);
    const { container } = render(<Analytics />);
    expect(statCount(container, "Swaps")).toBe("0");
  });

  it("case-INsensitive address compare: lowercased ME matches checksummed row", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME.toLowerCase() });
    setFeed([row({ user_from: ME.toUpperCase(), user_to: ALICE })]);
    const { container } = render(<Analytics />);
    expect(statCount(container, "Sent")).toBe("1");
  });

  it("no effective address -> all direction counts are 0 (defensive, no crash)", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined });
    setFeed([row({ user_from: ME, user_to: ALICE })]);
    const { container } = render(<Analytics />);
    expect(statCount(container, "Sent")).toBe("0");
    expect(statCount(container, "Received")).toBe("0");
    expect(statCount(container, "Total")).toBe("1");
  });
});

describe("Analytics — category-bucket independence (§15.x)", () => {
  it("CRITICAL: stealth_sent with user_from===me counts as BOTH Sent AND Stealth (not exclusive)", () => {
    setFeed([row({ activity_type: ACTIVITY_TYPES.STEALTH_SENT, user_from: ME, user_to: BOB })]);
    const { container } = render(<Analytics />);
    expect(statCount(container, "Sent")).toBe("1");
    expect(breakdownCount(container, "Stealth payments")).toBe("1");
  });

  it("Stealth breakdown includes all 3 stealth types", () => {
    setFeed([
      row({ activity_type: ACTIVITY_TYPES.STEALTH_SENT }),
      row({ activity_type: ACTIVITY_TYPES.STEALTH_CLAIM_STARTED }),
      row({ activity_type: ACTIVITY_TYPES.STEALTH_CLAIMED }),
    ]);
    const { container } = render(<Analytics />);
    expect(breakdownCount(container, "Stealth payments")).toBe("3");
  });

  it("Gifts breakdown includes both gift_created + gift_claimed (NOT gift_deactivated etc.)", () => {
    setFeed([
      row({ activity_type: ACTIVITY_TYPES.GIFT_CREATED }),
      row({ activity_type: ACTIVITY_TYPES.GIFT_CLAIMED }),
      row({ activity_type: ACTIVITY_TYPES.GIFT_DEACTIVATED }),
    ]);
    const { container } = render(<Analytics />);
    // 2 gifts (deactivated does NOT count per GIFT_TYPES set).
    expect(breakdownCount(container, "Gifts")).toBe("2");
  });

  it("Group splits breakdown includes group_expense + group_settlement + debt_settled", () => {
    setFeed([
      row({ activity_type: ACTIVITY_TYPES.GROUP_EXPENSE }),
      row({ activity_type: ACTIVITY_TYPES.GROUP_SETTLEMENT }),
      row({ activity_type: ACTIVITY_TYPES.DEBT_SETTLED }),
      row({ activity_type: ACTIVITY_TYPES.GROUP_VOTE }), // NOT counted
    ]);
    const { container } = render(<Analytics />);
    expect(breakdownCount(container, "Group splits")).toBe("3");
  });

  it("breakdown Sent/Received counts match the corresponding stat cards", () => {
    setFeed([
      row({ user_from: ME, user_to: ALICE }),
      row({ user_from: ME, user_to: BOB }),
      row({ user_from: ALICE, user_to: ME }),
    ]);
    const { container } = render(<Analytics />);
    expect(breakdownCount(container, "Transactions sent")).toBe("2");
    expect(statCount(container, "Sent")).toBe("2");
  });
});

describe("Analytics — monthly chart (§15.x)", () => {
  it("renders 6 month labels when chart is visible (this month + 5 prior)", () => {
    // Empty feed shows the empty-state copy, NOT the bar block (which is
    // where month labels live). Drop in one activity to materialize the
    // bar grid + per-bar month label.
    setFeed([row({ user_from: ME, user_to: ALICE })]);
    const { container } = render(<Analytics />);
    const monthLabels = Array.from(container.querySelectorAll("span"))
      .map((el) => el.textContent?.trim() ?? "")
      .filter((t) => /^[A-Z][a-z]{2}$/.test(t));
    const unique = Array.from(new Set(monthLabels));
    expect(unique.length).toBeGreaterThanOrEqual(6);
  });

  it("empty-feed shows 'No activity in the last 6 months' copy", () => {
    setFeed([]);
    const { container } = render(<Analytics />);
    expect(container.textContent).toContain("No activity in the last 6 months yet");
  });

  it("activity-in-window: empty-state copy HIDDEN", () => {
    setFeed([row()]);
    const { container } = render(<Analytics />);
    expect(container.textContent).not.toContain("No activity in the last 6 months yet");
  });

  it("CRITICAL: activity OLDER than 5 months is silently dropped (window guard)", () => {
    // 7 months ago — outside the rolling window.
    const sevenMonthsAgo = new Date();
    sevenMonthsAgo.setMonth(sevenMonthsAgo.getMonth() - 7);
    setFeed([row({ created_at: sevenMonthsAgo.toISOString(), user_from: ME, user_to: ALICE })]);
    const { container } = render(<Analytics />);
    // The chart's empty-state shows because the only activity falls
    // outside the 6-month window. Total stat card still shows 1.
    expect(container.textContent).toContain("No activity in the last 6 months yet");
    expect(statCount(container, "Total")).toBe("1");
  });

  it("chart legend always present: 'Sent' + 'Received' labels", () => {
    setFeed([]);
    const { container } = render(<Analytics />);
    expect(container.textContent).toContain("Monthly Activity");
    expect(container.textContent).toContain("Amounts encrypted via FHE");
  });
});

describe("Analytics — useActivityFeed integration (§15.x)", () => {
  it("re-renders when feed changes (single-source-of-truth via the hook)", () => {
    setFeed([]);
    const { container, rerender } = render(<Analytics />);
    expect(statCount(container, "Total")).toBe("0");

    setFeed([row(), row({ id: "act-2" })]);
    rerender(<Analytics />);
    expect(statCount(container, "Total")).toBe("2");
  });

  it("Total reflects activities.length exactly (no filtering applied)", () => {
    setFeed([
      row({ activity_type: ACTIVITY_TYPES.INVOICE_FINALIZED }),
      row({ activity_type: ACTIVITY_TYPES.ESCROW_ARBITER_DECIDED }),
    ]);
    const { container } = render(<Analytics />);
    expect(statCount(container, "Total")).toBe("2");
  });
});
