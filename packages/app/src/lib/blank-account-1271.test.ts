import { describe, it, expect, vi } from "vitest";
import {
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  concat,
  encodeAbiParameters,
  keccak256,
  toHex,
  type Hex,
} from "viem";
import { blankAccountReplaySafeHash, erc1271DigestFor } from "./blank-account-1271";
import { BlankAccountAbi } from "./abis";

const ACCOUNT = "0x1234567890123456789012345678901234567890" as const;
const H = keccak256(toHex("blank message"));

// Spelled out the way BlankAccount.replaySafeHash builds it in Solidity.
function solidityReplaySafeHash(hash: Hex, account: `0x${string}`, chainId: number): Hex {
  const domainTypehash = keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  const messageTypehash = keccak256(toHex("BlankAccountMessage(bytes32 hash)"));
  const domainSeparator = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [domainTypehash, keccak256(toHex("BlankAccount")), keccak256(toHex("1")), BigInt(chainId), account],
  ));
  const structHash = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [messageTypehash, hash]));
  return keccak256(concat(["0x1901", domainSeparator, structHash]));
}

function revertError(): BaseError {
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: BlankAccountAbi, functionName: "replaySafeHash" }),
    { abi: BlankAccountAbi, functionName: "replaySafeHash", args: [H], contractAddress: ACCOUNT },
  );
}

describe("blankAccountReplaySafeHash", () => {
  it("equals the contract's EIP-712 construction byte for byte", () => {
    expect(blankAccountReplaySafeHash(H, ACCOUNT, 84532)).toBe(solidityReplaySafeHash(H, ACCOUNT, 84532));
  });

  it("differs per account and per chain (the replay the upgrade closes)", () => {
    const a = blankAccountReplaySafeHash(H, ACCOUNT, 84532);
    expect(blankAccountReplaySafeHash(H, ACCOUNT, 11155111)).not.toBe(a);
    expect(blankAccountReplaySafeHash(H, "0x0000000000000000000000000000000000000001", 84532)).not.toBe(a);
  });
});

describe("erc1271DigestFor", () => {
  it("security-v1 implementation: returns the on-chain replaySafeHash after checking it matches", async () => {
    const wrapped = blankAccountReplaySafeHash(H, ACCOUNT, 84532);
    const readContract = vi.fn().mockResolvedValue(wrapped);
    await expect(erc1271DigestFor({ readContract } as never, ACCOUNT, 84532, H)).resolves.toBe(wrapped);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: ACCOUNT, functionName: "replaySafeHash", args: [H] }));
  });

  it("older implementation (function reverts): signs the raw hash", async () => {
    const readContract = vi.fn().mockRejectedValue(revertError());
    await expect(erc1271DigestFor({ readContract } as never, ACCOUNT, 84532, H)).resolves.toBe(H);
  });

  it("no code yet (zero data): raw hash, the factory deploys the older implementation", async () => {
    const zero = new ContractFunctionExecutionError(
      new ContractFunctionZeroDataError({ functionName: "replaySafeHash" }),
      { abi: BlankAccountAbi, functionName: "replaySafeHash", args: [H], contractAddress: ACCOUNT },
    );
    const readContract = vi.fn().mockRejectedValue(zero);
    await expect(erc1271DigestFor({ readContract } as never, ACCOUNT, 84532, H)).resolves.toBe(H);
  });

  it("network errors propagate instead of silently signing the wrong digest", async () => {
    const readContract = vi.fn().mockRejectedValue(new Error("fetch failed"));
    await expect(erc1271DigestFor({ readContract } as never, ACCOUNT, 84532, H)).rejects.toThrow("fetch failed");
  });

  it("an on-chain value that disagrees with the expected domain throws", async () => {
    const readContract = vi.fn().mockResolvedValue(keccak256(toHex("something else")));
    await expect(erc1271DigestFor({ readContract } as never, ACCOUNT, 84532, H)).rejects.toThrow(/EIP-712 domain/);
  });
});
