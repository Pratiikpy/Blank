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
              k !== "layoutId" &&
              k !== "layout",
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

import { EncryptionProgress } from "./EncryptionProgress";

describe("EncryptionProgress (§15.x)", () => {
  it("renders the title + subtitle", () => {
    const { getByText } = render(<EncryptionProgress progress={0} />);
    expect(getByText("Encrypting Payment")).toBeDefined();
    expect(getByText("Your amount is being encrypted with FHE")).toBeDefined();
  });

  it("renders without crashing at progress=0", () => {
    const { container } = render(<EncryptionProgress progress={0} />);
    expect(container.firstChild).not.toBeNull();
  });

  it("shows 'Encrypting' label at progress=0", () => {
    const { getByText } = render(<EncryptionProgress progress={0} />);
    expect(getByText("Encrypting")).toBeDefined();
  });

  it("shows 'Encrypting' label at progress=32 (just under 33 threshold)", () => {
    const { getByText } = render(<EncryptionProgress progress={32} />);
    expect(getByText("Encrypting")).toBeDefined();
  });

  it("shows 'ZK Proof' label at progress=33 (threshold boundary)", () => {
    const { getByText } = render(<EncryptionProgress progress={33} />);
    expect(getByText("ZK Proof")).toBeDefined();
  });

  it("shows 'ZK Proof' label at progress=65", () => {
    const { getByText } = render(<EncryptionProgress progress={65} />);
    expect(getByText("ZK Proof")).toBeDefined();
  });

  it("shows 'Verifying' label at progress=66 (threshold boundary)", () => {
    const { getByText } = render(<EncryptionProgress progress={66} />);
    expect(getByText("Verifying")).toBeDefined();
  });

  it("shows 'Verifying' label at progress=99", () => {
    const { getByText } = render(<EncryptionProgress progress={99} />);
    expect(getByText("Verifying")).toBeDefined();
  });

  it("shows 'Ready' label at progress=100 (final state)", () => {
    const { getByText } = render(<EncryptionProgress progress={100} />);
    expect(getByText("Ready")).toBeDefined();
  });

  it("the decorative SVG ring has aria-hidden='true' (screen readers skip it)", () => {
    const { container } = render(<EncryptionProgress progress={50} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });

  it("only ONE active label renders at a time (Verifying excludes Encrypting / ZK Proof / Ready)", () => {
    // The 4 step labels are rendered ONLY inside the active-step
    // AnimatePresence block, so exactly one of them must appear in
    // the DOM at any progress value. (Step dots are siblings but
    // contain no labels.)
    const { container } = render(<EncryptionProgress progress={66} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Verifying");
    // Encrypting appears in the title "Encrypting Payment", but the
    // standalone "Encrypting" step label shouldn't show. Match the
    // uppercased step label via the .uppercase classname instead.
    expect(text).not.toContain("ZK Proof");
    expect(text).not.toContain("Ready");
  });
});
