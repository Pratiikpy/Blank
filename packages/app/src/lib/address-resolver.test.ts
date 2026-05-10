import { describe, it, expect } from "vitest";
import { looksLikeEnsName } from "./address-resolver";

// §15.x lib test for the ENS-shape heuristic. Used in the Send flow
// to decide whether to attempt forward resolution before the user
// pastes a 0x address. False positives waste a network round-trip;
// false negatives leave valid names unresolved.

describe("looksLikeEnsName", () => {
  it("accepts standard *.eth names", () => {
    expect(looksLikeEnsName("vitalik.eth")).toBe(true);
    expect(looksLikeEnsName("pratik.eth")).toBe(true);
  });

  it("accepts subdomains and base.eth-style multi-label names", () => {
    expect(looksLikeEnsName("pratik.base.eth")).toBe(true);
    expect(looksLikeEnsName("user.alice.eth")).toBe(true);
  });

  it("accepts hyphens and digits in labels", () => {
    expect(looksLikeEnsName("alice-1.eth")).toBe(true);
    expect(looksLikeEnsName("name-with-hyphens.eth")).toBe(true);
    expect(looksLikeEnsName("123abc.eth")).toBe(true);
  });

  it("rejects names starting with 0x even when they have a dot", () => {
    // The 0x guard is intentional: 0x-prefixed strings always go to
    // address-parsing branch, never to ENS resolution. Otherwise an
    // address-shaped typo could waste an ENS round-trip.
    expect(looksLikeEnsName("0xen-deep.eth")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(looksLikeEnsName("PRATIK.ETH")).toBe(true);
    expect(looksLikeEnsName("Vitalik.Eth")).toBe(true);
  });

  it("rejects empty / whitespace-only input", () => {
    expect(looksLikeEnsName("")).toBe(false);
    expect(looksLikeEnsName("   ")).toBe(false);
  });

  it("rejects 0x addresses", () => {
    expect(looksLikeEnsName("0xabc1234567890abcdef1234567890abcdef12345678")).toBe(
      false,
    );
  });

  it("rejects strings with whitespace inside", () => {
    expect(looksLikeEnsName("hello world.eth")).toBe(false);
  });

  it("rejects single-label names without a dot", () => {
    expect(looksLikeEnsName("vitalik")).toBe(false);
  });

  it("rejects names with empty labels (leading or trailing dots)", () => {
    expect(looksLikeEnsName(".eth")).toBe(false);
    expect(looksLikeEnsName("vitalik.")).toBe(false);
    expect(looksLikeEnsName("vitalik..eth")).toBe(false);
  });

  it("rejects names with disallowed characters (underscore, slash, @)", () => {
    expect(looksLikeEnsName("vita_lik.eth")).toBe(false);
    expect(looksLikeEnsName("vita/lik.eth")).toBe(false);
    expect(looksLikeEnsName("vita@lik.eth")).toBe(false);
  });
});
