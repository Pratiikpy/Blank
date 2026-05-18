import { describe, it, expect, vi } from "vitest";
import {
  encryptBlob,
  decryptBlob,
  recoverBurnersFromEvents,
  type BurnerBackupPayload,
} from "./burner-registry";
import type { Address, PublicClient } from "viem";

// §15.x lib test for the AES-256-GCM burner backup envelope. The
// passphrase-derived key is the only thing standing between an
// attacker who reads MetadataSet event data on-chain and the user's
// burner labels. The encrypt + decrypt round-trip + the wrong-
// passphrase rejection are the load-bearing invariants.

const PAYLOAD = {
  id: "b-1",
  salt: "1234567890",
  label: "Coffee fund",
  createdAt: 1_700_000_000_000,
  notes: "Pre-funded for hackathons",
};

describe("encryptBlob + decryptBlob round-trip", () => {
  it("decrypts back to the original payload with the same passphrase", async () => {
    const env = await encryptBlob(PAYLOAD, "correct horse battery staple");
    const out = await decryptBlob(env, "correct horse battery staple");
    expect(out).toEqual(PAYLOAD);
  });

  it("decrypt fails on a wrong passphrase (AES-GCM auth-tag mismatch)", async () => {
    const env = await encryptBlob(PAYLOAD, "passphrase-A");
    await expect(decryptBlob(env, "passphrase-B")).rejects.toThrow(
      /Decryption failed/,
    );
  });

  it("re-encrypting the same payload twice produces different ciphertexts (fresh salt + nonce)", async () => {
    // Without fresh salt + nonce, the ciphertext would leak whether
    // the user's burner list has changed (an attacker observing two
    // event posts could tell). The randomization is a privacy
    // property, not just correctness.
    const a = await encryptBlob(PAYLOAD, "shared-passphrase");
    const b = await encryptBlob(PAYLOAD, "shared-passphrase");
    expect(a).not.toBe(b);
    // Both still decrypt to the same value:
    expect(await decryptBlob(a, "shared-passphrase")).toEqual(PAYLOAD);
    expect(await decryptBlob(b, "shared-passphrase")).toEqual(PAYLOAD);
  });

  it("rejects empty / too-short passphrase at encrypt time", async () => {
    await expect(encryptBlob(PAYLOAD, "")).rejects.toThrow(
      /at least 12 characters/,
    );
    // 11-char passphrase — one below the new floor of 12 chars (was 6).
    await expect(encryptBlob(PAYLOAD, "elevenChars")).rejects.toThrow(
      /at least 12 characters/,
    );
  });

  it("rejects a truncated envelope", async () => {
    await expect(decryptBlob("0xdeadbeef", "anything")).rejects.toThrow(
      /Ciphertext truncated/,
    );
  });

  it("rejects an unknown version byte", async () => {
    const env = await encryptBlob(PAYLOAD, "passphrase-X");
    // Replace the 1-byte version prefix (after "0x") with a non-1 value.
    // Real envelope: "0x01<salt><nonce><ct>". Replacing 01 → ff is
    // enough to trigger the "Unknown ciphertext version" branch
    // before the AES-GCM auth check.
    const tampered = "0xff" + env.slice(4);
    await expect(decryptBlob(tampered, "passphrase-X")).rejects.toThrow(
      /Unknown ciphertext version/,
    );
  });

  it("preserves all payload fields including optional notes", async () => {
    const minimal = { id: "x", salt: "0", label: "L", createdAt: 1 };
    const env = await encryptBlob(minimal, "mypassphrase");
    expect(await decryptBlob(env, "mypassphrase")).toEqual(minimal);
  });
});

// §15.x extension: recoverBurnersFromEvents — the disaster-recovery
// path that reconstructs the user's burner list from on-chain
// MetadataSet/MetadataCleared events using the master passphrase.
// Latest-write-wins keyed by burner address with (blockNumber,
// logIndex) tiebreak — a regression to plain blockNumber > would
// silently drop the second event in a paymaster-batched same-block
// re-set. Decryption failures (wrong passphrase, tampered blob) get
// counted but don't throw, so the user sees a partial recovery
// rather than a hard failure.

const PASSPHRASE = "shared-passphrase-for-test";
const REGISTRY = "0x1234567890123456789012345678901234567890" as Address;
const MAIN_ADDR = "0xowner000000000000000000000000000000000ad" as Address;

const BURNER_A = "0xa000000000000000000000000000000000000001" as Address;
const BURNER_B = "0xb000000000000000000000000000000000000002" as Address;

async function mkEncryptedBlob(payload: BurnerBackupPayload): Promise<`0x${string}`> {
  return (await encryptBlob(payload, PASSPHRASE)) as `0x${string}`;
}

function mkSetLog(args: {
  burner: Address;
  encryptedBlob: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
}) {
  return {
    args: { owner: MAIN_ADDR, burner: args.burner, encryptedBlob: args.encryptedBlob },
    blockNumber: args.blockNumber,
    logIndex: args.logIndex,
  };
}

function mkClearLog(args: { burner: Address; blockNumber: bigint; logIndex: number }) {
  return {
    args: { owner: MAIN_ADDR, burner: args.burner },
    blockNumber: args.blockNumber,
    logIndex: args.logIndex,
  };
}

function makeClient(setLogs: unknown[], clearLogs: unknown[]): PublicClient {
  const getLogs = vi.fn(async (params: { event: { name: string } }) => {
    return params.event.name === "MetadataSet" ? setLogs : clearLogs;
  });
  return { getLogs } as unknown as PublicClient;
}

describe("recoverBurnersFromEvents (master-passphrase disaster recovery)", () => {
  it("throws when the registry address is the zero address (not deployed on this chain)", async () => {
    const client = makeClient([], []);
    await expect(
      recoverBurnersFromEvents({
        publicClient: client,
        registryAddress: "0x0000000000000000000000000000000000000000" as Address,
        mainAddress: MAIN_ADDR,
        passphrase: PASSPHRASE,
      }),
    ).rejects.toThrow(/BurnerRegistry not deployed/);
  });

  it("returns the single decrypted burner record from one Set event", async () => {
    const payload = { id: "b-1", salt: "s", label: "Coffee", createdAt: 1000 };
    const blob = await mkEncryptedBlob(payload);
    const client = makeClient(
      [mkSetLog({ burner: BURNER_A, encryptedBlob: blob, blockNumber: 100n, logIndex: 0 })],
      [],
    );
    const result = await recoverBurnersFromEvents({
      publicClient: client,
      registryAddress: REGISTRY,
      mainAddress: MAIN_ADDR,
      passphrase: PASSPHRASE,
    });
    expect(result.records).toEqual([payload]);
    expect(result.failedCount).toBe(0);
  });

  it("latest blockNumber wins when the same burner is set twice in different blocks", async () => {
    const oldPayload = { id: "b-1", salt: "s", label: "OLD", createdAt: 1000 };
    const newPayload = { id: "b-1", salt: "s", label: "NEW", createdAt: 2000 };
    const oldBlob = await mkEncryptedBlob(oldPayload);
    const newBlob = await mkEncryptedBlob(newPayload);
    const client = makeClient(
      [
        mkSetLog({ burner: BURNER_A, encryptedBlob: oldBlob, blockNumber: 100n, logIndex: 0 }),
        mkSetLog({ burner: BURNER_A, encryptedBlob: newBlob, blockNumber: 200n, logIndex: 0 }),
      ],
      [],
    );
    const result = await recoverBurnersFromEvents({
      publicClient: client,
      registryAddress: REGISTRY,
      mainAddress: MAIN_ADDR,
      passphrase: PASSPHRASE,
    });
    expect(result.records).toEqual([newPayload]);
  });

  it("logIndex tiebreaks SAME-block re-sets (paymaster batch case)", async () => {
    const oldPayload = { id: "b-1", salt: "s", label: "OLD", createdAt: 1000 };
    const newPayload = { id: "b-1", salt: "s", label: "NEW", createdAt: 2000 };
    const oldBlob = await mkEncryptedBlob(oldPayload);
    const newBlob = await mkEncryptedBlob(newPayload);
    const client = makeClient(
      [
        mkSetLog({ burner: BURNER_A, encryptedBlob: oldBlob, blockNumber: 500n, logIndex: 3 }),
        mkSetLog({ burner: BURNER_A, encryptedBlob: newBlob, blockNumber: 500n, logIndex: 7 }),
      ],
      [],
    );
    const result = await recoverBurnersFromEvents({
      publicClient: client,
      registryAddress: REGISTRY,
      mainAddress: MAIN_ADDR,
      passphrase: PASSPHRASE,
    });
    // Without logIndex tiebreak, a regression to plain >-on-blockNumber
    // would silently keep the OLD payload here.
    expect(result.records).toEqual([newPayload]);
  });

  it("Set followed by Clear → burner is EXCLUDED from records (cleared wins)", async () => {
    const payload = { id: "b-1", salt: "s", label: "Will be cleared", createdAt: 1000 };
    const blob = await mkEncryptedBlob(payload);
    const client = makeClient(
      [mkSetLog({ burner: BURNER_A, encryptedBlob: blob, blockNumber: 100n, logIndex: 0 })],
      [mkClearLog({ burner: BURNER_A, blockNumber: 200n, logIndex: 0 })],
    );
    const result = await recoverBurnersFromEvents({
      publicClient: client,
      registryAddress: REGISTRY,
      mainAddress: MAIN_ADDR,
      passphrase: PASSPHRASE,
    });
    expect(result.records).toEqual([]);
    expect(result.failedCount).toBe(0);
  });

  it("Clear followed by Set (same block, later logIndex) → burner is RESURRECTED", async () => {
    const payload = { id: "b-1", salt: "s", label: "Resurrected", createdAt: 1500 };
    const blob = await mkEncryptedBlob(payload);
    const client = makeClient(
      [mkSetLog({ burner: BURNER_A, encryptedBlob: blob, blockNumber: 100n, logIndex: 5 })],
      [mkClearLog({ burner: BURNER_A, blockNumber: 100n, logIndex: 3 })],
    );
    const result = await recoverBurnersFromEvents({
      publicClient: client,
      registryAddress: REGISTRY,
      mainAddress: MAIN_ADDR,
      passphrase: PASSPHRASE,
    });
    expect(result.records).toEqual([payload]);
  });

  it("multiple burners with independent latest-wins (per-burner state, no cross-talk)", async () => {
    const payloadA = { id: "b-A", salt: "sA", label: "A-latest", createdAt: 2000 };
    const payloadB = { id: "b-B", salt: "sB", label: "B-latest", createdAt: 3000 };
    const blobAOld = await mkEncryptedBlob({ id: "b-A", salt: "sA", label: "A-old", createdAt: 1000 });
    const blobANew = await mkEncryptedBlob(payloadA);
    const blobB = await mkEncryptedBlob(payloadB);
    const client = makeClient(
      [
        mkSetLog({ burner: BURNER_A, encryptedBlob: blobAOld, blockNumber: 100n, logIndex: 0 }),
        mkSetLog({ burner: BURNER_A, encryptedBlob: blobANew, blockNumber: 200n, logIndex: 0 }),
        mkSetLog({ burner: BURNER_B, encryptedBlob: blobB, blockNumber: 150n, logIndex: 0 }),
      ],
      [],
    );
    const result = await recoverBurnersFromEvents({
      publicClient: client,
      registryAddress: REGISTRY,
      mainAddress: MAIN_ADDR,
      passphrase: PASSPHRASE,
    });
    // Both burners survive; A picks its later payload.
    expect(result.records).toHaveLength(2);
    // Sorted most-recent first by createdAt: B (3000) before A (2000).
    expect(result.records[0]!.id).toBe("b-B");
    expect(result.records[1]!.id).toBe("b-A");
  });

  it("decryption failures bump failedCount but do NOT throw (partial recovery is the contract)", async () => {
    const good = { id: "b-1", salt: "s", label: "Good", createdAt: 1000 };
    const goodBlob = await mkEncryptedBlob(good);
    // A blob encrypted with a DIFFERENT passphrase fails AES-GCM auth.
    const badBlob = await encryptBlob({ id: "b-2", salt: "s", label: "Bad", createdAt: 999 }, "different-passphrase");
    const client = makeClient(
      [
        mkSetLog({ burner: BURNER_A, encryptedBlob: goodBlob, blockNumber: 100n, logIndex: 0 }),
        mkSetLog({ burner: BURNER_B, encryptedBlob: badBlob as `0x${string}`, blockNumber: 200n, logIndex: 0 }),
      ],
      [],
    );
    const result = await recoverBurnersFromEvents({
      publicClient: client,
      registryAddress: REGISTRY,
      mainAddress: MAIN_ADDR,
      passphrase: PASSPHRASE,
    });
    expect(result.records).toEqual([good]);
    expect(result.failedCount).toBe(1);
  });

  it("records are sorted most-recent first by createdAt (UI shows freshest burner on top)", async () => {
    const earliest = { id: "b-1", salt: "s", label: "earliest", createdAt: 1000 };
    const middle = { id: "b-2", salt: "s", label: "middle", createdAt: 2000 };
    const latest = { id: "b-3", salt: "s", label: "latest", createdAt: 3000 };
    const e = await mkEncryptedBlob(earliest);
    const m = await mkEncryptedBlob(middle);
    const l = await mkEncryptedBlob(latest);
    const client = makeClient(
      [
        // Intentionally insert in arbitrary order to verify sort.
        mkSetLog({ burner: "0xa1" as Address, encryptedBlob: m, blockNumber: 100n, logIndex: 0 }),
        mkSetLog({ burner: "0xa2" as Address, encryptedBlob: l, blockNumber: 100n, logIndex: 1 }),
        mkSetLog({ burner: "0xa3" as Address, encryptedBlob: e, blockNumber: 100n, logIndex: 2 }),
      ],
      [],
    );
    const result = await recoverBurnersFromEvents({
      publicClient: client,
      registryAddress: REGISTRY,
      mainAddress: MAIN_ADDR,
      passphrase: PASSPHRASE,
    });
    expect(result.records.map((r) => r.label)).toEqual(["latest", "middle", "earliest"]);
  });

  it("empty event history → empty records + zero failedCount", async () => {
    const client = makeClient([], []);
    const result = await recoverBurnersFromEvents({
      publicClient: client,
      registryAddress: REGISTRY,
      mainAddress: MAIN_ADDR,
      passphrase: PASSPHRASE,
    });
    expect(result.records).toEqual([]);
    expect(result.failedCount).toBe(0);
  });

  it("passes fromBlock + toBlock through to getLogs verbatim (cursor scoping for huge histories)", async () => {
    const getLogs = vi.fn(async (_params: { fromBlock?: unknown; toBlock?: unknown }) => []);
    const client = { getLogs } as unknown as PublicClient;
    await recoverBurnersFromEvents({
      publicClient: client,
      registryAddress: REGISTRY,
      mainAddress: MAIN_ADDR,
      passphrase: PASSPHRASE,
      fromBlock: 12345n,
      toBlock: 67890n,
    });
    // Both Set + Clear queries get the same fromBlock/toBlock.
    expect(getLogs).toHaveBeenCalledTimes(2);
    for (const call of getLogs.mock.calls) {
      const params = call[0];
      expect(params.fromBlock).toBe(12345n);
      expect(params.toBlock).toBe(67890n);
    }
  });
});
