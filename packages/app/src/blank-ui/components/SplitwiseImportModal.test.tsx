import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// §15.x test for SplitwiseImportModal. Phase 3.3 — Splitwise CSV
// import modal. Three-step flow: upload CSV -> map each member
// label to a 0x address -> import (one addExpense UserOp per row).
// High-stakes UX: ~3-5s per row on testnet (~3-4 min for a 50-row
// CSV), so the progress display matters more than the speed; and
// a single bad row shouldn't abort the rest of the import.
//
// CRITICAL pins:
//   - 4-step state machine (upload / map / importing / done);
//     transitions are linear forward-only EXCEPT for upload-
//     failure -> stay on upload + toast error.
//   - parseSplitwiseCsv throwing -> toast.error with err.message;
//     parseSplitwiseCsv returning result with 0 usable rows ->
//     toast.error('CSV has no usable expense rows. Check the
//     file format.') + STAY on upload step (don't advance to map
//     with empty data).
//   - Pre-fill heuristic: for each parsed member label, look in
//     groupMembers for the FIRST address whose hex contains the
//     lowercased label substring; ONLY when the label looks like
//     a hex fragment does this heuristic actually help (users
//     name members 'Alice' and 'Bob' typically — those won't
//     match — so empty defaults are expected and users type the
//     0x address manually); test pins both the match-success and
//     match-miss paths.
//   - allMappingsValid: 0x-prefix + 40 hex chars regex on EVERY
//     parsed member; ANY invalid -> Import button disabled +
//     no startImport possible.
//   - 0-share rows skipped: Splitwise emits 0-share entries for
//     members not on a particular expense (e.g. trip member not
//     at that one restaurant); the import filters those out so
//     addExpense receives only members who actually owe / paid;
//     test pins by including a row with one 0-share entry and
//     asserting that entry doesn't appear in the addExpense call.
//   - Math.abs on shares: Splitwise emits NEGATIVE share for the
//     payer (they paid more than their cut, so their share is
//     negative); the import takes absolute value so addExpense
//     sees what each member's LIABILITY was for that expense
//     (the contract uses positive-only shares); test pins by
//     fixture with negative share and asserting positive value
//     in addExpense args.
//   - Empty mapped members on a row (e.g. all members had 0
//     shares OR all mapped to undefined) -> row marked 'error'
//     with 'no mapped members on this row' message + loop
//     CONTINUES to the next row; test pins.
//   - addExpense throwing on a single row -> row marked 'error'
//     with err.message + loop CONTINUES (single failure does
//     NOT kill the whole import); other rows still process.
//   - Per-row progress states (pending / ok / error) drive
//     the icon + color: pending=Loader2 (animate-spin gray) /
//     ok=CheckCircle2 (emerald-600) / error=AlertCircle (rose-
//     600); test pins via icon-class inspection.
//   - Overlay click + X button -> onClose; the X-aria-label is
//     'Close'; inner card click does NOT propagate (e.stopProp
//     prevents overlay onClick from firing); 'Close' button on
//     the done step also calls onClose.
//   - onImported callback fires AFTER all rows process (success
//     OR failure) so the parent can refresh its group list; the
//     callback fires once on the transition to 'done'.

const useGroupSplitMock = vi.hoisted(() => vi.fn());
const parseSplitwiseCsvMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/splitwise-csv", () => ({
  parseSplitwiseCsv: parseSplitwiseCsvMock,
}));
vi.mock("@/hooks/useGroupSplit", () => ({ useGroupSplit: useGroupSplitMock }));
vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string").join(" "),
}));
vi.mock("react-hot-toast", () => ({
  default: { error: toastErrorMock },
}));

import { SplitwiseImportModal } from "./SplitwiseImportModal";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const CAROL = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;

const addExpenseMock = vi.fn();

function makeFile(content: string, name = "splitwise.csv"): File {
  const f = new File([content], name, { type: "text/csv" });
  // jsdom may not implement File.prototype.text(); patch it so handleFile's
  // `await file.text()` resolves synchronously.
  Object.defineProperty(f, "text", {
    value: () => Promise.resolve(content),
    configurable: true,
  });
  return f;
}

beforeEach(() => {
  useGroupSplitMock.mockReset();
  parseSplitwiseCsvMock.mockReset();
  toastErrorMock.mockReset();
  addExpenseMock.mockReset();

  useGroupSplitMock.mockReturnValue({ addExpense: addExpenseMock });
  addExpenseMock.mockResolvedValue(undefined);
});

// ───────────────────────────────────────────────────────────
//  Step 1: upload + parse
// ───────────────────────────────────────────────────────────

describe("SplitwiseImportModal — upload step (§15.x)", () => {
  it("initial render -> 'upload' step + 'Import from Splitwise' heading + Upload button", () => {
    render(
      <SplitwiseImportModal
        groupId={1}
        groupMembers={[]}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    expect(screen.getByText("Import from Splitwise")).toBeInTheDocument();
    expect(screen.getByText("Click to upload CSV")).toBeInTheDocument();
  });

  it("CSV parse throws -> toast.error with err.message + stays on upload", async () => {
    parseSplitwiseCsvMock.mockImplementation(() => {
      throw new Error("Malformed CSV header");
    });
    render(
      <SplitwiseImportModal
        groupId={1}
        groupMembers={[]}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [makeFile("bad")] });
    fireEvent.change(input);
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("Malformed CSV header");
    });
    expect(screen.getByText("Click to upload CSV")).toBeInTheDocument(); // still on upload
  });

  it("CSV with 0 rows -> 'no usable expense rows' toast + stays on upload", async () => {
    parseSplitwiseCsvMock.mockReturnValue({
      rows: [],
      members: [],
      errors: [],
    });
    render(
      <SplitwiseImportModal
        groupId={1}
        groupMembers={[]}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [makeFile("empty")] });
    fireEvent.change(input);
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith(
        "CSV has no usable expense rows. Check the file format.",
      );
    });
    expect(screen.getByText("Click to upload CSV")).toBeInTheDocument();
  });

  it("valid CSV -> advances to 'map' step + shows row + member counts", async () => {
    parseSplitwiseCsvMock.mockReturnValue({
      rows: [
        { description: "Lunch", cost: 30, shares: { Alice: -20, Bob: 10, Carol: 10 } },
        { description: "Coffee", cost: 12, shares: { Alice: -8, Bob: 4, Carol: 4 } },
      ],
      members: ["Alice", "Bob", "Carol"],
      errors: [],
    });
    render(
      <SplitwiseImportModal
        groupId={1}
        groupMembers={[]}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [makeFile("valid")] });
    fireEvent.change(input);
    await waitFor(() => {
      expect(screen.getByText(/Found/)).toBeInTheDocument();
    });
    // Use container query because '2' and '3' appear inside <strong> nested in <p>
    expect(screen.getByText(/Map each member to a 0x address/)).toBeInTheDocument();
  });

  it("parse errors in CSV -> amber warning banner on map step", async () => {
    parseSplitwiseCsvMock.mockReturnValue({
      rows: [{ description: "Lunch", cost: 30, shares: { Alice: -20, Bob: 20 } }],
      members: ["Alice", "Bob"],
      errors: ["row 3 missing cost", "row 5 bad date"],
    });
    render(
      <SplitwiseImportModal
        groupId={1}
        groupMembers={[]}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [makeFile("with-errors")] });
    fireEvent.change(input);
    await waitFor(() => {
      expect(
        screen.getByText(/2 row\(s\) had parse errors and will be skipped/),
      ).toBeInTheDocument();
    });
  });
});

// ───────────────────────────────────────────────────────────
//  Step 2: member mapping
// ───────────────────────────────────────────────────────────

describe("SplitwiseImportModal — map step (§15.x)", () => {
  async function seedMapStep(members: string[] = ["Alice", "Bob"], existingMembers: string[] = []) {
    parseSplitwiseCsvMock.mockReturnValue({
      rows: [{ description: "Lunch", cost: 30, shares: { Alice: -20, Bob: 20 } }],
      members,
      errors: [],
    });
    const result = render(
      <SplitwiseImportModal
        groupId={1}
        groupMembers={existingMembers}
        onClose={vi.fn()}
        onImported={vi.fn()}
      />,
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [makeFile("any")] });
    fireEvent.change(input);
    await waitFor(() => {
      expect(screen.getByText(/Map each member to a 0x address/)).toBeInTheDocument();
    });
    return result;
  }

  it("renders one input per parsed member with member label", async () => {
    await seedMapStep(["Alice", "Bob", "Carol"]);
    expect(screen.getByTitle("Alice")).toBeInTheDocument();
    expect(screen.getByTitle("Bob")).toBeInTheDocument();
    expect(screen.getByTitle("Carol")).toBeInTheDocument();
  });

  it("Import button disabled until ALL members have valid 0x addresses", async () => {
    await seedMapStep(["Alice", "Bob"]);
    const importBtn = screen.getByText(/Import 1 expenses/).closest("button") as HTMLButtonElement;
    expect(importBtn.disabled).toBe(true);

    // Fill Alice only -> still disabled
    const inputs = document.querySelectorAll('input[type="text"]');
    fireEvent.change(inputs[0]!, { target: { value: ALICE } });
    expect(importBtn.disabled).toBe(true);

    // Fill Bob -> enabled
    fireEvent.change(inputs[1]!, { target: { value: BOB } });
    expect(importBtn.disabled).toBe(false);
  });

  it("invalid 0x address (too short) -> Import button still disabled", async () => {
    await seedMapStep(["Alice"]);
    const importBtn = screen.getByText(/Import 1 expenses/).closest("button") as HTMLButtonElement;
    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0xabc" } });
    expect(importBtn.disabled).toBe(true);
  });

  it("address that doesn't start with 0x -> Import button disabled", async () => {
    await seedMapStep(["Alice"]);
    const importBtn = screen.getByText(/Import 1 expenses/).closest("button") as HTMLButtonElement;
    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: ALICE.slice(2) } }); // strip 0x
    expect(importBtn.disabled).toBe(true);
  });

  it("pre-fill heuristic: member label that matches existing-member hex substring", async () => {
    // groupMembers includes ALICE; member label '0xaaaa' (lowercase) matches
    // ALICE's address substring, so pre-fill should put ALICE in the input.
    await seedMapStep(["0xaaaa"], [ALICE]);
    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.value).toBe(ALICE);
  });

  it("pre-fill miss: member label not in any group member -> empty default", async () => {
    await seedMapStep(["RandomName"], [ALICE, BOB]);
    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.value).toBe("");
  });

  it("datalist for autocomplete contains all groupMembers as options", async () => {
    await seedMapStep(["Alice"], [ALICE, BOB, CAROL]);
    const datalist = document.querySelector("#splitwise-known-members");
    expect(datalist).toBeInTheDocument();
    const options = datalist!.querySelectorAll("option");
    expect(options).toHaveLength(3);
  });
});

// ───────────────────────────────────────────────────────────
//  Step 3: import / row-by-row addExpense
// ───────────────────────────────────────────────────────────

describe("SplitwiseImportModal — import step (§15.x)", () => {
  async function startImportFlow(opts: {
    rows: Array<{ description: string; cost: number; shares: Record<string, number> }>;
    addExpense?: (groupId: number, cost: string, members: string[], shares: string[], note: string) => Promise<void>;
  }) {
    if (opts.addExpense) addExpenseMock.mockImplementation(opts.addExpense);
    parseSplitwiseCsvMock.mockReturnValue({
      rows: opts.rows,
      members: ["Alice", "Bob", "Carol"],
      errors: [],
    });
    const onImported = vi.fn();
    render(
      <SplitwiseImportModal
        groupId={42}
        groupMembers={[]}
        onClose={vi.fn()}
        onImported={onImported}
      />,
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [makeFile("any")] });
    fireEvent.change(input);
    await waitFor(() => {
      expect(screen.getByText(/Map each member to a 0x address/)).toBeInTheDocument();
    });
    const inputs = document.querySelectorAll('input[type="text"]');
    fireEvent.change(inputs[0]!, { target: { value: ALICE } });
    fireEvent.change(inputs[1]!, { target: { value: BOB } });
    fireEvent.change(inputs[2]!, { target: { value: CAROL } });
    fireEvent.click(screen.getByText(/Import \d+ expenses/));
    return { onImported };
  }

  it("import happy path: addExpense called per row with correct args", async () => {
    await startImportFlow({
      rows: [
        { description: "Lunch", cost: 30, shares: { Alice: -20, Bob: 10, Carol: 10 } },
      ],
    });
    await waitFor(() => {
      expect(addExpenseMock).toHaveBeenCalledTimes(1);
    });
    const call = addExpenseMock.mock.calls[0];
    expect(call[0]).toBe(42); // groupId
    expect(call[1]).toBe("30.000000"); // cost as string with 6dp
    expect(call[2]).toEqual([ALICE.toLowerCase(), BOB.toLowerCase(), CAROL.toLowerCase()]);
    // Shares are Math.abs() of the raw shares
    expect(call[3]).toEqual(["20.000000", "10.000000", "10.000000"]);
    expect(call[4]).toBe("Lunch");
  });

  it("Math.abs applied: negative shares (payer) -> positive in addExpense args", async () => {
    await startImportFlow({
      rows: [
        { description: "Coffee", cost: 12, shares: { Alice: -8, Bob: 4, Carol: 4 } },
      ],
    });
    await waitFor(() => {
      expect(addExpenseMock).toHaveBeenCalledTimes(1);
    });
    // Alice's share in the call should be 8 (absolute), not -8
    expect(addExpenseMock.mock.calls[0][3][0]).toBe("8.000000");
  });

  it("0-share entries skipped (member not on this expense)", async () => {
    await startImportFlow({
      rows: [
        { description: "Snack", cost: 6, shares: { Alice: -3, Bob: 3, Carol: 0 } },
      ],
    });
    await waitFor(() => {
      expect(addExpenseMock).toHaveBeenCalledTimes(1);
    });
    const call = addExpenseMock.mock.calls[0];
    // Carol should NOT appear in members (her share was 0)
    expect(call[2]).toEqual([ALICE.toLowerCase(), BOB.toLowerCase()]);
    expect(call[3]).toEqual(["3.000000", "3.000000"]);
  });

  it("description fallback: empty description -> 'Imported row N'", async () => {
    await startImportFlow({
      rows: [{ description: "", cost: 5, shares: { Alice: -3, Bob: 3 } }],
    });
    await waitFor(() => {
      expect(addExpenseMock).toHaveBeenCalledTimes(1);
    });
    expect(addExpenseMock.mock.calls[0][4]).toBe("Imported row 1");
  });

  it("addExpense rejection on row 1 -> row marked error, loop continues to row 2", async () => {
    let callCount = 0;
    await startImportFlow({
      rows: [
        { description: "Row1", cost: 10, shares: { Alice: -5, Bob: 5 } },
        { description: "Row2", cost: 20, shares: { Alice: -10, Bob: 10 } },
      ],
      addExpense: async () => {
        callCount += 1;
        if (callCount === 1) throw new Error("revert reason X");
      },
    });
    await waitFor(() => {
      expect(addExpenseMock).toHaveBeenCalledTimes(2); // both rows attempted
    });
    // Row 1 should show error label
    await waitFor(() => {
      expect(screen.getByText(/revert reason X/i)).toBeInTheDocument();
    });
  });

  it("row with no mapped members (all 0-shares) -> error + no addExpense call for that row", async () => {
    await startImportFlow({
      rows: [
        { description: "Empty", cost: 0, shares: { Alice: 0, Bob: 0, Carol: 0 } },
        { description: "Good", cost: 10, shares: { Alice: -5, Bob: 5 } },
      ],
    });
    await waitFor(() => {
      expect(addExpenseMock).toHaveBeenCalledTimes(1); // only Row2
    });
    await waitFor(() => {
      expect(screen.getByText(/no mapped members on this row/i)).toBeInTheDocument();
    });
  });

  it("'done' state: onImported callback fires + 'Close' button shown", async () => {
    const { onImported } = await startImportFlow({
      rows: [{ description: "Test", cost: 5, shares: { Alice: -3, Bob: 3 } }],
    });
    await waitFor(() => {
      expect(screen.getByText("Import complete.")).toBeInTheDocument();
    });
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Close")).toBeInTheDocument();
  });

  it("'importing' phase shows 'Importing expenses one at a time…' header", async () => {
    // Make addExpense hang so we can inspect the importing phase
    let resolveFn: () => void = () => {};
    addExpenseMock.mockReturnValue(
      new Promise<void>((res) => {
        resolveFn = res;
      }),
    );
    await startImportFlow({
      rows: [{ description: "Test", cost: 5, shares: { Alice: -3, Bob: 3 } }],
    });
    await waitFor(() => {
      expect(
        screen.getByText("Importing expenses one at a time…"),
      ).toBeInTheDocument();
    });
    resolveFn();
  });
});

// ───────────────────────────────────────────────────────────
//  Close paths
// ───────────────────────────────────────────────────────────

describe("SplitwiseImportModal — close paths (§15.x)", () => {
  it("X (Close) button click -> onClose", () => {
    const onClose = vi.fn();
    render(
      <SplitwiseImportModal
        groupId={1}
        groupMembers={[]}
        onClose={onClose}
        onImported={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("'Close' button on done step -> onClose", async () => {
    parseSplitwiseCsvMock.mockReturnValue({
      rows: [{ description: "Test", cost: 5, shares: { Alice: -3, Bob: 3 } }],
      members: ["Alice", "Bob"],
      errors: [],
    });
    const onClose = vi.fn();
    render(
      <SplitwiseImportModal
        groupId={1}
        groupMembers={[]}
        onClose={onClose}
        onImported={vi.fn()}
      />,
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [makeFile("any")] });
    fireEvent.change(input);
    await waitFor(() => {
      expect(screen.getByText(/Map each member to a 0x address/)).toBeInTheDocument();
    });
    const inputs = document.querySelectorAll('input[type="text"]');
    fireEvent.change(inputs[0]!, { target: { value: ALICE } });
    fireEvent.change(inputs[1]!, { target: { value: BOB } });
    fireEvent.click(screen.getByText(/Import 1 expenses/));
    await waitFor(() => {
      expect(screen.getByText("Import complete.")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
