import { describe, it, expect } from "vitest";
import { chainIdToViemChain, chainIdToViemChainOrNull } from "./viem-chains";
import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID } from "./constants";

// §15.x lib test for the chain-id → viem Chain resolver. The
// strict variant throws on unknown ids; the soft variant returns
// null. The strict path is what hooks like useSendPayment +
// useInheritance went through after the active-chain drift fix
// noted in the file header.

describe("chainIdToViemChain (strict)", () => {
  it("resolves Eth Sepolia", () => {
    const chain = chainIdToViemChain(ETH_SEPOLIA_ID);
    expect(chain.id).toBe(ETH_SEPOLIA_ID);
  });

  it("resolves Base Sepolia", () => {
    const chain = chainIdToViemChain(BASE_SEPOLIA_ID);
    expect(chain.id).toBe(BASE_SEPOLIA_ID);
  });

  it("resolves mainnet", () => {
    const chain = chainIdToViemChain(1);
    expect(chain.id).toBe(1);
  });

  it("throws on unsupported chain id", () => {
    expect(() => chainIdToViemChain(999_999)).toThrow(
      /unsupported chain id 999999/,
    );
  });
});

describe("chainIdToViemChainOrNull (soft)", () => {
  it("returns the chain object for known ids", () => {
    expect(chainIdToViemChainOrNull(ETH_SEPOLIA_ID)?.id).toBe(ETH_SEPOLIA_ID);
    expect(chainIdToViemChainOrNull(BASE_SEPOLIA_ID)?.id).toBe(BASE_SEPOLIA_ID);
    expect(chainIdToViemChainOrNull(1)?.id).toBe(1);
  });

  it("returns null for unknown ids without throwing", () => {
    expect(chainIdToViemChainOrNull(999_999)).toBeNull();
  });
});
