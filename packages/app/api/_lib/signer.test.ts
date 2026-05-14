import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ethers } from "ethers";
import { getSigner } from "./signer.js";

// §15.x server-side test for the BlankSigner factory (env
// backend). The KMS backend is excluded (heavy AWS SDK mocking,
// out of single-iter scope). The env backend is the current
// production path on all deployments.

// Hardhat-style well-known test private key (alice in
// Hardhat's default mnemonic). Address:
// 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
const RELAYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const RELAYER_ADDR = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const AGENT_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const AGENT_ADDR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

beforeEach(() => {
  process.env.BLANK_SIGNER_BACKEND = "env";
  process.env.RELAYER_PRIVATE_KEY = RELAYER_PK;
  process.env.AGENT_PRIVATE_KEY = AGENT_PK;
});

afterEach(() => {
  delete process.env.BLANK_SIGNER_BACKEND;
  delete process.env.RELAYER_PRIVATE_KEY;
  delete process.env.AGENT_PRIVATE_KEY;
});

describe("getSigner (env backend)", () => {
  it("relayer signer derives the expected address", async () => {
    const signer = getSigner("relayer");
    expect(await signer.getAddress()).toBe(RELAYER_ADDR);
  });

  it("agent signer derives a DIFFERENT address than relayer", async () => {
    const relayer = getSigner("relayer");
    const agent = getSigner("agent");
    expect(await agent.getAddress()).toBe(AGENT_ADDR);
    expect(await agent.getAddress()).not.toBe(await relayer.getAddress());
  });

  it("relayer + agent use DIFFERENT env vars (role isolation)", async () => {
    // Verify that swapping role doesn't accidentally route to the
    // wrong env var. Set RELAYER_PRIVATE_KEY to a sentinel that
    // would FAIL if buildEnvSigner read it for agent.
    process.env.RELAYER_PRIVATE_KEY = "0x" + "11".repeat(32);
    process.env.AGENT_PRIVATE_KEY = AGENT_PK;
    const agent = getSigner("agent");
    // Agent should resolve to AGENT_ADDR, NOT to the sentinel address.
    expect(await agent.getAddress()).toBe(AGENT_ADDR);
  });

  it("throws when RELAYER_PRIVATE_KEY is missing", () => {
    delete process.env.RELAYER_PRIVATE_KEY;
    expect(() => getSigner("relayer")).toThrow(/RELAYER_PRIVATE_KEY/);
  });

  it("throws when AGENT_PRIVATE_KEY is missing", () => {
    delete process.env.AGENT_PRIVATE_KEY;
    expect(() => getSigner("agent")).toThrow(/AGENT_PRIVATE_KEY/);
  });

  it("signMessage produces a signature ecrecover can verify", async () => {
    const signer = getSigner("relayer");
    const msg = "Blank: signer test " + Date.now();
    const sig = await signer.signMessage(msg);
    const recovered = ethers.verifyMessage(msg, sig);
    expect(recovered.toLowerCase()).toBe(RELAYER_ADDR.toLowerCase());
  });

  it("ethersSigner field is a working ethers Signer", async () => {
    const signer = getSigner("relayer");
    expect(signer.ethersSigner).toBeDefined();
    // ethersSigner should resolve the same address as getAddress.
    const addr = await signer.ethersSigner.getAddress();
    expect(addr).toBe(RELAYER_ADDR);
  });

  it("defaults to env backend when BLANK_SIGNER_BACKEND is unset", async () => {
    delete process.env.BLANK_SIGNER_BACKEND;
    const signer = getSigner("relayer");
    expect(await signer.getAddress()).toBe(RELAYER_ADDR);
  });
});

// §15.x extension: backend selection edges + provider passthrough +
// signMessage with Uint8Array. The backend dispatcher is the gate
// between the env-only path (current prod) and the KMS path (future
// prod when keys move to HSM); a regression that mis-routed would
// either crash with "KMS not configured" on dev OR silently fall
// back to env on prod (where keys aren't present in env). The
// provider passthrough is required for ethers v6 contract calls
// that need a connected signer.

describe("getSigner — backend selection edges", () => {
  it("BLANK_SIGNER_BACKEND='kms' (lowercase) routes to KMS backend (throws when key id missing)", () => {
    process.env.BLANK_SIGNER_BACKEND = "kms";
    delete process.env.KMS_RELAYER_KEY_ID;
    // KMS path requires KMS_RELAYER_KEY_ID; without it, the dispatch
    // throws BEFORE attempting to load the AWS SDK. This proves the
    // backend selection landed on the KMS branch.
    expect(() => getSigner("relayer")).toThrow(/KMS_RELAYER_KEY_ID/);
  });

  it("BLANK_SIGNER_BACKEND='KMS' (UPPERCASE) ALSO routes to KMS backend (case-insensitive)", () => {
    process.env.BLANK_SIGNER_BACKEND = "KMS";
    delete process.env.KMS_AGENT_KEY_ID;
    expect(() => getSigner("agent")).toThrow(/KMS_AGENT_KEY_ID/);
  });

  it("BLANK_SIGNER_BACKEND='Kms' (mixed case) ALSO routes to KMS backend", () => {
    process.env.BLANK_SIGNER_BACKEND = "Kms";
    delete process.env.KMS_RELAYER_KEY_ID;
    expect(() => getSigner("relayer")).toThrow(/KMS_RELAYER_KEY_ID/);
  });

  it("BLANK_SIGNER_BACKEND='garbage' (unknown value) falls back to env backend (defensive default)", async () => {
    process.env.BLANK_SIGNER_BACKEND = "garbage";
    // Env vars are still set in the global beforeEach, so the env
    // backend resolves successfully — which proves the dispatch
    // didn't accidentally route to KMS (which would have thrown).
    const signer = getSigner("relayer");
    expect(await signer.getAddress()).toBe(RELAYER_ADDR);
  });

  it("KMS backend with KMS_*_KEY_ID set surfaces the missing-key error message that points at the alias convention", () => {
    process.env.BLANK_SIGNER_BACKEND = "kms";
    delete process.env.KMS_RELAYER_KEY_ID;
    // The error message includes the canonical alias hint per the
    // source: "Set to a KMS key ID or alias like 'alias/blank-relayer'."
    let caught: unknown = null;
    try { getSigner("relayer"); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/alias\/blank-relayer/);
  });

  it("KMS backend with agent role surfaces the agent-alias hint", () => {
    process.env.BLANK_SIGNER_BACKEND = "kms";
    delete process.env.KMS_AGENT_KEY_ID;
    let caught: unknown = null;
    try { getSigner("agent"); } catch (e) { caught = e; }
    const msg = (caught as Error).message;
    expect(msg).toMatch(/alias\/blank-agent/);
  });
});

describe("getSigner — provider passthrough", () => {
  it("ethersSigner gets the provider attached when provider arg is passed", async () => {
    // Build a no-op JsonRpcProvider — ethers won't actually dial unless
    // we call a network method, so this stays fully offline.
    const provider = new ethers.JsonRpcProvider("http://localhost:8545");
    const signer = getSigner("relayer", provider);
    // ethers.Wallet exposes `.provider` once connected.
    const ethersSigner = signer.ethersSigner as ethers.Wallet;
    expect(ethersSigner.provider).toBe(provider);
  });

  it("ethersSigner has NO provider when no arg is passed (signing-only mode)", async () => {
    const signer = getSigner("relayer");
    const ethersSigner = signer.ethersSigner as ethers.Wallet;
    expect(ethersSigner.provider).toBeNull();
  });
});

describe("getSigner — signMessage accepts Uint8Array bytes (not just string)", () => {
  it("signMessage(bytes) produces a verifiable signature", async () => {
    const signer = getSigner("relayer");
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const sig = await signer.signMessage(bytes);
    // Verify against ethers.verifyMessage which accepts both forms.
    const recovered = ethers.verifyMessage(bytes, sig);
    expect(recovered.toLowerCase()).toBe(RELAYER_ADDR.toLowerCase());
  });

  it("signMessage(empty-bytes) succeeds (no off-by-one rejection on zero-length input)", async () => {
    const signer = getSigner("relayer");
    const empty = new Uint8Array(0);
    const sig = await signer.signMessage(empty);
    expect(sig).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(sig.length).toBeGreaterThan(2); // not just "0x"
  });

  it("signMessage produces DIFFERENT signatures for different messages from the SAME signer", async () => {
    const signer = getSigner("relayer");
    const sigA = await signer.signMessage("message A");
    const sigB = await signer.signMessage("message B");
    expect(sigA).not.toBe(sigB);
  });

  it("signMessage produces the SAME signature for the SAME message on repeat calls (deterministic ECDSA per ethers default)", async () => {
    const signer = getSigner("relayer");
    const msg = "deterministic message";
    const sigA = await signer.signMessage(msg);
    const sigB = await signer.signMessage(msg);
    // ethers.Wallet uses deterministic ECDSA (RFC 6979) by default.
    expect(sigA).toBe(sigB);
  });
});
