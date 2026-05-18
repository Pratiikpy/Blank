import { task } from "hardhat/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  createPublicClient,
  http,
  keccak256,
  toBytes,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia as viemSepolia, baseSepolia as viemBaseSepolia } from "viem/chains";

// ──────────────────────────────────────────────────────────────────
//  verify-sweep-state — read-only post-sweep state verification.
//
//  The multi-wallet-feature-sweep task verifies that every tx
//  mines successfully. This task takes the verification one step
//  further: it reads on-chain state AFTER the sweep and checks
//  the state changes the sweep was supposed to produce.
//
//  Per-persona checks:
//   - TestUSDC.balanceOf(persona) ≥ minimum (faucet succeeded)
//   - FHERC20Vault has non-zero totalDeposited (shields landed)
//   - Persona's smart-account ETH > 0 (gas funding succeeded)
//   - GroupManager.isMember(latest_group, persona) for all 4
//   - InheritanceManager.heirOf(Carol) == Dave (inheritance set)
//   - CreatorHub.hasProfile(Bob) (profile created)
//
//  Output: pass/fail per check + a final summary. Read-only, no
//  state changes, no gas burned. Run after a successful sweep on
//  the same chain.
//
//  Usage:
//   npx hardhat verify-sweep-state --network eth-sepolia
//   npx hardhat verify-sweep-state --network base-sepolia
// ──────────────────────────────────────────────────────────────────

task(
  "verify-sweep-state",
  "Read-only checks of on-chain state after multi-wallet-feature-sweep",
).setAction(async (_args, hre) => {
  const networkName = hre.network.name;
  const isBase = networkName === "base-sepolia";
  if (networkName !== "eth-sepolia" && networkName !== "base-sepolia") {
    throw new Error(`Unsupported network ${networkName}`);
  }

  const deploymentFile = isBase ? "base-sepolia.json" : "eth-sepolia.json";
  const deployments = JSON.parse(
    readFileSync(resolve(__dirname, "..", "deployments", deploymentFile), "utf8"),
  ) as Record<string, string>;

  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY env missing");
  const deployerHex = (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex;

  const rpcUrl = isBase
    ? process.env.BASE_SEPOLIA_RPC_URL || "https://base-sepolia-rpc.publicnode.com"
    : process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com";

  const chain = isBase ? viemBaseSepolia : viemSepolia;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const personas = ["Alice", "Bob", "Carol", "Dave"].map((name) => {
    const seed = keccak256(toBytes(deployerHex + "::" + name));
    return { name, address: privateKeyToAccount(seed as Hex).address };
  });

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  verify-sweep-state — ${networkName} (chain ${chain.id})`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  let pass = 0;
  let fail = 0;
  const report = (label: string, ok: boolean, detail?: string) => {
    const sym = ok ? "✓" : "✗";
    console.log(`  ${sym} ${label.padEnd(50)} ${detail ?? ""}`);
    if (ok) pass++;
    else fail++;
  };

  // ─── Per-persona checks ─────────────────────────────────────────
  console.log("[Persona balances]");
  for (const p of personas) {
    try {
      const ethBal = await publicClient.getBalance({ address: p.address });
      report(`${p.name} ETH balance > 0`, ethBal > 0n, `${ethBal} wei`);
    } catch (err) {
      report(`${p.name} ETH balance`, false, String(err).slice(0, 80));
    }

    try {
      const usdcBal = (await publicClient.readContract({
        address: deployments.TestUSDC as `0x${string}`,
        abi: [
          { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
        ],
        functionName: "balanceOf",
        args: [p.address],
      })) as bigint;
      // After sweep, persona's TestUSDC = 100 (faucet) - 10 (shield) - small change.
      // Just verify > 0.
      report(`${p.name} TestUSDC > 0`, usdcBal > 0n, `${usdcBal} (raw)`);
    } catch (err) {
      report(`${p.name} TestUSDC`, false, String(err).slice(0, 80));
    }
  }
  console.log("");

  // ─── Vault totalDeposited ──────────────────────────────────────
  console.log("[Vault state]");
  try {
    const totalDeposited = (await publicClient.readContract({
      address: deployments.FHERC20Vault_USDC as `0x${string}`,
      abi: [
        { name: "totalDeposited", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
      ],
      functionName: "totalDeposited",
    })) as bigint;
    report("FHERC20Vault.totalDeposited > 0", totalDeposited > 0n, `${totalDeposited} (raw)`);
  } catch (err) {
    report("FHERC20Vault.totalDeposited", false, String(err).slice(0, 80));
  }
  console.log("");

  // ─── GroupManager — Alice's most recent group ───────────────────
  console.log("[GroupManager state]");
  try {
    const nextGid = (await publicClient.readContract({
      address: deployments.GroupManager as `0x${string}`,
      abi: [{ name: "nextGroupId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
      functionName: "nextGroupId",
    })) as bigint;
    report("GroupManager.nextGroupId > 0", nextGid > 0n, `${nextGid}`);

    // The on-chain GroupManager is GLOBAL — other deployers' tests run
    // against the same contract too. So the most-recent groups aren't
    // necessarily ours. Scan a wider window to find one with our four
    // personas; cap at 500 for sanity.
    if (nextGid > 0n) {
      const windowSize = nextGid > 500n ? 500n : nextGid;
      let foundFullGroup = false;
      let foundGid: bigint | null = null;
      let scannedCount = 0n;
      let sampleMembers: string | null = null;
      for (let i = 1n; i <= windowSize; i++) {
        const gid = nextGid - i;
        try {
          const result = (await publicClient.readContract({
            address: deployments.GroupManager as `0x${string}`,
            abi: [
              {
                name: "getGroup",
                type: "function",
                stateMutability: "view",
                inputs: [{ name: "groupId", type: "uint256" }],
                outputs: [
                  { name: "name", type: "string" },
                  { name: "members", type: "address[]" },
                  { name: "expenseCount", type: "uint256" },
                  { name: "active", type: "bool" },
                ],
              },
            ],
            functionName: "getGroup",
            args: [gid],
          })) as readonly [string, readonly `0x${string}`[], bigint, boolean];
          scannedCount++;
          const members = result[1].map((m) => m.toLowerCase());
          if (sampleMembers === null && members.length > 0) {
            sampleMembers = `gid ${gid}: ${members.slice(0, 4).join(", ")}`;
          }
          const allFour = personas.every((p) => members.includes(p.address.toLowerCase()));
          if (allFour) {
            foundFullGroup = true;
            foundGid = gid;
            break;
          }
        } catch {
          /* try next */
        }
      }
      report(
        `recent group with all 4 personas as members`,
        foundFullGroup,
        foundGid !== null
          ? `groupId=${foundGid}`
          : `scanned ${scannedCount}/${windowSize}; sample: ${sampleMembers ?? "<none>"}`,
      );
    }
  } catch (err) {
    report("GroupManager state", false, String(err).slice(0, 80));
  }
  console.log("");

  // ─── InheritanceManager — Carol's plan has Dave as heir ───────
  // The contract exposes `getPlan(owner)` which returns a struct
  // (heir, inactivityPeriod, lastHeartbeat, claimStartedAt, active,
  // vaults). Read Carol's plan and verify heir == Dave.
  console.log("[InheritanceManager state]");
  if (deployments.InheritanceManager) {
    try {
      const plan = (await publicClient.readContract({
        address: deployments.InheritanceManager as `0x${string}`,
        abi: [
          {
            name: "getPlan",
            type: "function",
            stateMutability: "view",
            inputs: [{ name: "owner_", type: "address" }],
            outputs: [
              { name: "heir", type: "address" },
              { name: "inactivityPeriod", type: "uint256" },
              { name: "lastHeartbeat", type: "uint256" },
              { name: "claimStartedAt", type: "uint256" },
              { name: "active", type: "bool" },
              { name: "vaults", type: "address[]" },
            ],
          },
        ],
        functionName: "getPlan",
        args: [personas[2]!.address], // Carol
      })) as readonly [string, bigint, bigint, bigint, boolean, readonly string[]];
      const heir = plan[0];
      const active = plan[4];
      const expected = personas[3]!.address.toLowerCase();
      const heirOk = heir.toLowerCase() === expected;
      report(
        `getPlan(Carol).heir == Dave`,
        heirOk,
        heirOk ? heir : `expected ${expected}, got ${heir}`,
      );
      report(`getPlan(Carol).active`, active);
    } catch (err) {
      report("getPlan(Carol)", false, String(err).slice(0, 80));
    }
  } else {
    report("InheritanceManager deployed", false, "not in deployment file");
  }
  console.log("");

  // ─── CreatorHub — Bob has profile ──────────────────────────────
  console.log("[CreatorHub state]");
  if (deployments.CreatorHub) {
    try {
      const hasProfile = (await publicClient.readContract({
        address: deployments.CreatorHub as `0x${string}`,
        abi: [
          {
            name: "hasProfile",
            type: "function",
            stateMutability: "view",
            inputs: [{ name: "creator", type: "address" }],
            outputs: [{ type: "bool" }],
          },
        ],
        functionName: "hasProfile",
        args: [personas[1]!.address], // Bob
      })) as boolean;
      report("CreatorHub.hasProfile(Bob)", hasProfile);
    } catch (err) {
      report("CreatorHub.hasProfile(Bob)", false, String(err).slice(0, 80));
    }
  }
  console.log("");

  // ─── Summary ───────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  ${pass} pass · ${fail} fail · ${pass + fail} total`);
  console.log("═══════════════════════════════════════════════════════════════");
});
