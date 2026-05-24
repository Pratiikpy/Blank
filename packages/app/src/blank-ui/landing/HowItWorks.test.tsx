import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// §15.x test for HowItWorks. Pin the 6-row comparison table (the
// rhetorical centerpiece — each row makes the case for FHE) and the
// agent-transparency section (publishes the AI-signing wallet so
// anyone can verify AgentPaymentSubmission events via ecrecover).

const useChainMock = vi.hoisted(() => vi.fn());
const agentAddrRef = vi.hoisted(() => ({ value: "" as string }));

vi.mock("@/providers/ChainProvider", () => ({
  useChain: useChainMock,
}));

vi.mock("@/lib/constants", () => ({
  get AGENT_ATTESTATION_ADDRESS() {
    return agentAddrRef.value;
  },
}));

import HowItWorks from "./HowItWorks";

function withRouter(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

beforeEach(() => {
  useChainMock.mockReset();
  useChainMock.mockReturnValue({
    activeChain: {
      name: "Ethereum Sepolia",
      explorerUrl: "https://sepolia.etherscan.io",
    },
  });
  agentAddrRef.value = "";
});

describe("HowItWorks — page chrome (§15.x)", () => {
  it("renders without crashing + LandingNav + LandingFooter + .blank-landing wrapper", () => {
    const { container } = withRouter(<HowItWorks />);
    expect(container.firstChild).not.toBeNull();
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Primary");
    expect(container.querySelector("footer")).not.toBeNull();
    expect(container.querySelector(".blank-landing")).not.toBeNull();
  });
});

describe("HowItWorks — hero (§15.x)", () => {
  it("kicker reads 'How Blank works'", () => {
    const { container } = withRouter(<HowItWorks />);
    expect(container.textContent).toContain("How Blank works");
  });

  it("CRITICAL headline: 'Features that cannot exist without FHE.'", () => {
    const { container } = withRouter(<HowItWorks />);
    expect(container.textContent).toContain("Features that cannot exist without FHE");
  });

  it("lead copy frames FHE as load-bearing, not a polish layer", () => {
    const { container } = withRouter(<HowItWorks />);
    expect(container.textContent).toContain("not a polish layer");
    expect(container.textContent).toContain("Fully Homomorphic Encryption");
  });
});

describe("HowItWorks — 6-row comparison table (§15.x)", () => {
  it("uses role='table' with aria-label for screen-reader semantics", () => {
    const { container } = withRouter(<HowItWorks />);
    const table = container.querySelector('[role="table"]');
    expect(table).not.toBeNull();
    expect(table!.getAttribute("aria-label")).toBe("FHE comparison");
  });

  it("renders 3 column headers: Feature / Without FHE / With FHE (Blank)", () => {
    const { container } = withRouter(<HowItWorks />);
    const headers = Array.from(container.querySelectorAll('[role="columnheader"]')).map(
      (h) => h.textContent?.trim(),
    );
    expect(headers).toContain("Feature");
    expect(headers).toContain("Without FHE");
    expect(headers).toContain("With FHE (Blank)");
  });

  it("renders all 8 feature rows in correct order", () => {
    const { container } = withRouter(<HowItWorks />);
    const features = Array.from(container.querySelectorAll(".hiw-feature")).map(
      (el) => el.textContent?.trim(),
    );
    expect(features).toEqual([
      "Encrypted send",
      "Encrypted payroll",
      "Salary / balance proof",
      "Group expense splits",
      "Gift envelopes",
      "Stealth + encrypted",
      // Wave 5 additions.
      "Encrypted off-ramp",
      "Encrypted analytics",
    ]);
  });

  it("Encrypted send row: MEV-sandwich without / ciphertext with", () => {
    const { container } = withRouter(<HowItWorks />);
    expect(container.textContent).toContain("MEV bots");
    expect(container.textContent).toContain("32-byte handle");
  });

  it("Encrypted payroll row: every-employee-sees-every-paycheck contrast", () => {
    const { container } = withRouter(<HowItWorks />);
    expect(container.textContent).toContain("every other employee's paycheck");
    expect(container.textContent).toContain("Employer sees total");
  });

  it("Salary proof row: reveal-statement vs ebool ('income ≥ $X')", () => {
    const { container } = withRouter(<HowItWorks />);
    expect(container.textContent).toContain("rent a flat");
    expect(container.textContent).toContain("income ≥ $X");
  });

  it("Group splits + Gift envelopes + Stealth rows mention key counter-claims", () => {
    const { container } = withRouter(<HowItWorks />);
    expect(container.textContent).toContain("Alice owes Bob $80");
    expect(container.textContent).toContain("only their own share");
    expect(container.textContent).toContain("counterparty graph");
  });
});

describe("HowItWorks — agent transparency (§15.x)", () => {
  it("section heading reads 'Our AI agents are public'", () => {
    const { container } = withRouter(<HowItWorks />);
    expect(container.textContent).toContain("Our AI agents are public");
  });

  it("explainer mentions AgentPaymentSubmission + ecrecover (verifiability claim)", () => {
    const { container } = withRouter(<HowItWorks />);
    expect(container.textContent).toContain("AgentPaymentSubmission");
    expect(container.textContent).toContain("ecrecover");
  });

  it("when AGENT_ATTESTATION_ADDRESS is set: renders an external explorer link", () => {
    agentAddrRef.value = "0x" + "ab".repeat(20);
    const { container } = withRouter(<HowItWorks />);
    const link = container.querySelector(".hiw-agents-value") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toContain("/address/0x");
    expect(link.getAttribute("target")).toBe("_blank");
    // Tabnabbing guard.
    const rel = link.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });

  it("when AGENT_ATTESTATION_ADDRESS is unset: shows 'Not yet published' fallback", () => {
    agentAddrRef.value = "";
    const { container } = withRouter(<HowItWorks />);
    expect(container.textContent).toContain("Not yet published");
    expect(container.textContent).toContain("Recoverable via ecrecover from each event");
    // No external link in this state.
    expect(container.querySelector(".hiw-agents-value")).toBeNull();
  });
});

describe("HowItWorks — closing callout + CTAs (§15.x)", () => {
  it("callout drives the 'standard contract leaks every amount' framing", () => {
    const { container } = withRouter(<HowItWorks />);
    expect(container.textContent).toContain("leaks every amount");
    expect(container.textContent).toContain("Blank ships the other column");
  });

  it("'Try it now' CTA links to /app", () => {
    const { container } = withRouter(<HowItWorks />);
    const tryCta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Try it now"),
    );
    expect(tryCta?.getAttribute("href")).toBe("/app");
  });

  it("'See every feature' CTA links to /features", () => {
    const { container } = withRouter(<HowItWorks />);
    const featCta = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("See every feature"),
    );
    expect(featCta?.getAttribute("href")).toBe("/features");
  });
});
