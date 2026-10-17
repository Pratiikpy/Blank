import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";
import { Encryptable } from "@cofhe/sdk";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { sepolia as cofheSepolia, baseSepolia as cofheBaseSepolia, arbSepolia as cofheArbSepolia } from "@cofhe/sdk/chains";
import { createPublicClient, createWalletClient, http, keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia as viemSepolia, baseSepolia as viemBaseSepolia, arbitrumSepolia as viemArbSepolia } from "viem/chains";

// Create a P2POfframp offer from the deployer EOA so a taker can run the
// fill flow (take, decrypt escrow, attest, release) end to end. Writes the
// offer into deployments/<net>-p2p-fixture.json.
//
// P2PExchange (the old token-for-token book) is retired on-chain:
// createOffer reverts "P2PExchange: retired". This task replaces its
// old fixture.

const RAILS: Record<string, number> = { upi_phonepe: 1, upi_gpay: 2, upi_paytm: 3, wise: 4, venmo: 5, paypal: 6 };

function loadDeployment(network: string): Record<string, string> {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`No deployment file for ${network}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function rpcFor(network: string): string {
  if (network === "base-sepolia") return process.env.BASE_SEPOLIA_RPC_URL || "https://base-sepolia-rpc.publicnode.com";
  if (network === "arb-sepolia") return process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc";
  return process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com";
}

const OFFRAMP_ABI = [
  { type: "function", name: "createOffer", stateMutability: "nonpayable", inputs: [
    { name: "vault", type: "address" },
    { name: "encAmount", type: "bytes32" },
    { name: "encMinFill", type: "bytes32" },
    { name: "proof", type: "bytes" },
    { name: "fiatRail", type: "uint32" },
    { name: "makerHandleHash", type: "bytes32" },
    { name: "fiatAmountMicroUSD", type: "uint64" },
    { name: "fiatRateMicroUSD", type: "uint64" },
    { name: "expirySeconds", type: "uint32" },
  ], outputs: [{ name: "offerId", type: "uint64" }] },
  { type: "event", name: "OfferCreated", inputs: [
    { name: "offerId", type: "uint64", indexed: true },
    { name: "maker", type: "address", indexed: true },
    { name: "fiatAmountMicroUSD", type: "uint64", indexed: false },
    { name: "fiatRateMicroUSD", type: "uint64", indexed: false },
    { name: "fiatRail", type: "uint32", indexed: false },
    { name: "makerHandleHash", type: "bytes32", indexed: false },
    { name: "expiry", type: "uint32", indexed: false },
  ] },
] as const;

task("setup-p2p-offer", "Create a P2POfframp offer from the deployer for taker fill tests")
  .addOptionalParam("usdc", "USDC the maker escrows (base units, 6 dec)", "1000000")
  .addOptionalParam("fiat", "Fiat the taker pays (micro USD)", "1000000")
  .addOptionalParam("rail", `Fiat rail: ${Object.keys(RAILS).join(", ")}`, "wise")
  .addOptionalParam("handle", "Maker's rail handle (hashed on-chain)", "blank-testnet-maker@wise")
  .addOptionalParam("hours", "Offer lifetime in hours", "24")
  .setAction(async (args, hre: HardhatRuntimeEnvironment) => {
    const network = hre.network.name;
    const addr = loadDeployment(network);
    if (!addr.P2POfframp) throw new Error("P2POfframp not deployed on this network");
    if (!addr.FHERC20Vault_USDC || !addr.TestUSDC) throw new Error("USDC vault not deployed");
    const rail = RAILS[String(args.rail)];
    if (!rail) throw new Error(`Unknown rail ${args.rail}`);

    const usdcAmt = BigInt(args.usdc);
    const fiatAmt = BigInt(args.fiat);
    if (usdcAmt <= 0n || fiatAmt <= 0n) throw new Error("usdc and fiat must be > 0");
    const rate = (fiatAmt * 1_000_000n) / usdcAmt;
    if (rate <= 0n) throw new Error("fiat/usdc rate rounds to 0");
    const expirySeconds = Math.max(300, Math.min(7 * 24 * 3600, Number(args.hours) * 3600));

    const pk = process.env.PRIVATE_KEY;
    if (!pk) throw new Error("PRIVATE_KEY env missing");
    const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
    const chain = network === "base-sepolia" ? viemBaseSepolia : network === "arb-sepolia" ? viemArbSepolia : viemSepolia;
    const cofheChain = network === "base-sepolia" ? cofheBaseSepolia : network === "arb-sepolia" ? cofheArbSepolia : cofheSepolia;
    const publicClient = createPublicClient({ chain, transport: http(rpcFor(network)) });
    const wallet = createWalletClient({ account, chain, transport: http(rpcFor(network)) });

    console.log("P2POfframp offer fixture");
    console.log("  maker   :", account.address);
    console.log("  offramp :", addr.P2POfframp);
    console.log("  escrow  :", usdcAmt.toString(), "USDC base units");
    console.log("  fiat    :", fiatAmt.toString(), "micro USD on rail", args.rail);

    const [signer] = await hre.ethers.getSigners();
    const usdc = await hre.ethers.getContractAt(
      ["function balanceOf(address) view returns (uint256)", "function mint(address,uint256) external", "function approve(address,uint256) returns (bool)"],
      addr.TestUSDC,
      signer,
    );
    const vault = await hre.ethers.getContractAt(
      ["function shield(uint256) external", "function approvePlaintext(address,uint64) external"],
      addr.FHERC20Vault_USDC,
      signer,
    );

    console.log("1/4  shield", usdcAmt.toString(), "USDC");
    if (BigInt(await usdc.balanceOf(signer.address)) < usdcAmt) {
      await (await usdc.mint(signer.address, usdcAmt * 10n)).wait(1);
    }
    await (await usdc.approve(addr.FHERC20Vault_USDC, usdcAmt)).wait(1);
    await (await vault.shield(usdcAmt)).wait(1);

    console.log("2/4  approvePlaintext(P2POfframp, MAX)");
    await (await vault.approvePlaintext(addr.P2POfframp, (1n << 64n) - 1n)).wait(1);

    console.log("3/4  encrypt amount + min fill");
    const cofhe = createCofheClient(createCofheConfig({ supportedChains: [cofheChain] }));
    await cofhe.connect(publicClient as never, wallet as never);
    const [encAmount, encMin, proof] = (await cofhe
      .encryptInputs([Encryptable.uint64(usdcAmt), Encryptable.uint64(usdcAmt)])
      .setConsumingContract(addr.P2POfframp as `0x${string}`)
      .execute()) as [Hex, Hex, Hex];

    console.log("4/4  createOffer");
    const handleHash = keccak256(toBytes(String(args.handle)));
    const hash = await wallet.writeContract({
      address: addr.P2POfframp as `0x${string}`,
      abi: OFFRAMP_ABI,
      functionName: "createOffer",
      args: [addr.FHERC20Vault_USDC as `0x${string}`, encAmount, encMin, proof, rail, handleHash, fiatAmt, rate, expirySeconds],
      gas: 5_000_000n,
    });
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`createOffer reverted: ${hash}`);

    let offerId: bigint | null = null;
    const topic = hre.ethers.id("OfferCreated(uint64,address,uint64,uint64,uint32,bytes32,uint32)");
    for (const log of rcpt.logs) {
      if (log.address.toLowerCase() === addr.P2POfframp.toLowerCase() && log.topics[0] === topic && log.topics[1]) {
        offerId = BigInt(log.topics[1]);
        break;
      }
    }
    if (offerId === null) throw new Error("OfferCreated event not found in receipt");

    const fixturePath = path.join(__dirname, "..", "deployments", `${network}-p2p-fixture.json`);
    fs.writeFileSync(
      fixturePath,
      JSON.stringify(
        {
          contract: "P2POfframp",
          offramp: addr.P2POfframp,
          offerId: offerId.toString(),
          maker: account.address,
          vault: addr.FHERC20Vault_USDC,
          usdc: usdcAmt.toString(),
          fiatAmountMicroUSD: fiatAmt.toString(),
          fiatRateMicroUSD: rate.toString(),
          rail: args.rail,
          railId: rail,
          handle: args.handle,
          expiresAt: new Date(Date.now() + expirySeconds * 1000).toISOString(),
          txHash: hash,
        },
        null,
        2,
      ),
    );
    console.log(`  offerId ${offerId}  tx ${hash}`);
    console.log(`  fixture ${fixturePath}`);
  });
