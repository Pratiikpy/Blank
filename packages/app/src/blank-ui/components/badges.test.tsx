import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// §15.x test for the 4 simple badge/label primitives in blank-ui:
// AddressLabel, StatusBadge, InvoiceStatusBadge, FHEBadge. Used
// across many screens. Pinning the label/icon/class mappings for
// each prevents silent regressions where a single status renders
// the wrong color or tooltip.

const useLookupNameMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useAddressResolver", () => ({
  useLookupName: useLookupNameMock,
}));

import { AddressLabel } from "./AddressLabel";
import { StatusBadge } from "./StatusBadge";
import { InvoiceStatusBadge } from "./InvoiceStatusBadge";
import { FHEBadge } from "./FHEBadge";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

beforeEach(() => {
  useLookupNameMock.mockReset();
  useLookupNameMock.mockReturnValue({ data: undefined });
});

describe("AddressLabel (§15.x)", () => {
  it("renders em-dash when address is null/undefined", () => {
    const { container } = render(<AddressLabel address={null} />);
    expect(container.textContent).toBe("—");
  });

  it("renders ENS name when reverse lookup resolves", () => {
    useLookupNameMock.mockReturnValue({ data: "alice.eth" });
    const { container } = render(<AddressLabel address={ALICE} />);
    expect(container.textContent).toBe("alice.eth");
  });

  it("falls back to fallback prop when ENS doesn't resolve", () => {
    useLookupNameMock.mockReturnValue({ data: undefined });
    const { container } = render(
      <AddressLabel address={ALICE} fallback="Alice (contact)" />,
    );
    expect(container.textContent).toBe("Alice (contact)");
  });

  it("falls back to truncated address when neither ENS nor fallback set", () => {
    useLookupNameMock.mockReturnValue({ data: undefined });
    const { container } = render(<AddressLabel address={ALICE} />);
    expect(container.textContent).toMatch(/^0x[a-fA-F0-9]{4}\.\.\.[a-fA-F0-9]{4}$/);
  });

  it("renders the raw input when address fails isAddress (no truncation)", () => {
    useLookupNameMock.mockReturnValue({ data: undefined });
    const { container } = render(<AddressLabel address="not-an-address" />);
    expect(container.textContent).toBe("not-an-address");
  });

  it("applies font-mono class when mono=true (default) + no ENS name", () => {
    const { container } = render(<AddressLabel address={ALICE} />);
    const span = container.querySelector("span")!;
    expect(span.className).toContain("font-mono");
  });

  it("does NOT apply font-mono when mono=false", () => {
    const { container } = render(<AddressLabel address={ALICE} mono={false} />);
    const span = container.querySelector("span")!;
    expect(span.className).not.toContain("font-mono");
  });

  it("ENS-resolved name does NOT inherit font-mono (preserves ENS visual identity)", () => {
    useLookupNameMock.mockReturnValue({ data: "alice.eth" });
    const { container } = render(<AddressLabel address={ALICE} mono={true} />);
    const span = container.querySelector("span")!;
    expect(span.className).not.toContain("font-mono");
  });
});

describe("StatusBadge (§15.x)", () => {
  it("renders correct label for each status enum value", () => {
    const cases = [
      ["confirmed", "Confirmed"],
      ["pending", "Pending"],
      ["unclaimed", "Unclaimed"],
      ["claimed", "Claimed"],
      ["active", "Active"],
    ] as const;
    for (const [status, label] of cases) {
      const { container } = render(<StatusBadge status={status} />);
      expect(container.textContent).toBe(label);
    }
  });

  it("applies the matching badge-<status> class for each status", () => {
    const cases = [
      ["confirmed", "badge-confirmed"],
      ["pending", "badge-pending"],
      ["unclaimed", "badge-unclaimed"],
      ["claimed", "badge-claimed"],
      ["active", "badge-active"],
    ] as const;
    for (const [status, cls] of cases) {
      const { container } = render(<StatusBadge status={status} />);
      const span = container.querySelector("span")!;
      expect(span.className).toContain(cls);
      expect(span.className).toContain("badge-status");
    }
  });

  it("merges custom className alongside built-ins", () => {
    const { container } = render(<StatusBadge status="active" className="custom-extra" />);
    const span = container.querySelector("span")!;
    expect(span.className).toContain("custom-extra");
    expect(span.className).toContain("badge-active");
  });
});

describe("InvoiceStatusBadge — on-chain enum mapping (§15.x)", () => {
  it("renders correct label for each enum value (0=Pending → 4=Disputed)", () => {
    const cases: Array<[number, string]> = [
      [0, "Awaiting payment"],
      [1, "Paid"],
      [2, "Cancelled / refunded"],
      [3, "Funded, awaiting finalize"],
      [4, "Disputed, refund pending"],
    ];
    for (const [status, label] of cases) {
      const { container, unmount } = render(<InvoiceStatusBadge status={status} />);
      const el = container.querySelector('[data-testid="invoice-status-badge"]')!;
      expect(el.textContent).toContain(label);
      expect(el.getAttribute("data-status")).toBe(String(status));
      unmount();
    }
  });

  it("falls back to status=0 (Pending) when status is out-of-range (defensive guard)", () => {
    // A future contract enum extension that adds status=5 must not
    // render `undefined.label` and crash the render.
    const { container } = render(<InvoiceStatusBadge status={99} />);
    const el = container.querySelector('[data-testid="invoice-status-badge"]')!;
    expect(el.textContent).toContain("Awaiting payment");
  });

  it("each status maps to a distinct color class (no silent collision)", () => {
    const classes = new Set<string>();
    for (const status of [0, 1, 2, 3, 4]) {
      const { container, unmount } = render(<InvoiceStatusBadge status={status} />);
      const el = container.querySelector('[data-testid="invoice-status-badge"]')!;
      const colorMatch = el.className.match(/(amber|emerald|rose|blue|orange)-\d+/);
      if (colorMatch) classes.add(colorMatch[0]);
      unmount();
    }
    // 5 enum values must produce 5 unique color anchors.
    expect(classes.size).toBe(5);
  });
});

describe("FHEBadge (§15.x)", () => {
  it("renders the 'FHE Encrypted' label + Lock icon", () => {
    const { container } = render(<FHEBadge />);
    expect(container.textContent).toContain("FHE Encrypted");
    // Lock icon renders as an svg.
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("merges a custom className onto the badge-fhe base class", () => {
    const { container } = render(<FHEBadge className="my-custom" />);
    const span = container.querySelector("span")!;
    expect(span.className).toContain("badge-fhe");
    expect(span.className).toContain("my-custom");
  });
});
