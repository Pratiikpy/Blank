import { describe, it, expect } from "vitest";
import { extractEventId } from "./event-parser";

// §15.x lib test for extractEventId. The §1.7 fix changed the return
// type from `number` (with silent zero on miss) to `number | null`
// (explicit miss). Several share-link bugs traced to the old shape
// routing users at id=0; pin the new contract here so it can't drift.

const HUB = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

const TOPIC0 = "0xaaaa000000000000000000000000000000000000000000000000000000000000";

function logEntry(address: string, topics: string[]) {
  return { address, topics };
}

describe("extractEventId", () => {
  it("returns the indexed id from topics[1] when a matching log exists", () => {
    const logs = [
      logEntry(HUB, [
        TOPIC0,
        "0x000000000000000000000000000000000000000000000000000000000000002a",
      ]),
    ];
    expect(extractEventId(logs, HUB)).toBe(42);
  });

  it("returns null when no log targets the contract address", () => {
    const logs = [
      logEntry(OTHER, [TOPIC0, "0x0000000000000000000000000000000000000000000000000000000000000007"]),
    ];
    expect(extractEventId(logs, HUB)).toBeNull();
  });

  it("returns null when logs is empty", () => {
    expect(extractEventId([], HUB)).toBeNull();
  });

  it("matches address case-insensitively", () => {
    const logs = [
      logEntry(HUB.toUpperCase(), [
        TOPIC0,
        "0x0000000000000000000000000000000000000000000000000000000000000005",
      ]),
    ];
    expect(extractEventId(logs, HUB.toLowerCase())).toBe(5);
  });

  it("skips logs with fewer than 2 topics", () => {
    const logs = [
      logEntry(HUB, [TOPIC0]), // only topic0, no indexed id
      logEntry(HUB, [
        TOPIC0,
        "0x0000000000000000000000000000000000000000000000000000000000000003",
      ]),
    ];
    expect(extractEventId(logs, HUB)).toBe(3);
  });

  it("skips logs whose topic[1] is not parseable, falls back to next match", () => {
    const logs = [
      logEntry(HUB, [TOPIC0, "0xnot-a-bigint"]),
      logEntry(HUB, [
        TOPIC0,
        "0x0000000000000000000000000000000000000000000000000000000000000009",
      ]),
    ];
    expect(extractEventId(logs, HUB)).toBe(9);
  });

  it("returns the FIRST match if multiple logs match", () => {
    const logs = [
      logEntry(HUB, [
        TOPIC0,
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      ]),
      logEntry(HUB, [
        TOPIC0,
        "0x0000000000000000000000000000000000000000000000000000000000000002",
      ]),
    ];
    expect(extractEventId(logs, HUB)).toBe(1);
  });

  it("does NOT silently return 0 when no match is found (§1.7 contract)", () => {
    // Pre-§1.7 the function returned 0 on miss, which silently routed
    // share-links to someone else's id-0 record. Post-§1.7 it must
    // return null so callers throw a clear error instead.
    const result = extractEventId([], HUB);
    expect(result).not.toBe(0);
    expect(result).toBeNull();
  });
});
