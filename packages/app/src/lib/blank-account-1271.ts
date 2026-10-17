// ERC-1271 digest for a BlankAccount passkey signature.
//
// The security-v1 BlankAccount verifies isValidSignature(hash, sig) against
// replaySafeHash(hash): an EIP-712 hash with domain
//   { name: "BlankAccount", version: "1", chainId, verifyingContract: account }
// and type BlankAccountMessage(bytes32 hash). That binds a signature to one
// account on one chain, so the same passkey on another account or chain
// cannot replay it. Older implementations verify the raw hash.
//
// Which one to sign depends on the implementation the proxy runs right now,
// so ask the account: replaySafeHash exists only on the new implementation.
// The local computation is checked against it, so a domain mismatch fails
// loudly here instead of as a silent "invalid signature" at the verifier.

import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  hashTypedData,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { BlankAccountAbi } from "./abis";

export function blankAccountReplaySafeHash(hash: Hex, account: Address, chainId: number): Hex {
  return hashTypedData({
    domain: { name: "BlankAccount", version: "1", chainId, verifyingContract: account },
    types: { BlankAccountMessage: [{ name: "hash", type: "bytes32" }] },
    primaryType: "BlankAccountMessage",
    message: { hash },
  });
}

function isMissingFunction(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return !!err.walk(
    (e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError,
  );
}

/**
 * The digest the passkey must sign so `account.isValidSignature(hash, sig)`
 * returns the magic value. Network errors propagate; only "this function
 * does not exist on the deployed implementation" selects the raw hash.
 */
export async function erc1271DigestFor(
  publicClient: Pick<PublicClient, "readContract">,
  account: Address,
  chainId: number,
  hash: Hex,
): Promise<Hex> {
  let onChain: Hex;
  try {
    onChain = (await publicClient.readContract({
      address: account,
      abi: BlankAccountAbi,
      functionName: "replaySafeHash",
      args: [hash],
    })) as Hex;
  } catch (err) {
    if (isMissingFunction(err)) return hash;
    throw err;
  }
  const local = blankAccountReplaySafeHash(hash, account, chainId);
  if (local.toLowerCase() !== onChain.toLowerCase()) {
    throw new Error("BlankAccount replaySafeHash does not match the expected EIP-712 domain");
  }
  return onChain;
}
