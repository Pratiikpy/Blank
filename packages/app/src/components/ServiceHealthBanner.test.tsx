import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

vi.mock("@/hooks/useServiceHealth", () => ({
  useServiceHealth: vi.fn(),
}));

import { ServiceHealthBanner } from "./ServiceHealthBanner";
import { useServiceHealth } from "@/hooks/useServiceHealth";

const useServiceHealthMock = useServiceHealth as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  useServiceHealthMock.mockReset();
  window.history.pushState({}, "", "/app");
});

const ALL_REACHABLE = {
  loading: false,
  supabaseReachable: true,
  fhenixReachable: true,
  relayReachable: true,
  agentsReachable: true,
};

describe("ServiceHealthBanner (§15.x)", () => {
  it("renders nothing during initial loading", () => {
    useServiceHealthMock.mockReturnValue({ ...ALL_REACHABLE, loading: true });
    const { container } = render(<ServiceHealthBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when everything is reachable (silent on healthy)", () => {
    useServiceHealthMock.mockReturnValue(ALL_REACHABLE);
    const { container } = render(<ServiceHealthBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing on marketing routes even when a service is degraded", () => {
    window.history.pushState({}, "", "/features");
    useServiceHealthMock.mockReturnValue({
      ...ALL_REACHABLE,
      relayReachable: false,
    });
    const { container } = render(<ServiceHealthBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("offline (supabaseReachable=false) wins highest priority", () => {
    useServiceHealthMock.mockReturnValue({
      ...ALL_REACHABLE,
      supabaseReachable: false,
      fhenixReachable: false, // even when other things are ALSO down
    });
    const { getByText } = render(<ServiceHealthBanner />);
    expect(getByText("You're offline")).toBeDefined();
  });

  it("Fhenix unreachable shows the FHE-network-degraded banner", () => {
    useServiceHealthMock.mockReturnValue({
      ...ALL_REACHABLE,
      fhenixReachable: false,
    });
    const { getByText } = render(<ServiceHealthBanner />);
    expect(getByText("FHE network degraded")).toBeDefined();
  });

  it("relay unreachable shows the smart-wallet-relay banner", () => {
    useServiceHealthMock.mockReturnValue({
      ...ALL_REACHABLE,
      relayReachable: false,
    });
    const { getByText } = render(<ServiceHealthBanner />);
    expect(getByText("Smart-wallet relay unavailable")).toBeDefined();
  });

  it("agents unreachable shows the AI-agents banner", () => {
    useServiceHealthMock.mockReturnValue({
      ...ALL_REACHABLE,
      agentsReachable: false,
    });
    const { getByText } = render(<ServiceHealthBanner />);
    expect(getByText("AI agents unavailable")).toBeDefined();
  });

  it("priority order: offline > fhenix > relay > agents (only one banner at a time)", () => {
    // All four down: offline must win (highest impact, most likely cause).
    useServiceHealthMock.mockReturnValue({
      loading: false,
      supabaseReachable: false,
      fhenixReachable: false,
      relayReachable: false,
      agentsReachable: false,
    });
    const { getByText, queryByText } = render(<ServiceHealthBanner />);
    expect(getByText("You're offline")).toBeDefined();
    expect(queryByText("FHE network degraded")).toBeNull();
    expect(queryByText("Smart-wallet relay unavailable")).toBeNull();
    expect(queryByText("AI agents unavailable")).toBeNull();
  });

  it("offline banner uses the offline tone (gray, not amber)", () => {
    useServiceHealthMock.mockReturnValue({
      ...ALL_REACHABLE,
      supabaseReachable: false,
    });
    const { container } = render(<ServiceHealthBanner />);
    const div = container.firstChild as HTMLElement;
    // Class string contains "bg-gray-100" (offline tone) NOT "bg-amber".
    expect(div.className).toContain("bg-gray");
    expect(div.className).not.toContain("bg-amber");
  });
});
