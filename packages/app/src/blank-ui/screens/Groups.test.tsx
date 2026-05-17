import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, fireEvent } from "@testing-library/react";

// §15.x test for Groups screen — Phase 3.3 encrypted group split. Lets a
// user create a multi-member group, add expenses, settle debts, vote on
// expenses, leave + archive (admin only). Receipt OCR pre-fills empty
// description + amount fields (does NOT overwrite user-entered values).
//
// CRITICAL pins:
//   - audit Top-28 #28 refreshData closure depends on `activeChainId` so a
//     chain switch re-runs the fetch. Without that dep, fetchUserGroups
//     would return last-chain's groups + the user would see stale rows.
//   - uniqueGroups reducer dedupes on group_id (the same user can have
//     multiple membership rows from re-add flows) so the grid renders ONE
//     card per group, not duplicates.
//   - join-by-id 4-branch validation matrix (no wallet / invalid id /
//     already-member / not-found) each emits distinct toast copy before
//     the addSelfToGroup call. NOT a single generic "failed" — the user
//     needs to know which gate they tripped.
//   - CreateGroupModal: 3 validation gates (empty name, no valid members,
//     duplicate member dedup) + member-address regex /^0x[a-fA-F0-9]{40}$/
//     applied to EACH typed address + lowercase dedup via Set.
//   - AddExpenseModal split-mode: equal-split computes per-person via
//     useGroupSplit.computeEqualSplit; custom-split sums shares + matches
//     amount within 1e-6 tolerance (FP-safe). Mismatched custom shares
//     surface red error copy + disable the submit CTA.
//   - recognizeReceipt OCR result fills empty description + amount ONLY
//     (does NOT overwrite user-entered values) so the user's manual entry
//     is never silently clobbered. Both-missing -> "Couldn't read this
//     receipt" toast; partial -> success.
//   - SettleDebtModal validates target address regex before calling
//     settleDebt + emits "Invalid Ethereum address" toast.
//   - VoteModal fetches expenses on mount; selecting an expense + entering
//     vote amount > 0 + Submit -> voteOnExpense(groupId, expenseId, votes);
//     empty expense list shows "No expenses to vote on" empty state.
//   - Leave + Archive use window.confirm gates with distinct copy (Leave:
//     "no longer see expenses or debts"; Archive: "deactivated for all
//     members"). Archive button only visible when group.is_admin.

const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useGroupSplitMock = vi.hoisted(() => vi.fn());
const fetchUserGroupsMock = vi.hoisted(() => vi.fn());
const fetchGroupExpensesMock = vi.hoisted(() => vi.fn());
const fetchGroupByIdMock = vi.hoisted(() => vi.fn());
const addSelfToGroupMock = vi.hoisted(() => vi.fn());
const recognizeReceiptMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.hoisted(() => vi.fn());
const toastSuccessMock = vi.hoisted(() => vi.fn());
const toastLoadingMock = vi.hoisted(() => vi.fn());
const toastDefaultMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useGroupSplit", () => ({ useGroupSplit: useGroupSplitMock }));
vi.mock("@/lib/supabase", () => ({
  fetchUserGroups: fetchUserGroupsMock,
  fetchGroupExpenses: fetchGroupExpensesMock,
  fetchGroupById: fetchGroupByIdMock,
  addSelfToGroup: addSelfToGroupMock,
}));
vi.mock("@/lib/receipt-ocr", () => ({ recognizeReceipt: recognizeReceiptMock }));
vi.mock("@/blank-ui/components", () => ({
  SplitwiseImportModal: ({ groupId, onClose }: { groupId: number; onClose: () => void }) => (
    <div data-testid="splitwise-import-modal" data-group-id={groupId}>
      <button onClick={onClose}>close-splitwise</button>
    </div>
  ),
}));
vi.mock("react-hot-toast", () => {
  const fn: typeof toastDefaultMock & {
    error: typeof toastErrorMock;
    success: typeof toastSuccessMock;
    loading: typeof toastLoadingMock;
  } = Object.assign(toastDefaultMock, {
    error: toastErrorMock,
    success: toastSuccessMock,
    loading: toastLoadingMock,
  });
  return { default: fn };
});

import Groups from "./Groups";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALICE = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BOB = "0xcccccccccccccccccccccccccccccccccccccccc";

function groupRow(over: {
  group_id?: number;
  group_name?: string;
  is_admin?: boolean;
  member_address?: string;
} = {}) {
  return {
    id: `mem-${over.group_id ?? 1}`,
    group_id: over.group_id ?? 1,
    group_name: over.group_name ?? "Weekend Trip",
    member_address: over.member_address ?? ME,
    is_admin: over.is_admin ?? true,
    chain_id: 11155111,
    created_at: new Date().toISOString(),
  };
}

function expenseRow(over: {
  group_id?: number;
  expense_id?: number;
  description?: string;
  payer_address?: string;
} = {}) {
  return {
    id: `exp-${over.expense_id ?? 1}`,
    group_id: over.group_id ?? 1,
    expense_id: over.expense_id ?? 1,
    payer_address: over.payer_address ?? ALICE,
    description: over.description ?? "Dinner",
    member_count: 3,
    tx_hash: "0x1234",
    chain_id: 11155111,
    created_at: new Date().toISOString(),
  };
}

const createGroupMock = vi.fn();
const addExpenseMock = vi.fn();
const settleDebtMock = vi.fn();
const voteOnExpenseMock = vi.fn();
const leaveGroupMock = vi.fn();
const archiveGroupMock = vi.fn();
const computeEqualSplitMock = vi.fn(
  (amount: string, n: number) => (Number(amount || "0") / n).toFixed(6),
);

function setUseGroupSplit(isProcessing = false) {
  useGroupSplitMock.mockReturnValue({
    isProcessing,
    computeEqualSplit: computeEqualSplitMock,
    createGroup: createGroupMock,
    addExpense: addExpenseMock,
    settleDebt: settleDebtMock,
    voteOnExpense: voteOnExpenseMock,
    leaveGroup: leaveGroupMock,
    archiveGroup: archiveGroupMock,
  });
}

beforeEach(() => {
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  useGroupSplitMock.mockReset();
  fetchUserGroupsMock.mockReset();
  fetchGroupExpensesMock.mockReset();
  fetchGroupByIdMock.mockReset();
  addSelfToGroupMock.mockReset();
  recognizeReceiptMock.mockReset();
  toastErrorMock.mockReset();
  toastSuccessMock.mockReset();
  toastLoadingMock.mockReset();
  toastDefaultMock.mockReset();
  createGroupMock.mockReset();
  addExpenseMock.mockReset();
  settleDebtMock.mockReset();
  voteOnExpenseMock.mockReset();
  leaveGroupMock.mockReset();
  archiveGroupMock.mockReset();
  computeEqualSplitMock.mockClear();

  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME });
  useChainMock.mockReturnValue({ activeChainId: 11155111 });
  fetchUserGroupsMock.mockResolvedValue([]);
  fetchGroupExpensesMock.mockResolvedValue([]);
  fetchGroupByIdMock.mockResolvedValue(null);
  addSelfToGroupMock.mockResolvedValue(true);
  toastLoadingMock.mockReturnValue("toast-id");
  setUseGroupSplit();
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  });
}

function findButton(container: HTMLElement, label: string | RegExp): HTMLButtonElement {
  const btn = Array.from(container.querySelectorAll("button"))
    .find((b) => {
      const text = b.textContent ?? "";
      const aria = b.getAttribute("aria-label") ?? "";
      if (typeof label === "string") return text.includes(label) || aria === label;
      return label.test(text) || label.test(aria);
    }) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`Button '${label}' not found`);
  return btn;
}

/** Find a button inside the currently-open modal (.glass-elevated). */
function findModalButton(container: HTMLElement, label: string | RegExp): HTMLButtonElement {
  const modal = container.querySelector(".glass-elevated") as HTMLElement | null;
  if (!modal) throw new Error("No open modal");
  return findButton(modal, label);
}

// ----- page chrome ----- //

describe("Groups — page chrome (§15.x)", () => {
  it("renders 'Group Expenses' heading + privacy subtitle", async () => {
    const { container } = render(<Groups />);
    await flush();
    expect(container.textContent).toContain("Group Expenses");
    expect(container.textContent).toContain("Split bills privately with voting approval");
  });

  it("renders 'Join a group' card with input + 'Join by ID' CTA", async () => {
    const { container } = render(<Groups />);
    await flush();
    expect(container.textContent).toContain("Join a group");
    expect(container.querySelector('input[placeholder*="Group ID"]')).not.toBeNull();
    expect(findButton(container, "Join by ID")).toBeTruthy();
  });

  it("loading state renders 4 shimmer skeleton cards", () => {
    fetchUserGroupsMock.mockReturnValue(new Promise(() => {}));
    const { container } = render(<Groups />);
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThanOrEqual(4);
  });

  it("empty state renders 'No groups yet' + 'Create Your First Group' CTA", async () => {
    fetchUserGroupsMock.mockResolvedValue([]);
    const { container } = render(<Groups />);
    await flush();
    expect(container.textContent).toContain("No groups yet");
    expect(container.textContent).toContain("Create Your First Group");
  });
});

// ----- refreshData + chain switch (audit #28) ----- //

describe("Groups — refreshData lifecycle (§15.x)", () => {
  it("mount fetches user groups with lowercase address", async () => {
    fetchUserGroupsMock.mockResolvedValue([groupRow()]);
    render(<Groups />);
    await flush();
    expect(fetchUserGroupsMock).toHaveBeenCalledWith(ME.toLowerCase());
  });

  it("audit #28 chain switch triggers refetch (refreshData closure deps on activeChainId)", async () => {
    fetchUserGroupsMock.mockResolvedValue([]);
    const { rerender } = render(<Groups />);
    await flush();
    const initial = fetchUserGroupsMock.mock.calls.length;
    useChainMock.mockReturnValue({ activeChainId: 84532 });
    rerender(<Groups />);
    await flush();
    expect(fetchUserGroupsMock.mock.calls.length).toBeGreaterThan(initial);
  });

  it("no address skips fetchUserGroups + shows empty state", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    fetchUserGroupsMock.mockClear();
    const { container } = render(<Groups />);
    await flush();
    expect(fetchUserGroupsMock).toHaveBeenCalledTimes(0);
    expect(container.textContent).toContain("No groups yet");
  });

  it("fetches expenses for each unique group id via Promise.all", async () => {
    fetchUserGroupsMock.mockResolvedValue([
      groupRow({ group_id: 1 }),
      groupRow({ group_id: 2 }),
    ]);
    fetchGroupExpensesMock.mockResolvedValue([]);
    render(<Groups />);
    await flush();
    expect(fetchGroupExpensesMock).toHaveBeenCalledWith(1);
    expect(fetchGroupExpensesMock).toHaveBeenCalledWith(2);
  });

  it("Refresh button click re-runs fetchUserGroups", async () => {
    fetchUserGroupsMock.mockResolvedValue([groupRow()]);
    const { container } = render(<Groups />);
    await flush();
    const before = fetchUserGroupsMock.mock.calls.length;
    fireEvent.click(findButton(container, "Refresh"));
    await flush();
    expect(fetchUserGroupsMock.mock.calls.length).toBeGreaterThan(before);
  });

  it("supabase reject keeps loading=false (offline tolerated, no crash)", async () => {
    fetchUserGroupsMock.mockRejectedValue(new Error("offline"));
    const { container } = render(<Groups />);
    await flush();
    expect(container.textContent).toContain("No groups yet");
  });
});

// ----- uniqueGroups dedup ----- //

describe("Groups — uniqueGroups dedup (§15.x)", () => {
  it("dedupes multiple membership rows for same group_id", async () => {
    fetchUserGroupsMock.mockResolvedValue([
      groupRow({ group_id: 1, group_name: "Trip" }),
      groupRow({ group_id: 1, group_name: "Trip" }),
      groupRow({ group_id: 1, group_name: "Trip" }),
    ]);
    fetchGroupExpensesMock.mockResolvedValue([]);
    const { container } = render(<Groups />);
    await flush();
    const titles = Array.from(container.querySelectorAll("h3"))
      .filter((h) => h.textContent?.trim() === "Trip");
    expect(titles).toHaveLength(1);
  });

  it("renders distinct cards for distinct group_ids", async () => {
    fetchUserGroupsMock.mockResolvedValue([
      groupRow({ group_id: 1, group_name: "Trip" }),
      groupRow({ group_id: 2, group_name: "Lunch" }),
    ]);
    fetchGroupExpensesMock.mockResolvedValue([]);
    const { container } = render(<Groups />);
    await flush();
    expect(container.textContent).toContain("Trip");
    expect(container.textContent).toContain("Lunch");
  });
});

// ----- Join-by-ID 4-branch validation ----- //

describe("Groups — Join by ID validation (§15.x)", () => {
  it("no wallet -> 'Connect wallet first' toast (no addSelfToGroup)", async () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: null });
    const { container } = render(<Groups />);
    await flush();
    const input = container.querySelector('input[placeholder*="Group ID"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.click(findButton(container, "Join by ID"));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith("Connect wallet first");
    expect(addSelfToGroupMock).toHaveBeenCalledTimes(0);
  });

  it("input regex blocks non-numeric typing (controlled input rejects letters)", async () => {
    const { container } = render(<Groups />);
    await flush();
    const input = container.querySelector('input[placeholder*="Group ID"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc" } });
    expect(input.value).toBe("");
  });

  it("already-a-member -> info toast (no addSelfToGroup)", async () => {
    fetchUserGroupsMock.mockResolvedValue([groupRow({ group_id: 42 })]);
    fetchGroupExpensesMock.mockResolvedValue([]);
    const { container } = render(<Groups />);
    await flush();
    const input = container.querySelector('input[placeholder*="Group ID"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.click(findButton(container, "Join by ID"));
    await flush();
    expect(toastDefaultMock).toHaveBeenCalled();
    const arg = toastDefaultMock.mock.calls[0][0] as string;
    expect(arg).toContain("already in that group");
    expect(addSelfToGroupMock).toHaveBeenCalledTimes(0);
  });

  it("group not found -> 'Group not found' toast (no addSelfToGroup)", async () => {
    fetchGroupByIdMock.mockResolvedValue(null);
    const { container } = render(<Groups />);
    await flush();
    const input = container.querySelector('input[placeholder*="Group ID"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.click(findButton(container, "Join by ID"));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("Group not found"));
    expect(addSelfToGroupMock).toHaveBeenCalledTimes(0);
  });

  it("happy path -> addSelfToGroup + success toast + input clears + refresh", async () => {
    fetchGroupByIdMock.mockResolvedValue({
      id: "g-99",
      group_id: 99,
      group_name: "Beach Trip",
      member_address: ALICE,
      is_admin: true,
      created_at: new Date().toISOString(),
    });
    addSelfToGroupMock.mockResolvedValue(true);
    const { container } = render(<Groups />);
    await flush();
    const input = container.querySelector('input[placeholder*="Group ID"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.click(findButton(container, "Join by ID"));
    await flush();
    expect(addSelfToGroupMock).toHaveBeenCalledWith(99, ME.toLowerCase());
    expect(toastSuccessMock).toHaveBeenCalledWith(expect.stringContaining("Beach Trip"));
    expect(input.value).toBe("");
  });

  it("addSelfToGroup returns false -> 'Failed to join group' toast", async () => {
    fetchGroupByIdMock.mockResolvedValue({
      id: "g-99",
      group_id: 99,
      group_name: "Beach Trip",
      member_address: ALICE,
      is_admin: true,
      created_at: new Date().toISOString(),
    });
    addSelfToGroupMock.mockResolvedValue(false);
    const { container } = render(<Groups />);
    await flush();
    const input = container.querySelector('input[placeholder*="Group ID"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.click(findButton(container, "Join by ID"));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringContaining("Failed to join"));
  });

  it("Enter key in input also triggers join", async () => {
    fetchGroupByIdMock.mockResolvedValue({
      id: "g-99",
      group_id: 99,
      group_name: "Beach Trip",
      member_address: ALICE,
      is_admin: true,
      created_at: new Date().toISOString(),
    });
    const { container } = render(<Groups />);
    await flush();
    const input = container.querySelector('input[placeholder*="Group ID"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flush();
    expect(addSelfToGroupMock).toHaveBeenCalledWith(99, ME.toLowerCase());
  });
});

// ----- CreateGroupModal ----- //

describe("Groups — CreateGroupModal (§15.x)", () => {
  async function openCreateModal() {
    fetchUserGroupsMock.mockResolvedValue([]);
    const result = render(<Groups />);
    await flush();
    fireEvent.click(findButton(result.container, "Create Your First Group"));
    return result;
  }

  it("opens via Create CTA + renders inputs", async () => {
    const { container } = await openCreateModal();
    expect(container.textContent).toContain("Create New Group");
    expect(container.textContent).toContain("Group Name");
    expect(container.textContent).toContain("Add Members");
  });

  it("empty name -> Create disabled + no createGroup call (button enables only with both name + members)", async () => {
    const { container } = await openCreateModal();
    const memberInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(memberInput, { target: { value: ALICE } });
    fireEvent.click(findButton(container, "Add member"));
    await flush();
    // Scope to modal — header has its own "Create Group" CTA
    const createBtn = findModalButton(container, "Create Group");
    expect(createBtn.disabled).toBe(true); // empty name keeps modal button disabled
    expect(createGroupMock).toHaveBeenCalledTimes(0);
  });

  it("invalid hex address -> 'Invalid Ethereum address' toast (member NOT added)", async () => {
    const { container } = await openCreateModal();
    const memberInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(memberInput, { target: { value: "not-hex" } });
    fireEvent.click(findButton(container, "Add member"));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid Ethereum address");
    // No member chip rendered
    const chip = Array.from(container.querySelectorAll(".font-mono"))
      .find((s) => s.textContent?.includes("not-h"));
    expect(chip).toBeUndefined();
  });

  it("empty member input -> 'Paste a wallet address first' toast", async () => {
    const { container } = await openCreateModal();
    fireEvent.click(findButton(container, "Add member"));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith("Paste a wallet address first");
  });

  it("duplicate add (same address) -> 'Address already added' toast", async () => {
    const { container } = await openCreateModal();
    const memberInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(memberInput, { target: { value: ALICE } });
    fireEvent.click(findButton(container, "Add member"));
    await flush();
    fireEvent.change(memberInput, { target: { value: ALICE } });
    fireEvent.click(findButton(container, "Add member"));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith("Address already added");
  });

  it("Enter key in member input also adds member", async () => {
    const { container } = await openCreateModal();
    const memberInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(memberInput, { target: { value: ALICE } });
    fireEvent.keyDown(memberInput, { key: "Enter" });
    await flush();
    // Chip with truncated alice
    expect(container.textContent).toContain(ALICE.slice(0, 6));
    expect(container.textContent).toContain(ALICE.slice(-4));
  });

  it("Create with name + 2 members -> createGroup(name, lowercase-deduped) + close on success", async () => {
    createGroupMock.mockResolvedValue({ ok: true });
    const { container } = await openCreateModal();
    const nameInput = container.querySelector('input[placeholder="Weekend getaway"]') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "  Trip  " } });
    const memberInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(memberInput, { target: { value: ALICE } });
    fireEvent.click(findButton(container, "Add member"));
    await flush();
    fireEvent.change(memberInput, { target: { value: BOB } });
    fireEvent.click(findButton(container, "Add member"));
    await flush();
    fireEvent.click(findModalButton(container, "Create Group"));
    await flush();
    expect(createGroupMock).toHaveBeenCalledWith("Trip", [
      ALICE.toLowerCase(),
      BOB.toLowerCase(),
    ]);
  });

  it("Remove member chip drops it from the list", async () => {
    const { container } = await openCreateModal();
    const memberInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(memberInput, { target: { value: ALICE } });
    fireEvent.click(findButton(container, "Add member"));
    await flush();
    const removeBtn = findButton(container, new RegExp(`Remove member ${ALICE.slice(0, 6)}`));
    fireEvent.click(removeBtn);
    await flush();
    expect(container.textContent).not.toContain(ALICE.slice(0, 6));
  });
});

// ----- GroupCard chrome ----- //

describe("Groups — GroupCard (§15.x)", () => {
  it("renders group name + group #id + Admin/Member label", async () => {
    fetchUserGroupsMock.mockResolvedValue([
      groupRow({ group_id: 7, group_name: "Office Lunch", is_admin: true }),
    ]);
    const { container } = render(<Groups />);
    await flush();
    expect(container.textContent).toContain("Office Lunch");
    expect(container.textContent).toContain("Group #7");
    expect(container.textContent).toContain("Admin");
  });

  it("non-admin sees 'Member' label + NO Archive button", async () => {
    fetchUserGroupsMock.mockResolvedValue([
      groupRow({ is_admin: false }),
    ]);
    const { container } = render(<Groups />);
    await flush();
    expect(container.textContent).toContain("Member");
    expect(container.textContent).not.toContain("Archive Group");
  });

  it("audit A27 #4: 'Your Share' card shows 'Encrypted' + 'Decrypts during Settle' (no fake reveal toggle)", async () => {
    fetchUserGroupsMock.mockResolvedValue([groupRow()]);
    const { container } = render(<Groups />);
    await flush();
    expect(container.textContent).toContain("Your Share");
    expect(container.textContent).toContain("Encrypted");
    expect(container.textContent).toContain("Decrypts during Settle");
  });

  it("audit A27 #6: 'Expense count' (count not dollar sum) label rendered", async () => {
    fetchUserGroupsMock.mockResolvedValue([groupRow()]);
    fetchGroupExpensesMock.mockResolvedValue([
      expenseRow({ expense_id: 1 }),
      expenseRow({ expense_id: 2 }),
    ]);
    const { container } = render(<Groups />);
    await flush();
    expect(container.textContent).toContain("Expense count");
    // The number "2" appears in the card body (count, not amount)
    expect(container.textContent).toContain("2");
  });

  it("Recent Expenses lists up to 3 expense rows", async () => {
    fetchUserGroupsMock.mockResolvedValue([groupRow()]);
    fetchGroupExpensesMock.mockResolvedValue([
      expenseRow({ expense_id: 1, description: "Breakfast" }),
      expenseRow({ expense_id: 2, description: "Lunch" }),
      expenseRow({ expense_id: 3, description: "Dinner" }),
      expenseRow({ expense_id: 4, description: "Snacks" }),
    ]);
    const { container } = render(<Groups />);
    await flush();
    expect(container.textContent).toContain("Breakfast");
    expect(container.textContent).toContain("Lunch");
    expect(container.textContent).toContain("Dinner");
    expect(container.textContent).not.toContain("Snacks");
  });
});

// ----- Leave + Archive ----- //

describe("Groups — Leave + Archive confirm gates (§15.x)", () => {
  it("Leave confirm copy mentions 'no longer see expenses or debts'", async () => {
    fetchUserGroupsMock.mockResolvedValue([groupRow()]);
    const { container } = render(<Groups />);
    await flush();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    leaveGroupMock.mockResolvedValue(undefined);
    fireEvent.click(findButton(container, "Leave Group"));
    expect(confirmSpy.mock.calls[0][0]).toContain("no longer see expenses or debts");
    expect(leaveGroupMock).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it("Leave confirm=false -> NO leaveGroup call", async () => {
    fetchUserGroupsMock.mockResolvedValue([groupRow()]);
    const { container } = render(<Groups />);
    await flush();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(findButton(container, "Leave Group"));
    expect(leaveGroupMock).toHaveBeenCalledTimes(0);
    confirmSpy.mockRestore();
  });

  it("Archive (admin only) confirm copy mentions 'deactivated for all members'", async () => {
    fetchUserGroupsMock.mockResolvedValue([groupRow({ is_admin: true })]);
    const { container } = render(<Groups />);
    await flush();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    archiveGroupMock.mockResolvedValue(undefined);
    fireEvent.click(findButton(container, "Archive Group"));
    expect(confirmSpy.mock.calls[0][0]).toContain("deactivated for all members");
    expect(archiveGroupMock).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });
});

// ----- AddExpenseModal ----- //

describe("Groups — AddExpenseModal (§15.x)", () => {
  async function openAddExpense() {
    fetchUserGroupsMock.mockResolvedValue([groupRow({ group_id: 7 })]);
    const result = render(<Groups />);
    await flush();
    fireEvent.click(findButton(result.container, "Add Expense"));
    await flush();
    return result;
  }

  it("opens modal with group id in heading", async () => {
    const { container } = await openAddExpense();
    expect(container.textContent).toContain("Add Expense to Group #7");
  });

  it("USDC amount regex /^\\d*\\.?\\d{0,6}$/ accepts 6dp, rejects 7th decimal", async () => {
    const { container } = await openAddExpense();
    const amountInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "10.123456" } });
    expect(amountInput.value).toBe("10.123456");
    fireEvent.change(amountInput, { target: { value: "10.1234567" } });
    expect(amountInput.value).toBe("10.123456");
  });

  it("missing description -> disabled submit + no addExpense call", async () => {
    const { container } = await openAddExpense();
    const amountInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "10" } });
    const submit = findModalButton(container, "Add Expense");
    expect(submit.disabled).toBe(true);
    fireEvent.click(submit);
    await flush();
    expect(addExpenseMock).toHaveBeenCalledTimes(0);
  });

  it("happy path: description + amount + addExpense called with (groupId, amount, members, shares, description)", async () => {
    addExpenseMock.mockResolvedValue(undefined);
    const { container } = await openAddExpense();
    const modal = container.querySelector(".glass-elevated") as HTMLElement;
    const descInput = Array.from(modal.querySelectorAll("input"))
      .find((i) => i.getAttribute("placeholder") === "What was this expense for?") as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: "Dinner" } });
    const amountInput = modal.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "30" } });
    fireEvent.click(findModalButton(container, "Add Expense"));
    await flush();
    expect(addExpenseMock).toHaveBeenCalled();
    const args = addExpenseMock.mock.calls[0];
    expect(args[0]).toBe(7); // groupId
    expect(args[1]).toBe("30"); // amount
    expect(Array.isArray(args[2])).toBe(true); // members
    expect(Array.isArray(args[3])).toBe(true); // shares
    expect(args[4]).toBe("Dinner");
  });

  it("split-mode toggle appears only when allMembers.length > 1 (2 members typed)", async () => {
    const { container } = await openAddExpense();
    // Solo (only `address`) -> NO split mode toggle
    expect(container.textContent).not.toContain("Split Mode");

    // Add 2 members so expenseMembers.length === 2
    const modal = container.querySelector(".glass-elevated") as HTMLElement;
    const memberInput = modal.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(memberInput, { target: { value: ALICE } });
    fireEvent.keyDown(memberInput, { key: "Enter" });
    await flush();
    fireEvent.change(memberInput, { target: { value: BOB } });
    fireEvent.keyDown(memberInput, { key: "Enter" });
    await flush();
    expect(container.textContent).toContain("Split Mode");
    expect(container.textContent).toContain("Equal Split");
    expect(container.textContent).toContain("Custom Split");
  });

  it("custom split sum mismatch -> disabled submit + red 'must match total' copy", async () => {
    const { container } = await openAddExpense();
    const modal = container.querySelector(".glass-elevated") as HTMLElement;
    const descInput = Array.from(modal.querySelectorAll("input"))
      .find((i) => i.getAttribute("placeholder") === "What was this expense for?") as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: "Lunch" } });
    const amountInput = modal.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "30" } });
    const memberInput = modal.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(memberInput, { target: { value: ALICE } });
    fireEvent.keyDown(memberInput, { key: "Enter" });
    await flush();
    fireEvent.change(memberInput, { target: { value: BOB } });
    fireEvent.keyDown(memberInput, { key: "Enter" });
    await flush();
    fireEvent.click(findButton(modal, "Custom Split"));
    await flush();
    expect(container.textContent).toContain("must match total");
    const submit = findModalButton(container, "Add Expense");
    expect(submit.disabled).toBe(true);
  });

  it("custom split FP-safe tolerance 1e-6: shares sum 10.000000 vs amount 10 -> valid (matches)", async () => {
    const { container } = await openAddExpense();
    const modal = container.querySelector(".glass-elevated") as HTMLElement;
    const descInput = Array.from(modal.querySelectorAll("input"))
      .find((i) => i.getAttribute("placeholder") === "What was this expense for?") as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: "Lunch" } });
    const amountInput = modal.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "10" } });
    const memberInput = modal.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(memberInput, { target: { value: ALICE } });
    fireEvent.keyDown(memberInput, { key: "Enter" });
    await flush();
    fireEvent.change(memberInput, { target: { value: BOB } });
    fireEvent.keyDown(memberInput, { key: "Enter" });
    await flush();
    fireEvent.click(findButton(modal, "Custom Split"));
    await flush();
    // Custom share inputs are 2 (alice + bob) inside the custom-split section
    // (each h-10, distinct from the amount input h-14).
    const customInputs = Array.from(modal.querySelectorAll("input"))
      .filter((i) => i.getAttribute("placeholder") === "0.00" && i.className.includes("h-10")) as HTMLInputElement[];
    expect(customInputs.length).toBeGreaterThanOrEqual(2);
    fireEvent.change(customInputs[0], { target: { value: "4" } });
    fireEvent.change(customInputs[1], { target: { value: "6" } });
    await flush();
    expect(container.textContent).toContain("(matches)");
  });
});

// ----- recognizeReceipt OCR fills empty fields ----- //

describe("Groups — receipt OCR (§15.x)", () => {
  async function openAddExpense() {
    fetchUserGroupsMock.mockResolvedValue([groupRow({ group_id: 1 })]);
    const result = render(<Groups />);
    await flush();
    fireEvent.click(findButton(result.container, "Add Expense"));
    await flush();
    return result;
  }

  it("OCR fills empty description + amount", async () => {
    recognizeReceiptMock.mockResolvedValue({
      total: 42.5,
      merchant: "Joe's Pizza",
      date: null,
      rawText: "raw",
    });
    const { container } = await openAddExpense();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "receipt.jpg", { type: "image/jpeg" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fireEvent.change(fileInput);
    await flush();
    const descInput = Array.from(container.querySelectorAll("input"))
      .find((i) => i.getAttribute("placeholder") === "What was this expense for?") as HTMLInputElement;
    const amountInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    expect(descInput.value).toBe("Joe's Pizza");
    expect(amountInput.value).toBe("42.50");
  });

  it("OCR does NOT overwrite user-entered description", async () => {
    recognizeReceiptMock.mockResolvedValue({
      total: 42.5,
      merchant: "Joe's Pizza",
      date: null,
      rawText: "raw",
    });
    const { container } = await openAddExpense();
    const descInput = Array.from(container.querySelectorAll("input"))
      .find((i) => i.getAttribute("placeholder") === "What was this expense for?") as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: "User's typed desc" } });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "receipt.jpg", { type: "image/jpeg" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fireEvent.change(fileInput);
    await flush();
    expect(descInput.value).toBe("User's typed desc");
    // amount was empty so it should still get filled
    const amountInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    expect(amountInput.value).toBe("42.50");
  });

  it("OCR both-null -> 'Couldn\\'t read this receipt' toast", async () => {
    recognizeReceiptMock.mockResolvedValue({
      total: null,
      merchant: null,
      date: null,
      rawText: "",
    });
    const { container } = await openAddExpense();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "receipt.jpg", { type: "image/jpeg" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fireEvent.change(fileInput);
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "Couldn't read this receipt. Try a sharper photo.",
      expect.any(Object),
    );
  });

  it("OCR thrown error -> error toast with error message", async () => {
    recognizeReceiptMock.mockRejectedValue(new Error("wasm load failed"));
    const { container } = await openAddExpense();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "receipt.jpg", { type: "image/jpeg" });
    Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
    fireEvent.change(fileInput);
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("wasm load failed"),
      expect.any(Object),
    );
  });
});

// ----- SettleDebtModal ----- //

describe("Groups — SettleDebtModal (§15.x)", () => {
  async function openSettle() {
    fetchUserGroupsMock.mockResolvedValue([groupRow({ group_id: 5 })]);
    const result = render(<Groups />);
    await flush();
    fireEvent.click(findButton(result.container, "Settle"));
    await flush();
    return result;
  }

  it("invalid hex address -> 'Invalid Ethereum address' toast (no settleDebt)", async () => {
    const { container } = await openSettle();
    const addrInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(addrInput, { target: { value: "not-hex" } });
    const amountInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "5" } });
    fireEvent.click(findButton(container, "Settle Debt"));
    await flush();
    expect(toastErrorMock).toHaveBeenCalledWith("Invalid Ethereum address");
    expect(settleDebtMock).toHaveBeenCalledTimes(0);
  });

  it("happy path -> settleDebt(groupId, address, amount) called", async () => {
    settleDebtMock.mockResolvedValue({ ok: true });
    const { container } = await openSettle();
    const addrInput = container.querySelector('input[placeholder="0x..."]') as HTMLInputElement;
    fireEvent.change(addrInput, { target: { value: ALICE } });
    const amountInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: "5" } });
    fireEvent.click(findButton(container, "Settle Debt"));
    await flush();
    expect(settleDebtMock).toHaveBeenCalledWith(5, ALICE, "5");
  });
});

// ----- VoteModal ----- //

describe("Groups — VoteModal (§15.x)", () => {
  async function openVote(expenses: ReturnType<typeof expenseRow>[]) {
    fetchUserGroupsMock.mockResolvedValue([groupRow({ group_id: 9 })]);
    fetchGroupExpensesMock.mockImplementation(async (gid: number) => {
      return gid === 9 ? expenses : [];
    });
    const result = render(<Groups />);
    await flush();
    fireEvent.click(findButton(result.container, "Vote on expense"));
    await flush();
    return result;
  }

  it("empty expense list -> 'No expenses to vote on' empty state", async () => {
    const { container } = await openVote([]);
    expect(container.textContent).toContain("No expenses to vote on");
  });

  it("expense list renders + select an expense + submit vote -> voteOnExpense", async () => {
    voteOnExpenseMock.mockResolvedValue(undefined);
    const { container } = await openVote([
      expenseRow({ group_id: 9, expense_id: 42, description: "Pizza" }),
    ]);
    // Click the expense row to select
    const pizzaBtn = findButton(container, "Pizza");
    fireEvent.click(pizzaBtn);
    await flush();
    // Enter vote amount
    const voteInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(voteInput, { target: { value: "1" } });
    fireEvent.click(findButton(container, "Submit Vote"));
    await flush();
    expect(voteOnExpenseMock).toHaveBeenCalledWith(9, 42, "1");
  });

  it("Submit disabled when no expense selected (even with vote amount)", async () => {
    const { container } = await openVote([
      expenseRow({ group_id: 9, expense_id: 42, description: "Pizza" }),
    ]);
    const voteInput = container.querySelector('input[placeholder="0.00"]') as HTMLInputElement;
    fireEvent.change(voteInput, { target: { value: "1" } });
    const submit = findButton(container, "Submit Vote");
    expect(submit.disabled).toBe(true);
  });
});

// ----- Splitwise import trigger ----- //

describe("Groups — Splitwise import modal (§15.x)", () => {
  it("Import from Splitwise click opens modal with group id", async () => {
    fetchUserGroupsMock.mockResolvedValue([groupRow({ group_id: 11 })]);
    const { container, getByTestId } = render(<Groups />);
    await flush();
    fireEvent.click(findButton(container, "Import from Splitwise"));
    await flush();
    const modal = getByTestId("splitwise-import-modal");
    expect(modal.getAttribute("data-group-id")).toBe("11");
  });
});
