import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// §15.x test for Help screen. Pins the single-expansion accordion
// (one open at a time — opening item B closes item A), the default-
// open first item (so the page never lands fully collapsed), and
// the testnet "do not use real funds" warning. Also pins the
// aria-expanded + aria-controls wiring for screen readers.

const navigateMock = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import Help from "./Help";

function withRouter(node: React.ReactElement, initial = ["/help"]) {
  return render(
    <MemoryRouter initialEntries={initial}>
      <Routes>
        <Route path="/help" element={node} />
        <Route path="*" element={<div>elsewhere</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigateMock.mockReset();
});

describe("Help — page chrome (§15.x)", () => {
  it("renders the 'Help & FAQ' heading", () => {
    const { getByText } = withRouter(<Help />);
    expect(getByText("Help & FAQ")).toBeDefined();
  });

  it("renders the subtitle 'Frequently asked questions about Blank'", () => {
    const { container } = withRouter(<Help />);
    expect(container.textContent).toContain("Frequently asked questions about Blank");
  });

  it("renders a back button with aria-label='Go back' that calls navigate(-1)", () => {
    const { getByLabelText } = withRouter(<Help />);
    const back = getByLabelText("Go back");
    fireEvent.click(back);
    expect(navigateMock).toHaveBeenCalledWith(-1);
  });
});

describe("Help — FAQ accordion (§15.x)", () => {
  it("renders all 6 FAQ items", () => {
    const { container } = withRouter(<Help />);
    const triggers = container.querySelectorAll("button[aria-expanded]");
    expect(triggers.length).toBe(6);
  });

  it("CRITICAL default-open item is 'What is Blank?' (avoids dead-collapsed first impression)", () => {
    const { container } = withRouter(<Help />);
    const triggers = Array.from(
      container.querySelectorAll("button[aria-expanded]"),
    );
    const firstOpen = triggers.find((t) => t.getAttribute("aria-expanded") === "true");
    expect(firstOpen?.textContent).toContain("What is Blank?");
  });

  it("only ONE item is open at a time (single-expansion accordion)", () => {
    const { container } = withRouter(<Help />);
    const triggers = Array.from(
      container.querySelectorAll("button[aria-expanded]"),
    );
    const openCount = triggers.filter((t) => t.getAttribute("aria-expanded") === "true").length;
    expect(openCount).toBe(1);
  });

  it("clicking another item closes the previously-open one", () => {
    const { container, getByText } = withRouter(<Help />);
    // Click "What is FHE?" trigger.
    const fheTrigger = getByText("What is FHE?").closest("button")!;
    fireEvent.click(fheTrigger);

    const triggers = Array.from(
      container.querySelectorAll("button[aria-expanded]"),
    );
    const open = triggers.filter((t) => t.getAttribute("aria-expanded") === "true");
    expect(open.length).toBe(1);
    expect(open[0].textContent).toContain("What is FHE?");
  });

  it("clicking an already-open item closes it (toggle behavior)", () => {
    const { container, getByText } = withRouter(<Help />);
    // Default-open is "What is Blank?". Click it to collapse.
    const trigger = getByText("What is Blank?").closest("button")!;
    fireEvent.click(trigger);

    const triggers = Array.from(
      container.querySelectorAll("button[aria-expanded]"),
    );
    const openCount = triggers.filter((t) => t.getAttribute("aria-expanded") === "true").length;
    expect(openCount).toBe(0);
  });

  it("aria-controls on each trigger maps to a distinct faq-answer-<id> region", () => {
    const { container } = withRouter(<Help />);
    const triggers = Array.from(
      container.querySelectorAll("button[aria-expanded]"),
    );
    const controlIds = triggers.map((t) => t.getAttribute("aria-controls"));
    // Each id should be unique and faq-answer-<slug> shaped.
    expect(new Set(controlIds).size).toBe(6);
    for (const id of controlIds) {
      expect(id).toMatch(/^faq-answer-/);
    }
  });
});

describe("Help — FAQ content (§15.x)", () => {
  it("'What is FHE?' explains Fully Homomorphic Encryption", () => {
    const { container, getByText } = withRouter(<Help />);
    fireEvent.click(getByText("What is FHE?").closest("button")!);
    expect(container.textContent).toContain("Fully Homomorphic Encryption");
    expect(container.textContent).toContain("compute on");
    expect(container.textContent).toContain("encrypted data");
  });

  it("getting-started flow lists all 5 numbered steps", () => {
    const { container, getByText } = withRouter(<Help />);
    fireEvent.click(getByText("How do I get started?").closest("button")!);
    const steps = container.textContent ?? "";
    expect(steps).toContain("Connect your wallet");
    expect(steps).toContain("Switch to the Ethereum Sepolia");
    expect(steps).toContain("Get test USDC");
    expect(steps).toContain("Shield your tokens");
    expect(steps).toContain("Send privately");
  });

  it("'Why do amounts show as ••••?' mentions the 10s auto-hide", () => {
    const { container, getByText } = withRouter(<Help />);
    fireEvent.click(getByText(/Why do amounts show/).closest("button")!);
    expect(container.textContent).toContain("auto-hide after 10 seconds");
  });

  it("shielding explainer covers public→encrypted conversion + unshield reversibility", () => {
    const { container, getByText } = withRouter(<Help />);
    fireEvent.click(getByText("What is shielding?").closest("button")!);
    expect(container.textContent).toContain("converts your public ERC-20");
    expect(container.textContent).toContain("unshield at any time");
  });

  it("CRITICAL: support FAQ external GitHub link has tabnabbing guard", () => {
    const { container, getByText } = withRouter(<Help />);
    fireEvent.click(
      getByText("How do I report an issue or get support?").closest("button")!,
    );
    const ghLink = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Report Issues on GitHub"),
    )!;
    expect(ghLink.getAttribute("href")).toBe("https://github.com/FhenixProtocol");
    expect(ghLink.getAttribute("target")).toBe("_blank");
    const rel = ghLink.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });
});

describe("Help — bottom info (§15.x)", () => {
  it("mentions both Fhenix CoFHE + Ethereum Sepolia stack", () => {
    const { container } = withRouter(<Help />);
    expect(container.textContent).toContain("Fhenix CoFHE");
    expect(container.textContent).toContain("Ethereum Sepolia");
  });

  it("CRITICAL: testnet 'do not use real funds' safety warning is present", () => {
    const { container } = withRouter(<Help />);
    expect(container.textContent).toContain("testnet application");
    expect(container.textContent).toContain("do not use real funds");
  });
});
