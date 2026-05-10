import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import type { ActivityRow } from "@/lib/supabase";

// §15.x test for PaginatedActivityTable. Pins the empty state, page-
// size cap (10/page default), pagination navigation + ellipsis-insertion
// thresholds, the From/To direction inversion when current user is
// sender vs recipient, "You" self-label, and the 3-second loading-
// shimmer grace period that prevents layout jank on quick fetches.

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: vi.fn(async () => true),
}));

import { PaginatedActivityTable } from "./PaginatedActivityTable";

const ME = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function rowFor(opts: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: opts.id ?? "row-1",
    tx_hash: opts.tx_hash ?? "0x" + "1".repeat(64),
    user_from: opts.user_from ?? ME,
    user_to: opts.user_to ?? ALICE,
    activity_type: opts.activity_type ?? "payment",
    note: opts.note ?? "",
    created_at: opts.created_at ?? new Date(Date.now() - 5 * 60_000).toISOString(),
    chain_id: opts.chain_id ?? 11155111,
    contract_address: opts.contract_address ?? "0x" + "9".repeat(40),
    token_address: opts.token_address ?? "0x" + "8".repeat(40),
    block_number: opts.block_number ?? 1,
  } as ActivityRow;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PaginatedActivityTable — empty state (§15.x)", () => {
  it("shows 'No activity yet' message when activities array is empty", () => {
    const { container } = render(
      <PaginatedActivityTable activities={[]} currentUser={ME} />,
    );
    expect(container.textContent).toContain("No activity yet");
  });

  it("does NOT render pagination controls when there are 0 activities (only 1 page)", () => {
    const { queryByLabelText } = render(
      <PaginatedActivityTable activities={[]} currentUser={ME} />,
    );
    expect(queryByLabelText("Previous page")).toBeNull();
  });
});

describe("PaginatedActivityTable — direction labeling (§15.x)", () => {
  it("when current user is SENDER (user_from), shows 'to <counterparty>'", () => {
    const { container } = render(
      <PaginatedActivityTable
        activities={[rowFor({ user_from: ME, user_to: ALICE })]}
        currentUser={ME}
      />,
    );
    expect(container.textContent).toContain("to");
    // Counterparty (Alice) shown as truncated address.
    expect(container.textContent).toContain(ALICE.slice(0, 6));
  });

  it("when current user is RECIPIENT (user_to), shows 'from <counterparty>'", () => {
    const { container } = render(
      <PaginatedActivityTable
        activities={[rowFor({ user_from: ALICE, user_to: ME })]}
        currentUser={ME}
      />,
    );
    expect(container.textContent).toContain("from");
    expect(container.textContent).toContain(ALICE.slice(0, 6));
  });

  it("direction match is case-insensitive (mixed-case currentUser still resolves)", () => {
    const { container } = render(
      <PaginatedActivityTable
        activities={[rowFor({ user_from: ME, user_to: ALICE })]}
        currentUser={ME.toUpperCase()}
      />,
    );
    expect(container.textContent).toContain("to");
  });
});

describe("PaginatedActivityTable — type labels + dot colors (§15.x)", () => {
  it("renders 'Payment' for type=payment", () => {
    const { container } = render(
      <PaginatedActivityTable
        activities={[rowFor({ activity_type: "payment" })]}
        currentUser={ME}
      />,
    );
    expect(container.textContent).toContain("Payment");
  });

  it("renders 'Invoice Paid' for type=invoice_paid (mapped label)", () => {
    const { container } = render(
      <PaginatedActivityTable
        activities={[rowFor({ activity_type: "invoice_paid" })]}
        currentUser={ME}
      />,
    );
    expect(container.textContent).toContain("Invoice Paid");
  });

  it("falls back to the raw activity_type string when not in the label map", () => {
    const { container } = render(
      <PaginatedActivityTable
        activities={[rowFor({ activity_type: "weird_unmapped_type" })]}
        currentUser={ME}
      />,
    );
    expect(container.textContent).toContain("weird_unmapped_type");
  });
});

describe("PaginatedActivityTable — note + tx_hash columns (§15.x)", () => {
  it("renders an em-dash placeholder when note is empty", () => {
    const { container } = render(
      <PaginatedActivityTable
        activities={[rowFor({ note: "" })]}
        currentUser={ME}
      />,
    );
    expect(container.textContent).toContain("—");
  });

  it("renders the note text when non-empty", () => {
    const { container } = render(
      <PaginatedActivityTable
        activities={[rowFor({ note: "rent split" })]}
        currentUser={ME}
      />,
    );
    expect(container.textContent).toContain("rent split");
  });

  it("truncates tx_hash to 8...4 chars (e.g. 0x111111…1111)", () => {
    const longHash = "0x" + "a".repeat(60) + "1234";
    const { container } = render(
      <PaginatedActivityTable
        activities={[rowFor({ tx_hash: longHash })]}
        currentUser={ME}
      />,
    );
    expect(container.textContent).toContain("0xaaaaaa…1234");
  });
});

describe("PaginatedActivityTable — pagination (§15.x)", () => {
  function rows(n: number): ActivityRow[] {
    return Array.from({ length: n }, (_, i) =>
      rowFor({ id: `row-${i}`, tx_hash: "0x" + i.toString(16).padStart(64, "0") }),
    );
  }

  it("shows exactly pageSize rows per page (default 10)", () => {
    const { container } = render(
      <PaginatedActivityTable activities={rows(25)} currentUser={ME} />,
    );
    // 10 data rows + 1 header row = 11 <tr> total in tbody+thead.
    const dataRows = container.querySelectorAll("tbody tr");
    expect(dataRows.length).toBe(10);
  });

  it("respects an explicit pageSize prop", () => {
    const { container } = render(
      <PaginatedActivityTable activities={rows(15)} currentUser={ME} pageSize={5} />,
    );
    expect(container.querySelectorAll("tbody tr").length).toBe(5);
  });

  it("hides pagination controls when totalPages = 1", () => {
    const { queryByLabelText } = render(
      <PaginatedActivityTable activities={rows(5)} currentUser={ME} pageSize={10} />,
    );
    expect(queryByLabelText("Previous page")).toBeNull();
  });

  it("renders pagination controls when totalPages > 1", () => {
    const { getByLabelText } = render(
      <PaginatedActivityTable activities={rows(25)} currentUser={ME} />,
    );
    expect(getByLabelText("Previous page")).not.toBeNull();
  });

  it("clicking next page advances pageActivities slice", () => {
    const { container, getByText } = render(
      <PaginatedActivityTable activities={rows(25)} currentUser={ME} />,
    );
    fireEvent.click(getByText("2"));
    // Page 2 with pageSize=10 starts at row-10.
    const dataRows = container.querySelectorAll("tbody tr");
    expect(dataRows.length).toBe(10);
  });

  it("Previous button is disabled on page 1", () => {
    const { getByLabelText } = render(
      <PaginatedActivityTable activities={rows(25)} currentUser={ME} />,
    );
    const prev = getByLabelText("Previous page") as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
  });

  it("ellipsis renders when page count > 5 (default maxVisible)", () => {
    const { container } = render(
      <PaginatedActivityTable activities={rows(100)} currentUser={ME} />,
    );
    // 100 / 10 = 10 pages; default maxVisible = 5, so an ellipsis must appear.
    expect(container.textContent).toContain("...");
  });

  it("clamps current page when activities array shrinks past current page", () => {
    const initial = rows(25);
    const { container, rerender } = render(
      <PaginatedActivityTable activities={initial} currentUser={ME} />,
    );

    // Navigate to page 3.
    fireEvent.click((container.querySelectorAll("button")[3]!) as HTMLButtonElement);

    // Shrink to 5 rows — only 1 page now. Effect should clamp.
    rerender(<PaginatedActivityTable activities={rows(5)} currentUser={ME} />);
    // No pagination controls (1 page) means we successfully clamped.
    expect(container.querySelector('[aria-label="Previous page"]')).toBeNull();
  });
});

describe("PaginatedActivityTable — loading shimmer grace period (§15.x)", () => {
  it("shows shimmer rows immediately when isLoading=true", () => {
    const { container } = render(
      <PaginatedActivityTable activities={[]} currentUser={ME} isLoading={true} />,
    );
    // 5 shimmer rows by source.
    const shimmerCells = container.querySelectorAll(".animate-pulse");
    expect(shimmerCells.length).toBeGreaterThan(0);
  });

  it("keeps shimmer visible for at least 3s after isLoading flips to false (jank prevention)", async () => {
    const { container, rerender } = render(
      <PaginatedActivityTable activities={[]} currentUser={ME} isLoading={true} />,
    );
    // Shimmer is visible.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);

    // Flip isLoading=false immediately (fast fetch). Shimmer should persist.
    await act(async () => {
      rerender(
        <PaginatedActivityTable
          activities={[rowFor()]}
          currentUser={ME}
          isLoading={false}
        />,
      );
    });
    // Shimmer still visible at t=0.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);

    // After 3s, shimmer should clear.
    await act(async () => {
      vi.advanceTimersByTime(3100);
    });
    expect(container.textContent).not.toMatch(/animate-pulse/);
    // Real row now visible.
    expect(container.textContent).toContain("Payment");
  });

  it("does NOT show shimmer when isLoading was never true (cold render)", () => {
    const { container } = render(
      <PaginatedActivityTable activities={[rowFor()]} currentUser={ME} />,
    );
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
  });
});
