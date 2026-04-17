import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import * as fs from "fs";
import * as path from "path";

// Setup a USDT → USDC offer on P2PExchange from the deployer EOA so that a
// smart-account taker (with only USDC) can test fillOffer end-to-end. Writes
// { offerId, expiry } into deployments/<net>-p2p-fixture.json so the
// Playwright test can pick it up.

function loadDeployment(network: string): Record<string, string> {
  const filePath = path.join(__dirname, "..", "deployments", `${network}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`No deployment file for ${network}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveFixture(network: string, data: Record<string, unknown>) {
  const filePath = path.join(__dirname, "..", "deployments", `${network}-p2p-fixture.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`Fixture written to ${filePath}`);
}

task("setup-p2p-offer", "Create a USDT→USDC offer on P2PExchange for taker fill tests")
  .addOptionalParam("giveamt", "Amount of USDT maker gives (token units, 6 dec)", "1000000") // 1 USDT
  .addOptionalParam("wantamt", "Amount of USDC maker wants (token units, 6 dec)", "1000000") // 1 USDC
  .setAction(async (args, hre: HardhatRuntimeEnvironment) => {
    const addr = loadDeployment(hre.network.name);
    if (!addr.TestUSDT) throw new Error("TestUSDT not deployed");
    if (!addr.FHERC20Vault_USDT) throw new Error("FHERC20Vault_USDT not deployed");
    if (!addr.FHERC20Vault_USDC) throw new Error("FHERC20Vault_USDC not deployed");
    if (!addr.P2PExchange) throw new Error("P2PExchange not deployed");

    const [signer] = await hre.ethers.getSigners();
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  P2P offer fixture — USDT→USDC");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  Maker (EOA)    :", signer.address);
    console.log("  TestUSDT       :", addr.TestUSDT);
    console.log("  Vault_USDT     :", addr.FHERC20Vault_USDT);
    console.log("  P2PExchange    :", addr.P2PExchange);
    console.log("  Give           :", args.giveamt, "USDT (smallest unit)");
    console.log("  Want           :", args.wantamt, "USDC (smallest unit)");
    console.log();

    const giveAmt = BigInt(args.giveamt);
    const wantAmt = BigInt(args.wantamt);

    // 1. Check USDT raw balance; mint via faucet if insufficient
    const usdt = await hre.ethers.getContractAt(
      ["function balanceOf(address) view returns (uint256)", "function faucet() external", "function approve(address,uint256) returns (bool)"],
      addr.TestUSDT,
      signer,
    );
    const rawBal = BigInt(await usdt.balanceOf(signer.address));
    console.log("1/5  Raw USDT balance:", rawBal.toString());
    if (rawBal < giveAmt * 2n) {
      console.log("     minting via faucet()...");
      const mintTx = await usdt.faucet();
      await mintTx.wait(1);
      console.log("     ✓ minted — new balance:", (await usdt.balanceOf(signer.address)).toString());
    }

    // 2. Approve vault to pull USDT
    console.log("2/5  Approving Vault_USDT to pull USDT...");
    const approveTx = await usdt.approve(addr.FHERC20Vault_USDT, giveAmt * 10n);
    await approveTx.wait(1);
    console.log("     ✓ approved");

    // 3. Shield USDT → encrypted vault balance
    console.log("3/5  Shielding", giveAmt.toString(), "USDT to vault...");
    const vault = await hre.ethers.getContractAt(
      [
        "function shield(uint256) external",
        "function approvePlaintext(address,uint64) external",
      ],
      addr.FHERC20Vault_USDT,
      signer,
    );
    const shieldTx = await vault.shield(giveAmt);
    await shieldTx.wait(1);
    console.log("     ✓ shielded");

    // 4. Approve P2PExchange to pull from our vault
    console.log("4/5  approvePlaintext(P2PExchange, MAX)...");
    const MAX_U64 = (1n << 64n) - 1n;
    const p2pApproveTx = await vault.approvePlaintext(addr.P2PExchange, MAX_U64);
    await p2pApproveTx.wait(1);
    console.log("     ✓ approved");

    // 5. createOffer(tokenGive=vault_USDT, tokenWant=vault_USDC, give, want, expiry)
    console.log("5/5  Creating offer...");
    const p2p = await hre.ethers.getContractAt(
      [
        "function createOffer(address,address,uint256,uint256,uint256) external returns (uint256)",
        "function nextOfferId() view returns (uint256)",
        "event OfferCreated(uint256 indexed id, address indexed maker, address tokenGive, address tokenWant, uint256 amountGive, uint256 amountWant, uint256 expiry, uint256 timestamp)",
      ],
      addr.P2PExchange,
      signer,
    );
    const expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hour
    const createTx = await p2p.createOffer(
      addr.FHERC20Vault_USDT,
      addr.FHERC20Vault_USDC,
      giveAmt,
      wantAmt,
      expiry,
    );
    const rcpt = await createTx.wait(1);
    console.log("     tx:", createTx.hash);

    // Parse OfferCreated event
    let offerId = -1;
    for (const log of rcpt?.logs ?? []) {
      try {
        const parsed = p2p.interface.parseLog(log);
        if (parsed && parsed.name === "OfferCreated") {
          offerId = Number(parsed.args[0]);
          break;
        }
      } catch {}
    }
    if (offerId < 0) throw new Error("OfferCreated event not found in receipt");
    console.log("     ✓ offerId =", offerId);

    saveFixture(hre.network.name, {
      offerId,
      expiry,
      maker: signer.address,
      give: args.giveamt,
      want: args.wantamt,
      tokenGive: addr.FHERC20Vault_USDT,
      tokenWant: addr.FHERC20Vault_USDC,
      txHash: createTx.hash,
    });

    // Insert into Supabase exchange_offers so the taker UI sees it
    const supabaseUrl = process.env.VITE_SUPABASE_URL || "https://nlwooeqotxmfjdaizjus.supabase.co";
    const anonKey = process.env.VITE_SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5sd29vZXFvdHhtZmpkYWl6anVzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3NzgyNTcsImV4cCI6MjA5MDM1NDI1N30.EHPoMd6Ts8aZPmcLBn68FCAiz2uYk4pjx7IodrR8r1g";

    const body = {
      offer_id: offerId,
      maker_address: signer.address.toLowerCase(),
      amount_give: Number(giveAmt) / 1e6,
      amount_want: Number(wantAmt) / 1e6,
      token_give: addr.FHERC20Vault_USDT.toLowerCase(),
      token_want: addr.FHERC20Vault_USDC.toLowerCase(),
      expiry: new Date(expiry * 1000).toISOString(),
      status: "active",
      taker_address: "",
      chain_id: hre.network.config.chainId ?? 84532,
      tx_hash: createTx.hash.toLowerCase(),
    };
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/exchange_offers`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(body),
    });
    if (!insertRes.ok) {
      const text = await insertRes.text();
      console.log(`     ⚠ Supabase insert failed (${insertRes.status}): ${text.slice(0, 300)}`);
    } else {
      console.log("     ✓ Supabase row inserted");
    }

    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  ✓ P2P fixture ready");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  offerId:", offerId);
    console.log("  expiry: ", new Date(expiry * 1000).toISOString());
  });
