import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Pricing from "./Pricing";

// §15.x test for Pricing. Smoke + content pin: the page deliberately
// commits to the SHAPE (per-vendor settled-invoice fee, capped, first
// $N free) WITHOUT committing to numbers. Future edits that quietly
// drop "free during testnet" or accidentally introduce a hardcoded
// dollar figure would betray the page's central promise — pinning
// key copy prevents those silent regressions.

function withRouter(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe("Pricing — page chrome (§15.x)", () => {
  it("renders without crashing + LandingNav + LandingFooter", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.firstChild).not.toBeNull();
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Primary");
    expect(container.querySelector("footer")).not.toBeNull();
  });

  it("wraps the page in 'blank-landing'", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.querySelector(".blank-landing")).not.toBeNull();
  });
});

describe("Pricing — hero (§15.x)", () => {
  it("hero kicker reads 'Pricing — shape, not numbers'", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("Pricing");
    expect(container.textContent).toContain("shape, not numbers");
  });

  it("hero headline commits to 'Free during testnet.' + 'Honest about mainnet.'", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("Free during testnet");
    expect(container.textContent).toContain("Honest about mainnet");
  });

  it("subline explains why no numbers are shown", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("we don't know them yet");
    expect(container.textContent).toContain("rather say that than guess");
  });
});

describe("Pricing — 3-tier card grid (§15.x)", () => {
  it("renders all 3 tier names: Personal / Vendor / Platform", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("Personal");
    expect(container.textContent).toContain("Vendor");
    expect(container.textContent).toContain("Platform");
  });

  it("renders each tier's audience label", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("Anyone with a wallet");
    expect(container.textContent).toContain("Freelancers, agencies, small businesses");
    expect(container.textContent).toContain("Apps that want privacy as a feature");
  });

  it("Personal tier carries 'Live now' status badge", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("Live now");
  });

  it("Vendor tier carries 'Mainnet shape' status badge", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("Mainnet shape");
  });

  it("Platform tier carries 'Later' status badge", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("Later");
  });

  it("Personal tier says it is free during testnet", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("Free during testnet");
    expect(container.textContent).toContain("Core personal payments should stay free");
  });

  it("Vendor tier explains per-settled-invoice fee shape", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("Per-settled-invoice fee");
    expect(container.textContent).toContain("Free until your first paid invoice clears mainnet");
  });

  it("each tier's bullet list shows feature deltas (Personal → Vendor → Platform)", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("Send and receive encrypted payments");
    expect(container.textContent).toContain("Everything in Personal");
    expect(container.textContent).toContain("Webhook events for paid / disputed / refunded");
  });
});

describe("Pricing — reasoning block (§15.x)", () => {
  it("section kicker is 'The reasoning'", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("The reasoning");
  });

  it("renders the 4 reasoning sub-points (each starts with bold leading clause)", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("The personal payment surface should stay free");
    expect(container.textContent).toContain("Vendors pay because vendors get paid");
    expect(container.textContent).toContain("Platforms pay because platforms multiply");
    expect(container.textContent).toContain("Why we can't tell you the numbers yet");
  });

  it("reasoning enumerates the 3 unknown variables (Fhenix economics + audit + regulatory)", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("threshold-decrypt economics");
    expect(container.textContent).toContain("Audit costs");
    expect(container.textContent).toContain("Regulatory clarity");
  });
});

describe("Pricing — free-during-testnet block (§15.x)", () => {
  it("section kicker is 'Free during testnet'", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("Free during testnet");
  });

  it("renders all 8 free-during-testnet items", () => {
    const { container } = withRouter(<Pricing />);
    const text = container.textContent ?? "";
    const items = [
      "Receiving encrypted payments",
      "Sending encrypted payments to people you know",
      "Viewing your own activity feed",
      "Exporting your data to CSV",
      "The smart-wallet passkey signup flow",
      "Reading public invoice pages",
      "Stealth claim codes for one-off transfers",
      "Reading the source code on GitHub",
    ];
    for (const item of items) {
      expect(text).toContain(item);
    }
  });
});

describe("Pricing — CTAs (§15.x)", () => {
  it("hero/CTA section both link 'Launch Blank' to /app", () => {
    const { container } = withRouter(<Pricing />);
    const launchCtas = Array.from(container.querySelectorAll("a")).filter((a) =>
      a.textContent?.includes("Launch Blank"),
    );
    expect(launchCtas.length).toBeGreaterThanOrEqual(1);
    for (const cta of launchCtas) {
      expect(cta.getAttribute("href")).toBe("https://app.myblank.app");
    }
  });

  it("CTA section keeps the no-asterisk testnet promise", () => {
    const { container } = withRouter(<Pricing />);
    expect(container.textContent).toContain("Use it free during testnet");
    expect(container.textContent).toContain("no asterisk");
  });
});
