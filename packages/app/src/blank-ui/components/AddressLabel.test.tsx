import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// §15.x test for AddressLabel. The address-display primitive
// used across the activity feed, contacts list, invoice rows,
// stealth inbox, etc. — anywhere a 0x address shows in the UI.
// 4-level fallback chain: (1) resolved ENS / Basenames name ->
// (2) caller-provided fallback (e.g. local contact nickname) ->
// (3) truncated 0x... form (with font-mono if mono=true) ->
// (4) literal '—' for null/undefined inputs. Cached for 5min
// via React Query so re-rendering lists doesn't re-hit RPC.
//
// CRITICAL pins:
//   - address null/undefined/empty -> renders literal '—'
//     (em-dash character) with className passthrough but NO
//     useLookupName side effect (the early return happens
//     BEFORE the lookup-result check); the hook IS called (it's
//     a top-level hook so can't be conditional) but with `null`
//     when address is invalid so the query stays disabled.
//   - ENS name resolves -> renders the ENS name verbatim
//     (no truncation); the className passes through but mono
//     class is NOT applied (ENS names are not monospace
//     candidates).
//   - ENS lookup returns null/undefined AND fallback prop is
//     set -> renders the fallback string; mono class NOT
//     applied to fallback (it's typically a contact nickname).
//   - ENS lookup empty AND no fallback -> renders truncated
//     0x... form via truncateAddress() helper; mono class
//     IS applied when mono=true (default); invalid address
//     (e.g. 'not-an-address') skips truncation and renders
//     verbatim.
//   - mono prop default is TRUE so the truncated 0x form looks
//     like a hex string; callers can override to false for
//     mixed-content rows.
//   - isAddress() guard catches malformed addresses BEFORE
//     calling useLookupName with them — the hook gets null
//     instead of the bad string, which keeps the wagmi query
//     from firing a bad RPC call.
//   - className passthrough on every render path (4 branches)
//     so the parent's layout / typography styling applies
//     consistently regardless of which fallback level renders.

const useLookupNameMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useAddressResolver", () => ({
  useLookupName: useLookupNameMock,
}));
vi.mock("@/lib/address", () => ({
  truncateAddress: (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`,
}));
vi.mock("@/lib/cn", () => ({
  cn: (...args: unknown[]) =>
    args.filter((a) => typeof a === "string" && a.length > 0).join(" "),
}));

import { AddressLabel } from "./AddressLabel";

const VALID = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const VALID2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;

beforeEach(() => {
  useLookupNameMock.mockReset();
  useLookupNameMock.mockReturnValue({ data: undefined });
});

// ───────────────────────────────────────────────────────────
//  Null / undefined / empty address (level 4 fallback)
// ───────────────────────────────────────────────────────────

describe("AddressLabel — null/empty address (§15.x)", () => {
  it("address=null -> renders '—' (em-dash)", () => {
    render(<AddressLabel address={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("address=undefined -> renders '—'", () => {
    render(<AddressLabel address={undefined} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("address='' (empty string) -> renders '—'", () => {
    render(<AddressLabel address="" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("null address -> className passthrough applied to the '—' span", () => {
    const { container } = render(
      <AddressLabel address={null} className="custom-cls" />,
    );
    const span = container.querySelector("span");
    expect(span!.className).toContain("custom-cls");
    expect(span!.textContent).toBe("—");
  });

  it("invalid address -> useLookupName called with null (NOT the invalid string)", () => {
    render(<AddressLabel address="not-an-address" />);
    expect(useLookupNameMock).toHaveBeenCalledWith(null);
  });
});

// ───────────────────────────────────────────────────────────
//  Level 1: resolved ENS name
// ───────────────────────────────────────────────────────────

describe("AddressLabel — level 1: ENS resolved (§15.x)", () => {
  it("ENS lookup returns name -> renders the name verbatim", () => {
    useLookupNameMock.mockReturnValue({ data: "vitalik.eth" });
    render(<AddressLabel address={VALID} />);
    expect(screen.getByText("vitalik.eth")).toBeInTheDocument();
  });

  it("ENS name renders WITHOUT mono class (names aren't monospace)", () => {
    useLookupNameMock.mockReturnValue({ data: "alice.eth" });
    const { container } = render(<AddressLabel address={VALID} />);
    const span = container.querySelector("span");
    expect(span!.className).not.toContain("font-mono");
  });

  it("ENS name renders WITH className passthrough", () => {
    useLookupNameMock.mockReturnValue({ data: "alice.eth" });
    const { container } = render(
      <AddressLabel address={VALID} className="custom-cls" />,
    );
    const span = container.querySelector("span");
    expect(span!.className).toContain("custom-cls");
  });

  it("ENS name takes priority over fallback prop (ENS wins)", () => {
    useLookupNameMock.mockReturnValue({ data: "alice.eth" });
    render(<AddressLabel address={VALID} fallback="My Contact" />);
    expect(screen.getByText("alice.eth")).toBeInTheDocument();
    expect(screen.queryByText("My Contact")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  Level 2: caller fallback (e.g. contact nickname)
// ───────────────────────────────────────────────────────────

describe("AddressLabel — level 2: caller fallback (§15.x)", () => {
  it("no ENS + fallback set -> renders fallback", () => {
    useLookupNameMock.mockReturnValue({ data: undefined });
    render(<AddressLabel address={VALID} fallback="Mom" />);
    expect(screen.getByText("Mom")).toBeInTheDocument();
  });

  it("ENS data=null -> falls through to fallback (null treated like missing)", () => {
    useLookupNameMock.mockReturnValue({ data: null });
    render(<AddressLabel address={VALID} fallback="Bob" />);
    expect(screen.getByText("Bob")).toBeInTheDocument();
  });

  it("fallback renders WITHOUT mono class (it's typically a name)", () => {
    useLookupNameMock.mockReturnValue({ data: undefined });
    const { container } = render(
      <AddressLabel address={VALID} fallback="Alice" />,
    );
    const span = container.querySelector("span");
    expect(span!.className).not.toContain("font-mono");
  });

  it("fallback renders WITH className passthrough", () => {
    useLookupNameMock.mockReturnValue({ data: undefined });
    const { container } = render(
      <AddressLabel address={VALID} fallback="Alice" className="custom-cls" />,
    );
    const span = container.querySelector("span");
    expect(span!.className).toContain("custom-cls");
  });
});

// ───────────────────────────────────────────────────────────
//  Level 3: truncated 0x... form
// ───────────────────────────────────────────────────────────

describe("AddressLabel — level 3: truncated 0x form (§15.x)", () => {
  it("valid address + no ENS + no fallback -> truncated via truncateAddress()", () => {
    useLookupNameMock.mockReturnValue({ data: undefined });
    render(<AddressLabel address={VALID} />);
    // mock returns first6...last4: '0xaaaa...aaaa'
    expect(screen.getByText("0xaaaa...aaaa")).toBeInTheDocument();
  });

  it("truncated form has font-mono class (default mono=true)", () => {
    useLookupNameMock.mockReturnValue({ data: undefined });
    const { container } = render(<AddressLabel address={VALID} />);
    const span = container.querySelector("span");
    expect(span!.className).toContain("font-mono");
  });

  it("mono=false -> truncated form WITHOUT font-mono class", () => {
    useLookupNameMock.mockReturnValue({ data: undefined });
    const { container } = render(<AddressLabel address={VALID} mono={false} />);
    const span = container.querySelector("span");
    expect(span!.className).not.toContain("font-mono");
  });

  it("invalid address (not hex) -> renders verbatim, NOT truncated", () => {
    useLookupNameMock.mockReturnValue({ data: undefined });
    render(<AddressLabel address="not-an-address" />);
    expect(screen.getByText("not-an-address")).toBeInTheDocument();
  });

  it("different addresses produce different truncations", () => {
    useLookupNameMock.mockReturnValue({ data: undefined });
    const { rerender } = render(<AddressLabel address={VALID} />);
    expect(screen.getByText("0xaaaa...aaaa")).toBeInTheDocument();
    rerender(<AddressLabel address={VALID2} />);
    expect(screen.getByText("0xbbbb...bbbb")).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  4-level fallback chain ordering
// ───────────────────────────────────────────────────────────

describe("AddressLabel — fallback chain ordering (§15.x)", () => {
  it("priority: ENS > fallback > truncated > '—'", () => {
    // (1) ENS wins when all 3 supplied
    useLookupNameMock.mockReturnValue({ data: "name.eth" });
    const { rerender } = render(
      <AddressLabel address={VALID} fallback="Contact" />,
    );
    expect(screen.getByText("name.eth")).toBeInTheDocument();

    // (2) Fallback wins when ENS missing
    useLookupNameMock.mockReturnValue({ data: undefined });
    rerender(<AddressLabel address={VALID} fallback="Contact" />);
    expect(screen.getByText("Contact")).toBeInTheDocument();

    // (3) Truncated wins when no ENS + no fallback
    rerender(<AddressLabel address={VALID} />);
    expect(screen.getByText("0xaaaa...aaaa")).toBeInTheDocument();

    // (4) Em-dash for null
    rerender(<AddressLabel address={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
