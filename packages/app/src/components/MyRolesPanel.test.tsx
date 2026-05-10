import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// §15.x test for MyRolesPanel. Pins the role-kind → route mapping
// (clicking a role must navigate to the right screen — getting this
// wrong silently routes to the wrong destination), the empty/loading
// state branching, and the markSeen + onNavigate fanout on row click.

const useMyRolesMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useMyRoles", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useMyRoles")>("@/hooks/useMyRoles");
  return {
    ...actual,
    useMyRoles: useMyRolesMock,
  };
});

import { MyRolesPanel } from "./MyRolesPanel";

const ALICE = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function withRouter(node: React.ReactElement) {
  return <MemoryRouter>{node}</MemoryRouter>;
}

beforeEach(() => {
  useMyRolesMock.mockReset();
  useMyRolesMock.mockReturnValue({
    roles: [],
    unreadCount: 0,
    loading: false,
    markAllSeen: vi.fn(),
    markSeen: vi.fn(),
    refetch: vi.fn(),
  });
});

describe("MyRolesPanel — empty + loading states (§15.x)", () => {
  it("shows 'Checking your designations...' on initial loading + zero roles", () => {
    useMyRolesMock.mockReturnValue({
      roles: [],
      unreadCount: 0,
      loading: true,
      markAllSeen: vi.fn(),
      markSeen: vi.fn(),
      refetch: vi.fn(),
    });
    const { container } = render(withRouter(<MyRolesPanel />));
    expect(container.textContent).toContain("Checking your designations");
  });

  it("renders 3 pulsing skeleton rows during initial loading", () => {
    useMyRolesMock.mockReturnValue({
      roles: [],
      unreadCount: 0,
      loading: true,
      markAllSeen: vi.fn(),
      markSeen: vi.fn(),
      refetch: vi.fn(),
    });
    const { container } = render(withRouter(<MyRolesPanel />));
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBe(3);
  });

  it("shows 'No active roles yet' when not loading + zero roles", () => {
    const { container } = render(withRouter(<MyRolesPanel />));
    expect(container.textContent).toContain("No active roles yet");
  });

  it("renders the empty-state icon + helper text when no roles", () => {
    const { container } = render(withRouter(<MyRolesPanel />));
    expect(container.textContent).toContain("names you as arbiter");
  });
});

describe("MyRolesPanel — roles listing + counts (§15.x)", () => {
  it("renders the roles count in the header", () => {
    useMyRolesMock.mockReturnValue({
      roles: [
        { kind: "arbiter", escrowId: 1, depositor: ALICE, description: "x", createdAt: "" },
        { kind: "heir", principal: BOB, createdAt: "" },
      ],
      unreadCount: 0,
      loading: false,
      markAllSeen: vi.fn(),
      markSeen: vi.fn(),
      refetch: vi.fn(),
    });
    const { container } = render(withRouter(<MyRolesPanel />));
    expect(container.textContent).toContain("2 roles");
  });

  it("singular 'role' (no plural s) when count is exactly 1", () => {
    useMyRolesMock.mockReturnValue({
      roles: [{ kind: "heir", principal: BOB, createdAt: "" }],
      unreadCount: 0,
      loading: false,
      markAllSeen: vi.fn(),
      markSeen: vi.fn(),
      refetch: vi.fn(),
    });
    const { container } = render(withRouter(<MyRolesPanel />));
    expect(container.textContent).toContain("1 role");
    expect(container.textContent).not.toContain("1 roles");
  });

  it("appends ' · N new' when unreadCount > 0", () => {
    useMyRolesMock.mockReturnValue({
      roles: [
        { kind: "heir", principal: BOB, createdAt: "" },
        { kind: "heir", principal: ALICE, createdAt: "" },
      ],
      unreadCount: 2,
      loading: false,
      markAllSeen: vi.fn(),
      markSeen: vi.fn(),
      refetch: vi.fn(),
    });
    const { container } = render(withRouter(<MyRolesPanel />));
    expect(container.textContent).toContain("2 new");
  });
});

describe("MyRolesPanel — role-kind → route mapping (§15.x)", () => {
  function rolesWith(role: import("@/hooks/useMyRoles").MyRole) {
    useMyRolesMock.mockReturnValue({
      roles: [role],
      unreadCount: 0,
      loading: false,
      markAllSeen: vi.fn(),
      markSeen: vi.fn(),
      refetch: vi.fn(),
    });
  }

  it("arbiter → /app/business", () => {
    rolesWith({ kind: "arbiter", escrowId: 5, depositor: ALICE, description: "x", createdAt: "" });
    const { container } = render(withRouter(<MyRolesPanel />));
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/app/business");
  });

  it("escrow_beneficiary → /app/business", () => {
    rolesWith({ kind: "escrow_beneficiary", escrowId: 5, depositor: ALICE, description: "x", createdAt: "" });
    const { container } = render(withRouter(<MyRolesPanel />));
    expect(container.querySelector("a")!.getAttribute("href")).toBe("/app/business");
  });

  it("heir → /app/inheritance", () => {
    rolesWith({ kind: "heir", principal: ALICE, createdAt: "" });
    const { container } = render(withRouter(<MyRolesPanel />));
    expect(container.querySelector("a")!.getAttribute("href")).toBe("/app/inheritance");
  });

  it("group_member → /app/groups", () => {
    rolesWith({ kind: "group_member", groupId: 3, groupName: "Friends", createdAt: "" });
    const { container } = render(withRouter(<MyRolesPanel />));
    expect(container.querySelector("a")!.getAttribute("href")).toBe("/app/groups");
  });

  it("invoice_pending → /app/business", () => {
    rolesWith({ kind: "invoice_pending", invoiceId: 9, vendor: ALICE, description: "x", createdAt: "" });
    const { container } = render(withRouter(<MyRolesPanel />));
    expect(container.querySelector("a")!.getAttribute("href")).toBe("/app/business");
  });

  it("request_pending → /app/requests", () => {
    rolesWith({ kind: "request_pending", requestId: 7, requester: ALICE, note: "x", createdAt: "" });
    const { container } = render(withRouter(<MyRolesPanel />));
    expect(container.querySelector("a")!.getAttribute("href")).toBe("/app/requests");
  });
});

describe("MyRolesPanel — markAllSeen button (§15.x)", () => {
  it("button hidden when unreadCount=0 even when there are roles", () => {
    useMyRolesMock.mockReturnValue({
      roles: [{ kind: "heir", principal: ALICE, createdAt: "" }],
      unreadCount: 0,
      loading: false,
      markAllSeen: vi.fn(),
      markSeen: vi.fn(),
      refetch: vi.fn(),
    });
    const { queryByRole } = render(withRouter(<MyRolesPanel />));
    expect(queryByRole("button", { name: /mark all/i })).toBeNull();
  });

  it("button visible when unreadCount > 0", () => {
    useMyRolesMock.mockReturnValue({
      roles: [{ kind: "heir", principal: ALICE, createdAt: "" }],
      unreadCount: 1,
      loading: false,
      markAllSeen: vi.fn(),
      markSeen: vi.fn(),
      refetch: vi.fn(),
    });
    const { getByRole } = render(withRouter(<MyRolesPanel />));
    expect(getByRole("button", { name: /mark all/i })).not.toBeNull();
  });

  it("hidden when hideMarkAll prop is true (inline-rendered case)", () => {
    useMyRolesMock.mockReturnValue({
      roles: [{ kind: "heir", principal: ALICE, createdAt: "" }],
      unreadCount: 1,
      loading: false,
      markAllSeen: vi.fn(),
      markSeen: vi.fn(),
      refetch: vi.fn(),
    });
    const { queryByRole } = render(withRouter(<MyRolesPanel hideMarkAll />));
    expect(queryByRole("button", { name: /mark all/i })).toBeNull();
  });

  it("clicking the button calls markAllSeen", () => {
    const markAllSeen = vi.fn();
    useMyRolesMock.mockReturnValue({
      roles: [{ kind: "heir", principal: ALICE, createdAt: "" }],
      unreadCount: 1,
      loading: false,
      markAllSeen,
      markSeen: vi.fn(),
      refetch: vi.fn(),
    });
    const { getByRole } = render(withRouter(<MyRolesPanel />));
    fireEvent.click(getByRole("button", { name: /mark all/i }));
    expect(markAllSeen).toHaveBeenCalledTimes(1);
  });
});

describe("MyRolesPanel — row click (§15.x)", () => {
  it("clicking a role link calls markSeen with the role + onNavigate prop", () => {
    const role = { kind: "heir" as const, principal: ALICE, createdAt: "" };
    const markSeen = vi.fn();
    const onNavigate = vi.fn();
    useMyRolesMock.mockReturnValue({
      roles: [role],
      unreadCount: 1,
      loading: false,
      markAllSeen: vi.fn(),
      markSeen,
      refetch: vi.fn(),
    });
    const { container } = render(withRouter(<MyRolesPanel onNavigate={onNavigate} />));
    const link = container.querySelector("a")!;
    fireEvent.click(link);
    expect(markSeen).toHaveBeenCalledWith(role);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("works without onNavigate prop (optional callback)", () => {
    const role = { kind: "heir" as const, principal: ALICE, createdAt: "" };
    const markSeen = vi.fn();
    useMyRolesMock.mockReturnValue({
      roles: [role],
      unreadCount: 1,
      loading: false,
      markAllSeen: vi.fn(),
      markSeen,
      refetch: vi.fn(),
    });
    const { container } = render(withRouter(<MyRolesPanel />));
    const link = container.querySelector("a")!;
    expect(() => fireEvent.click(link)).not.toThrow();
    expect(markSeen).toHaveBeenCalledTimes(1);
  });
});
