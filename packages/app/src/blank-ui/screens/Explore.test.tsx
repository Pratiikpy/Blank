import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

// §15.x test for Explore screen. The static feature-catalog page
// that surfaces every app feature in 4 themed sections. Each tile
// is a route shortcut, so the test acts as a route-mapping smoke
// check: a refactor that renames /app/groups to /app/group OR
// re-targets Privacy Controls to a different screen is caught
// here before the user clicks a dead tile.
//
// Also pins:
//   - 4 section headings in a specific order
//   - 12 distinct tile titles
//   - the intentional /app/profile dual-mapping (Privacy Controls
//     + Export Statements both point there in this build, since
//     CSV export is a Privacy/Settings concern). A refactor that
//     splits them into separate routes would break the test, which
//     is exactly when the route table needs human review.

const useNavigateMock = vi.hoisted(() => vi.fn());

vi.mock("react-router-dom", () => ({
  useNavigate: () => useNavigateMock,
}));

import Explore from "./Explore";

beforeEach(() => {
  useNavigateMock.mockReset();
});

describe("Explore — page chrome (§15.x)", () => {
  it("renders 'Explore' heading + 'Discover all BlankPay features' subtitle", () => {
    const { container } = render(<Explore />);
    expect(container.textContent).toContain("Explore");
    expect(container.textContent).toContain("Discover all BlankPay features");
  });

  it("renders 4 section headings in order: PAYMENTS / SOCIAL / ADVANCED / SECURITY", () => {
    const { container } = render(<Explore />);
    const text = container.textContent ?? "";
    const positions: Array<[string, number]> = [
      ["PAYMENTS", text.indexOf("PAYMENTS")],
      ["SOCIAL", text.indexOf("SOCIAL")],
      ["ADVANCED", text.indexOf("ADVANCED")],
      ["SECURITY", text.indexOf("SECURITY")],
    ];
    // All 4 present.
    for (const [, idx] of positions) {
      expect(idx).toBeGreaterThan(-1);
    }
    // Strictly increasing order.
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i][1]).toBeGreaterThan(positions[i - 1][1]);
    }
  });
});

describe("Explore — tile -> route mapping (§15.x)", () => {
  const routeTable: Array<[string, string]> = [
    // PAYMENTS
    ["Send Money", "/app/send"],
    ["Receive Money", "/app/receive"],
    ["Payment Requests", "/app/requests"],
    // SOCIAL
    ["Group Splits", "/app/groups"],
    ["Gift Envelopes", "/app/gifts"],
    ["Creator Support", "/app/creators"],
    // ADVANCED
    ["Stealth Payments", "/app/stealth"],
    ["P2P Exchange", "/app/swap"],
    ["Business Tools", "/app/business"],
    // SECURITY
    ["Beneficiary Planning", "/app/inheritance"],
    ["Privacy Controls", "/app/profile"],
    ["Export Statements", "/app/profile"],
  ];

  for (const [title, route] of routeTable) {
    it(`'${title}' tile click navigates to ${route}`, () => {
      const { getByText } = render(<Explore />);
      fireEvent.click(getByText(title));
      expect(useNavigateMock).toHaveBeenCalledWith(route);
    });
  }

  it("renders all 12 distinct tile titles", () => {
    const { container } = render(<Explore />);
    const text = container.textContent ?? "";
    for (const [title] of routeTable) {
      expect(text).toContain(title);
    }
  });

  it("CRITICAL: Privacy Controls AND Export Statements both target /app/profile (dual-mapping intentional)", () => {
    const { getByText } = render(<Explore />);
    fireEvent.click(getByText("Privacy Controls"));
    expect(useNavigateMock).toHaveBeenLastCalledWith("/app/profile");

    useNavigateMock.mockClear();
    fireEvent.click(getByText("Export Statements"));
    expect(useNavigateMock).toHaveBeenLastCalledWith("/app/profile");
  });
});

describe("Explore — tile subtitles (positioning copy) (§15.x)", () => {
  it("Send Money subtitle names FHE-encrypted P2P (positions the feature as encrypted-by-default)", () => {
    const { container } = render(<Explore />);
    expect(container.textContent).toContain("FHE-encrypted P2P payments");
  });

  it("Group Splits subtitle pins the 'encrypted amounts' framing", () => {
    const { container } = render(<Explore />);
    expect(container.textContent).toContain("Split bills with encrypted amounts");
  });

  it("Stealth Payments subtitle uses 'Anonymous claim codes' framing", () => {
    const { container } = render(<Explore />);
    expect(container.textContent).toContain("Anonymous claim codes");
  });

  it("Beneficiary Planning subtitle frames as 'Automatic fund transfer to trusted contacts'", () => {
    const { container } = render(<Explore />);
    expect(container.textContent).toContain("Automatic fund transfer to trusted contacts");
  });

  it("Privacy Controls subtitle: 'Manage permits and sharing'", () => {
    const { container } = render(<Explore />);
    expect(container.textContent).toContain("Manage permits and sharing");
  });
});

describe("Explore — section composition (§15.x)", () => {
  it("PAYMENTS section contains exactly 3 tiles: Send / Receive / Requests", () => {
    const { container } = render(<Explore />);
    const text = container.textContent ?? "";
    const paymentsIdx = text.indexOf("PAYMENTS");
    const socialIdx = text.indexOf("SOCIAL");
    const paymentsSection = text.slice(paymentsIdx, socialIdx);
    expect(paymentsSection).toContain("Send Money");
    expect(paymentsSection).toContain("Receive Money");
    expect(paymentsSection).toContain("Payment Requests");
    // Not in this section
    expect(paymentsSection).not.toContain("Stealth Payments");
    expect(paymentsSection).not.toContain("Group Splits");
  });

  it("SECURITY section contains Beneficiary / Privacy / Export (NOT Stealth which lives in ADVANCED)", () => {
    const { container } = render(<Explore />);
    const text = container.textContent ?? "";
    const securityIdx = text.indexOf("SECURITY");
    const securitySection = text.slice(securityIdx);
    expect(securitySection).toContain("Beneficiary Planning");
    expect(securitySection).toContain("Privacy Controls");
    expect(securitySection).toContain("Export Statements");
    expect(securitySection).not.toContain("Stealth Payments");
  });

  it("ADVANCED section: Stealth + P2P Exchange + Business Tools", () => {
    const { container } = render(<Explore />);
    const text = container.textContent ?? "";
    const advancedIdx = text.indexOf("ADVANCED");
    const securityIdx = text.indexOf("SECURITY");
    const advancedSection = text.slice(advancedIdx, securityIdx);
    expect(advancedSection).toContain("Stealth Payments");
    expect(advancedSection).toContain("P2P Exchange");
    expect(advancedSection).toContain("Business Tools");
  });
});

describe("Explore — tile shape (§15.x)", () => {
  it("every tile is a button (keyboard + screen-reader accessible)", () => {
    const { container } = render(<Explore />);
    const buttons = container.querySelectorAll("button");
    // 12 tile buttons (no other buttons on this screen).
    expect(buttons.length).toBe(12);
  });

  it("each tile has a ChevronRight indicator (visual affordance for navigation)", () => {
    const { container } = render(<Explore />);
    // Every button contains a lucide-chevron-right via class "lucide-chevron-right".
    const chevrons = container.querySelectorAll(".lucide-chevron-right");
    expect(chevrons.length).toBe(12);
  });
});
