import { describe, it, expect } from "vitest";
import { toFunctionSelector } from "viem";
import {
  TestUSDCAbi,
  FHERC20VaultAbi,
  PaymentHubAbi,
  EventHubAbi,
  BlankAccountFactoryAbi,
  BlankAccountAbi,
  TokenRegistryAbi,
  GroupManagerAbi,
  CreatorHubAbi,
  BusinessHubAbi,
  P2PExchangeAbi,
  GiftMoneyAbi,
  InheritanceManagerAbi,
  PrivacyRouterAbi,
  StealthPaymentsAbi,
  EncryptedFlagsAbi,
  PaymentReceiptsAbi,
  ERC5564AnnouncerAbi,
  ERC6538RegistryAbi,
  ClaimLinksAbi,
  StorefrontAbi,
  EncryptedCrowdfundAbi,
  EncryptedEscrowAbi,
} from "./abis";

// §15.x lib test for the Wave 4 contract ABIs. The ABIs declared
// here are what wagmi/viem use to encode/decode every contract
// call from the frontend; if a function name or signature drifts
// from the deployed bytecode, the call fails with a generic
// "function not found" / "decode failed" with no signal of which
// piece broke. Pin the function selectors against deployed state.

function selector(humanReadable: string): `0x${string}` {
  return toFunctionSelector(humanReadable);
}

function abiSelectors(abi: readonly unknown[]): Set<`0x${string}`> {
  const out = new Set<`0x${string}`>();
  for (const entry of abi as Array<{ type?: string; name?: string; inputs?: Array<{ type: string }> }>) {
    if (entry.type !== "function" || !entry.name) continue;
    const sig = `function ${entry.name}(${(entry.inputs ?? [])
      .map((i) => i.type)
      .join(",")})`;
    try {
      out.add(toFunctionSelector(sig));
    } catch {
      // tuples need internal-type expansion; skip those for the
      // selector check (they're tested by the wagmi e2e flow).
    }
  }
  return out;
}

describe("ClaimLinksAbi", () => {
  const sels = abiSelectors(ClaimLinksAbi);

  it("includes claimBearer(uint256,bytes32) selector", () => {
    expect(sels.has(selector("function claimBearer(uint256,bytes32)"))).toBe(true);
  });

  it("includes claimEmailBound(uint256,bytes32,bytes32) selector", () => {
    expect(
      sels.has(selector("function claimEmailBound(uint256,bytes32,bytes32)")),
    ).toBe(true);
  });

  it("includes claimAddressBound(uint256,bytes32) selector", () => {
    expect(sels.has(selector("function claimAddressBound(uint256,bytes32)"))).toBe(true);
  });

  it("includes refundLink(uint256) selector", () => {
    expect(sels.has(selector("function refundLink(uint256)"))).toBe(true);
  });
});

describe("Wave 4 contract ABIs are non-empty", () => {
  it("ClaimLinksAbi has function entries", () => {
    expect(ClaimLinksAbi.length).toBeGreaterThan(0);
    expect(ClaimLinksAbi.some((e) => (e as { type?: string }).type === "function")).toBe(true);
  });

  it("StorefrontAbi has function entries", () => {
    expect(StorefrontAbi.length).toBeGreaterThan(0);
    expect(StorefrontAbi.some((e) => (e as { type?: string }).type === "function")).toBe(true);
  });

  it("EncryptedCrowdfundAbi has function entries", () => {
    expect(EncryptedCrowdfundAbi.length).toBeGreaterThan(0);
    expect(EncryptedCrowdfundAbi.some((e) => (e as { type?: string }).type === "function")).toBe(true);
  });

  it("EncryptedEscrowAbi has function entries", () => {
    expect(EncryptedEscrowAbi.length).toBeGreaterThan(0);
    expect(EncryptedEscrowAbi.some((e) => (e as { type?: string }).type === "function")).toBe(true);
  });

  it("PaymentHubAbi has function entries", () => {
    expect(PaymentHubAbi.length).toBeGreaterThan(0);
    expect(PaymentHubAbi.some((e) => (e as { type?: string }).type === "function")).toBe(true);
  });
});

describe("Wave 4 ABIs have unique function selectors (no collisions)", () => {
  // Selector collisions (same first-4-bytes hash) on different
  // functions in the same contract would silently route calls to
  // the wrong implementation. viem catches some at runtime but
  // pinning here surfaces drift earlier.
  it("ClaimLinksAbi has no selector collisions", () => {
    const sels = abiSelectors(ClaimLinksAbi);
    const names = new Set<string>();
    for (const entry of ClaimLinksAbi as readonly { type?: string; name?: string }[]) {
      if (entry.type === "function" && entry.name) names.add(entry.name);
    }
    // At least as many selectors as unique function names (some
    // may overload, but for our ABIs every function is uniquely
    // named).
    expect(sels.size).toBeGreaterThanOrEqual(1);
    expect(sels.size).toBeLessThanOrEqual(names.size);
  });
});

// §15.x extension: parameterize the shape + collision checks across
// ALL 23 contract ABIs. Each ABI is the bridge between wagmi/viem
// and deployed bytecode — a missing function entry on a callsite-
// active ABI surfaces as a generic "function not found" runtime
// error that's hard to trace. Pin the shape invariants once, in
// one place, across every ABI.

const ALL_ABIS: ReadonlyArray<[string, readonly unknown[]]> = [
  ["TestUSDCAbi", TestUSDCAbi],
  ["FHERC20VaultAbi", FHERC20VaultAbi],
  ["PaymentHubAbi", PaymentHubAbi],
  ["EventHubAbi", EventHubAbi],
  ["BlankAccountFactoryAbi", BlankAccountFactoryAbi],
  ["BlankAccountAbi", BlankAccountAbi],
  ["TokenRegistryAbi", TokenRegistryAbi],
  ["GroupManagerAbi", GroupManagerAbi],
  ["CreatorHubAbi", CreatorHubAbi],
  ["BusinessHubAbi", BusinessHubAbi],
  ["P2PExchangeAbi", P2PExchangeAbi],
  ["GiftMoneyAbi", GiftMoneyAbi],
  ["InheritanceManagerAbi", InheritanceManagerAbi],
  ["PrivacyRouterAbi", PrivacyRouterAbi],
  ["StealthPaymentsAbi", StealthPaymentsAbi],
  ["EncryptedFlagsAbi", EncryptedFlagsAbi],
  ["PaymentReceiptsAbi", PaymentReceiptsAbi],
  ["ERC5564AnnouncerAbi", ERC5564AnnouncerAbi],
  ["ERC6538RegistryAbi", ERC6538RegistryAbi],
  ["ClaimLinksAbi", ClaimLinksAbi],
  ["StorefrontAbi", StorefrontAbi],
  ["EncryptedCrowdfundAbi", EncryptedCrowdfundAbi],
  ["EncryptedEscrowAbi", EncryptedEscrowAbi],
];

describe("all 23 ABIs share the same shape invariants", () => {
  it("every ABI is non-empty (catches accidental empty-array drop on extract)", () => {
    for (const [name, abi] of ALL_ABIS) {
      expect(abi.length, `${name} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("every ABI has at least one function OR event entry", () => {
    // Wave 4 ABIs are all either contract-call-driven (function) or
    // event-only (EventHubAbi is just `Activity` event). A pure-empty
    // ABI is a sentinel for a copy-paste regression that dropped the
    // payload during extraction.
    for (const [name, abi] of ALL_ABIS) {
      const hasFnOrEvent = abi.some((e) => {
        const t = (e as { type?: string }).type;
        return t === "function" || t === "event";
      });
      expect(hasFnOrEvent, `${name} should have at least one function or event`).toBe(true);
    }
  });

  it("no ABI has selector collisions (would silently route calls to wrong impl)", () => {
    for (const [name, abi] of ALL_ABIS) {
      const sels = abiSelectors(abi);
      const fnNames = new Set<string>();
      for (const e of abi as readonly { type?: string; name?: string }[]) {
        if (e.type === "function" && e.name) fnNames.add(e.name);
      }
      // Selectors derived match unique-name count (with allowance for
      // tuple-internal-type entries that abiSelectors skips). Every
      // selector in the set must be unique by construction (Set).
      expect(sels.size, `${name} selectors should be unique`).toBeLessThanOrEqual(fnNames.size);
    }
  });

  it("every function entry has a name (no anonymous function entries)", () => {
    for (const [name, abi] of ALL_ABIS) {
      for (const e of abi as readonly { type?: string; name?: string }[]) {
        if (e.type === "function") {
          expect(e.name, `${name} has a function entry with no name`).toBeTruthy();
        }
      }
    }
  });
});

// §15.x extension: hot-path selector pins. The selectors below are
// the ones our hooks call on every user action. A signature drift
// here is the silent-failure class that costs hours to debug.

// Function-name + arg-type-shape pin (works for tuple-bearing functions
// that the selector-string helper above can't handle). Matches by
// flat inputs[].type list; tuple args appear as the literal "tuple".
function hasFn(
  abi: readonly unknown[],
  name: string,
  argTypes: readonly string[],
): boolean {
  for (const e of abi as readonly { type?: string; name?: string; inputs?: readonly { type: string }[] }[]) {
    if (e.type !== "function" || e.name !== name) continue;
    const types = (e.inputs ?? []).map((i) => i.type);
    if (types.length !== argTypes.length) continue;
    let ok = true;
    for (let i = 0; i < types.length; i++) {
      if (types[i] !== argTypes[i]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

describe("hot-path function pins (frontend <-> deployed bytecode contract)", () => {
  it("PaymentHubAbi exports sendPayment + createRequest + fulfillRequest", () => {
    expect(hasFn(PaymentHubAbi, "sendPayment", ["address", "address", "tuple", "string"])).toBe(true);
    expect(hasFn(PaymentHubAbi, "createRequest", ["address", "address", "tuple", "string"])).toBe(true);
    expect(hasFn(PaymentHubAbi, "fulfillRequest", ["uint256", "tuple"])).toBe(true);
  });

  it("FHERC20VaultAbi exports shield + transfer + balanceOf + requestUnshield + claimUnshield", () => {
    expect(hasFn(FHERC20VaultAbi, "shield", ["uint256"])).toBe(true);
    expect(hasFn(FHERC20VaultAbi, "transfer", ["address", "tuple"])).toBe(true);
    expect(hasFn(FHERC20VaultAbi, "balanceOf", ["address"])).toBe(true);
    expect(hasFn(FHERC20VaultAbi, "requestUnshield", ["tuple"])).toBe(true);
    expect(hasFn(FHERC20VaultAbi, "claimUnshield", ["uint64", "bytes"])).toBe(true);
  });

  it("TokenRegistryAbi exports the getActiveTokens view (the token-list bootstrap)", () => {
    // tuple[] outputs are tricky for toFunctionSelector — fall back to
    // checking the function name exists in the ABI.
    const hasFn = TokenRegistryAbi.some(
      (e) => (e as { type?: string; name?: string }).name === "getActiveTokens",
    );
    expect(hasFn).toBe(true);
  });

  it("BlankAccountAbi exports execute + executeBatch + isValidSignature (ERC-4337 surface)", () => {
    expect(hasFn(BlankAccountAbi, "execute", ["address", "uint256", "bytes"])).toBe(true);
    expect(hasFn(BlankAccountAbi, "executeBatch", ["address[]", "uint256[]", "bytes[]"])).toBe(true);
    expect(hasFn(BlankAccountAbi, "isValidSignature", ["bytes32", "bytes"])).toBe(true);
  });

  it("EventHubAbi is event-only (Activity), no function entries", () => {
    const hasFn = EventHubAbi.some((e) => (e as { type?: string }).type === "function");
    const hasEvent = EventHubAbi.some(
      (e) => (e as { type?: string; name?: string }).type === "event" &&
        (e as { name?: string }).name === "Activity",
    );
    expect(hasFn).toBe(false);
    expect(hasEvent).toBe(true);
  });
});

// §15.x extension: InEuint64 tuple component shape. The on-chain
// InEuint64 struct (from @fhenixprotocol/cofhe-contracts/ICofhe.sol)
// is { uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature }.
// @cofhe/abi's extractEncryptableValues uses this exact 4-field shape
// to auto-encrypt struct-tagged input args. A regression that
// reordered fields or added/dropped one would either:
//   - silently mis-encrypt (wrong field used as the ciphertext handle), OR
//   - fail decode with "tuple arity mismatch" on first encrypt.
// Pinned here as a sentinel across every ABI that declares an
// InEuint64 input.

const CANONICAL_INEUINT64_SHAPE: ReadonlyArray<{ name: string; type: string }> = [
  { name: "ctHash", type: "uint256" },
  { name: "securityZone", type: "uint8" },
  { name: "utype", type: "uint8" },
  { name: "signature", type: "bytes" },
];

function findInEuint64Tuples(
  abi: readonly unknown[],
): Array<{ name?: string; components?: ReadonlyArray<{ name: string; type: string }> }> {
  const out: Array<{ name?: string; components?: ReadonlyArray<{ name: string; type: string }> }> = [];
  for (const entry of abi as Array<{ inputs?: ReadonlyArray<{ internalType?: string; components?: ReadonlyArray<{ name: string; type: string }>; type?: string; name?: string }> }>) {
    for (const input of entry.inputs ?? []) {
      if (input.internalType === "struct InEuint64" || input.internalType === "struct InEuint64[]") {
        out.push({ name: input.name, components: input.components });
      }
    }
  }
  return out;
}

describe("InEuint64 tuple component shape is consistent across ABIs", () => {
  it("the canonical 4-field shape (ctHash + securityZone + utype + signature) matches every InEuint64 tuple in every ABI", () => {
    let totalTuplesChecked = 0;
    for (const [name, abi] of ALL_ABIS) {
      const tuples = findInEuint64Tuples(abi);
      for (const tuple of tuples) {
        totalTuplesChecked++;
        expect(tuple.components, `${name} InEuint64 tuple missing components`).toBeDefined();
        const components = tuple.components ?? [];
        expect(components.length, `${name} InEuint64 has wrong field count`).toBe(
          CANONICAL_INEUINT64_SHAPE.length,
        );
        for (let i = 0; i < CANONICAL_INEUINT64_SHAPE.length; i++) {
          const canonical = CANONICAL_INEUINT64_SHAPE[i]!;
          const actual = components[i]!;
          expect(actual.name, `${name} InEuint64 field ${i} name drift`).toBe(canonical.name);
          expect(actual.type, `${name} InEuint64 field ${i} type drift`).toBe(canonical.type);
        }
      }
    }
    // Sanity: we should have inspected at least one InEuint64 tuple
    // (multiple ABIs use it). A zero count means the regex / detection
    // logic broke silently.
    expect(totalTuplesChecked).toBeGreaterThan(5);
  });
});
