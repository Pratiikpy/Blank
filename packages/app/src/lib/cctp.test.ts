import { describe, it, expect, vi, afterEach } from "vitest";
import {
  addressToBytes32,
  hashMessage,
  planBridge,
  pollAttestation,
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

// §15.x extension: pollAttestation — the Circle Iris poller that
// waits for the CCTP attestation after a burn tx. A regression here
// either hangs the bridge UI forever (no progress signal) or returns
// the wrong shape (sends bad message + attestation to receiveMessage,
// which reverts with a hard-to-trace error). 10+ branches across
// network errors, 404 propagation delay, partial-success retries,
// version filtering, and AbortSignal cancellation.
//
// Test strategy: pollIntervalMs=0 + timeoutMs in the 1-2s range to
// keep tests fast. Mock fetch via vi.stubGlobal so each test scripts
// its own response sequence.

const TX_HASH = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex;
const MESSAGE = "0xdead" as Hex;
const ATTESTATION = "0xbeef" as Hex;

function mkResponse(opts: { status?: number; json?: unknown; networkError?: boolean }): Response {
  if (opts.networkError) throw new Error("network error");
  return {
    status: opts.status ?? 200,
    ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
    json: async () => opts.json,
  } as unknown as Response;
}

function makeFetchSequence(responses: Array<Parameters<typeof mkResponse>[0] | Error>) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return mkResponse(r);
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pollAttestation (Circle Iris attestation poller)", () => {
  it("resolves with { message, attestation } when Iris returns a complete v2 message on the first poll", async () => {
    const fetchMock = makeFetchSequence([
      {
        status: 200,
        json: {
          messages: [
            { message: MESSAGE, attestation: ATTESTATION, status: "complete", cctpVersion: 2 },
          ],
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollAttestation({
      sourceDomain: 0,
      txHash: TX_HASH,
      pollIntervalMs: 0,
      timeoutMs: 500,
    });
    expect(result).toEqual({ message: MESSAGE, attestation: ATTESTATION });
  });

  it("emits onProgress('propagating') on 404 and keeps polling until ready", async () => {
    const onProgress = vi.fn();
    const fetchMock = makeFetchSequence([
      { status: 404 },
      { status: 404 },
      {
        status: 200,
        json: {
          messages: [
            { message: MESSAGE, attestation: ATTESTATION, status: "complete", cctpVersion: 2 },
          ],
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollAttestation({
      sourceDomain: 0,
      txHash: TX_HASH,
      pollIntervalMs: 0,
      timeoutMs: 500,
      onProgress,
    });
    expect(result).toEqual({ message: MESSAGE, attestation: ATTESTATION });
    expect(onProgress).toHaveBeenCalledWith("propagating");
    expect(onProgress).toHaveBeenCalledWith("complete");
  });

  it("emits onProgress with status string while message is pending (not yet complete)", async () => {
    const onProgress = vi.fn();
    const fetchMock = makeFetchSequence([
      {
        status: 200,
        json: {
          messages: [
            {
              message: MESSAGE,
              attestation: null,
              status: "pending_confirmations",
              cctpVersion: 2,
            },
          ],
        },
      },
      {
        status: 200,
        json: {
          messages: [
            { message: MESSAGE, attestation: ATTESTATION, status: "complete", cctpVersion: 2 },
          ],
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    await pollAttestation({
      sourceDomain: 0,
      txHash: TX_HASH,
      pollIntervalMs: 0,
      timeoutMs: 500,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledWith("pending_confirmations");
    expect(onProgress).toHaveBeenCalledWith("complete");
  });

  it("ignores cctpVersion=1 messages (only v2 counts)", async () => {
    const onProgress = vi.fn();
    const fetchMock = makeFetchSequence([
      {
        status: 200,
        json: {
          messages: [
            // V1 message that LOOKS complete but is wrong version.
            { message: "0xv1", attestation: "0xv1att", status: "complete", cctpVersion: 1 },
          ],
        },
      },
      {
        status: 200,
        json: {
          messages: [
            // V1 still there alongside V2.
            { message: "0xv1", attestation: "0xv1att", status: "complete", cctpVersion: 1 },
            { message: MESSAGE, attestation: ATTESTATION, status: "complete", cctpVersion: 2 },
          ],
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollAttestation({
      sourceDomain: 0,
      txHash: TX_HASH,
      pollIntervalMs: 0,
      timeoutMs: 500,
      onProgress,
    });
    expect(result.message).toBe(MESSAGE);
    expect(result.attestation).toBe(ATTESTATION);
  });

  it("retries on network errors (fetch throws) without crashing the loop", async () => {
    const fetchMock = makeFetchSequence([
      new Error("network unreachable"),
      new Error("dns failure"),
      {
        status: 200,
        json: {
          messages: [
            { message: MESSAGE, attestation: ATTESTATION, status: "complete", cctpVersion: 2 },
          ],
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollAttestation({
      sourceDomain: 0,
      txHash: TX_HASH,
      pollIntervalMs: 0,
      timeoutMs: 500,
    });
    expect(result.message).toBe(MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries on non-OK responses, surfacing http-<status> via onProgress", async () => {
    const onProgress = vi.fn();
    const fetchMock = makeFetchSequence([
      { status: 500, json: {} },
      {
        status: 200,
        json: {
          messages: [
            { message: MESSAGE, attestation: ATTESTATION, status: "complete", cctpVersion: 2 },
          ],
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    await pollAttestation({
      sourceDomain: 0,
      txHash: TX_HASH,
      pollIntervalMs: 0,
      timeoutMs: 500,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledWith("http-500");
  });

  it("retries on empty messages array (Iris returned 200 but no entries yet)", async () => {
    const onProgress = vi.fn();
    const fetchMock = makeFetchSequence([
      { status: 200, json: { messages: [] } },
      {
        status: 200,
        json: {
          messages: [
            { message: MESSAGE, attestation: ATTESTATION, status: "complete", cctpVersion: 2 },
          ],
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollAttestation({
      sourceDomain: 0,
      txHash: TX_HASH,
      pollIntervalMs: 0,
      timeoutMs: 500,
      onProgress,
    });
    expect(result.message).toBe(MESSAGE);
    // Iris-error path: when body.error is set, that string is the
    // onProgress signal; else http-<status>.
    expect(onProgress).toHaveBeenCalledWith("http-200");
  });

  it("surfaces body.error string via onProgress when Iris returns a structured error", async () => {
    const onProgress = vi.fn();
    const fetchMock = makeFetchSequence([
      { status: 200, json: { error: "rate-limited" } },
      {
        status: 200,
        json: {
          messages: [
            { message: MESSAGE, attestation: ATTESTATION, status: "complete", cctpVersion: 2 },
          ],
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);
    await pollAttestation({
      sourceDomain: 0,
      txHash: TX_HASH,
      pollIntervalMs: 0,
      timeoutMs: 500,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalledWith("rate-limited");
  });

  it("throws 'Attestation timed out' when the deadline expires without success", async () => {
    const fetchMock = vi.fn(async () => mkResponse({ status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      pollAttestation({
        sourceDomain: 0,
        txHash: TX_HASH,
        pollIntervalMs: 5,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("AbortSignal.aborted=true at entry throws 'aborted'", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      pollAttestation({
        sourceDomain: 0,
        txHash: TX_HASH,
        pollIntervalMs: 0,
        timeoutMs: 500,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/i);
    // Fetch must NOT have been called when aborted before the first poll.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries on JSON parse failure (body.json() throws) without crashing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => { throw new Error("bad JSON"); },
      } as unknown as Response)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          messages: [
            { message: MESSAGE, attestation: ATTESTATION, status: "complete", cctpVersion: 2 },
          ],
        }),
      } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const result = await pollAttestation({
      sourceDomain: 0,
      txHash: TX_HASH,
      pollIntervalMs: 0,
      timeoutMs: 500,
    });
    expect(result.message).toBe(MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
