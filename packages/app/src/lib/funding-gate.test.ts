import { describe, it, expect, vi } from "vitest";
import { runFundingGate, supportsFundingGate, FundingGateTimeout } from "./funding-gate";

const SIG = "0xabc" as const;
const noSleep = async () => {};

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe("runFundingGate", () => {
  it("decrypts the bit and confirms with the signature", async () => {
    const confirm = vi.fn(async () => {});
    const res = await runFundingGate({
      readHandle: async () => 7n,
      decryptForTx: async () => ({ decryptedValue: true, signature: SIG }),
      confirm,
      sleep: noSleep,
    });
    expect(res).toEqual({ funded: true });
    expect(confirm).toHaveBeenCalledWith(true, SIG);
  });

  it("reports an unfunded verdict and still confirms it (so the item is voided)", async () => {
    const confirm = vi.fn(async () => {});
    const res = await runFundingGate({
      readHandle: async () => 7n,
      decryptForTx: async () => ({ decryptedValue: 0n, signature: SIG }),
      confirm,
      sleep: noSleep,
    });
    expect(res).toEqual({ funded: false });
    expect(confirm).toHaveBeenCalledWith(false, SIG);
  });

  it("waits for a lagging RPC to return the handle", async () => {
    let calls = 0;
    const c = clock();
    const res = await runFundingGate({
      readHandle: async () => (++calls < 4 ? 0n : 9n),
      decryptForTx: async (h) => (h === 9n ? { decryptedValue: true, signature: SIG } : null),
      confirm: async () => {},
      ...c,
    });
    expect(res.funded).toBe(true);
    expect(calls).toBe(4);
  });

  it("treats a throwing read as not-ready and keeps polling", async () => {
    let calls = 0;
    const c = clock();
    await runFundingGate({
      readHandle: async () => { if (++calls < 3) throw new Error("rpc"); return 5n; },
      decryptForTx: async () => ({ decryptedValue: true, signature: SIG }),
      confirm: async () => {},
      ...c,
    });
    expect(calls).toBe(3);
  });

  it("polls decryptForTx until the Threshold Network answers", async () => {
    let calls = 0;
    const c = clock();
    const res = await runFundingGate({
      readHandle: async () => 1n,
      decryptForTx: async () => (++calls < 3 ? null : { decryptedValue: true, signature: SIG }),
      confirm: async () => {},
      ...c,
    });
    expect(res.funded).toBe(true);
    expect(calls).toBe(3);
  });

  it("times out when the handle never appears", async () => {
    const c = clock();
    await expect(
      runFundingGate({ readHandle: async () => 0n, decryptForTx: async () => null, confirm: async () => {}, timeoutMs: 10_000, ...c }),
    ).rejects.toBeInstanceOf(FundingGateTimeout);
  });

  it("times out when the decryption never arrives, without calling confirm", async () => {
    const c = clock();
    const confirm = vi.fn(async () => {});
    await expect(
      runFundingGate({ readHandle: async () => 3n, decryptForTx: async () => null, confirm, timeoutMs: 10_000, ...c }),
    ).rejects.toBeInstanceOf(FundingGateTimeout);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("retries confirm on a transient revert, then succeeds", async () => {
    let n = 0;
    const confirm = vi.fn(async () => { if (++n < 3) throw new Error("execution reverted"); });
    const res = await runFundingGate({
      readHandle: async () => 1n,
      decryptForTx: async () => ({ decryptedValue: true, signature: SIG }),
      confirm,
      sleep: noSleep,
    });
    expect(res.funded).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it("asks for a fresh decryption on every confirm retry, so a bad signer can be replaced", async () => {
    const sigs = ["0x01", "0x02", "0x03"] as const;
    let d = 0;
    const seen: string[] = [];
    const res = await runFundingGate({
      readHandle: async () => 1n,
      decryptForTx: async () => ({ decryptedValue: true, signature: sigs[d++] }),
      confirm: async (_f, sig) => { seen.push(sig); if (sig !== "0x03") throw new Error("InvalidSigner"); },
      sleep: noSleep,
    });
    expect(res.funded).toBe(true);
    expect(seen).toEqual(["0x01", "0x02", "0x03"]);
  });

  it("rethrows the last confirm error once retries are used up", async () => {
    const confirm = vi.fn(async () => { throw new Error("still reverted"); });
    await expect(
      runFundingGate({
        readHandle: async () => 1n,
        decryptForTx: async () => ({ decryptedValue: true, signature: SIG }),
        confirm,
        confirmRetries: 2,
        sleep: noSleep,
      }),
    ).rejects.toThrow("still reverted");
    expect(confirm).toHaveBeenCalledTimes(3);
  });
});

describe("supportsFundingGate", () => {
  it("is true when the probe resolves", async () => {
    expect(await supportsFundingGate(async () => 0n)).toBe(true);
  });
  it("is false when the contract has no such function", async () => {
    expect(await supportsFundingGate(async () => { throw new Error("function not found"); })).toBe(false);
  });
});
