import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import React from "react";

// §15.x test for Onboarding screen. The user's first interaction
// with the app: a 4-step intro carousel + WalletChoiceCard on the
// final step. CRITICAL pins:
//
//   - 4 steps with distinct copy (Send privately / Only you see
//     amounts / Works everywhere / Your keys your money). Each
//     step's heading + subtitle is load-bearing marketing copy;
//     pin in place so a future polish pass cannot quietly water
//     down the privacy framing.
//   - per-address onboarding flag (audit #313 style): a shared
//     browser MUST NOT let User A's "saw the intro" flag skip
//     User B's onboarding. STORAGE_KEYS.onboardingComplete is
//     keyed by address.
//   - wallet-connect re-sync: a returning user with `seen=true`
//     who connects mid-flow gets jumped to the final step (so
//     they don't have to click through 4 dots again).
//   - auto-mark complete: reaching the final step + address set
//     writes the flag (defensive: even if user back-navigates
//     they don't re-trigger the carousel on reload).
//   - MetaMask download link tabnabbing guard
//   - Passkey modal open/close + success auto-close after 1.2s

const useAccountMock = vi.hoisted(() => vi.fn());
const useNavigateMock = vi.hoisted(() => vi.fn());
const getStoredStringMock = vi.hoisted(() => vi.fn());
const setStoredStringMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ useAccount: useAccountMock }));
vi.mock("react-router-dom", () => ({ useNavigate: () => useNavigateMock }));
vi.mock("@/lib/storage", () => ({
  STORAGE_KEYS: {
    onboardingComplete: (addr: string) => `blank_onboarding_complete_${addr.toLowerCase()}`,
  },
  getStoredString: getStoredStringMock,
  setStoredString: setStoredStringMock,
}));
vi.mock("framer-motion", () => ({
  motion: new Proxy({}, {
    get: (_t, prop: string) => {
      const Tag = prop as keyof React.JSX.IntrinsicElements;
      const Component = React.forwardRef<HTMLElement, Record<string, unknown>>(
        ({ children, ...rest }, ref) => {
          // Strip motion-specific props (initial/animate/exit/transition/etc.)
          const safeProps: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(rest)) {
            if (!/^(initial|animate|exit|transition|whileHover|whileTap|variants|layout|layoutId)$/.test(k)) {
              safeProps[k] = v;
            }
          }
          return React.createElement(Tag, { ...safeProps, ref }, children as React.ReactNode);
        },
      );
      Component.displayName = `motion.${prop}`;
      return Component;
    },
  }),
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/PasskeyCreationModal", () => ({
  PasskeyCreationModal: (props: { open: boolean; onClose: () => void; onSuccess: () => void }) => (
    <div data-testid="passkey-modal" data-open={props.open ? "true" : "false"}>
      <button data-testid="passkey-close" onClick={props.onClose}>close</button>
      <button data-testid="passkey-success" onClick={props.onSuccess}>success</button>
    </div>
  ),
}));
vi.mock("@/blank-ui/components", () => ({
  WalletChoiceCard: (props: { onSelectPasskey: () => void; onSelectBrowse: () => void }) => (
    <div data-testid="wallet-choice-card">
      <button data-testid="choice-passkey" onClick={props.onSelectPasskey}>Use passkey</button>
      <button data-testid="choice-browse" onClick={props.onSelectBrowse}>Browse without a wallet</button>
    </div>
  ),
}));

import Onboarding from "./Onboarding";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

beforeEach(() => {
  useAccountMock.mockReset();
  useNavigateMock.mockReset();
  getStoredStringMock.mockReset();
  setStoredStringMock.mockReset();

  useAccountMock.mockReturnValue({ address: undefined });
  getStoredStringMock.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Onboarding — step 1 default (§15.x)", () => {
  it("renders step 0: 'Send money privately' heading + privacy subtitle", () => {
    const { container } = render(<Onboarding />);
    expect(container.textContent).toContain("Send money privately");
    expect(container.textContent).toContain("Your payments are encrypted");
    expect(container.textContent).toContain("The amount stays private");
  });

  it("step 0: Back button HIDDEN (cannot go below 0)", () => {
    const { queryByText } = render(<Onboarding />);
    expect(queryByText("Back")).toBeNull();
  });

  it("step 0: Next button visible + WalletChoiceCard HIDDEN", () => {
    const { getByText, queryByTestId } = render(<Onboarding />);
    expect(getByText("Next")).toBeDefined();
    expect(queryByTestId("wallet-choice-card")).toBeNull();
  });

  it("4 progress dots rendered (one per step)", () => {
    const { container } = render(<Onboarding />);
    const dots = container.querySelectorAll("button[aria-label^='Go to step']");
    expect(dots.length).toBe(4);
  });
});

describe("Onboarding — step navigation (§15.x)", () => {
  it("clicking Next advances step 0 -> step 1 ('Only you see the amounts')", () => {
    const { getByText, container } = render(<Onboarding />);
    fireEvent.click(getByText("Next"));
    expect(container.textContent).toContain("Only you see the amounts");
    expect(container.textContent).toContain("encrypted on-chain");
  });

  it("step 2 reveals 'Works everywhere you go' copy (supported EVM testnets)", () => {
    const { getByText, container } = render(<Onboarding />);
    fireEvent.click(getByText("Next"));
    fireEvent.click(getByText("Next"));
    expect(container.textContent).toContain("Works everywhere you go");
    expect(container.textContent).toContain("supported EVM testnets");
  });

  it("step 3 (last) reveals 'Your keys. Your money.' copy", () => {
    const { getByText, container } = render(<Onboarding />);
    for (let i = 0; i < 3; i++) fireEvent.click(getByText("Next"));
    expect(container.textContent).toContain("Your keys. Your money");
    expect(container.textContent).toContain("Non-custodial and self-sovereign");
  });

  it("Back button appears on step 1+ and rewinds", () => {
    const { getByText, container } = render(<Onboarding />);
    fireEvent.click(getByText("Next"));
    expect(getByText("Back")).toBeDefined();
    fireEvent.click(getByText("Back"));
    expect(container.textContent).toContain("Send money privately");
  });

  it("Progress dot click jumps to that step directly (lets crypto-natives skip)", () => {
    const { container } = render(<Onboarding />);
    const dot3 = container.querySelector("button[aria-label='Go to step 4']") as HTMLButtonElement;
    fireEvent.click(dot3);
    expect(container.textContent).toContain("Your keys. Your money");
  });

  it("dot for current step has w-8 width (active marker), others have w-2", () => {
    const { container } = render(<Onboarding />);
    const dots = Array.from(container.querySelectorAll("button[aria-label^='Go to step']"));
    expect(dots[0].className).toContain("w-8");
    expect(dots[0].className).toContain("bg-gray-900");
    expect(dots[1].className).toContain("w-2");
    expect(dots[2].className).toContain("w-2");
    expect(dots[3].className).toContain("w-2");
  });
});

describe("Onboarding — last-step CTAs (§15.x)", () => {
  beforeEach(() => {
    // Pre-set step to last via dot click in each test below.
  });

  it("last step: Next button HIDDEN (no further steps)", () => {
    const { container, queryByText } = render(<Onboarding />);
    const dot4 = container.querySelector("button[aria-label='Go to step 4']") as HTMLButtonElement;
    fireEvent.click(dot4);
    expect(queryByText("Next")).toBeNull();
  });

  it("last step: WalletChoiceCard rendered with passkey + browse callbacks", () => {
    const { container, getByTestId } = render(<Onboarding />);
    const dot4 = container.querySelector("button[aria-label='Go to step 4']") as HTMLButtonElement;
    fireEvent.click(dot4);
    expect(getByTestId("wallet-choice-card")).toBeDefined();
    expect(getByTestId("choice-passkey")).toBeDefined();
    expect(getByTestId("choice-browse")).toBeDefined();
  });

  it("'Install MetaMask' link has tabnabbing guard (target + rel)", () => {
    const { container, getByText } = render(<Onboarding />);
    const dot4 = container.querySelector("button[aria-label='Go to step 4']") as HTMLButtonElement;
    fireEvent.click(dot4);
    const link = getByText("Install MetaMask") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://metamask.io/download/");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("'Browse without a wallet' click navigates to '/' (does NOT persist the choice)", () => {
    const { container, getByTestId } = render(<Onboarding />);
    const dot4 = container.querySelector("button[aria-label='Go to step 4']") as HTMLButtonElement;
    fireEvent.click(dot4);
    fireEvent.click(getByTestId("choice-browse"));
    expect(useNavigateMock).toHaveBeenCalledWith("/");
    // Browse choice MUST NOT set the onboarding-complete flag because
    // /app screens still need an address; user should be re-prompted.
    expect(setStoredStringMock).not.toHaveBeenCalled();
  });
});

describe("Onboarding — passkey modal flow (§15.x)", () => {
  it("modal closed by default", () => {
    const { getByTestId } = render(<Onboarding />);
    expect(getByTestId("passkey-modal").getAttribute("data-open")).toBe("false");
  });

  it("'Use passkey' click opens the passkey modal", () => {
    const { container, getByTestId } = render(<Onboarding />);
    const dot4 = container.querySelector("button[aria-label='Go to step 4']") as HTMLButtonElement;
    fireEvent.click(dot4);
    fireEvent.click(getByTestId("choice-passkey"));
    expect(getByTestId("passkey-modal").getAttribute("data-open")).toBe("true");
  });

  it("modal close button reflects state -> data-open='false'", () => {
    const { container, getByTestId } = render(<Onboarding />);
    const dot4 = container.querySelector("button[aria-label='Go to step 4']") as HTMLButtonElement;
    fireEvent.click(dot4);
    fireEvent.click(getByTestId("choice-passkey"));
    fireEvent.click(getByTestId("passkey-close"));
    expect(getByTestId("passkey-modal").getAttribute("data-open")).toBe("false");
  });

  it("passkey success triggers setTimeout(1200ms) -> modal closes after delay", async () => {
    vi.useFakeTimers();
    const { container, getByTestId } = render(<Onboarding />);
    const dot4 = container.querySelector("button[aria-label='Go to step 4']") as HTMLButtonElement;
    fireEvent.click(dot4);
    fireEvent.click(getByTestId("choice-passkey"));
    expect(getByTestId("passkey-modal").getAttribute("data-open")).toBe("true");
    fireEvent.click(getByTestId("passkey-success"));
    // Modal stays open briefly so user sees success state.
    expect(getByTestId("passkey-modal").getAttribute("data-open")).toBe("true");
    await act(async () => {
      vi.advanceTimersByTime(1200);
    });
    expect(getByTestId("passkey-modal").getAttribute("data-open")).toBe("false");
  });
});

describe("Onboarding — per-address onboarding flag (audit #313 style) (§15.x)", () => {
  it("pre-connect (address=undefined): always starts at step 0 regardless of localStorage", () => {
    useAccountMock.mockReturnValue({ address: undefined });
    getStoredStringMock.mockReturnValue("true"); // someone else's flag
    const { container } = render(<Onboarding />);
    expect(container.textContent).toContain("Send money privately");
  });

  it("connected + seen=null: starts at step 0", () => {
    useAccountMock.mockReturnValue({ address: ME });
    getStoredStringMock.mockReturnValue(null);
    const { container } = render(<Onboarding />);
    expect(container.textContent).toContain("Send money privately");
  });

  it("connected + seen='true': starts at LAST step (no re-onboarding)", () => {
    useAccountMock.mockReturnValue({ address: ME });
    getStoredStringMock.mockReturnValue("true");
    const { container, getByTestId } = render(<Onboarding />);
    expect(container.textContent).toContain("Your keys. Your money");
    expect(getByTestId("wallet-choice-card")).toBeDefined();
  });

  it("CRITICAL: getStoredString is keyed by address (not a global flag) — shared-browser guard", () => {
    useAccountMock.mockReturnValue({ address: ME });
    render(<Onboarding />);
    expect(getStoredStringMock).toHaveBeenCalledWith(`blank_onboarding_complete_${ME.toLowerCase()}`);
    // A DIFFERENT address must hit a DIFFERENT key.
    getStoredStringMock.mockClear();
    useAccountMock.mockReturnValue({ address: OTHER });
    render(<Onboarding />);
    expect(getStoredStringMock).toHaveBeenCalledWith(`blank_onboarding_complete_${OTHER.toLowerCase()}`);
    expect(getStoredStringMock).not.toHaveBeenCalledWith(`blank_onboarding_complete_${ME.toLowerCase()}`);
  });

  it("reaching the last step + address set: writes 'true' under per-address key", () => {
    useAccountMock.mockReturnValue({ address: ME });
    const { container } = render(<Onboarding />);
    const dot4 = container.querySelector("button[aria-label='Go to step 4']") as HTMLButtonElement;
    fireEvent.click(dot4);
    expect(setStoredStringMock).toHaveBeenCalledWith(
      `blank_onboarding_complete_${ME.toLowerCase()}`,
      "true",
    );
  });

  it("reaching the last step WITHOUT an address: does NOT write the flag (no anchor to scope it)", () => {
    useAccountMock.mockReturnValue({ address: undefined });
    const { container } = render(<Onboarding />);
    const dot4 = container.querySelector("button[aria-label='Go to step 4']") as HTMLButtonElement;
    fireEvent.click(dot4);
    expect(setStoredStringMock).not.toHaveBeenCalled();
  });
});

describe("Onboarding — wallet-connect re-sync (§15.x)", () => {
  it("returning user (seen=true) who connects mid-flow: jumps to last step", () => {
    useAccountMock.mockReturnValue({ address: undefined });
    getStoredStringMock.mockReturnValue(null);
    const { container, rerender } = render(<Onboarding />);
    // Start at step 0 pre-connect.
    expect(container.textContent).toContain("Send money privately");

    // Now wallet connects + getStoredString returns "true" (returning user).
    useAccountMock.mockReturnValue({ address: ME });
    getStoredStringMock.mockReturnValue("true");
    rerender(<Onboarding />);
    expect(container.textContent).toContain("Your keys. Your money");
  });

  it("returning user (seen=true) who connects ALREADY on last step: does not re-render or loop", () => {
    useAccountMock.mockReturnValue({ address: ME });
    getStoredStringMock.mockReturnValue("true");
    const { container } = render(<Onboarding />);
    expect(container.textContent).toContain("Your keys. Your money");
    // setStoredString fires once from the step-change effect; verify no infinite loop.
    expect(setStoredStringMock.mock.calls.length).toBeLessThan(5);
  });

  it("first-time connect (seen=null) does NOT skip ahead: stays on current step", () => {
    useAccountMock.mockReturnValue({ address: undefined });
    getStoredStringMock.mockReturnValue(null);
    const { container, rerender } = render(<Onboarding />);

    fireEvent.click(container.querySelector("button[aria-label='Go to step 2']") as HTMLButtonElement);
    expect(container.textContent).toContain("Only you see the amounts");

    useAccountMock.mockReturnValue({ address: ME });
    getStoredStringMock.mockReturnValue(null);
    rerender(<Onboarding />);
    expect(container.textContent).toContain("Only you see the amounts");
  });
});

describe("Onboarding — step copy invariants (§15.x)", () => {
  // The 4 step subtitles are load-bearing marketing/disclosure copy.
  // Pin in place so a future "polish pass" can't quietly water them
  // down or remove the privacy framing that drove the entire product.
  const expectedCopy: Array<{ heading: string; copyExcerpts: string[] }> = [
    { heading: "Send money privately", copyExcerpts: ["payments are encrypted", "Who you pay is visible", "The amount stays private"] },
    { heading: "Only you see the amounts", copyExcerpts: ["balances and transfers are encrypted on-chain", "Not even the blockchain"] },
    { heading: "Works everywhere you go", copyExcerpts: ["supported EVM testnets", "low testnet fees", "FHE encryption"] },
    { heading: "Your keys. Your money", copyExcerpts: ["Non-custodial", "self-sovereign", "what amount data you reveal"] },
  ];

  for (let i = 0; i < 4; i++) {
    it(`step ${i + 1} keeps its load-bearing copy ("${expectedCopy[i].heading}")`, () => {
      const { container } = render(<Onboarding />);
      const dot = container.querySelector(`button[aria-label='Go to step ${i + 1}']`) as HTMLButtonElement;
      fireEvent.click(dot);
      expect(container.textContent).toContain(expectedCopy[i].heading);
      for (const excerpt of expectedCopy[i].copyExcerpts) {
        expect(container.textContent).toContain(excerpt);
      }
    });
  }
});
