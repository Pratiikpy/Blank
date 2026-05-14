import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// §15.x test for ConnectionHealthBanner. Audit Top-28 #21 + #22
// surface for RPC + Supabase-realtime degradation. The banner
// only renders when at least one connection is degraded — it's
// intentionally narrow, replacing in-screen toasts with a
// persistent banner so users with stale balances or stale
// activity feeds see the cause at a glance instead of guessing
// 'is this broken? am I refreshing it wrong?'.
//
// CRITICAL pins:
//   - Hidden when BOTH connections healthy (rpcDegraded=false
//     AND realtimeDegraded=false) -> returns null; test pins via
//     queryByRole('status') === null so a stale banner can't
//     occupy layout space when there's nothing to report.
//   - 3 visible-state copy variants: both-degraded ->
//     'Connection issues. Balances and live updates may be
//     stale. Retrying…'; rpc-only -> 'RPC connection unstable.
//     On-chain reads may be stale. Retrying…'; realtime-only ->
//     'Live updates paused. Try refreshing if your activity
//     feed looks stale.'. Test pins each copy literally because
//     the messages are user-facing and PR-C audit specifically
//     called out the wording.
//   - Icon variant: rpcDegraded -> WifiOff (signals network
//     loss); rpc-OK + realtime-degraded -> AlertTriangle
//     (signals 'attention but not network'); the both-degraded
//     case shows WifiOff because rpcDegraded is checked FIRST
//     in the ternary (rpcDegraded outranks realtimeDegraded
//     for the icon choice).
//   - role='status' + aria-live='polite' so screen-readers
//     announce the banner asynchronously when it appears WITHOUT
//     interrupting the user's current focus (assertive would
//     cut off whatever they're hearing).
//   - Amber color palette across all 3 visible states (NOT red
//     for both, NOT green/yellow gradient) — both rpc-only and
//     realtime-only use the same warning-not-error visual weight
//     because the user CAN still operate the app (writes go
//     through the relayer, reads come back eventually); a regression
//     that escalated to red would suggest the app is broken
//     when it isn't.

const useConnectionHealthMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useConnectionHealth", () => ({
  useConnectionHealth: useConnectionHealthMock,
}));

import { ConnectionHealthBanner } from "./ConnectionHealthBanner";

beforeEach(() => {
  useConnectionHealthMock.mockReset();
});

// ───────────────────────────────────────────────────────────
//  Hidden state (both healthy)
// ───────────────────────────────────────────────────────────

describe("ConnectionHealthBanner — hidden state (§15.x)", () => {
  it("rpc + realtime both healthy -> renders null", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: false,
      realtimeDegraded: false,
    });
    const { container } = render(<ConnectionHealthBanner />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  3 visible-state copy variants
// ───────────────────────────────────────────────────────────

describe("ConnectionHealthBanner — copy variants (§15.x)", () => {
  it("both degraded -> 'Connection issues. Balances and live updates may be stale. Retrying…' copy", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: true,
      realtimeDegraded: true,
    });
    render(<ConnectionHealthBanner />);
    expect(
      screen.getByText(
        "Connection issues. Balances and live updates may be stale. Retrying…",
      ),
    ).toBeInTheDocument();
  });

  it("rpc-only degraded -> 'RPC connection unstable. On-chain reads may be stale. Retrying…' copy", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: true,
      realtimeDegraded: false,
    });
    render(<ConnectionHealthBanner />);
    expect(
      screen.getByText(
        "RPC connection unstable. On-chain reads may be stale. Retrying…",
      ),
    ).toBeInTheDocument();
  });

  it("realtime-only degraded -> 'Live updates paused. Try refreshing if your activity feed looks stale.' copy", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: false,
      realtimeDegraded: true,
    });
    render(<ConnectionHealthBanner />);
    expect(
      screen.getByText(
        "Live updates paused. Try refreshing if your activity feed looks stale.",
      ),
    ).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  Icon variant (rpc-first ternary)
// ───────────────────────────────────────────────────────────

describe("ConnectionHealthBanner — icon variant (§15.x)", () => {
  function getIconName(banner: HTMLElement): string | null {
    const svg = banner.querySelector("svg");
    if (!svg) return null;
    const cls = svg.getAttribute("class") || "";
    // lucide-react has renamed some icons over versions (AlertTriangle ->
    // TriangleAlert), so check for either form. WifiOff is stable.
    if (cls.includes("wifi-off")) return "WifiOff";
    if (cls.includes("alert-triangle") || cls.includes("triangle-alert"))
      return "AlertTriangle";
    return null;
  }

  it("rpc-degraded -> WifiOff icon", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: true,
      realtimeDegraded: false,
    });
    render(<ConnectionHealthBanner />);
    const banner = screen.getByRole("status");
    expect(getIconName(banner)).toBe("WifiOff");
  });

  it("realtime-only degraded -> AlertTriangle icon (NOT WifiOff)", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: false,
      realtimeDegraded: true,
    });
    render(<ConnectionHealthBanner />);
    const banner = screen.getByRole("status");
    expect(getIconName(banner)).toBe("AlertTriangle");
  });

  it("both degraded -> WifiOff (rpcDegraded outranks realtimeDegraded in icon ternary)", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: true,
      realtimeDegraded: true,
    });
    render(<ConnectionHealthBanner />);
    const banner = screen.getByRole("status");
    expect(getIconName(banner)).toBe("WifiOff");
  });
});

// ───────────────────────────────────────────────────────────
//  Accessibility primitives
// ───────────────────────────────────────────────────────────

describe("ConnectionHealthBanner — accessibility (§15.x)", () => {
  it("role='status' for screen-reader announcement", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: true,
      realtimeDegraded: false,
    });
    render(<ConnectionHealthBanner />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("aria-live='polite' so announcement waits for user to pause", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: false,
      realtimeDegraded: true,
    });
    render(<ConnectionHealthBanner />);
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });
});

// ───────────────────────────────────────────────────────────
//  Color palette (amber across all states)
// ───────────────────────────────────────────────────────────

describe("ConnectionHealthBanner — amber palette (§15.x)", () => {
  it("rpc-only -> amber border + amber bg + amber text", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: true,
      realtimeDegraded: false,
    });
    render(<ConnectionHealthBanner />);
    const banner = screen.getByRole("status");
    expect(banner.className).toContain("border-amber-300/60");
    expect(banner.className).toContain("bg-amber-50");
    expect(banner.className).toContain("text-amber-900");
  });

  it("realtime-only uses SAME amber palette (warning-not-error visual weight)", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: false,
      realtimeDegraded: true,
    });
    render(<ConnectionHealthBanner />);
    const banner = screen.getByRole("status");
    expect(banner.className).toContain("border-amber-300/60");
    expect(banner.className).toContain("bg-amber-50");
  });

  it("both-degraded uses SAME amber palette (NOT escalated to red)", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: true,
      realtimeDegraded: true,
    });
    render(<ConnectionHealthBanner />);
    const banner = screen.getByRole("status");
    expect(banner.className).not.toContain("bg-red");
    expect(banner.className).toContain("bg-amber-50");
  });
});
