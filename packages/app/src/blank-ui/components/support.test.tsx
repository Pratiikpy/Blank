import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

// §15.x test for two small blank-ui support components:
// - NumericKeypad: pure callback delegation for 11 keys + backspace
// - ConnectionHealthBanner: audit Top-28 #21/#22 — surfaces RPC and
//   Supabase-realtime degradation with a 3-state message hierarchy

const useConnectionHealthMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useConnectionHealth", () => ({
  useConnectionHealth: useConnectionHealthMock,
}));

import { NumericKeypad } from "./NumericKeypad";
import { ConnectionHealthBanner } from "./ConnectionHealthBanner";

beforeEach(() => {
  useConnectionHealthMock.mockReset();
  useConnectionHealthMock.mockReturnValue({
    rpcDegraded: false,
    realtimeDegraded: false,
  });
});

describe("NumericKeypad (§15.x)", () => {
  it("renders 11 numeric/decimal keys + 1 backspace = 12 buttons total", () => {
    const { container } = render(
      <NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />,
    );
    expect(container.querySelectorAll("button").length).toBe(12);
  });

  it("renders digits 1-9 + 0 + decimal point", () => {
    const { container } = render(
      <NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />,
    );
    const labels = Array.from(container.querySelectorAll("button"))
      .map((b) => b.textContent?.trim())
      .filter((t) => t && t.length > 0);
    for (const k of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "."]) {
      expect(labels).toContain(k);
    }
  });

  it("clicking a digit calls onKey with that digit", () => {
    const onKey = vi.fn();
    const { getByText } = render(
      <NumericKeypad onKey={onKey} onBackspace={vi.fn()} />,
    );
    fireEvent.click(getByText("5"));
    expect(onKey).toHaveBeenCalledWith("5");
  });

  it("clicking the decimal point calls onKey with '.'", () => {
    const onKey = vi.fn();
    const { getByText } = render(
      <NumericKeypad onKey={onKey} onBackspace={vi.fn()} />,
    );
    fireEvent.click(getByText("."));
    expect(onKey).toHaveBeenCalledWith(".");
  });

  it("decimal point gets a screen-reader-friendly aria-label", () => {
    const { getByLabelText } = render(
      <NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />,
    );
    // aria-label is "Decimal point" (not just ".") for screen-reader UX.
    expect(getByLabelText("Decimal point")).toBeDefined();
  });

  it("digit aria-labels match the digit", () => {
    const { getByLabelText } = render(
      <NumericKeypad onKey={vi.fn()} onBackspace={vi.fn()} />,
    );
    for (const d of ["0", "1", "5", "9"]) {
      expect(getByLabelText(d)).toBeDefined();
    }
  });

  it("backspace button has aria-label='Backspace' + click invokes onBackspace", () => {
    const onBackspace = vi.fn();
    const { getByLabelText } = render(
      <NumericKeypad onKey={vi.fn()} onBackspace={onBackspace} />,
    );
    fireEvent.click(getByLabelText("Backspace"));
    expect(onBackspace).toHaveBeenCalledTimes(1);
  });

  it("clicking backspace does NOT call onKey (separate callback paths)", () => {
    const onKey = vi.fn();
    const onBackspace = vi.fn();
    const { getByLabelText } = render(
      <NumericKeypad onKey={onKey} onBackspace={onBackspace} />,
    );
    fireEvent.click(getByLabelText("Backspace"));
    expect(onKey).not.toHaveBeenCalled();
  });
});

describe("ConnectionHealthBanner — audit Top-28 #21/#22 (§15.x)", () => {
  it("renders nothing when both connections healthy", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: false,
      realtimeDegraded: false,
    });
    const { container } = render(<ConnectionHealthBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("RPC-only message when only RPC is degraded", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: true,
      realtimeDegraded: false,
    });
    const { container } = render(<ConnectionHealthBanner />);
    expect(container.textContent).toContain("RPC connection unstable");
  });

  it("Realtime-only message when only realtime is degraded", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: false,
      realtimeDegraded: true,
    });
    const { container } = render(<ConnectionHealthBanner />);
    expect(container.textContent).toContain("Live updates paused");
  });

  it("Combined message when BOTH are degraded (precedence: both wins)", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: true,
      realtimeDegraded: true,
    });
    const { container } = render(<ConnectionHealthBanner />);
    expect(container.textContent).toContain("Connection issues");
    // Must NOT show either single-state message when both are degraded.
    expect(container.textContent).not.toContain("RPC connection unstable");
    expect(container.textContent).not.toContain("Live updates paused");
  });

  it("uses role='status' with aria-live='polite' for screen-reader announcement", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: true,
      realtimeDegraded: false,
    });
    const { getByRole } = render(<ConnectionHealthBanner />);
    const status = getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("WifiOff icon shown when RPC degraded (with or without realtime)", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: true,
      realtimeDegraded: false,
    });
    const { container } = render(<ConnectionHealthBanner />);
    // lucide WifiOff icon — assert via class name unique to the icon.
    expect(container.querySelector(".lucide-wifi-off")).not.toBeNull();
  });

  it("AlertTriangle icon shown when ONLY realtime degraded (RPC healthy)", () => {
    useConnectionHealthMock.mockReturnValue({
      rpcDegraded: false,
      realtimeDegraded: true,
    });
    const { container } = render(<ConnectionHealthBanner />);
    expect(container.querySelector(".lucide-triangle-alert, .lucide-alert-triangle")).not.toBeNull();
  });
});
