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
