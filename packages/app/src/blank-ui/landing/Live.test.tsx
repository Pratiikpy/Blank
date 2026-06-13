import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { LiveActivity } from "@/hooks/useLiveActivities";

// §15.x test for Live. Pin the 4-state UI (loading / error / empty
// list / populated), the ████.██ amount placeholder (load-bearing
// privacy-claim brand statement), the activity-type normalization
// (case-insensitive substring → human label), and the tabnabbing
// guard on every tx-hash external link.

const useLiveActivitiesMock = vi.hoisted(() => vi.fn());
const getExplorerTxUrlMock = vi.hoisted(() => vi.fn());

vi.mock("@/hooks/useLiveActivities", () => ({
  useLiveActivities: useLiveActivitiesMock,
}));

vi.mock("@/lib/constants", () => ({
  getExplorerTxUrl: getExplorerTxUrlMock,
}));

import Live from "./Live";

function withRouter(node: React.ReactElement) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function rowFor(opts: Partial<LiveActivity> = {}): LiveActivity {
  return {
    id: opts.id ?? "row-1",
    tx_hash: opts.tx_hash ?? "0x" + "1".repeat(64),
    user_from: opts.user_from ?? ALICE,
    user_to: opts.user_to ?? BOB,
    activity_type: opts.activity_type ?? "payment",
    note: opts.note ?? "",
    created_at: opts.created_at ?? new Date(Date.now() - 10 * 1000).toISOString(),
    chain_id: opts.chain_id ?? 11155111,
    contract_address: opts.contract_address ?? "0x" + "9".repeat(40),
    token_address: opts.token_address ?? "0x" + "8".repeat(40),
    block_number: opts.block_number ?? 1,
    isNew: opts.isNew,
  } as LiveActivity;
}

beforeEach(() => {
  useLiveActivitiesMock.mockReset();
  getExplorerTxUrlMock.mockReset();
  getExplorerTxUrlMock.mockImplementation(
    (hash: string, chainId: number) =>
      `https://sepolia.etherscan.io/tx/${hash}?chain=${chainId}`,
  );
  // Default: configured + populated.
  useLiveActivitiesMock.mockReturnValue({
    activities: [],
    isLoading: false,
    error: null,
    supabaseConfigured: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Live — page chrome (§15.x)", () => {
  it("renders without crashing + LandingNav + LandingFooter + .blank-landing", () => {
    const { container } = withRouter(<Live />);
    expect(container.firstChild).not.toBeNull();
    expect(container.querySelector("nav")?.getAttribute("aria-label")).toBe("Primary");
    expect(container.querySelector("footer")).not.toBeNull();
    expect(container.querySelector(".blank-landing")).not.toBeNull();
  });
});

describe("Live — hero (§15.x)", () => {
  it("kicker reads 'Live'", () => {
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain("Live");
  });

  it("CRITICAL headline: 'Real transactions. Sealed amounts. Nothing to fake here.'", () => {
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain("Real transactions. Sealed amounts. Nothing to fake here");
  });

  it("lead frames addresses-public + amounts-encrypted contract", () => {
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain("Addresses are public");
    expect(container.textContent).toContain("amounts are encrypted");
  });
});

describe("Live — status banner (§15.x)", () => {
  it("names all three live chains when supabaseConfigured", () => {
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain(
      "Streaming from Base Sepolia, Ethereum Sepolia & Arbitrum Sepolia",
    );
  });

  it("shows empty-state fallback when Supabase not configured", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [],
      isLoading: false,
      error: null,
      supabaseConfigured: false,
    });
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain("Supabase not configured");
  });
});

describe("Live — 4-state UI (§15.x)", () => {
  it("loading state shows 'Loading recent activity…'", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [],
      isLoading: true,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain("Loading recent activity");
  });

  it("error state shows 'Couldn't load activity' + the error message", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [],
      isLoading: false,
      error: "RLS denied",
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain("Couldn't load activity");
    expect(container.textContent).toContain("RLS denied");
  });

  it("empty state shows 'No transactions yet.' + 'Be the first' link to /app", () => {
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain("No transactions yet");
    const beFirst = Array.from(container.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Be the first"),
    );
    expect(beFirst?.getAttribute("href")).toBe("https://app.myblank.app");
  });

  it("populated list renders one row per activity", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [
        rowFor({ id: "a", tx_hash: "0xa".padEnd(66, "a") }),
        rowFor({ id: "b", tx_hash: "0xb".padEnd(66, "b") }),
        rowFor({ id: "c", tx_hash: "0xc".padEnd(66, "c") }),
      ],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(container.querySelectorAll(".ll-live-row").length).toBe(3);
  });
});

describe("Live — Row content (§15.x)", () => {
  it("CRITICAL: every row shows the ████.██ encrypted amount placeholder", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [rowFor()],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain("████.██");
  });

  it("renders truncated sender + receiver + arrow (sender → receiver)", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [rowFor()],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain(ALICE.slice(0, 6));
    expect(container.textContent).toContain(BOB.slice(0, 6));
    expect(container.textContent).toContain("→");
  });

  it("type normalization: 'payment' → 'Payment'", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [rowFor({ activity_type: "payment" })],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain("Payment");
  });

  it("type normalization is case-insensitive (handles 'PAYROLL_BATCH' → 'Payroll')", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [rowFor({ activity_type: "PAYROLL_BATCH" })],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain("Payroll");
  });

  it("type normalization: substring matching maps 'invoice_paid' → 'Invoice'", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [rowFor({ activity_type: "invoice_paid" })],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain("Invoice");
  });

  it("renders the note in quotes when non-empty", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [rowFor({ note: "rent split" })],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain('"rent split"');
  });

  it("CRITICAL: tx-hash external link uses target='_blank' + rel='noopener noreferrer' (tabnabbing guard)", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [rowFor({ tx_hash: "0xabc" })],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    const txLink = container.querySelector(".ll-live-link") as HTMLAnchorElement;
    expect(txLink).not.toBeNull();
    expect(txLink.getAttribute("target")).toBe("_blank");
    const rel = txLink.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });

  it("tx-hash link href is built via getExplorerTxUrl(hash, chainId)", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [rowFor({ tx_hash: "0xabc", chain_id: 84532 })],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(getExplorerTxUrlMock).toHaveBeenCalledWith("0xabc", 84532);
    const txLink = container.querySelector(".ll-live-link") as HTMLAnchorElement;
    expect(txLink.getAttribute("href")).toContain("0xabc");
  });

  it("isNew=true gets ' new' suffix on row class (flash animation hook)", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [rowFor({ isNew: true })],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    const row = container.querySelector(".ll-live-row");
    expect(row?.className).toContain("new");
  });
});

describe("Live — timeAgo branches (§15.x via row rendering)", () => {
  it("recent (<5s) → 'just now'", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [rowFor({ created_at: new Date(Date.now() - 1000).toISOString() })],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain("just now");
  });

  it("seconds → 'Xs ago'", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [rowFor({ created_at: new Date(Date.now() - 30_000).toISOString() })],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(container.textContent).toMatch(/30s ago/);
  });

  it("minutes → 'Xm ago'", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [rowFor({ created_at: new Date(Date.now() - 5 * 60_000).toISOString() })],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(container.textContent).toMatch(/5m ago/);
  });

  it("hours → 'Xh ago'", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [rowFor({ created_at: new Date(Date.now() - 3 * 3600_000).toISOString() })],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(container.textContent).toMatch(/3h ago/);
  });

  it("days → 'Xd ago' (within 7 days)", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [rowFor({ created_at: new Date(Date.now() - 2 * 86_400_000).toISOString() })],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(container.textContent).toMatch(/2d ago/);
  });

  it("malformed date → '—' fallback", () => {
    useLiveActivitiesMock.mockReturnValue({
      activities: [rowFor({ created_at: "not a date" })],
      isLoading: false,
      error: null,
      supabaseConfigured: true,
    });
    const { container } = withRouter(<Live />);
    expect(container.querySelector(".ll-live-time")?.textContent).toBe("—");
  });
});

describe("Live — bottom CTA (§15.x)", () => {
  it("CTA section title: 'Add yours to the feed.'", () => {
    const { container } = withRouter(<Live />);
    expect(container.textContent).toContain("Add yours to the feed");
  });

  it("'Launch Blank' CTA links to /app", () => {
    const { container } = withRouter(<Live />);
    const launchCtas = Array.from(container.querySelectorAll("a")).filter((a) =>
      a.textContent?.includes("Launch Blank"),
    );
    expect(launchCtas.length).toBeGreaterThanOrEqual(1);
    for (const cta of launchCtas) {
      expect(cta.getAttribute("href")).toBe("https://app.myblank.app");
    }
  });
});
