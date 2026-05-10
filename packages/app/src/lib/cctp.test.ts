import { describe, it, expect } from "vitest";
import {
  addressToBytes32,
  hashMessage,
  planBridge,
  CCTP_FINALITY,
  CCTP_DOMAIN,
  CCTP_TOKEN_MESSENGER_V2,
  CCTP_USDC,
  CCTP_MESSAGE_TRANSMITTER_V2,
} from "./cctp";
import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID } from "./constants";
import type { Address, Hex } from "viem";

// §15.x lib test for the CCTP V2 bridge-plan helpers. The cross-chain
// USDC bridge depends on these getting the bytes32-encoding, fee
// math, and per-chain address routing exactly right; one wrong byte
// in mintRecipient32 sends user funds to a black hole.

const ALICE = "0x1234567890abcdef1234567890abcdef12345678" as Address;

describe("addressToBytes32", () => {
  it("encodes a 20-byte address as a left-padded 32-byte hex (ABI-encoded)", () => {
    const out = addressToBytes32(ALICE);
    // viem's encodeAbiParameters left-pads addresses with zeros.
    expect(out).toBe(
      "0x0000000000000000000000001234567890abcdef1234567890abcdef12345678",
    );
    expect(out.length).toBe(2 + 64); // "0x" + 32 bytes
  });

  it("produces a hex output that ends with the original address bytes", () => {
    const out = addressToBytes32(ALICE);
    expect(out.slice(-40).toLowerCase()).toBe(ALICE.slice(2).toLowerCase());
  });
});

describe("hashMessage", () => {
  it("returns a 32-byte keccak hash with the 0x prefix", () => {
    const out = hashMessage("0xdeadbeef" as Hex);
    expect(out).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    const a = hashMessage("0xabcd" as Hex);
    const b = hashMessage("0xabcd" as Hex);
    expect(a).toBe(b);
  });

  it("produces distinct hashes for distinct inputs", () => {
    const a = hashMessage("0xabcd" as Hex);
    const b = hashMessage("0xabce" as Hex);
    expect(a).not.toBe(b);
  });
});

describe("planBridge", () => {
  it("rejects source === destination", () => {
    expect(() =>
      planBridge({
        sourceChain: ETH_SEPOLIA_ID,
        destChain: ETH_SEPOLIA_ID,
        recipient: ALICE,
        amountUnits: 1_000_000n,
      }),
    ).toThrow(/source and destination must differ/);
  });

  it("rejects zero / negative amount", () => {
    expect(() =>
      planBridge({
        sourceChain: ETH_SEPOLIA_ID,
        destChain: BASE_SEPOLIA_ID,
        recipient: ALICE,
        amountUnits: 0n,
      }),
    ).toThrow(/amount must be > 0/);
  });

  it("defaults to FAST speed with auto-derived maxFee = amount/200 (0.5%)", () => {
    const plan = planBridge({
      sourceChain: ETH_SEPOLIA_ID,
      destChain: BASE_SEPOLIA_ID,
      recipient: ALICE,
      amountUnits: 100_000_000n, // 100 USDC
    });
    expect(plan.minFinalityThreshold).toBe(CCTP_FINALITY.FAST);
    expect(plan.maxFee).toBe(500_000n); // 100 USDC / 200 = 0.5 USDC
    expect(plan.amountUnits).toBe(100_000_000n);
  });

  it("FINALIZED speed uses 0 maxFee", () => {
    const plan = planBridge({
      sourceChain: ETH_SEPOLIA_ID,
      destChain: BASE_SEPOLIA_ID,
      recipient: ALICE,
      amountUnits: 100_000_000n,
      speed: "finalized",
    });
    expect(plan.minFinalityThreshold).toBe(CCTP_FINALITY.FINALIZED);
    expect(plan.maxFee).toBe(0n);
  });

  it("respects a maxFeeUnits override on FAST speed", () => {
    const plan = planBridge({
      sourceChain: ETH_SEPOLIA_ID,
      destChain: BASE_SEPOLIA_ID,
      recipient: ALICE,
      amountUnits: 100_000_000n,
      maxFeeUnits: 1_000_000n,
    });
    expect(plan.maxFee).toBe(1_000_000n);
  });

  it("routes mintRecipient32 through addressToBytes32", () => {
    const plan = planBridge({
      sourceChain: ETH_SEPOLIA_ID,
      destChain: BASE_SEPOLIA_ID,
      recipient: ALICE,
      amountUnits: 1_000_000n,
    });
    expect(plan.mintRecipient32).toBe(addressToBytes32(ALICE));
  });

  it("uses bytes32(0) as destinationCaller (anyone can broadcast receive)", () => {
    const plan = planBridge({
      sourceChain: ETH_SEPOLIA_ID,
      destChain: BASE_SEPOLIA_ID,
      recipient: ALICE,
      amountUnits: 1_000_000n,
    });
    expect(plan.destinationCaller32).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("routes the per-chain address constants correctly", () => {
    const plan = planBridge({
      sourceChain: ETH_SEPOLIA_ID,
      destChain: BASE_SEPOLIA_ID,
      recipient: ALICE,
      amountUnits: 1_000_000n,
    });
    expect(plan.sourceTokenMessenger).toBe(CCTP_TOKEN_MESSENGER_V2[ETH_SEPOLIA_ID]);
    expect(plan.sourceUsdc).toBe(CCTP_USDC[ETH_SEPOLIA_ID]);
    expect(plan.destMessageTransmitter).toBe(CCTP_MESSAGE_TRANSMITTER_V2[BASE_SEPOLIA_ID]);
    expect(plan.destDomain).toBe(CCTP_DOMAIN[BASE_SEPOLIA_ID]);
  });

  it("CCTP domain ids: Eth Sepolia=0, Base Sepolia=6 (per Circle spec)", () => {
    expect(CCTP_DOMAIN[ETH_SEPOLIA_ID]).toBe(0);
    expect(CCTP_DOMAIN[BASE_SEPOLIA_ID]).toBe(6);
  });
});
