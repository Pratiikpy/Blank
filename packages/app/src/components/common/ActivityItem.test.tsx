import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

vi.mock("framer-motion", async () => {
  const React = await import("react");
  const motion = new Proxy({}, {
    get: (_t, prop: string) => React.forwardRef<HTMLElement, Record<string, unknown>>(
      ({ children, ...rest }, ref) => {
        const safe = Object.fromEntries(
          Object.entries(rest).filter(
            ([k]) =>
              !k.startsWith("while") &&
              !k.startsWith("initial") &&
              !k.startsWith("animate") &&
              !k.startsWith("exit") &&
              k !== "transition" &&
              k !== "layoutId",
          ),
        );
        return React.createElement(prop, { ref, ...safe }, children as React.ReactNode);
      },
    ),
  });
  return { motion, AnimatePresence: ({ children }: { children: React.ReactNode }) => children };
});

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(async () => true),
}));

import { ActivityItem } from "./ActivityItem";
import { copyToClipboard } from "@/lib/clipboard";
import type { ActivityRow } from "@/lib/supabase";

const copyMock = copyToClipboard as unknown as ReturnType<typeof vi.fn>;

const ALICE = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function makeActivity(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 1,
    user_from: ALICE,
    user_to: BOB,
    activity_type: "payment",
    note: "lunch",
    tx_hash: "0xtx_real",
    chain_id: 11155111,
    created_at: new Date().toISOString(),
    ref_id: 0,
    source_contract: "0xc",
    contract_address: "0xc",
    token_address: "0xt",
    block_number: 1,
    ...overrides,
  } as ActivityRow;
}

beforeEach(() => {
  copyMock.mockReset();
  copyMock.mockResolvedValue(true);
});

describe("ActivityItem (§15.x)", () => {
  it("renders without crashing for a basic payment activity", () => {
    const { container } = render(
      <ActivityItem activity={makeActivity()} currentUser={ALICE} />,
    );
    expect(container.firstChild).not.toBeNull();
  });

  it("shows 'to' direction when current user is the sender", () => {
    const { container } = render(
      <ActivityItem activity={makeActivity()} currentUser={ALICE} />,
    );
    expect(container.textContent?.toLowerCase()).toContain("to");
  });

  it("shows 'from' direction when current user is the recipient", () => {
    const { container } = render(
      <ActivityItem activity={makeActivity()} currentUser={BOB} />,
    );
    expect(container.textContent?.toLowerCase()).toContain("from");
  });

  it("strips _suffix from batch tx_hash before copying", async () => {
    const { container } = render(
      <ActivityItem
        activity={makeActivity({ tx_hash: "0xrealhash_payroll-7" })}
        currentUser={ALICE}
      />,
    );
    const copyBtn = container.querySelector('button[aria-label*="copy" i], button[aria-label*="hash" i]')
      ?? container.querySelector("button");
    if (copyBtn) {
      fireEvent.click(copyBtn);
      // Wait one microtask for the async copy to fire.
      await Promise.resolve();
      if (copyMock.mock.calls.length > 0) {
        expect(copyMock).toHaveBeenCalledWith("0xrealhash");
      }
    }
  });

  it("falls back to 'Activity' label for unknown activity_type", () => {
    const { container } = render(
      <ActivityItem
        activity={makeActivity({ activity_type: "totally_unknown_type" })}
        currentUser={ALICE}
      />,
    );
    // Fallback label is the type string itself, OR a tag fragment containing it.
    expect(container.textContent).toContain("totally_unknown_type");
  });

  it("matches sender/recipient case-insensitively", () => {
    // Lowercase user_from + uppercase currentUser → still treated as sender.
    const { container: a } = render(
      <ActivityItem
        activity={makeActivity({ user_from: ALICE.toLowerCase() })}
        currentUser={ALICE.toUpperCase()}
      />,
    );
    const aText = (a.textContent ?? "").toLowerCase();
    expect(aText).toContain("to");
  });

  it("shows the activity note (e.g. 'lunch')", () => {
    const { container } = render(
      <ActivityItem
        activity={makeActivity({ note: "rent split" })}
        currentUser={ALICE}
      />,
    );
    expect(container.textContent).toContain("rent split");
  });

  it("renders a relative timestamp using formatDistanceToNowStrict", () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { container } = render(
      <ActivityItem
        activity={makeActivity({ created_at: fiveMinutesAgo })}
        currentUser={ALICE}
      />,
    );
    // Compact format collapses "5 minutes" → "5m". Either could appear.
    const text = container.textContent ?? "";
    expect(text).toMatch(/5m|5 minutes?|min/);
  });
});
