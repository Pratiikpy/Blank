import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Home, Send, Inbox } from "lucide-react";

// §15.x test for DesktopSidebar. The blank-ui desktop nav rail
// with logo + privacy toggle + workspace-mode-filtered nav items
// (from nav-registry) + ChainSelector + theme toggle + FHE status
// pill. Different from the older src/components/layout/Sidebar
// in that the nav items are pulled from a registry filtered by
// the active workspace mode (personal / business) rather than
// hardcoded sections.
//
// CRITICAL pins:
//   - Nav items pulled from desktopSidebarItems(mode) registry
//     so adding / renaming routes happens in lib/nav-registry.ts
//     NOT in this component; test pins by mocking the registry
//     to return controlled fixtures and asserting the rendered
//     buttons match.
//   - isActive logic 2-branch: path === '/app' uses STRICT
//     equality (location.pathname === '/app'); other paths use
//     startsWith() so '/app/send' AND '/app/send/confirm' both
//     activate the Send item. The strict-equality for '/app' is
//     load-bearing because a startsWith would mark '/app' as
//     active for EVERY sub-route, leaving the Dashboard item
//     permanently highlighted.
//   - aria-current='page' on the active button + undefined on
//     others (NOT 'false' — see Sidebar.test for rationale);
//     screen readers announce the current page only via
//     attribute presence.
//   - Privacy toggle pulls from usePrivacyMode(): label flips
//     'Privacy Mode' vs 'Public Mode' + bg color flips emerald
//     vs tertiary + thumb translate-x flips between 22px and
//     0.5px; aria-label flips 'Disable privacy mode' vs 'Enable
//     privacy mode'; click calls toggle() from the provider.
//   - Dark mode toggle: localStorage key 'blank_dark_mode';
//     boolean toggle that persists across reloads + applies /
//     removes the 'dark' class on document.documentElement;
//     icon flips Moon -> Sun + label flips 'Dark Mode' -> 'Light
//     Mode'; useEffect on mount re-applies saved preference
//     (only fires once via empty-deps + eslint-disable so a re-
//     render doesn't keep re-adding the class).
//   - On-mount dark mode application from localStorage: if
//     'blank_dark_mode' === 'true' at mount time, document.
//     documentElement gets the 'dark' class added; this matters
//     because the useState initializer reads localStorage
//     SYNCHRONOUSLY so the initial state is correct, but the
//     class isn't added until the mount-effect fires.
//   - ChainSelector + BlankLogo + FHE Active status pill all
//     rendered as sibling components in the footer; test pins
//     their PRESENCE (not behavior — those are tested separately
//     in their own test files) so a regression that dropped them
//     from the layout gets caught.

const usePrivacyModeMock = vi.hoisted(() => vi.fn());
const useWorkspaceModeMock = vi.hoisted(() => vi.fn());
const desktopSidebarItemsMock = vi.hoisted(() => vi.fn());
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
vi.mock("@/providers/PrivacyModeProvider", () => ({
  usePrivacyMode: usePrivacyModeMock,
}));
vi.mock("@/providers/WorkspaceModeProvider", () => ({
  useWorkspaceMode: useWorkspaceModeMock,
}));
vi.mock("@/lib/nav-registry", () => ({
  desktopSidebarItems: desktopSidebarItemsMock,
}));
vi.mock("./ChainSelector", () => ({
  ChainSelector: () => <div data-testid="chain-selector-stub">Chain</div>,
}));
vi.mock("@/blank-ui/landing/BlankLogo", () => ({
  BlankLogo: () => <div data-testid="blank-logo-stub">Logo</div>,
}));
vi.mock("@/blank-ui/landing/landing.css", () => ({}));
vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string").join(" "),
}));

import { DesktopSidebar } from "./DesktopSidebar";

const togglePrivacyMock = vi.fn();

const NAV_ITEMS = [
  { path: "/app", label: "Dashboard", icon: Home },
  { path: "/app/send", label: "Send", icon: Send },
  { path: "/app/activity", label: "Activity", icon: Inbox },
];

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <DesktopSidebar />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  usePrivacyModeMock.mockReset();
  useWorkspaceModeMock.mockReset();
  desktopSidebarItemsMock.mockReset();
  navigateMock.mockReset();
  togglePrivacyMock.mockReset();

  usePrivacyModeMock.mockReturnValue({
    privacyMode: false,
    toggle: togglePrivacyMock,
  });
  useWorkspaceModeMock.mockReturnValue({ mode: "personal" });
  desktopSidebarItemsMock.mockReturnValue(NAV_ITEMS);

  // Clear localStorage between tests so dark-mode state doesn't leak
  try { localStorage.clear(); } catch { /* noop */ }
  // Reset document classList
  document.documentElement.classList.remove("dark");
});

// ───────────────────────────────────────────────────────────
//  Layout primitives
// ───────────────────────────────────────────────────────────

describe("DesktopSidebar — layout primitives (§15.x)", () => {
  it("renders BlankLogo + ChainSelector + FHE Active status pill", () => {
    renderAt("/app");
    expect(screen.getByTestId("blank-logo-stub")).toBeInTheDocument();
    expect(screen.getByTestId("chain-selector-stub")).toBeInTheDocument();
    expect(screen.getByText("FHE Active")).toBeInTheDocument();
  });

  it("renders nav items from desktopSidebarItems(mode)", () => {
    renderAt("/app");
    expect(screen.getByRole("button", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Activity" })).toBeInTheDocument();
  });

  it("desktopSidebarItems called with the active workspace mode", () => {
    useWorkspaceModeMock.mockReturnValue({ mode: "business" });
    renderAt("/app");
    expect(desktopSidebarItemsMock).toHaveBeenCalledWith("business");
  });
});

// ───────────────────────────────────────────────────────────
//  isActive 2-branch logic
// ───────────────────────────────────────────────────────────

describe("DesktopSidebar — isActive logic (§15.x)", () => {
  it("at '/app' -> Dashboard active (strict equality, NOT startsWith)", () => {
    renderAt("/app");
    const dashboard = screen.getByRole("button", { name: "Dashboard" });
    expect(dashboard.getAttribute("aria-current")).toBe("page");
  });

  it("at '/app/send' -> Send active, Dashboard NOT active (strict-equality guard)", () => {
    renderAt("/app/send");
    expect(
      screen.getByRole("button", { name: "Send" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen.getByRole("button", { name: "Dashboard" }).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("at '/app/send/confirm' (deep sub-route) -> Send still active (startsWith match)", () => {
    renderAt("/app/send/confirm");
    expect(
      screen.getByRole("button", { name: "Send" }).getAttribute("aria-current"),
    ).toBe("page");
  });

  it("at unknown path -> no item active", () => {
    renderAt("/nonexistent");
    const allNavButtons = NAV_ITEMS.map((item) =>
      screen.getByRole("button", { name: item.label }),
    );
    for (const btn of allNavButtons) {
      expect(btn.getAttribute("aria-current")).toBeNull();
    }
  });

  it("click nav item -> navigate(item.path)", () => {
    renderAt("/app");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(navigateMock).toHaveBeenCalledWith("/app/send");
  });
});

// ───────────────────────────────────────────────────────────
//  Privacy toggle
// ───────────────────────────────────────────────────────────

describe("DesktopSidebar — privacy toggle (§15.x)", () => {
  it("privacyMode=false -> 'Public Mode' label + 'Enable privacy mode' aria-label", () => {
    usePrivacyModeMock.mockReturnValue({
      privacyMode: false,
      toggle: togglePrivacyMock,
    });
    renderAt("/app");
    expect(screen.getByText("Public Mode")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Enable privacy mode"),
    ).toBeInTheDocument();
  });

  it("privacyMode=true -> 'Privacy Mode' label + 'Disable privacy mode' aria-label", () => {
    usePrivacyModeMock.mockReturnValue({
      privacyMode: true,
      toggle: togglePrivacyMock,
    });
    renderAt("/app");
    expect(screen.getByText("Privacy Mode")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Disable privacy mode"),
    ).toBeInTheDocument();
  });

  it("click privacy toggle -> calls toggle() from the provider", () => {
    renderAt("/app");
    fireEvent.click(screen.getByLabelText("Enable privacy mode"));
    expect(togglePrivacyMock).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────────────────────────────────────────
//  Dark mode toggle + persistence
// ───────────────────────────────────────────────────────────

describe("DesktopSidebar — dark mode toggle (§15.x)", () => {
  it("default (no localStorage) -> Moon icon + 'Dark Mode' label", () => {
    renderAt("/app");
    expect(screen.getByLabelText("Switch to dark mode")).toBeInTheDocument();
    expect(screen.getByText("Dark Mode")).toBeInTheDocument();
  });

  it("localStorage 'blank_dark_mode'='true' at mount -> 'Light Mode' label + 'dark' class on documentElement", () => {
    localStorage.setItem("blank_dark_mode", "true");
    renderAt("/app");
    expect(screen.getByText("Light Mode")).toBeInTheDocument();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("click toggle from light -> dark: localStorage updates + class added", () => {
    renderAt("/app");
    fireEvent.click(screen.getByLabelText("Switch to dark mode"));
    expect(localStorage.getItem("blank_dark_mode")).toBe("true");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByText("Light Mode")).toBeInTheDocument();
  });

  it("click toggle from dark -> light: localStorage updates + class removed", () => {
    localStorage.setItem("blank_dark_mode", "true");
    renderAt("/app");
    fireEvent.click(screen.getByLabelText("Switch to light mode"));
    expect(localStorage.getItem("blank_dark_mode")).toBe("false");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(screen.getByText("Dark Mode")).toBeInTheDocument();
  });

  it("on-mount effect applies dark class ONCE (doesn't re-add on re-render)", () => {
    localStorage.setItem("blank_dark_mode", "true");
    const { rerender } = renderAt("/app");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    // Manually remove the class to simulate it being cleared by another mechanism
    document.documentElement.classList.remove("dark");
    rerender(
      <MemoryRouter initialEntries={["/app"]}>
        <DesktopSidebar />
      </MemoryRouter>,
    );
    // The empty-deps effect should NOT re-add the class on re-render
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────
//  Empty / dynamic nav items
// ───────────────────────────────────────────────────────────

describe("DesktopSidebar — dynamic nav items from registry (§15.x)", () => {
  it("empty nav items from registry -> renders no nav buttons (graceful)", () => {
    desktopSidebarItemsMock.mockReturnValue([]);
    renderAt("/app");
    // Privacy + theme toggle buttons still render; nav buttons are absent
    expect(screen.queryByRole("button", { name: "Dashboard" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("workspace mode change -> nav re-fetches via registry (test fixture differs)", () => {
    useWorkspaceModeMock.mockReturnValue({ mode: "personal" });
    desktopSidebarItemsMock.mockImplementation((mode: string) =>
      mode === "personal"
        ? [{ path: "/app", label: "Personal", icon: Home }]
        : [{ path: "/app/biz", label: "Business", icon: Send }],
    );
    const { rerender } = renderAt("/app");
    expect(
      screen.getByRole("button", { name: "Personal" }),
    ).toBeInTheDocument();
    // Switch workspace mode
    useWorkspaceModeMock.mockReturnValue({ mode: "business" });
    rerender(
      <MemoryRouter initialEntries={["/app"]}>
        <DesktopSidebar />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole("button", { name: "Business" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Personal" })).toBeNull();
  });
});
