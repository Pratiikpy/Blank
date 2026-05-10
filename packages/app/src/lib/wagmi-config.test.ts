import { describe, it, expect } from "vitest";
import { wagmiConfig } from "./wagmi-config";
import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID } from "./constants";

// §15.x lib test for the wagmi config singleton. Pins the chain
// allowlist + transport-per-chain mapping so a refactor can't
// silently drop a chain or accidentally route writes through the
// wrong transport.

describe("wagmiConfig", () => {
  it("exposes Eth Sepolia AND Base Sepolia (both Wave 3+ chains)", () => {
    const ids = wagmiConfig.chains.map((c) => c.id);
    expect(ids).toContain(ETH_SEPOLIA_ID);
    expect(ids).toContain(BASE_SEPOLIA_ID);
  });

  it("includes only the 2 supported chains (no mainnet leak)", () => {
    expect(wagmiConfig.chains.length).toBe(2);
    const ids = wagmiConfig.chains.map((c) => c.id);
    expect(ids).not.toContain(1); // mainnet must NOT appear
  });

  it("registers a transport for every chain in the chain set", () => {
    for (const chain of wagmiConfig.chains) {
      // Just check the transport entry exists; full transport-shape
      // verification happens in the rpc.test.ts URL list.
      const transport = (wagmiConfig as unknown as { _internal: { transports: Record<number, unknown> } })
        ._internal.transports[chain.id];
      expect(transport).toBeDefined();
    }
  });

  it("has at least one connector wired (injected)", () => {
    expect(wagmiConfig.connectors.length).toBeGreaterThanOrEqual(1);
    const types = wagmiConfig.connectors.map((c) => c.type);
    expect(types).toContain("injected");
  });
});
