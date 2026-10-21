import { describe, it, expect, beforeEach, vi } from "vitest";
import { decodeFunctionResult, encodeFunctionData, getAbiItem, toEventSelector } from "viem";
import {
  PENDING_EVENT_TOPIC,
  addPendingFunding,
  asHandle,
  describeGateFailure,
  findPendingId,
  listPendingFundings,
  removePendingFunding,
} from "./pending-funding";
import { FundingGateTimeout } from "./funding-gate";
import { CreatorHubAbi, P2POfframpAbi, StorefrontAbi, InheritanceManagerAbi } from "./abis";
import { formatWait } from "./format-wait";

const HUB = "0x2222222222222222222222222222222222222222";
const ME = "0xAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const scope = { kind: "tip", chainId: 11155111, contract: HUB, account: ME } as const;
const pad = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

beforeEach(() => localStorage.clear());

describe("pending-funding store", () => {
  it("adds, lists and removes an entry, scoped by kind, chain, contract and account", () => {
    addPendingFunding(scope, 7n, { creator: "0xbb" });
    expect(listPendingFundings(scope)).toHaveLength(1);
    expect(listPendingFundings(scope)[0]).toMatchObject({ id: "7", data: { creator: "0xbb" } });
    expect(listPendingFundings({ ...scope, kind: "purchase" })).toHaveLength(0);
    expect(listPendingFundings({ ...scope, chainId: 84532 })).toHaveLength(0);
    expect(listPendingFundings({ ...scope, account: "0xcc" })).toHaveLength(0);
    removePendingFunding(scope, 7n);
    expect(listPendingFundings(scope)).toHaveLength(0);
  });

  it("matches addresses case-insensitively", () => {
    addPendingFunding(scope, 1n);
    expect(listPendingFundings({ ...scope, account: ME.toLowerCase() })).toHaveLength(1);
  });

  it("adding the same id twice keeps one entry with the latest data", () => {
    addPendingFunding(scope, 7n, { message: "first" });
    addPendingFunding(scope, 7n, { message: "second" });
    const entries = listPendingFundings(scope);
    expect(entries).toHaveLength(1);
    expect(entries[0].data.message).toBe("second");
  });

  it("drops entries older than 30 days", () => {
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now - 31 * 24 * 3600 * 1000);
    addPendingFunding(scope, 1n);
    spy.mockReturnValue(now);
    addPendingFunding(scope, 2n);
    expect(listPendingFundings(scope).map((e) => e.id)).toEqual(["2"]);
    spy.mockRestore();
  });

  it("survives corrupt storage", () => {
    localStorage.setItem("blank:pending-funding:v1", "{not json");
    expect(listPendingFundings(scope)).toEqual([]);
    localStorage.setItem("blank:pending-funding:v1", JSON.stringify([{ kind: "tip" }, 5, null]));
    expect(listPendingFundings(scope)).toEqual([]);
    expect(() => addPendingFunding(scope, 1n)).not.toThrow();
    expect(listPendingFundings(scope)).toHaveLength(1);
  });

  it("does not throw when storage is unavailable", () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => addPendingFunding(scope, 1n)).not.toThrow();
    set.mockRestore();
  });
});

describe("findPendingId", () => {
  const log = (kind: keyof typeof PENDING_EVENT_TOPIC, id: bigint, address = HUB) => ({
    address,
    topics: [PENDING_EVENT_TOPIC[kind], pad(id)],
  });

  it("reads the id from the Pending event of the right contract and kind", () => {
    expect(findPendingId([log("tip", 7n)], HUB, "tip")).toBe(7n);
    expect(findPendingId([log("tip", 0n)], HUB, "tip")).toBe(0n);
  });

  it("ignores other contracts, other events and missing logs", () => {
    expect(findPendingId([log("tip", 7n, "0x3333333333333333333333333333333333333333")], HUB, "tip")).toBeNull();
    expect(findPendingId([log("fill", 7n)], HUB, "tip")).toBeNull();
    expect(findPendingId([{ address: HUB, topics: ["0xdeadbeef"] }], HUB, "tip")).toBeNull();
    expect(findPendingId(undefined, HUB, "tip")).toBeNull();
    expect(findPendingId([], HUB, "tip")).toBeNull();
  });

  it("finds the event among unrelated logs", () => {
    const noise = { address: HUB, topics: ["0xabc", pad(99n)] };
    expect(findPendingId([noise, log("purchase", 5n)], HUB, "purchase")).toBe(5n);
  });
});

// Hand ABI-encoding of getTip -> (address, address, address, uint8) and
// getPurchase -> (uint256, address, uint8, uint8).
const word = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
const num = (n: number) => n.toString(16).padStart(64, "0");
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

describe("compiled ABI agreement (the topics and calls this module relies on)", () => {
  it("topic0 constants equal the event selectors of the real ABIs", () => {
    expect(PENDING_EVENT_TOPIC.tip).toBe(toEventSelector(getAbiItem({ abi: CreatorHubAbi, name: "TipPending" })));
    expect(PENDING_EVENT_TOPIC.fill).toBe(toEventSelector(getAbiItem({ abi: P2POfframpAbi, name: "FillPending" })));
    expect(PENDING_EVENT_TOPIC.purchase).toBe(toEventSelector(getAbiItem({ abi: StorefrontAbi, name: "PurchasePending" })));
  });

  it("the id is the first indexed argument of each Pending event", () => {
    const first = (abi: readonly unknown[], name: string) =>
      (getAbiItem({ abi: abi as never, name: name as never }) as unknown as { inputs: { indexed: boolean; name: string }[] }).inputs[0];
    expect(first(CreatorHubAbi, "TipPending")).toMatchObject({ indexed: true, name: "tipId" });
    expect(first(P2POfframpAbi, "FillPending")).toMatchObject({ indexed: true, name: "fillId" });
    expect(first(StorefrontAbi, "PurchasePending")).toMatchObject({ indexed: true, name: "purchaseId" });
  });

  it("the funding-gate calls encode with the real ABIs", () => {
    const sig = `0x${"ab".repeat(65)}` as `0x${string}`;
    expect(() => encodeFunctionData({ abi: CreatorHubAbi, functionName: "confirmFunding", args: [7n, true, sig] })).not.toThrow();
    expect(() => encodeFunctionData({ abi: P2POfframpAbi, functionName: "confirmFunding", args: [9n, false, sig] })).not.toThrow();
    expect(() => encodeFunctionData({ abi: P2POfframpAbi, functionName: "takeOfferExpecting", args: [5n, 25_000_000n] })).not.toThrow();
    expect(() => encodeFunctionData({ abi: StorefrontAbi, functionName: "confirmFunding", args: [4n, true, sig] })).not.toThrow();
    expect(() => encodeFunctionData({ abi: InheritanceManagerAbi, functionName: "lastClaimAt", args: [addr(1) as `0x${string}`] })).not.toThrow();
  });

  it("status reads decode to the positions the hooks use", () => {
    const tip = `0x${[addr(1), addr(2), addr(3)].map(word).join("")}${num(2)}` as `0x${string}`;
    const t = decodeFunctionResult({ abi: CreatorHubAbi, functionName: "getTip", data: tip }) as readonly unknown[];
    expect(Number(t[3])).toBe(2);
    const purchase = `0x${num(7)}${word(addr(1))}${num(0)}${num(3)}` as `0x${string}`;
    const p = decodeFunctionResult({ abi: StorefrontAbi, functionName: "getPurchase", data: purchase }) as readonly unknown[];
    expect(Number(p[3])).toBe(3);
  });
});

describe("asHandle", () => {
  it("accepts a bigint (uint256-declared ebool) and a hex string (bytes32-declared)", () => {
    expect(asHandle(7n)).toBe(7n);
    expect(asHandle(`0x${"00".repeat(32)}`)).toBe(0n);
    expect(asHandle(pad(255n))).toBe(255n);
  });

  it("rejects anything else rather than guessing", () => {
    expect(() => asHandle(undefined)).toThrow();
    expect(() => asHandle("12")).toThrow();
    expect(() => asHandle(null)).toThrow();
  });
});

describe("describeGateFailure", () => {
  it("a timeout and a real error read differently, and keep the note", () => {
    const t = describeGateFailure(new FundingGateTimeout("The funding check"), "It stays pending.");
    expect(t).toMatch(/not ready yet/);
    expect(t).toMatch(/It stays pending\./);
    const e = describeGateFailure(new Error("rpc: nonce too low"), "It stays pending.");
    expect(e).toMatch(/rpc: nonce too low/);
    expect(e).toMatch(/It stays pending\./);
  });

  it("clips a very long reason", () => {
    const msg = describeGateFailure(new Error("x".repeat(500)), "n");
    expect(msg.length).toBeLessThan(260);
  });
});

describe("formatWait", () => {
  it("formats hours and minutes, rounding up so the shown wait is never short", () => {
    expect(formatWait(0)).toBe("under a minute");
    expect(formatWait(59)).toBe("under a minute");
    expect(formatWait(60)).toBe("1m");
    expect(formatWait(61)).toBe("2m");
    expect(formatWait(3600)).toBe("1h");
    expect(formatWait(3601)).toBe("1h 1m");
    expect(formatWait(22 * 3600)).toBe("22h");
    expect(formatWait(86400)).toBe("24h");
    expect(formatWait(3599 + 3600)).toBe("2h");
  });
});
