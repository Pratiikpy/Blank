import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";

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
  return {
    motion,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

import { QuickSendRow } from "./QuickSendRow";

const ALICE = "0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("QuickSendRow (§15.x)", () => {
  it("renders an empty-state input when no contacts", () => {
    const { container } = render(
      <QuickSendRow contacts={[]} onSelect={() => {}} />,
    );
    const input = container.querySelector('input[aria-label="Recipient address"]');
    expect(input).not.toBeNull();
  });

  it("empty state send-button calls onSelect with the typed address", () => {
    const onSelect = vi.fn();
    const { container, getByLabelText } = render(
      <QuickSendRow contacts={[]} onSelect={onSelect} />,
    );
    const input = container.querySelector("input")!;
    fireEvent.change(input, { target: { value: ALICE } });
    fireEvent.click(getByLabelText("Send to this address"));
    expect(onSelect).toHaveBeenCalledWith(ALICE);
  });

  it("empty state send-button does NOT fire when input is empty", () => {
    const onSelect = vi.fn();
    const { getByLabelText } = render(
      <QuickSendRow contacts={[]} onSelect={onSelect} />,
    );
    fireEvent.click(getByLabelText("Send to this address"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("empty state trims whitespace before submitting", () => {
    const onSelect = vi.fn();
    const { container, getByLabelText } = render(
      <QuickSendRow contacts={[]} onSelect={onSelect} />,
    );
    const input = container.querySelector("input")!;
    fireEvent.change(input, { target: { value: "  alice.eth  " } });
    fireEvent.click(getByLabelText("Send to this address"));
    expect(onSelect).toHaveBeenCalledWith("alice.eth");
  });

  it("renders contacts as buttons with display names", () => {
    const { getByText } = render(
      <QuickSendRow
        contacts={[
          { address: ALICE, name: "Alice" },
          { address: BOB, name: "Bob" },
        ]}
        onSelect={() => {}}
      />,
    );
    expect(getByText("Alice")).toBeDefined();
    expect(getByText("Bob")).toBeDefined();
  });

  it("falls back to truncated address when contact has no name", () => {
    const { container } = render(
      <QuickSendRow
        contacts={[{ address: ALICE }]}
        onSelect={() => {}}
      />,
    );
    // truncateAddress: 6-prefix + "..." + 4-suffix
    expect(container.textContent).toMatch(/0x[a-fA-F0-9]{4}\.\.\.[a-fA-F0-9]{4}/);
  });

  it("clicking a contact calls onSelect with its address", () => {
    const onSelect = vi.fn();
    const { getByLabelText } = render(
      <QuickSendRow
        contacts={[{ address: ALICE, name: "Alice" }]}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(getByLabelText("Send to Alice"));
    expect(onSelect).toHaveBeenCalledWith(ALICE);
  });

  it("renders the Add Contact button when onAddContact is provided", () => {
    const { getByLabelText } = render(
      <QuickSendRow
        contacts={[{ address: ALICE, name: "Alice" }]}
        onSelect={() => {}}
        onAddContact={() => {}}
      />,
    );
    expect(getByLabelText("Add new contact")).toBeDefined();
  });

  it("clicking Add Contact button calls onAddContact", () => {
    const onAddContact = vi.fn();
    const { getByLabelText } = render(
      <QuickSendRow
        contacts={[{ address: ALICE, name: "Alice" }]}
        onSelect={() => {}}
        onAddContact={onAddContact}
      />,
    );
    fireEvent.click(getByLabelText("Add new contact"));
    expect(onAddContact).toHaveBeenCalledTimes(1);
  });

  it("aria-label on contact button shows name when present", () => {
    const { getByLabelText } = render(
      <QuickSendRow
        contacts={[{ address: ALICE, name: "Alice" }]}
        onSelect={() => {}}
      />,
    );
    expect(getByLabelText("Send to Alice")).toBeDefined();
  });

  it("aria-label on contact button shows address when no name", () => {
    const { getByLabelText } = render(
      <QuickSendRow
        contacts={[{ address: ALICE }]}
        onSelect={() => {}}
      />,
    );
    expect(getByLabelText(`Send to ${ALICE}`)).toBeDefined();
  });
});
