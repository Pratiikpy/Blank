import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
const c = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
const DAIMO = "0xc2b78104907F722DABAc4C69f826a522B2754De4";
const code = await c.getCode({ address: DAIMO });
console.log("Daimo verifier on Base Sepolia:", code === undefined || code === "0x" ? "NOT DEPLOYED" : `${code.length / 2} bytes`);

// Try the daimo verifier with our sig
const hashHex = "94520bb8ae051ecd1a2d6892218d3e33cd41705121dcb0fc0c9067c0d204c1b6";
const r = "8f8d5a6235597577cb64ea3ab5df26efacac8cebd7f924efe89855577983c132";
const s = "17cdf764e53aa97bf4d6d440b6ca23d3b1ef6b2c2c03508adc56a19b433b9782";
const x = "cb95c03c21bd16e22f34d0a253c35a5bd53ad5a9fc0e4ef9f3dd61ced364573a";
const y = "e969d62fbbffa077bcc2ec6ea520bac95d62388d8edcf40f795c20e607e62dc4";
const input = "0x" + hashHex + r + s + x + y;
const res = await c.call({ to: DAIMO, data: input });
console.log("Daimo verify result:", res.data || "EMPTY");
