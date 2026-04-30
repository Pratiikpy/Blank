import { createPublicClient, http, parseAbi } from "viem";
import { baseSepolia } from "viem/chains";
import { p256 } from "@noble/curves/nist.js";

const ENTRYPOINT = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const PUBX = "cb95c03c21bd16e22f34d0a253c35a5bd53ad5a9fc0e4ef9f3dd61ced364573a";
const PUBY = "e969d62fbbffa077bcc2ec6ea520bac95d62388d8edcf40f795c20e607e62dc4";

const userOp = {
  sender: "0x021a0F005E16e7c3ae98E4F28F278DeBC7A3573f",
  nonce: 0n,
  initCode: "0x",
  callData: "0x47e1da2a000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000020000000000000000000000006377ef23b3464019ecf35528be6eb6d6d57d0b1a000000000000000000000000789f0bc466e172ed737493e9796a6d0a3ab0ff230000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000044095ea7b3000000000000000000000000789f0bc466e172ed737493e9796a6d0a3ab0ff2300000000000000000000000000000000000000000000000000000000009896800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000245f0110f9000000000000000000000000000000000000000000000000000000000098968000000000000000000000000000000000000000000000000000000000",
  accountGasLimits: "0x000000000000000000000000001e8480000000000000000000000000001e8480",
  preVerificationGas: 100000n,
  gasFees: "0x00000000000000000000000005f5e1000000000000000000000000003b9aca00",
  paymasterAndData: "0xB1CbBD59E63d7aB0BbF0406CCF1016c1Dd8e63de00000000000000000000000000030d40000000000000000000000000000186a00000000000000000000000000000000000000000000000000000000000000000",
  signature: "0x",
};

const c = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const abi = parseAbi(["struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }", "function getUserOpHash(PackedUserOperation u) view returns (bytes32)"]);

const userOpHash = await c.readContract({ address: ENTRYPOINT, abi, functionName: "getUserOpHash", args: [userOp] });
console.log("On-chain userOpHash:", userOpHash);

// Sig from the failed test
const sigHex = "8f8d5a6235597577cb64ea3ab5df26efacac8cebd7f924efe89855577983c13217cdf764e53aa97bf4d6d440b6ca23d3b1ef6b2c2c03508adc56a19b433b9782";
const r = sigHex.slice(0, 64);
const s = sigHex.slice(64);
console.log("Sig r:", r);
console.log("Sig s:", s);

// Verify via noble using on-chain hash
const sig = new Uint8Array(64);
for (let i = 0; i < 32; i++) sig[i] = parseInt(r.slice(i * 2, i * 2 + 2), 16);
for (let i = 0; i < 32; i++) sig[32 + i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);

const hash = new Uint8Array(32);
const hashHex = userOpHash.slice(2);
for (let i = 0; i < 32; i++) hash[i] = parseInt(hashHex.slice(i * 2, i * 2 + 2), 16);

const pub = new Uint8Array(65);
pub[0] = 0x04;
for (let i = 0; i < 32; i++) pub[1 + i] = parseInt(PUBX.slice(i * 2, i * 2 + 2), 16);
for (let i = 0; i < 32; i++) pub[33 + i] = parseInt(PUBY.slice(i * 2, i * 2 + 2), 16);

const valid = p256.verify(sig, hash, pub);
console.log("noble verify(sig, userOpHash, pub):", valid);

// Try with sha256 of hash (in case noble re-hashed during sign)
import { sha256 } from "@noble/hashes/sha2.js";
const validHashed = p256.verify(sig, sha256(hash), pub);
console.log("noble verify(sig, sha256(userOpHash), pub):", validHashed);
