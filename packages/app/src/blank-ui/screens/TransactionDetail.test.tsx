import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, waitFor } from "@testing-library/react";

// §15.x test for TransactionDetail screen. The deep-link landing
// page for a single activity row. Pins:
//   - 3-state lifecycle: loading skeleton -> not-found OR detail
//   - id-less params -> not-found (defensive against /app/tx/ with
//     no segment)
//   - fetchActivityById returns null -> not-found (server has no
//     row matching the id)
//   - fetchActivityById THROWS -> not-found (try/catch swallow, no
//     unhandled rejection)
//   - CRITICAL: cancellation guard via `let cancelled = false` so
//     a fast unmount during fetch doesn't write to a stale state
//     and trigger React's "setState on unmounted component" warn
//   - hasValidTxHash filter: `tx_hash && !tx_hash.includes("_")`.
//     Local optimistic rows have synthetic txHashes like "local_<id>"
//     that would render a broken explorer link. Filter hides both
//     the tx-hash row AND the explorer button for those.
//   - isPending: id.startsWith("local_") OR block_number=0
//     (same pattern as HistoryRow.test pinned earlier)
//   - typeIconMap fallback: unknown activity_type falls back to
//     Send icon + gray bg (no crash on a new activity_type)
//   - CopyableAddress: clipboard rejection silently swallowed (no
//     toast/throw -- this is the only screen that doesn't toast,
//     per source); 2s timer revert preserved

const useParamsMock = vi.hoisted(() => vi.fn());
const useNavigateMock = vi.hoisted(() => vi.fn());
const fetchActivityByIdMock = vi.hoisted(() => vi.fn());
const getExplorerTxUrlMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  useParams: useParamsMock,
  useNavigate: () => useNavigateMock,
}));
vi.mock("@/lib/supabase", () => ({
  fetchActivityById: fetchActivityByIdMock,
}));
vi.mock("@/lib/constants", () => ({
  getExplorerTxUrl: getExplorerTxUrlMock,
}));

import TransactionDetail from "./TransactionDetail";

const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BOB = "0xcccccccccccccccccccccccccccccccccccccccc";
const TX_HASH = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

type ActivityRow = {
  id: string;
  activity_type: string;
  user_from: string;
  user_to: string;
  note: string | null;
  tx_hash: string;
  chain_id: number;
  block_number: number;
  created_at: string;
};

function activity(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: "act-42",
    activity_type: "payment",
    user_from: ALICE,
    user_to: BOB,
    note: null,
    tx_hash: TX_HASH,
    chain_id: 11155111,
    block_number: 100,
    created_at: new Date("2025-03-15T14:30:45Z").toISOString(),
    ...over,
  };
}

let writeTextMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useParamsMock.mockReset();
  useNavigateMock.mockReset();
  fetchActivityByIdMock.mockReset();
  getExplorerTxUrlMock.mockReset();

  useParamsMock.mockReturnValue({ id: "act-42" });
  fetchActivityByIdMock.mockResolvedValue(activity());
  getExplorerTxUrlMock.mockImplementation(
    (hash: string, chainId: number) => `https://explorer.test/${hash}?c=${chainId}`,
  );

  writeTextMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TransactionDetail — loading state (§15.x)", () => {
  it("renders shimmer skeleton while fetchActivityById is pending", () => {
    fetchActivityByIdMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(<TransactionDetail />);
    expect(container.querySelectorAll(".shimmer").length).toBeGreaterThan(0);
  });

  it("does NOT show 'Transaction not found' during pending fetch", () => {
    fetchActivityByIdMock.mockReturnValue(new Promise(() => {}));
    const { container } = render(<TransactionDetail />);
    expect(container.textContent).not.toContain("Transaction not found");
  });
});

describe("TransactionDetail — not-found state (§15.x)", () => {
  it("missing id param -> 'Transaction not found' (defensive against /app/tx/ with no segment)", async () => {
    useParamsMock.mockReturnValue({ id: undefined });
    const { container, findByText } = render(<TransactionDetail />);
    await findByText("Transaction not found");
    expect(container.textContent).toContain("This transaction may have been removed or the link is invalid");
  });

  it("fetchActivityById returns null -> 'Transaction not found'", async () => {
    fetchActivityByIdMock.mockResolvedValue(null);
    const { findByText } = render(<TransactionDetail />);
    expect(await findByText("Transaction not found")).toBeDefined();
  });

  it("fetchActivityById throws -> 'Transaction not found' (try/catch swallows, no rejection)", async () => {
    fetchActivityByIdMock.mockRejectedValue(new Error("network down"));
    const { findByText } = render(<TransactionDetail />);
    expect(await findByText("Transaction not found")).toBeDefined();
  });

  it("not-found page has 'View All Transactions' CTA -> navigates to /app/history", async () => {
    fetchActivityByIdMock.mockResolvedValue(null);
    const { findByText } = render(<TransactionDetail />);
    const cta = await findByText("View All Transactions");
    fireEvent.click(cta);
    expect(useNavigateMock).toHaveBeenCalledWith("/app/history");
  });

  it("not-found page back button navigates(-1)", async () => {
    fetchActivityByIdMock.mockResolvedValue(null);
    const { findByText, getByLabelText } = render(<TransactionDetail />);
    await findByText("Transaction not found");
    fireEvent.click(getByLabelText("Go back"));
    expect(useNavigateMock).toHaveBeenCalledWith(-1);
  });
});

describe("TransactionDetail — cancellation guard (§15.x)", () => {
  it("CRITICAL: unmount during pending fetch does NOT call setState on resolution", async () => {
    let resolveFetch!: (v: ActivityRow) => void;
    fetchActivityByIdMock.mockReturnValue(
      new Promise<ActivityRow>((res) => { resolveFetch = res; }),
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { unmount } = render(<TransactionDetail />);
    unmount();

    await act(async () => {
      resolveFetch(activity());
      await Promise.resolve();
      await Promise.resolve();
    });

    // No "Can't perform a React state update on an unmounted component" warning.
    const calls = consoleErrorSpy.mock.calls.map((c) => String(c[0] ?? ""));
    expect(calls.some((c) => c.includes("unmounted component"))).toBe(false);

    consoleErrorSpy.mockRestore();
  });
});

describe("TransactionDetail — type icon + label fallback (§15.x)", () => {
  it("known type 'payment' renders 'Sent payment' label + blue Send icon background", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ activity_type: "payment" }));
    const { findByText, container } = render(<TransactionDetail />);
    await findByText("Sent payment");
    expect(container.innerHTML).toContain("bg-[#007AFF]");
  });

  it("unknown activity_type renders the RAW type string (label fallback)", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ activity_type: "weird_new_type" }));
    const { findByText } = render(<TransactionDetail />);
    expect(await findByText("weird_new_type")).toBeDefined();
  });

  it("unknown activity_type uses Send-icon fallback + gray background (no crash on unmapped type)", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ activity_type: "weird_new_type" }));
    const { findByText, container } = render(<TransactionDetail />);
    await findByText("weird_new_type");
    expect(container.innerHTML).toContain("bg-gray-50");
  });

  it("stealth_sent maps to 'Anonymous payment' label + gray Ghost icon bg", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ activity_type: "stealth_sent" }));
    const { findByText, container } = render(<TransactionDetail />);
    await findByText("Anonymous payment");
    expect(container.innerHTML).toContain("bg-gray-100");
  });
});

describe("TransactionDetail — pending/confirmed pill (§15.x)", () => {
  it("'Confirmed' pill when block_number > 0 + non-local id", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ id: "act-1", block_number: 100 }));
    const { findByText } = render(<TransactionDetail />);
    expect(await findByText("Confirmed")).toBeDefined();
  });

  it("CRITICAL: 'Pending' pill when id starts with 'local_' (optimistic UI row)", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ id: "local_abc", block_number: 100 }));
    const { findByText } = render(<TransactionDetail />);
    expect(await findByText("Pending")).toBeDefined();
  });

  it("CRITICAL: 'Pending' pill when block_number === 0 (mined-but-pre-confirmation)", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ id: "act-1", block_number: 0 }));
    const { findByText } = render(<TransactionDetail />);
    expect(await findByText("Pending")).toBeDefined();
  });
});

describe("TransactionDetail — tx-hash + explorer-link gating (§15.x)", () => {
  it("valid tx_hash renders the Transaction Hash row + explorer link", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ tx_hash: TX_HASH }));
    const { findByText, container } = render(<TransactionDetail />);
    await findByText("Transaction Hash");
    expect(container.textContent).toContain(TX_HASH);
    expect(container.textContent).toContain("View on Explorer");
  });

  it("CRITICAL: synthetic local tx_hash 'local_abc' HIDES both the hash row AND explorer link (no broken link)", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ tx_hash: "local_abc" }));
    const { findByText, container } = render(<TransactionDetail />);
    await findByText("Sent payment");
    expect(container.textContent).not.toContain("Transaction Hash");
    expect(container.textContent).not.toContain("View on Explorer");
  });

  it("empty tx_hash also hides the rows", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ tx_hash: "" }));
    const { findByText, container } = render(<TransactionDetail />);
    await findByText("Sent payment");
    expect(container.textContent).not.toContain("Transaction Hash");
    expect(container.textContent).not.toContain("View on Explorer");
  });

  it("explorer link uses getExplorerTxUrl(tx_hash, chain_id) + tabnabbing guard", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ tx_hash: TX_HASH, chain_id: 11155111 }));
    const { findByText, container } = render(<TransactionDetail />);
    await findByText("View on Explorer");
    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("View on Explorer"),
    ) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain(TX_HASH);
    expect(getExplorerTxUrlMock).toHaveBeenCalledWith(TX_HASH, 11155111);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});

describe("TransactionDetail — note conditional (§15.x)", () => {
  it("renders Note row when activity.note is truthy", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ note: "rent for July" }));
    const { findByText, container } = render(<TransactionDetail />);
    await findByText("rent for July");
    expect(container.textContent).toContain("Note");
  });

  it("HIDES Note row when activity.note is null", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ note: null }));
    const { findByText, container } = render(<TransactionDetail />);
    await findByText("Sent payment");
    // The Note section uses the heading "Note" preceding the note content;
    // make sure the SECTION wrapper isn't rendered (no "Note" + note text).
    const noteSections = Array.from(container.querySelectorAll("p")).filter(
      (p) => p.textContent?.trim() === "Note",
    );
    expect(noteSections.length).toBe(0);
  });
});

describe("TransactionDetail — encrypted-amount masking + a11y (§15.x)", () => {
  it("amount renders 6-dot mask via aria-hidden span + 'Amount hidden' sr-only", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity());
    const { findByText, container } = render(<TransactionDetail />);
    await findByText("Amount");
    expect(container.innerHTML).toContain("aria-hidden");
    expect(container.textContent).toContain("Amount hidden (encrypted)");
  });

  it("explainer copy mentions FHE + permit-to-reveal", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity());
    const { container, findByText } = render(<TransactionDetail />);
    await findByText("Amount");
    expect(container.textContent).toContain("Encrypted with FHE");
    expect(container.textContent).toContain("permit");
  });
});

describe("TransactionDetail — date formatting (§15.x)", () => {
  it("renders date in en-US long form (weekday + month name + year)", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({
      created_at: new Date("2025-03-15T14:30:45Z").toISOString(),
    }));
    const { findByText, container } = render(<TransactionDetail />);
    await findByText("Date & Time");
    // weekday + month-name + day + year. Tests are TZ-dependent so we just
    // assert key tokens present.
    expect(container.textContent).toMatch(/\d{4}/); // year
    expect(container.textContent).toMatch(/January|February|March|April|May|June|July|August|September|October|November|December/);
  });

  it("renders time in HH:MM:SS form", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity());
    const { findByText, container } = render(<TransactionDetail />);
    await findByText("Date & Time");
    expect(container.textContent).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });
});

describe("TransactionDetail — CopyableAddress sub-component (§15.x)", () => {
  it("renders both From + To CopyableAddress rows", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ user_from: ALICE, user_to: BOB }));
    const { findByLabelText, container } = render(<TransactionDetail />);
    await findByLabelText("Copy from address");
    expect(container.textContent).toContain(ALICE);
    expect(container.textContent).toContain(BOB);
  });

  it("clicking Copy on the 'From' row writes that exact address to clipboard", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ user_from: ALICE, user_to: BOB }));
    const { findByLabelText } = render(<TransactionDetail />);
    const btn = await findByLabelText("Copy from address");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenCalledWith(ALICE);
  });

  it("clicking Copy on the 'To' row writes the recipient address (not the sender)", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ user_from: ALICE, user_to: BOB }));
    const { findByLabelText } = render(<TransactionDetail />);
    const btn = await findByLabelText("Copy to address");
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(writeTextMock).toHaveBeenCalledWith(BOB);
  });

  it("CRITICAL: clipboard rejection is silently swallowed (this screen does NOT toast — by design)", async () => {
    writeTextMock.mockRejectedValueOnce(new Error("denied"));
    fetchActivityByIdMock.mockResolvedValue(activity());
    const { findByLabelText } = render(<TransactionDetail />);
    const btn = await findByLabelText("Copy from address");
    // Should not throw despite the rejection.
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });
    // No assertion on toast — this screen has no toast wiring. The
    // contract is "no throw, no crash". Test passes by NOT throwing.
    expect(true).toBe(true);
  });

  it("copied state reverts after 2s timeout", async () => {
    vi.useFakeTimers();
    fetchActivityByIdMock.mockResolvedValue(activity());
    const { container } = render(<TransactionDetail />);

    // Wait for fetch to resolve + render.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const fromBtn = container.querySelector("button[aria-label='Copy from address']") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(fromBtn);
      await Promise.resolve();
    });
    // Check icon is in DOM (Check size=16, text-emerald-500).
    expect(fromBtn.innerHTML).toContain("text-emerald-500");

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(fromBtn.innerHTML).not.toContain("text-emerald-500");
  });
});

describe("TransactionDetail — back-nav + Back-to-Activity (§15.x)", () => {
  it("back arrow on detail page navigates(-1)", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity());
    const { findByLabelText } = render(<TransactionDetail />);
    const back = await findByLabelText("Go back");
    fireEvent.click(back);
    expect(useNavigateMock).toHaveBeenCalledWith(-1);
  });

  it("'Back to Activity' button navigates to /app/history", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity());
    const { findByText } = render(<TransactionDetail />);
    const btn = await findByText("Back to Activity");
    fireEvent.click(btn);
    expect(useNavigateMock).toHaveBeenCalledWith("/app/history");
  });
});

describe("TransactionDetail — id-changes refetch (§15.x)", () => {
  it("changing the route id triggers a re-fetch with the new id", async () => {
    fetchActivityByIdMock.mockResolvedValue(activity({ id: "act-1", note: "first" }));
    useParamsMock.mockReturnValue({ id: "act-1" });
    const { findByText, rerender } = render(<TransactionDetail />);
    await findByText("first");

    fetchActivityByIdMock.mockResolvedValue(activity({ id: "act-2", note: "second" }));
    useParamsMock.mockReturnValue({ id: "act-2" });
    rerender(<TransactionDetail />);
    await waitFor(() => {
      expect(fetchActivityByIdMock).toHaveBeenCalledWith("act-2");
    });
  });
});
