import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("framer-motion", async () => {
  const React = await import("react");
  const motion = new Proxy({}, {
    get: (_t, prop: string) => React.forwardRef<HTMLElement, Record<string, unknown>>(
      ({ children, ...rest }, ref) => {
        const safe = Object.fromEntries(
          Object.entries(rest).filter(
            ([k]) =>
              !k.startsWith("while") &&
              !k.startsWith("initial") &&
              !k.startsWith("animate") &&
              !k.startsWith("exit") &&
              k !== "transition" &&
              k !== "layoutId",
          ),
        );
        return React.createElement(prop, { ref, ...safe }, children as React.ReactNode);
      },
    ),
  });
  return { motion };
});

// EncryptedAmount is heavy (framer-motion + scramble timer); stub it out
// so this test focuses on TransactionBubble's own layout invariants.
vi.mock("./EncryptedAmount", () => ({
  EncryptedAmount: ({ amount }: { amount?: bigint | null }) => (
    <span data-testid="encrypted-amount">{amount?.toString() ?? "null"}</span>
  ),
}));

import { TransactionBubble } from "./TransactionBubble";

const ALICE = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW_ISO = new Date().toISOString();

describe("TransactionBubble (§15.x)", () => {
  it("renders without crashing for a basic payment", () => {
    const { container } = render(
      <TransactionBubble
        type="payment"
        isSender={true}
        otherParty={ALICE}
        timestamp={NOW_ISO}
      />,
    );
    expect(container.firstChild).not.toBeNull();
  });

  it("isSender=true aligns the row right (justify-end)", () => {
    const { container } = render(
      <TransactionBubble
        type="payment"
        isSender={true}
        otherParty={ALICE}
        timestamp={NOW_ISO}
      />,
    );
    const row = container.firstChild as HTMLElement;
    expect(row.className).toContain("justify-end");
  });

  it("isSender=false aligns the row left (justify-start) + shows avatar on left", () => {
    const { container } = render(
      <TransactionBubble
        type="payment"
        isSender={false}
        otherParty={ALICE}
        timestamp={NOW_ISO}
      />,
    );
    const row = container.firstChild as HTMLElement;
    expect(row.className).toContain("justify-start");
  });

  it("renders 'Sent' label for type='payment'", () => {
    const { container } = render(
      <TransactionBubble
        type="payment"
        isSender={true}
        otherParty={ALICE}
        timestamp={NOW_ISO}
      />,
    );
    expect(container.textContent).toContain("Sent");
  });

  it("renders 'Tipped' label for type='tip'", () => {
    const { container } = render(
      <TransactionBubble
        type="tip"
        isSender={true}
        otherParty={ALICE}
        timestamp={NOW_ISO}
      />,
    );
    expect(container.textContent).toContain("Tipped");
  });

  it("renders 'Shielded' label for type='shield'", () => {
    const { container } = render(
      <TransactionBubble
        type="shield"
        isSender={true}
        otherParty={ALICE}
        timestamp={NOW_ISO}
      />,
    );
    expect(container.textContent).toContain("Shielded");
  });

  it("renders the optional note when provided", () => {
    const { container } = render(
      <TransactionBubble
        type="payment"
        isSender={true}
        otherParty={ALICE}
        timestamp={NOW_ISO}
        note="dinner split"
      />,
    );
    expect(container.textContent).toContain("dinner split");
  });

  it("does NOT render note text when undefined", () => {
    const { container } = render(
      <TransactionBubble
        type="payment"
        isSender={true}
        otherParty={ALICE}
        timestamp={NOW_ISO}
      />,
    );
    // No literal "undefined" leaking from missing-note.
    expect(container.textContent).not.toContain("undefined");
  });

  it("renders a relative timestamp (5m / 5 minutes / min variants)", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { container } = render(
      <TransactionBubble
        type="payment"
        isSender={true}
        otherParty={ALICE}
        timestamp={fiveMinAgo}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toMatch(/5m|5 minutes?|min/);
  });
});
