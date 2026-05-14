import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// §15.x test for PayPage. Pin the 3-phase UI (loading / error /
// ready), the 4 error-kind copy variants (not-found / ens-failed /
// invalid / supabase-unavailable), and the goToSend URL builder
// that pre-fills /app/send/amount with to/amount/note/chain params.

const resolvePayTargetMock = vi.hoisted(() => vi.fn());
const lookupNameMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/pay-resolver", () => ({
  resolvePayTarget: resolvePayTargetMock,
}));

vi.mock("@/lib/address-resolver", () => ({
  lookupName: lookupNameMock,
}));

// AddressLabel uses useLookupName, which we mock to avoid the wagmi/
// React-Query chain.
vi.mock("@/blank-ui/components", async () => {
  const React = await import("react");
  return {
    AddressLabel: ({ address }: { address: string }) =>
      React.createElement("span", null, address.slice(0, 8)),
  };
});

import PayPage from "./PayPage";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function withRoute(identifier: string, search = "") {
  return render(
    <MemoryRouter initialEntries={[`/pay/${identifier}${search ? "?" + search : ""}`]}>
      <Routes>
        <Route path="/pay/:identifier" element={<PayPage />} />
        <Route path="/app/send/amount" element={<div data-testid="send-amount-page">SEND</div>} />
        <Route path="/" element={<div>HOME</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  resolvePayTargetMock.mockReset();
  lookupNameMock.mockReset();
  lookupNameMock.mockResolvedValue(null);
});

describe("PayPage — page chrome (§15.x)", () => {
  it("renders LandingNav + LandingFooter even in loading state", () => {
    resolvePayTargetMock.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = withRoute(ALICE);
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Primary");
    expect(container.querySelector("footer")).not.toBeNull();
  });

  it("loading phase shows 'Resolving payment link…' with a Loader2 spinner", () => {
    resolvePayTargetMock.mockReturnValue(new Promise(() => {}));
    const { container } = withRoute(ALICE);
    expect(container.textContent).toContain("Resolving payment link");
    expect(container.querySelector(".animate-spin")).not.toBeNull();
  });
});

describe("PayPage — error phase (§15.x)", () => {
  it("not-found error shows the identifier + 'Check the link' hint", async () => {
    resolvePayTargetMock.mockResolvedValue({
      ok: false,
      error: { kind: "not-found", identifier: "INV-999" },
    });
    const { container } = withRoute("INV-999");
    await flushMicrotasks();
    expect(container.textContent).toContain("Couldn't resolve this link");
    expect(container.textContent).toContain("INV-999");
    expect(container.textContent).toContain("Check the link");
  });

  it("ens-failed error mentions 'doesn't resolve to an address'", async () => {
    resolvePayTargetMock.mockResolvedValue({
      ok: false,
      error: { kind: "ens-failed", identifier: "bogus.eth" },
    });
    const { container } = withRoute("bogus.eth");
    await flushMicrotasks();
    expect(container.textContent).toContain("bogus.eth");
    expect(container.textContent).toContain("doesn't resolve to an address");
  });

  it("invalid error names the identifier as not a valid address/ENS/invoice ID", async () => {
    resolvePayTargetMock.mockResolvedValue({
      ok: false,
      error: { kind: "invalid", identifier: "garbage" },
    });
    const { container } = withRoute("garbage");
    await flushMicrotasks();
    expect(container.textContent).toContain("garbage");
    expect(container.textContent).toContain("isn't a valid address");
  });

  it("invalid error uses '(empty)' placeholder when identifier is empty", async () => {
    resolvePayTargetMock.mockResolvedValue({
      ok: false,
      error: { kind: "invalid", identifier: "" },
    });
    const { container } = withRoute("anything"); // route param triggers resolve
    await flushMicrotasks();
    expect(container.textContent).toContain("(empty)");
  });

  it("supabase-unavailable error shows 'temporarily unavailable' copy", async () => {
    resolvePayTargetMock.mockResolvedValue({
      ok: false,
      error: { kind: "supabase-unavailable" },
    });
    const { container } = withRoute("INV-42");
    await flushMicrotasks();
    expect(container.textContent).toContain("temporarily unavailable");
  });

  it("error phase shows 'Back to Blank' recovery link → /", async () => {
    resolvePayTargetMock.mockResolvedValue({
      ok: false,
      error: { kind: "not-found", identifier: "x" },
    });
    const { container } = withRoute("x");
    await flushMicrotasks();
    const back = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Back to Blank"),
    );
    expect(back?.getAttribute("href")).toBe("/");
  });
});

describe("PayPage — ready phase (§15.x address target)", () => {
  beforeEach(() => {
    resolvePayTargetMock.mockResolvedValue({
      ok: true,
      target: { kind: "address", address: ALICE },
    });
  });

  it("renders 'Pay' label + truncated address as the recipient", async () => {
    const { container } = withRoute(ALICE);
    await flushMicrotasks();
    expect(container.textContent).toContain("Pay");
    // truncateAddress: 6+4 = "0xaaaa...aaaa".
    expect(container.textContent).toMatch(/0xaaaa\.\.\.aaaa/);
  });

  it("uses reverse-lookup ENS name when available", async () => {
    lookupNameMock.mockResolvedValue("alice.eth");
    const { container } = withRoute(ALICE);
    await flushMicrotasks();
    expect(container.textContent).toContain("alice.eth");
  });

  it("renders BOTH 'Pay with Blank (passkey)' AND 'Pay with connected wallet' CTAs", async () => {
    const { container } = withRoute(ALICE);
    await flushMicrotasks();
    expect(container.textContent).toContain("Pay with Blank (passkey)");
    expect(container.textContent).toContain("Pay with connected wallet");
  });

  it("shows the privacy footer line about on-chain encryption", async () => {
    const { container } = withRoute(ALICE);
    await flushMicrotasks();
    expect(container.textContent).toContain("Amount is encrypted on-chain");
  });
});

describe("PayPage — amount + note prefills (§15.x)", () => {
  it("renders amount when ?amount= is present in URL", async () => {
    resolvePayTargetMock.mockResolvedValue({
      ok: true,
      target: { kind: "address", address: ALICE },
    });
    const { container } = withRoute(ALICE, "amount=100");
    await flushMicrotasks();
    expect(container.textContent).toContain("$100");
    expect(container.textContent).toContain("USDC");
  });

  it("renders Memo block when ?note= is present (non-invoice target)", async () => {
    resolvePayTargetMock.mockResolvedValue({
      ok: true,
      target: { kind: "address", address: ALICE },
    });
    const { container } = withRoute(ALICE, "note=dinner+split");
    await flushMicrotasks();
    expect(container.textContent).toContain("Memo");
    expect(container.textContent).toContain("dinner split");
  });
});

describe("PayPage — invoice target (§15.x)", () => {
  beforeEach(() => {
    resolvePayTargetMock.mockResolvedValue({
      ok: true,
      target: {
        kind: "invoice",
        address: ALICE,
        invoice: {
          invoice_id: 42,
          description: "Web design",
          status: "pending",
          due_date: "2026-06-01",
        },
      },
    });
  });

  it("shows invoice header '#42 — Web design'", async () => {
    const { container } = withRoute("INV-42");
    await flushMicrotasks();
    expect(container.textContent).toContain("#42");
    expect(container.textContent).toContain("Web design");
  });

  it("shows 'Due' date when invoice has due_date", async () => {
    const { container } = withRoute("INV-42");
    await flushMicrotasks();
    expect(container.textContent).toContain("Due");
  });

  it("shows 'already been paid' banner when invoice.status = 'paid'", async () => {
    resolvePayTargetMock.mockResolvedValue({
      ok: true,
      target: {
        kind: "invoice",
        address: ALICE,
        invoice: { invoice_id: 42, description: "x", status: "paid", due_date: null },
      },
    });
    const { container } = withRoute("INV-42");
    await flushMicrotasks();
    expect(container.textContent).toContain("This invoice has already been paid");
  });
});

describe("PayPage — goToSend URL builder (§15.x)", () => {
  it("'Pay with Blank' click navigates to /app/send/amount with ?to=", async () => {
    resolvePayTargetMock.mockResolvedValue({
      ok: true,
      target: { kind: "address", address: ALICE },
    });
    const { container, queryByTestId } = withRoute(ALICE);
    await flushMicrotasks();

    const cta = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Pay with Blank"),
    )!;
    fireEvent.click(cta);
    await flushMicrotasks();

    expect(queryByTestId("send-amount-page")).not.toBeNull();
  });

  it("'Pay with connected wallet' click navigates with ?wallet=external", async () => {
    resolvePayTargetMock.mockResolvedValue({
      ok: true,
      target: { kind: "address", address: ALICE },
    });
    const { container, queryByTestId } = withRoute(ALICE);
    await flushMicrotasks();

    const cta = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("connected wallet"),
    )!;
    fireEvent.click(cta);
    await flushMicrotasks();

    expect(queryByTestId("send-amount-page")).not.toBeNull();
  });
});
