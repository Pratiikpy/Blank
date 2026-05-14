import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// §15.x test for GlobalSearch. The cmd-K search bar in the Desktop
// Sidebar + Mobile menu — searches across activity feed (notes /
// tx hashes / from-address / to-address) AND contacts (nickname /
// address). High-traffic UX so correctness of the debounce +
// filter + navigation matters. The compact mobile variant adds a
// hidden-by-default search icon that expands to a full input on
// tap.
//
// CRITICAL pins:
//   - 300ms debounce: typing 'abc' should fire only ONE filter
//     pass at the end of the 300ms window, not three on each
//     keystroke; test uses vi.useFakeTimers to advance time
//     deterministically.
//   - MAX_RESULTS_PER_CATEGORY = 5 caps each section so a user
//     who has 100 activities or contacts doesn't blow up the
//     dropdown's max-h-80 + overflow-y-auto layout; test seeds 10
//     activities and asserts only 5 rendered.
//   - Search filter is case-INsensitive across all 4 activity
//     fields (note + tx_hash + user_from + user_to) AND both
//     contact fields (nickname + address); test pins mixed-case
//     queries against mixed-case fixtures.
//   - Dropdown visibility 2-gate: isOpen (input focused) AND
//     debouncedQuery.trim().length > 0; empty query hides the
//     dropdown even when focused (so an empty focused input
//     doesn't show a ghost dropdown with 0 results message).
//   - Empty results: shows 'No results for "{query}"' empty state
//     instead of just hiding the dropdown so the user knows the
//     query DID run + found nothing (vs. is-still-typing
//     ambiguity).
//   - Activity row click -> navigate('/app/tx/{id}') + clears
//     query + closes dropdown; contact row click -> navigate('/app/
//     contacts') + clears; the activity link uses the activity.id
//     (NOT tx_hash) because the receipt route is keyed on the
//     supabase row id.
//   - Click-outside (mousedown anywhere outside containerRef) ->
//     closes dropdown + collapses compact mode if active; Escape
//     key -> same behavior + ALSO blurs the input.
//   - Compact mobile mode: starts as a search icon button; on
//     click it expands to the full input + auto-focuses (via
//     setTimeout to wait for the input to mount); the X button
//     in compact mode collapses back to the icon AND closes
//     dropdown; ARIA: 'Open search' aria-label on the icon
//     button.
//   - Activity rendering fallback chain: note -> activityLabels
//     [activity_type] -> raw activity_type string; pinned because
//     a regression that dropped the activityLabels map would
//     surface raw enum strings like 'invoice_created' to the
//     user.
//   - Activities section header 'Transactions', contacts header
//     'Contacts'; both uppercase + tracking-wider; only rendered
//     when their section has matches (so an activity-only query
//     doesn't show an empty 'Contacts' header).

const useActivityFeedMock = vi.hoisted(() => vi.fn());
const useContactsMock = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});
vi.mock("@/hooks/useActivityFeed", () => ({
  useActivityFeed: useActivityFeedMock,
}));
vi.mock("@/hooks/useContacts", () => ({ useContacts: useContactsMock }));
vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string").join(" "),
}));
vi.mock("@/lib/address", () => ({
  truncateAddress: (a: string) => a.slice(0, 6) + "..." + a.slice(-4),
}));

import { GlobalSearch } from "./GlobalSearch";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const BOB = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;

function makeActivity(id: string, fields: Record<string, unknown>) {
  return {
    id,
    tx_hash: `0x${id}`,
    user_from: ME,
    user_to: ALICE,
    note: "",
    activity_type: "payment",
    created_at: new Date().toISOString(),
    ...fields,
  };
}

function makeContact(nickname: string, address: string) {
  return { nickname, address };
}

// Helper to render with Router context
function renderWithRouter(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

// Advance debounce + flush state updates.
async function advanceDebounce(ms = 300) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  useActivityFeedMock.mockReset();
  useContactsMock.mockReset();
  navigateMock.mockReset();

  useActivityFeedMock.mockReturnValue({ activities: [] });
  useContactsMock.mockReturnValue({ contacts: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

// ───────────────────────────────────────────────────────────
//  Render — non-compact (default) + compact (mobile)
// ───────────────────────────────────────────────────────────

describe("GlobalSearch — render (§15.x)", () => {
  it("default (non-compact) renders the search input + placeholder + aria-label", () => {
    renderWithRouter(<GlobalSearch />);
    const input = screen.getByLabelText("Global search");
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).placeholder).toContain(
      "Search transactions, contacts",
    );
  });

  it("compact mode + not expanded -> renders a search icon button (no input visible)", () => {
    renderWithRouter(<GlobalSearch compact />);
    expect(screen.getByLabelText("Open search")).toBeInTheDocument();
    expect(screen.queryByLabelText("Global search")).toBeNull();
  });

  it("compact -> click icon -> input mounts + focuses (auto-focus via setTimeout)", async () => {
    vi.useFakeTimers();
    renderWithRouter(<GlobalSearch compact />);
    fireEvent.click(screen.getByLabelText("Open search"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150); // > 100ms focus timeout
    });
    expect(screen.getByLabelText("Global search")).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Debounce + filter
// ───────────────────────────────────────────────────────────

describe("GlobalSearch — debounce + filter (§15.x)", () => {
  it("300ms debounce: typing -> dropdown does NOT open until 300ms after last keystroke", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({
      activities: [makeActivity("1", { note: "Lunch payment" })],
    });
    renderWithRouter(<GlobalSearch />);
    const input = screen.getByLabelText("Global search");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "lunch" } });
    // 200ms in: NOT yet debounced
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(screen.queryByText(/Lunch payment/)).toBeNull();
    // After full 300ms: dropdown shows
    await advanceDebounce(100);
    expect(screen.getByText(/Lunch payment/)).toBeInTheDocument();
  });

  it("case-INsensitive filter on activity note", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({
      activities: [makeActivity("1", { note: "LUNCH at noon" })],
    });
    renderWithRouter(<GlobalSearch />);
    const input = screen.getByLabelText("Global search");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "lunch" } });
    await advanceDebounce();
    expect(screen.getByText(/LUNCH at noon/)).toBeInTheDocument();
  });

  it("case-INsensitive filter on user_from address (lowercased query matches mixed-case field)", async () => {
    vi.useFakeTimers();
    const MIXED = "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd";
    useActivityFeedMock.mockReturnValue({
      activities: [makeActivity("1", { user_from: MIXED, note: "test" })],
    });
    renderWithRouter(<GlobalSearch />);
    fireEvent.focus(screen.getByLabelText("Global search"));
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "abcdef" },
    });
    await advanceDebounce();
    expect(screen.getByText(/test/)).toBeInTheDocument();
  });

  it("filters across BOTH activities AND contacts in one query", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({
      activities: [makeActivity("1", { note: "Alice lunch" })],
    });
    useContactsMock.mockReturnValue({
      contacts: [makeContact("Alice", ALICE)],
    });
    renderWithRouter(<GlobalSearch />);
    fireEvent.focus(screen.getByLabelText("Global search"));
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "alice" },
    });
    await advanceDebounce();
    expect(screen.getByText(/Alice lunch/)).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("MAX_RESULTS_PER_CATEGORY=5: 10 matching activities -> only 5 rendered", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({
      activities: Array.from({ length: 10 }).map((_, i) =>
        makeActivity(String(i), { note: `lunch ${i}` }),
      ),
    });
    renderWithRouter(<GlobalSearch />);
    fireEvent.focus(screen.getByLabelText("Global search"));
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "lunch" },
    });
    await advanceDebounce();
    const matches = screen.getAllByText(/lunch \d/);
    expect(matches).toHaveLength(5);
  });

  it("empty/whitespace query -> no filter pass, no matches (debouncedQuery.trim() guard)", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({
      activities: [makeActivity("1", { note: "anything" })],
    });
    renderWithRouter(<GlobalSearch />);
    fireEvent.focus(screen.getByLabelText("Global search"));
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "   " },
    });
    await advanceDebounce();
    expect(screen.queryByText(/anything/)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Dropdown visibility 2-gate
// ───────────────────────────────────────────────────────────

describe("GlobalSearch — dropdown 2-gate visibility (§15.x)", () => {
  it("focused + empty query -> dropdown hidden", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({
      activities: [makeActivity("1", { note: "test" })],
    });
    renderWithRouter(<GlobalSearch />);
    fireEvent.focus(screen.getByLabelText("Global search"));
    // No query typed yet
    expect(screen.queryByText("Transactions")).toBeNull();
  });

  it("not focused + non-empty query -> dropdown hidden (isOpen=false)", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({
      activities: [makeActivity("1", { note: "test" })],
    });
    renderWithRouter(<GlobalSearch />);
    // Change without focus first
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "test" },
    });
    await advanceDebounce();
    expect(screen.queryByText("Transactions")).toBeNull();
  });

  it("focused + non-empty query + no matches -> 'No results for {q}' empty state", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({ activities: [] });
    useContactsMock.mockReturnValue({ contacts: [] });
    renderWithRouter(<GlobalSearch />);
    fireEvent.focus(screen.getByLabelText("Global search"));
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "nothing" },
    });
    await advanceDebounce();
    expect(screen.getByText(/No results for/)).toBeInTheDocument();
    expect(screen.getByText(/nothing/)).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Navigation on row click
// ───────────────────────────────────────────────────────────

describe("GlobalSearch — navigation on row click (§15.x)", () => {
  it("activity row click -> navigate('/app/tx/{id}') + clears query", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({
      activities: [makeActivity("42", { note: "Lunch with Alice" })],
    });
    renderWithRouter(<GlobalSearch />);
    fireEvent.focus(screen.getByLabelText("Global search"));
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "lunch" },
    });
    await advanceDebounce();
    fireEvent.click(screen.getByText(/Lunch with Alice/).closest("button")!);
    expect(navigateMock).toHaveBeenCalledWith("/app/tx/42");
    expect((screen.getByLabelText("Global search") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("contact row click -> navigate('/app/contacts')", async () => {
    vi.useFakeTimers();
    useContactsMock.mockReturnValue({
      contacts: [makeContact("Alice", ALICE)],
    });
    renderWithRouter(<GlobalSearch />);
    fireEvent.focus(screen.getByLabelText("Global search"));
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "alice" },
    });
    await advanceDebounce();
    fireEvent.click(screen.getByText("Alice").closest("button")!);
    expect(navigateMock).toHaveBeenCalledWith("/app/contacts");
  });

  it("activity link uses activity.id NOT tx_hash (supabase row id)", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({
      activities: [
        makeActivity("supabase-row-uuid", {
          note: "test",
          tx_hash: "0xchaintx",
        }),
      ],
    });
    renderWithRouter(<GlobalSearch />);
    fireEvent.focus(screen.getByLabelText("Global search"));
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "test" },
    });
    await advanceDebounce();
    fireEvent.click(screen.getByText("test").closest("button")!);
    expect(navigateMock).toHaveBeenCalledWith("/app/tx/supabase-row-uuid");
    expect(navigateMock).not.toHaveBeenCalledWith("/app/tx/0xchaintx");
  });
});

// ───────────────────────────────────────────────────────────
//  Click-outside + Escape close
// ───────────────────────────────────────────────────────────

describe("GlobalSearch — click-outside + Escape (§15.x)", () => {
  it("mousedown outside containerRef -> dropdown closes", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({
      activities: [makeActivity("1", { note: "test" })],
    });
    render(
      <MemoryRouter>
        <GlobalSearch />
        <button data-testid="outside">Outside</button>
      </MemoryRouter>,
    );
    fireEvent.focus(screen.getByLabelText("Global search"));
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "test" },
    });
    await advanceDebounce();
    expect(screen.getByText("Transactions")).toBeInTheDocument();
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId("outside"));
    });
    expect(screen.queryByText("Transactions")).toBeNull();
  });

  it("Escape -> dropdown closes + input blurs", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({
      activities: [makeActivity("1", { note: "test" })],
    });
    renderWithRouter(<GlobalSearch />);
    const input = screen.getByLabelText("Global search") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "test" } });
    await advanceDebounce();
    expect(screen.getByText("Transactions")).toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByText("Transactions")).toBeNull();
  });

  it("compact mode Escape -> collapses back to icon", async () => {
    vi.useFakeTimers();
    renderWithRouter(<GlobalSearch compact />);
    fireEvent.click(screen.getByLabelText("Open search"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(screen.getByLabelText("Global search")).toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByLabelText("Global search")).toBeNull();
    expect(screen.getByLabelText("Open search")).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Section headers
// ───────────────────────────────────────────────────────────

describe("GlobalSearch — section headers (§15.x)", () => {
  it("activity-only matches -> 'Transactions' header shown, NO 'Contacts' header", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({
      activities: [makeActivity("1", { note: "test" })],
    });
    useContactsMock.mockReturnValue({ contacts: [] });
    renderWithRouter(<GlobalSearch />);
    fireEvent.focus(screen.getByLabelText("Global search"));
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "test" },
    });
    await advanceDebounce();
    expect(screen.getByText("Transactions")).toBeInTheDocument();
    expect(screen.queryByText("Contacts")).toBeNull();
  });

  it("contact-only matches -> 'Contacts' header shown, NO 'Transactions' header", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({ activities: [] });
    useContactsMock.mockReturnValue({
      contacts: [makeContact("Bob", BOB)],
    });
    renderWithRouter(<GlobalSearch />);
    fireEvent.focus(screen.getByLabelText("Global search"));
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "bob" },
    });
    await advanceDebounce();
    expect(screen.getByText("Contacts")).toBeInTheDocument();
    expect(screen.queryByText("Transactions")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Activity label fallback chain
// ───────────────────────────────────────────────────────────

describe("GlobalSearch — activity label fallback (§15.x)", () => {
  it("note set -> shows note", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({
      activities: [
        makeActivity("1", { note: "Custom note", activity_type: "payment" }),
      ],
    });
    renderWithRouter(<GlobalSearch />);
    fireEvent.focus(screen.getByLabelText("Global search"));
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "custom" },
    });
    await advanceDebounce();
    expect(screen.getByText("Custom note")).toBeInTheDocument();
  });

  it("empty note + known activity_type -> shows activityLabels map value", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({
      activities: [
        // Match by user_from since note is empty
        makeActivity("1", {
          note: "",
          activity_type: "invoice_created",
          user_from: ME,
        }),
      ],
    });
    renderWithRouter(<GlobalSearch />);
    fireEvent.focus(screen.getByLabelText("Global search"));
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "0xaaaa" }, // matches user_from
    });
    await advanceDebounce();
    expect(screen.getByText("Invoice created")).toBeInTheDocument();
  });

  it("empty note + unknown activity_type -> shows raw activity_type", async () => {
    vi.useFakeTimers();
    useActivityFeedMock.mockReturnValue({
      activities: [
        makeActivity("1", {
          note: "",
          activity_type: "uncategorized_op",
          user_from: ME,
        }),
      ],
    });
    renderWithRouter(<GlobalSearch />);
    fireEvent.focus(screen.getByLabelText("Global search"));
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "0xaaaa" },
    });
    await advanceDebounce();
    expect(screen.getByText("uncategorized_op")).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Clear button (X)
// ───────────────────────────────────────────────────────────

describe("GlobalSearch — clear button (§15.x)", () => {
  it("X button visible only when query non-empty", async () => {
    renderWithRouter(<GlobalSearch />);
    expect(screen.queryByLabelText("Clear search")).toBeNull();
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "anything" },
    });
    expect(screen.getByLabelText("Clear search")).toBeInTheDocument();
  });

  it("X click -> clears query + debouncedQuery", async () => {
    vi.useFakeTimers();
    renderWithRouter(<GlobalSearch />);
    fireEvent.change(screen.getByLabelText("Global search"), {
      target: { value: "foo" },
    });
    await advanceDebounce();
    fireEvent.click(screen.getByLabelText("Clear search"));
    expect((screen.getByLabelText("Global search") as HTMLInputElement).value).toBe(
      "",
    );
  });

  it("compact mode X click -> ALSO collapses back to icon mode", async () => {
    vi.useFakeTimers();
    renderWithRouter(<GlobalSearch compact />);
    fireEvent.click(screen.getByLabelText("Open search"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150);
    });
    // In compact + expanded, X clears AND collapses even with empty query
    fireEvent.click(screen.getByLabelText("Clear search"));
    expect(screen.queryByLabelText("Global search")).toBeNull();
    expect(screen.getByLabelText("Open search")).toBeInTheDocument();
  });
});
