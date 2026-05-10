import { describe, it, expect } from "vitest";
import { ensClient } from "./ens-client";

// §15.x lib test for the dedicated mainnet client used only for ENS
// resolution. The file's invariant: this client is locked to chain
// id 1 (Ethereum mainnet) so Basenames CCIP-Read works correctly,
// and it is NEVER added to the wagmi chain set so wallets can't be
// invited to switch to mainnet.

describe("ensClient", () => {
  it("is bound to Ethereum mainnet (chain id 1)", () => {
    expect(ensClient.chain?.id).toBe(1);
  });

  it("exposes the mainnet name", () => {
    expect(ensClient.chain?.name.toLowerCase()).toContain("ethereum");
  });

  it("uses a fallback transport so a single RPC blip doesn't break ENS", () => {
    // viem's fallback transport surfaces as `type === "fallback"` on
    // the client.transport. The check defends against an accidental
    // refactor that drops back to a single-URL http() transport.
    expect(ensClient.transport.type).toBe("fallback");
  });
});
