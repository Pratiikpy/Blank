import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// §15.x test for Verify. Public verification page that resolves
// /verify/:proofId for shared encrypted-proof links. 5 visible
// states: loading -> rpc-error / not-found / ready-true /
// ready-false / pending-publish. The pending-publish state lets
// ANYONE with a connected wallet finalize the proof on-chain
// (no special permission needed). The flow is designed so a
// recipient with the URL can verify the claim themselves
// without the prover's involvement.
//
// CRITICAL pins:
//   - 5-state title routing in the hero: 'Loading proof...' /
//     'Network error' / 'Proof not found' / 'Verified ✓' /
//     'Not verified ✗' / 'Pending verification'; pinned per
//     state via mock-driven fetchProof returns.
//   - URL ?chain= param auto-switches the chain via setActiveChain
//     so a recipient on a different chain than the proof's
//     home chain sees the right network without manual switch;
//     test pins via useSearchParams fixture.
//   - BigInt(proofIdStr) try/catch returns null for malformed
//     ids (e.g. 'abc'), routes to notFound state without
//     crashing; pinned by passing a non-numeric proof id and
//     asserting the not-found UI.
//   - rpcError state: fetchProof throwing -> 'Network error.
//     Try again' message + retry button + chain-name hint
//     ('We couldn't reach <chain>'); retry button calls refresh
//     which re-runs fetchProof.
//   - notFound state: fetchProof returning null -> 'Proof
//     {id} doesn't exist on <chain>' + 'Back to Blank' link
//     to '/'; pinned per chain-name interpolation so a regression
//     that dropped activeChain.name from the message would
//     leave the user confused about why they don't see their
//     proof.
//   - ready-true verdict: CheckCircle2 icon + 'Verified ✓' +
//     'Confirmed by Fhenix Threshold Network' status + Twitter
//     share button with TRUE-specific tweet copy that includes
//     the threshold amount.
//   - ready-false verdict: XCircle icon + 'Not verified ✗' +
//     'Disproven by Fhenix Threshold Network' status + Twitter
//     share with FALSE-specific tweet copy that emphasizes
//     'no amount was leaked'.
//   - pending-publish state: !isReady + isConnected=false ->
//     'Connect a wallet to publish' hint; !isReady + isConnected
//     -> 'Verify on-chain' button that calls publishProof;
//     during publish, button shows 'Decrypting...' / 'Publishing...'
//     per step state; success triggers refresh.

const useAccountMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const useQualificationProofMock = vi.hoisted(() => vi.fn());

vi.mock("wagmi", () => ({ useAccount: useAccountMock }));
vi.mock("@/providers/ChainProvider", () => ({ useChain: useChainMock }));
vi.mock("@/hooks/useQualificationProof", () => ({
  useQualificationProof: useQualificationProofMock,
}));
vi.mock("./LandingNav", () => ({
  LandingNav: () => <nav data-testid="landing-nav-stub">Nav</nav>,
}));
vi.mock("./LandingFooter", () => ({
  LandingFooter: () => <footer data-testid="landing-footer-stub">Footer</footer>,
}));
vi.mock("./landing.css", () => ({}));
vi.mock("./how-it-works.css", () => ({}));
vi.mock("./verify.css", () => ({}));

import Verify from "./Verify";

const fetchProofMock = vi.fn();
const publishProofMock = vi.fn();
const setActiveChainMock = vi.fn();

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/verify/:proofId" element={<Verify />} />
      </Routes>
    </MemoryRouter>,
  );
}

function makeProof(overrides: Record<string, unknown> = {}) {
  return {
    proofId: 7n,
    prover: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    threshold: 50_000_000n, // $50
    isReady: true,
    isTrue: true,
    blockNumber: 12345n,
    timestamp: 1700000000n,
    ...overrides,
  };
}

beforeEach(() => {
  useAccountMock.mockReset();
  useChainMock.mockReset();
  useQualificationProofMock.mockReset();
  fetchProofMock.mockReset();
  publishProofMock.mockReset();
  setActiveChainMock.mockReset();

  useAccountMock.mockReturnValue({ isConnected: true });
  useChainMock.mockReturnValue({
    activeChain: {
      id: 11155111,
      name: "Sepolia",
      explorerUrl: "https://sepolia.etherscan.io",
    },
    activeChainId: 11155111,
    setActiveChain: setActiveChainMock,
  });
  useQualificationProofMock.mockReturnValue({
    fetchProof: fetchProofMock,
    publishProof: publishProofMock,
    step: "idle",
  });
  fetchProofMock.mockResolvedValue(null);
  publishProofMock.mockResolvedValue(true);
});

// ───────────────────────────────────────────────────────────
//  Loading state
// ───────────────────────────────────────────────────────────

describe("Verify — loading state (§15.x)", () => {
  it("renders 'Loading proof...' + 'Reading proof from chain...' while fetchProof pending", () => {
    // fetchProof returns a never-resolving promise -> loading stays true
    fetchProofMock.mockReturnValue(new Promise(() => {}));
    renderAt("/verify/7");
    expect(screen.getByText("Loading proof...")).toBeInTheDocument();
    expect(screen.getByText(/Reading proof from chain/)).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────
//  RPC error state
// ───────────────────────────────────────────────────────────

describe("Verify — rpc-error state (§15.x)", () => {
  it("fetchProof throws -> 'Network error' title + retry button + chain-name hint", async () => {
    fetchProofMock.mockRejectedValue(new Error("RPC down"));
    renderAt("/verify/7");
    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
    expect(screen.getByText(/Network error\. Try again/)).toBeInTheDocument();
    expect(screen.getByText(/We couldn't reach/)).toBeInTheDocument();
    expect(screen.getByText("Sepolia")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });

  it("retry button click -> refresh re-runs fetchProof", async () => {
    fetchProofMock.mockRejectedValueOnce(new Error("RPC down"));
    fetchProofMock.mockResolvedValueOnce(makeProof());
    renderAt("/verify/7");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Retry/ })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await waitFor(() => {
      expect(fetchProofMock).toHaveBeenCalledTimes(2);
    });
  });
});

// ───────────────────────────────────────────────────────────
//  Not-found state
// ───────────────────────────────────────────────────────────

describe("Verify — not-found state (§15.x)", () => {
  it("fetchProof returns null -> 'Proof not found' title + proofId in body", async () => {
    fetchProofMock.mockResolvedValue(null);
    renderAt("/verify/999");
    await waitFor(() => {
      expect(screen.getByText("Proof not found")).toBeInTheDocument();
    });
    expect(screen.getByText("999")).toBeInTheDocument();
  });

  it("not-found state includes chain-name in message + 'Back to Blank' link", async () => {
    fetchProofMock.mockResolvedValue(null);
    renderAt("/verify/999");
    await waitFor(() => {
      expect(screen.getByText("Proof not found")).toBeInTheDocument();
    });
    // Find the Sepolia mention inside the not-found message specifically
    expect(screen.getAllByText("Sepolia").length).toBeGreaterThan(0);
    const backLink = screen.getByRole("link", { name: /Back to Blank/ });
    expect((backLink as HTMLAnchorElement).getAttribute("href")).toBe("/");
  });

  it("malformed proofId (non-numeric) -> not-found state without crashing", async () => {
    // Note: BigInt('abc') throws; the source catches and sets notFound
    renderAt("/verify/not-a-bigint");
    await waitFor(() => {
      expect(screen.getByText("Proof not found")).toBeInTheDocument();
    });
    // fetchProof should NOT have been called for an invalid id
    expect(fetchProofMock).toHaveBeenCalledTimes(0);
  });
});

// ───────────────────────────────────────────────────────────
//  ready-true verdict
// ───────────────────────────────────────────────────────────

describe("Verify — ready-true verdict (§15.x)", () => {
  it("isReady=true + isTrue=true -> 'Verified ✓' title + 'Confirmed by Fhenix' status", async () => {
    fetchProofMock.mockResolvedValue(makeProof({ isTrue: true }));
    renderAt("/verify/7");
    await waitFor(() => {
      expect(screen.getByText(/Verified ✓/)).toBeInTheDocument();
    });
    expect(
      screen.getByText("Confirmed by Fhenix Threshold Network"),
    ).toBeInTheDocument();
  });

  it("threshold rendered as 'Income ≥ $50' with locale formatting", async () => {
    fetchProofMock.mockResolvedValue(
      makeProof({ threshold: 50_000_000n, isTrue: true }),
    );
    renderAt("/verify/7");
    await waitFor(() => {
      expect(screen.getByText(/Income ≥ \$50/)).toBeInTheDocument();
    });
  });

  it("Twitter share button uses TRUE-specific tweet copy", async () => {
    fetchProofMock.mockResolvedValue(makeProof({ isTrue: true }));
    renderAt("/verify/7");
    await waitFor(() => {
      expect(screen.getByText(/Share on X/)).toBeInTheDocument();
    });
    const share = screen.getByText(/Share on X/).closest("a") as HTMLAnchorElement;
    const tweetText = decodeURIComponent(share.href.split("text=")[1]!);
    expect(tweetText).toContain("TRUE");
    expect(tweetText).toContain("without revealing");
  });

  it("ready-true does NOT show 'Verify on-chain' publish button (already published)", async () => {
    fetchProofMock.mockResolvedValue(makeProof({ isReady: true, isTrue: true }));
    renderAt("/verify/7");
    await waitFor(() => {
      expect(screen.getByText(/Verified ✓/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Verify on-chain/ })).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────
//  ready-false verdict
// ───────────────────────────────────────────────────────────

describe("Verify — ready-false verdict (§15.x)", () => {
  it("isReady=true + isTrue=false -> 'Not verified ✗' title + 'Disproven by Fhenix' status", async () => {
    fetchProofMock.mockResolvedValue(makeProof({ isTrue: false }));
    renderAt("/verify/7");
    await waitFor(() => {
      expect(screen.getByText(/Not verified ✗/)).toBeInTheDocument();
    });
    expect(
      screen.getByText("Disproven by Fhenix Threshold Network"),
    ).toBeInTheDocument();
  });

  it("Twitter share uses FALSE-specific tweet copy ('no amount was leaked')", async () => {
    fetchProofMock.mockResolvedValue(makeProof({ isTrue: false }));
    renderAt("/verify/7");
    await waitFor(() => {
      expect(screen.getByText(/Share on X/)).toBeInTheDocument();
    });
    const share = screen.getByText(/Share on X/).closest("a") as HTMLAnchorElement;
    const tweetText = decodeURIComponent(share.href.split("text=")[1]!);
    expect(tweetText).toContain("FALSE");
    expect(tweetText).toContain("no amount was leaked");
  });
});

// ───────────────────────────────────────────────────────────
//  Pending-publish state
// ───────────────────────────────────────────────────────────

describe("Verify — pending-publish state (§15.x)", () => {
  it("isReady=false + isConnected=false -> 'Connect a wallet' hint (NO button)", async () => {
    useAccountMock.mockReturnValue({ isConnected: false });
    fetchProofMock.mockResolvedValue(makeProof({ isReady: false }));
    renderAt("/verify/7");
    await waitFor(() => {
      expect(screen.getByText(/Pending verification/)).toBeInTheDocument();
    });
    expect(screen.getByText(/Connect a wallet to publish/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Verify on-chain/ })).toBeNull();
  });

  it("isReady=false + isConnected=true -> 'Verify on-chain' button visible", async () => {
    useAccountMock.mockReturnValue({ isConnected: true });
    fetchProofMock.mockResolvedValue(makeProof({ isReady: false }));
    renderAt("/verify/7");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Verify on-chain/ })).toBeInTheDocument();
    });
  });

  it("Verify on-chain click -> publishProof called + refresh on success", async () => {
    fetchProofMock.mockResolvedValueOnce(makeProof({ isReady: false }));
    fetchProofMock.mockResolvedValueOnce(makeProof({ isReady: true, isTrue: true }));
    publishProofMock.mockResolvedValue(true);
    renderAt("/verify/7");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Verify on-chain/ })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Verify on-chain/ }));
    await waitFor(() => {
      expect(publishProofMock).toHaveBeenCalledWith(7n);
    });
    await waitFor(() => {
      expect(fetchProofMock).toHaveBeenCalledTimes(2); // initial + refresh
    });
  });

  it("step='decrypting' -> button shows 'Decrypting...' + disabled", async () => {
    fetchProofMock.mockResolvedValue(makeProof({ isReady: false }));
    useQualificationProofMock.mockReturnValue({
      fetchProof: fetchProofMock,
      publishProof: publishProofMock,
      step: "decrypting",
    });
    renderAt("/verify/7");
    await waitFor(() => {
      expect(screen.getByText(/Decrypting/)).toBeInTheDocument();
    });
    const btn = screen.getByText(/Decrypting/).closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("step='publishing' -> button shows 'Publishing...' + disabled", async () => {
    fetchProofMock.mockResolvedValue(makeProof({ isReady: false }));
    useQualificationProofMock.mockReturnValue({
      fetchProof: fetchProofMock,
      publishProof: publishProofMock,
      step: "publishing",
    });
    renderAt("/verify/7");
    await waitFor(() => {
      expect(screen.getByText(/Publishing/)).toBeInTheDocument();
    });
    const btn = screen.getByText(/Publishing/).closest("button") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────
//  Auto-switch chain from ?chain= URL param
// ───────────────────────────────────────────────────────────

describe("Verify — chain auto-switch from URL param (§15.x)", () => {
  it("?chain=84532 with active=11155111 -> setActiveChain(84532) fires", async () => {
    fetchProofMock.mockResolvedValue(makeProof());
    renderAt("/verify/7?chain=84532");
    await waitFor(() => {
      expect(setActiveChainMock).toHaveBeenCalledWith(84532);
    });
  });

  it("?chain= matches activeChainId -> setActiveChain NOT called (no-op)", async () => {
    fetchProofMock.mockResolvedValue(makeProof());
    renderAt("/verify/7?chain=11155111");
    await waitFor(() => {
      expect(fetchProofMock).toHaveBeenCalled();
    });
    expect(setActiveChainMock).toHaveBeenCalledTimes(0);
  });

  it("no ?chain= param -> setActiveChain NOT called", async () => {
    fetchProofMock.mockResolvedValue(makeProof());
    renderAt("/verify/7");
    await waitFor(() => {
      expect(fetchProofMock).toHaveBeenCalled();
    });
    expect(setActiveChainMock).toHaveBeenCalledTimes(0);
  });
});
