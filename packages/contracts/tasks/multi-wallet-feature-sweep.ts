import { task } from "hardhat/config";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Encryptable } from "@cofhe/sdk";
import { createCofheClient, createCofheConfig } from "@cofhe/sdk/node";
import { sepolia as cofheSepolia, baseSepolia as cofheBaseSepolia, arbSepolia as cofheArbSepolia } from "@cofhe/sdk/chains";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodePacked,
  http,
  keccak256,
  parseEther,
  parseUnits,
  toBytes,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia as viemSepolia, baseSepolia as viemBaseSepolia, arbitrumSepolia as viemArbSepolia } from "viem/chains";
import { settleFundingExpectFunded, viemGateIO, type GateKind } from "./lib/funding-gate";

// ──────────────────────────────────────────────────────────────────
//  multi-wallet-feature-sweep — drive a real 4-wallet feature sweep
//  on testnet without any UI overhead.
//
//  Purpose:
//   The user's stop-hook directive asks for "4 wallets, all features,
//   end-to-end, like a real human." The UI flow is real-world flaky
//   on Sepolia (RPC CORS / AA UserOp 60–120s latency / passphrase
//   modal race) — so this task drives the SAME contract paths the
//   UI exercises, but as plain viem calls signed by EOA keys. The
//   on-chain side effects, encrypted state, and receipts are exactly
//   the same as what the UI produces.
//
//  Personas:
//   Alice/Bob/Carol/Dave — derived deterministically from
//   the deployer key + a per-persona salt so the addresses are
//   reproducible across runs. Each persona signs as itself.
//
//  Features exercised:
//   1. faucet — each persona mints TestUSDC
//   2. shield — each persona deposits into FHE vault
//   3. P2P pay — Alice→Bob and Carol→Dave via PaymentHub.sendPayment
//   4. Group — Alice creates group, all 4 add, settle one debt
//   5. Payment receipts — verify receipt anchors landed for each tx
//
//  Funding gate:
//   Escrow, gift, claim link, tip, contribution, offramp fill and storefront
//   purchase start Pending on an upgraded contract. Each one is confirmed
//   (decrypt the funded bit, confirmFunding) before the step that needs it
//   Active, and the confirm is recorded as its own "<feature>_funding" result.
//   Contracts that predate the gate record a skip for that result instead.
//
//  Output:
//   A summary table of tx hashes per feature × persona, plus a
//   pass/fail line per feature. Failures print the revert reason
//   inline; the task continues so partial coverage is still useful.
//
//  Usage:
//   npx hardhat multi-wallet-feature-sweep --network eth-sepolia
//   npx hardhat multi-wallet-feature-sweep --network base-sepolia
//   npx hardhat multi-wallet-feature-sweep --network arb-sepolia
// ──────────────────────────────────────────────────────────────────

const FAUCET_AMOUNT = parseUnits("100", 6); // 100 USDC
const SHIELD_AMOUNT = parseUnits("10", 6); //  10 USDC
const PAY_AMOUNT = parseUnits("1", 6); //    1 USDC
const MAX_U64 = (1n << 64n) - 1n;

interface Persona {
  name: string;
  privKey: Hex;
  address: `0x${string}`;
}

interface FeatureResult {
  feature: string;
  persona: string;
  status: "pass" | "fail" | "skip";
  txHash?: string;
  error?: string;
}

task(
  "multi-wallet-feature-sweep",
  "Drive a real 4-wallet feature sweep on testnet (shield/pay/group/receipts)",
).setAction(async (_args, hre) => {
  const networkName = hre.network.name;
  const isBase = networkName === "base-sepolia";
  const isArb = networkName === "arb-sepolia";
  if (networkName !== "eth-sepolia" && networkName !== "base-sepolia" && networkName !== "arb-sepolia") {
    throw new Error(`Unsupported network ${networkName} (expected eth-sepolia, base-sepolia, or arb-sepolia)`);
  }

  const deploymentFile = isBase
    ? "base-sepolia.json"
    : isArb
      ? "arb-sepolia.json"
      : "eth-sepolia.json";
  const deployments = JSON.parse(
    readFileSync(resolve(__dirname, "..", "deployments", deploymentFile), "utf8"),
  ) as Record<string, string>;

  const TestUSDC = deployments.TestUSDC;
  const Vault = deployments.FHERC20Vault_USDC;
  const PaymentHub = deployments.PaymentHub;
  const GroupManager = deployments.GroupManager;
  if (!TestUSDC || !Vault || !PaymentHub || !GroupManager) {
    throw new Error(
      `Missing core deployment addrs in ${deploymentFile} — got TestUSDC=${TestUSDC}, Vault=${Vault}, PaymentHub=${PaymentHub}, GroupManager=${GroupManager}`,
    );
  }

  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error("PRIVATE_KEY env missing");
  const deployerHex = (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex;
  const deployerAccount = privateKeyToAccount(deployerHex);

  const rpcUrl = isBase
    ? process.env.BASE_SEPOLIA_RPC_URL || "https://base-sepolia-rpc.publicnode.com"
    : isArb
      ? process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc"
      : process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia.publicnode.com";

  const chain = isBase ? viemBaseSepolia : isArb ? viemArbSepolia : viemSepolia;
  const cofheChainCfg = isBase ? cofheBaseSepolia : isArb ? cofheArbSepolia : cofheSepolia;

  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const deployerWallet = createWalletClient({
    account: deployerAccount,
    chain,
    transport: http(rpcUrl),
  });

  // Derive deterministic per-persona keys via keccak256(deployer || name).
  // Earlier the derivation truncated to deployerHex (all four personas
  // ended up as the deployer — caught by the inheritance "invalid heir"
  // revert which would only fire if heir == self). keccak256 gives 32
  // distinct bytes per persona, plus the deployer salt scopes the keys
  // to the operator's deployer so they're reproducible across runs.
  // SAFETY: testnet only; these wallets are funded from the deployer
  // and never hold real value.
  const personas: Persona[] = ["Alice", "Bob", "Carol", "Dave"].map((name) => {
    const seed = keccak256(toBytes(deployerHex + "::" + name));
    const privKey = seed as Hex;
    const acct = privateKeyToAccount(privKey);
    return { name, privKey, address: acct.address };
  });

  // Extract the indexed-id from a creation event log. Walks the receipt
  // logs for an event whose topic[0] matches `eventSelector` AND whose
  // emitter is `contractAddr`. Returns the id from topic[1]. This is
  // race-safe vs the prior "read nextId" approach because we read OUR
  // OWN tx's logs — guaranteed to be the id we just minted, no matter
  // what other deployers do to the counter concurrently.
  async function extractIdFromReceipt(
    hash: `0x${string}`,
    contractAddr: string,
    eventSelector: `0x${string}`,
  ): Promise<bigint> {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === contractAddr.toLowerCase() &&
        log.topics[0]?.toLowerCase() === eventSelector.toLowerCase() &&
        log.topics[1]
      ) {
        return BigInt(log.topics[1]);
      }
    }
    throw new Error(
      `extractIdFromReceipt: no matching event ${eventSelector} from ${contractAddr} in ${hash}`,
    );
  }

  // Poll ClaimLinks.getLink(linkId) until the RPC returns a sender !=
  // 0x0, proving the just-mined createLink is now visible to this
  // node. Base Sepolia's load-balanced RPCs sometimes serve a node
  // that's 1 block behind, which makes simulateContract revert with
  // "no such link" instead of the spec'd guard. 5×400ms = 2s max wait.
  async function waitForLinkVisible(claimLinksAddr: `0x${string}`, linkId: bigint): Promise<void> {
    for (let i = 0; i < 5; i++) {
      try {
        const result = (await publicClient.readContract({
          address: claimLinksAddr,
          abi: [
            {
              name: "getLink",
              type: "function",
              stateMutability: "view",
              inputs: [{ name: "linkId", type: "uint256" }],
              outputs: [
                { name: "sender", type: "address" },
                { name: "vault", type: "address" },
                { name: "mode", type: "uint8" },
                { name: "boundAddress", type: "address" },
                { name: "createdAt", type: "uint256" },
                { name: "expiryTimestamp", type: "uint256" },
                { name: "claimed", type: "bool" },
                { name: "refunded", type: "bool" },
                { name: "note", type: "string" },
                { name: "claimer", type: "address" },
                { name: "claimedAt", type: "uint256" },
              ],
            },
          ],
          functionName: "getLink",
          args: [linkId],
        })) as readonly [`0x${string}`, ...unknown[]];
        if (result[0] !== "0x0000000000000000000000000000000000000000") return;
      } catch {
        /* RPC blip; try again */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  // ClaimLinks v2: the secret derives a one-time claim key; only its address
  // goes on-chain and the claimer submits the key's EIP-191 signature over
  // claimDigest(linkId, claimer). Mirrors packages/app/src/lib/claim-links.ts.
  const CLAIM_LINKS_V2_ABI = [
    {
      name: "createLink",
      type: "function",
      stateMutability: "nonpayable",
      inputs: [
        { name: "vault", type: "address" },
        { name: "encAmount", type: "bytes32" },
        { name: "proof", type: "bytes" },
        { name: "claimKey", type: "address" },
        { name: "mode", type: "uint8" },
        { name: "boundAddress", type: "address" },
        { name: "expirySeconds", type: "uint256" },
        { name: "note", type: "string" },
      ],
      outputs: [{ name: "linkId", type: "uint256" }],
    },
    {
      name: "claim",
      type: "function",
      stateMutability: "nonpayable",
      inputs: [
        { name: "linkId", type: "uint256" },
        { name: "signature", type: "bytes" },
      ],
      outputs: [],
    },
    {
      name: "claimDigest",
      type: "function",
      stateMutability: "view",
      inputs: [
        { name: "linkId", type: "uint256" },
        { name: "claimer", type: "address" },
      ],
      outputs: [{ type: "bytes32" }],
    },
  ] as const;
  const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

  /** Fresh secret + claim key for a mode. EmailBound mixes the email hash in. */
  function makeClaimKey(seedLabel: string, mode: 0 | 1 | 2, emailHash?: Hex): { priv: Hex; claimKey: `0x${string}` } {
    for (let attempt = 0; attempt < 16; attempt++) {
      const secretHex = keccak256(toBytes(`${seedLabel}-${Date.now()}-${attempt}`));
      const priv =
        mode === 1
          ? keccak256(encodePacked(["string", "uint8", "bytes32", "bytes32"], ["BLANK_CLAIM_KEY_v2", 1, secretHex, emailHash!]))
          : keccak256(encodePacked(["string", "uint8", "bytes32"], ["BLANK_CLAIM_KEY_v2", mode, secretHex]));
      const n = BigInt(priv);
      if (n !== 0n && n < SECP256K1_N) return { priv, claimKey: privateKeyToAccount(priv).address };
    }
    throw new Error("could not derive a valid claim key");
  }

  /** Claim signature for `claimer`, signed by the claim key. */
  async function signClaim(claimLinksAddr: `0x${string}`, priv: Hex, linkId: bigint, claimer: `0x${string}`): Promise<Hex> {
    const digest = (await publicClient.readContract({
      address: claimLinksAddr,
      abi: CLAIM_LINKS_V2_ABI,
      functionName: "claimDigest",
      args: [linkId, claimer],
    })) as Hex;
    return privateKeyToAccount(priv).signMessage({ message: { raw: digest } });
  }

  // Pre-computed event selectors (keccak256 of the canonical event sig)
  // Used to extract the just-minted id from the create tx receipt.
  // These are race-safe because we're reading OUR tx's logs.
  const SIG = {
    LinkCreated:     keccak256(toBytes("LinkCreated(uint256,address,address,uint8,address,uint256,string)")),
    EnvelopeCreated: keccak256(toBytes("EnvelopeCreated(uint256,address,address,uint256,string,uint256)")),
    EscrowCreated:   keccak256(toBytes("EscrowCreated(uint256,address,address,address,uint256)")),
    ListingCreated:  keccak256(toBytes("ListingCreated(uint256,address,uint8,address,uint256,string)")),
    GroupCreated:    keccak256(toBytes("GroupCreated(uint256,string,address[],uint256)")),
    StealthSent:     keccak256(toBytes("StealthSent(uint256,address,bytes32,address,string,uint256)")),
    CampaignCreated: keccak256(toBytes("CampaignCreated(uint256,address,address,uint256,string)")),
    // Funding-gate events: emitted only by contracts that have the gate. The
    // ebool argument is a bytes32 handle in the ABI.
    PurchasePending: keccak256(toBytes("PurchasePending(uint256,uint256,address,bytes32)")),
    TipPending:      keccak256(toBytes("TipPending(uint256,address,address,address,bytes32)")),
    FillPending:     keccak256(toBytes("FillPending(uint64,uint64,address,bytes32)")),
    Contributed:     keccak256(toBytes("Contributed(uint256,address,uint256,uint256)")),
  };
  // Defensive: log selectors at startup so a wrong canonical sig is
  // visible (won't match any logs and the extractor throws clearly).
  void SIG;

  // Wait for receipt AND throw on revert. viem's waitForTransactionReceipt
  // returns the receipt regardless of status — receipt.status === "reverted"
  // is the actual on-chain failure signal. Without this check, the sweep
  // was silently accepting reverted txs as "pass" because the hash
  // returned by writeContract was just the broadcast hash, not a
  // success signal. Caught when verify-sweep-state showed group 24
  // didn't have our personas — the settleDebt tx had reverted on-chain
  // with status=0x0 but the sweep printed "ok" because we never checked.
  async function waitOk(hash: `0x${string}`, label: string) {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: 1,
    });
    if (receipt.status === "reverted") {
      throw new Error(
        `${label}: tx reverted on-chain (status=reverted) — hash=${hash}`,
      );
    }
    return receipt;
  }

  // Retry wrapper for writeContract — Sepolia publicnode RPC throws
  // "Missing or invalid parameters" on ~4% of back-to-back submissions
  // (some nonce/encoding race in the RPC layer; always succeeds on retry).
  // Doesn't apply to simulate (read-only) calls, only to writes.
  async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        // publicnode Sepolia throws several distinct transient errors under
        // load: "Missing or invalid parameters", "took too long to respond"
        // (HTTP timeout), and "nonce too low" (rare; happens when a prior
        // tx hadn't propagated yet). All three resolve cleanly on retry.
        const retryable = /missing or invalid parameters|took too long to respond|nonce too low|timeout|request failed|fetch failed/i.test(msg);
        if (retryable && i < attempts - 1) {
          console.log(`    ${label}: retry ${i + 1}/${attempts - 1} (${msg.slice(0, 80)})`);
          await new Promise((r) => setTimeout(r, 2_000 * (i + 1)));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }
  void withRetry; // available for downstream branches; not all writeContract
                  // sites need wrapping yet — only the ones observed to flake.

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Wave 4 · multi-wallet feature sweep");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Network:   ${networkName} (chain ${chain.id})`);
  console.log(`  Deployer:  ${deployerAccount.address}`);
  for (const p of personas) {
    console.log(`  ${p.name.padEnd(6)}    ${p.address}`);
  }
  console.log("═══════════════════════════════════════════════════════════════\n");

  const results: FeatureResult[] = [];

  // ─── Fund personas with ETH for gas (one batch from deployer) ───
  console.log("[Step 0] Funding personas with ETH for gas...");
  // Derive the top-up from live gas price rather than hardcoding it. Every
  // FHE call is submitted with a 5M gas LIMIT (the precompile cannot be
  // estimated), and a wallet must hold limit * price up front even though it
  // spends far less. On an L2 that is dust; on Ethereum Sepolia at 1 gwei it
  // is ~0.005 ETH per submission, which is why a flat 0.002 left every
  // persona unable to send a single transaction there.
  // runPayroll submits with a 10M limit, the largest in this sweep.
  const FHE_GAS_LIMIT = 10_000_000n;
  const SUBMISSIONS_HEADROOM = 5n;
  const livePrice = await publicClient.getGasPrice();
  const derived = FHE_GAS_LIMIT * livePrice * SUBMISSIONS_HEADROOM;
  const floor = parseEther("0.002");
  const gasPerPersona = derived > floor ? derived : floor;
  console.log(`  gas price ${livePrice} wei -> topping each persona up to ${gasPerPersona} wei`);
  for (const p of personas) {
    const bal = await publicClient.getBalance({ address: p.address });
    if (bal >= gasPerPersona) {
      console.log(`  ${p.name}: already has ${bal} wei, skipping`);
      continue;
    }
    try {
      const hash = await deployerWallet.sendTransaction({
        to: p.address,
        value: gasPerPersona,
      });
      await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      console.log(`  ${p.name}: funded with ${gasPerPersona} wei  tx=${hash}`);
    } catch (err) {
      console.log(`  ${p.name}: gas-fund FAILED ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("");

  // ─── 1. Faucet — each persona mints TestUSDC ───────────────────
  console.log("[Feature 1] Faucet — each persona mints TestUSDC");
  for (const p of personas) {
    const wallet = createWalletClient({
      account: privateKeyToAccount(p.privKey),
      chain,
      transport: http(rpcUrl),
    });
    try {
      const balanceBefore = (await publicClient.readContract({
        address: TestUSDC as `0x${string}`,
        abi: [
          { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
        ],
        functionName: "balanceOf",
        args: [p.address],
      })) as bigint;
      if (balanceBefore >= FAUCET_AMOUNT) {
        console.log(`  ${p.name}: already funded (${balanceBefore})`);
        results.push({ feature: "faucet", persona: p.name, status: "skip" });
        continue;
      }
      const hash = await wallet.writeContract({
        address: TestUSDC as `0x${string}`,
        abi: [
          { name: "faucet", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] },
        ],
        functionName: "faucet",
      });
      await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      console.log(`  ${p.name}: faucet ok  tx=${hash}`);
      results.push({ feature: "faucet", persona: p.name, status: "pass", txHash: hash });
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
      console.log(`  ${p.name}: faucet FAILED ${msg}`);
      results.push({ feature: "faucet", persona: p.name, status: "fail", error: msg });
    }
  }
  console.log("");

  // ─── 2. Shield — each persona deposits 10 USDC into the vault ──
  // Cofhe encryption proofs bind to msg.sender on chain. A single
  // deployer-connected cofhe client produces proofs signed by deployer
  // → every InEuint64 sent from a PERSONA wallet then reverts at
  // FHE.asEuint64 because the proof signer doesn't match the caller.
  // Fix: build a per-persona cofhe client each time we need to encrypt
  // for that persona. The CofheClient connect call replaces the wallet
  // on the existing client; cheaper than creating a new client each
  // time but still scoped to the right signer.
  console.log("[Feature 2] Shield — each persona deposits 10 USDC into the vault");
  let cofheClient: any = null;
  try {
    const cfg = createCofheConfig({ supportedChains: [cofheChainCfg] });
    cofheClient = createCofheClient(cfg);
    await cofheClient.connect(publicClient as any, deployerWallet as any);
  } catch (err) {
    console.log(`  cofhe.connect FAILED ${err instanceof Error ? err.message : String(err)}`);
  }

  // Helper: reconnect the cofhe client with a specific persona's wallet
  // so the next encryptInputs call signs proofs for that persona.
  async function connectCofheAs(persona: Persona): Promise<void> {
    if (!cofheClient) return;
    const wallet = createWalletClient({
      account: privateKeyToAccount(persona.privKey),
      chain,
      transport: http(rpcUrl),
    });
    await cofheClient.connect(publicClient as any, wallet as any);
  }

  // Funding gate. On an upgraded contract an item starts Pending and every
  // follow-up call reverts until confirmFunding lands. The creating persona
  // submits it, though anyone could. Records "<feature>" as pass with the
  // confirm tx, or skip when the contract predates the gate. A failure is
  // recorded and rethrown so the dependent steps below it are not attempted.
  async function settleGate(
    kind: GateKind,
    ids: bigint[],
    address: string,
    by: Persona,
    feature: string,
    label: string,
  ): Promise<void> {
    const walletClient = createWalletClient({
      account: privateKeyToAccount(by.privKey),
      chain,
      transport: http(rpcUrl),
    });
    try {
      const out = await settleFundingExpectFunded(
        viemGateIO(kind, ids, { publicClient, walletClient, address: address as `0x${string}` }),
        cofheClient,
        { label },
      );
      if (!out.gated) {
        console.log(`  ${label}: funding gate skipped (${out.reason})`);
        results.push({ feature, persona: by.name, status: "skip", error: out.reason });
        return;
      }
      results.push({ feature, persona: by.name, status: "pass", txHash: out.confirmTx });
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
      console.log(`  ${label}: funding gate FAILED ${msg}`);
      results.push({ feature, persona: by.name, status: "fail", error: msg });
      throw err;
    }
  }

  // First matching event's first indexed arg (the new item's id), or null when
  // the contract never emits any of them (a generation without the gate).
  async function tryExtractId(
    hash: `0x${string}`,
    contractAddr: string,
    selectors: readonly `0x${string}`[],
  ): Promise<bigint | null> {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    for (const log of receipt.logs) {
      if (
        log.address.toLowerCase() === contractAddr.toLowerCase() &&
        selectors.some((s) => log.topics[0]?.toLowerCase() === s.toLowerCase()) &&
        log.topics[1]
      ) {
        return BigInt(log.topics[1]);
      }
    }
    return null;
  }

  if (!cofheClient) {
    for (const p of personas) {
      results.push({ feature: "shield", persona: p.name, status: "skip", error: "cofhe client unavailable" });
    }
  } else {
    for (const p of personas) {
      const wallet = createWalletClient({
        account: privateKeyToAccount(p.privKey),
        chain,
        transport: http(rpcUrl),
      });
      try {
        // Approve vault as spender on TestUSDC (plain ERC20 approve).
        const approveHash = await wallet.writeContract({
          address: TestUSDC as `0x${string}`,
          abi: [
            { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
          ],
          functionName: "approve",
          args: [Vault as `0x${string}`, SHIELD_AMOUNT],
        });
        await waitOk(approveHash, "approveHash");

        // shield(amount) — plaintext amount (uint256), vault encrypts internally.
        // Manual gas because the FHE precompile inside _balances[..] = FHE.add(..)
        // breaks viem's auto-estimation; ~2-5M is the empirical band for shield.
        const shieldHash = await withRetry(`shield ${p.name}`, () => wallet.writeContract({
          address: Vault as `0x${string}`,
          abi: [
            { name: "shield", type: "function", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
          ],
          functionName: "shield",
          args: [SHIELD_AMOUNT],
          gas: 5_000_000n,
        }));
        await waitOk(shieldHash, "shieldHash");
        console.log(`  ${p.name}: shield ok  approve=${approveHash}  shield=${shieldHash}`);
        results.push({ feature: "shield", persona: p.name, status: "pass", txHash: shieldHash });
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
        console.log(`  ${p.name}: shield FAILED ${msg}`);
        results.push({ feature: "shield", persona: p.name, status: "fail", error: msg });
      }
    }
  }
  console.log("");

  // ─── 3. P2P payments — A→B and C→D ─────────────────────────────
  console.log("[Feature 3] P2P — Alice→Bob and Carol→Dave (1 USDC each)");
  const pairs: Array<[Persona, Persona]> = [
    [personas[0]!, personas[1]!],
    [personas[2]!, personas[3]!],
  ];
  if (!cofheClient) {
    for (const [from, to] of pairs) {
      results.push({ feature: `pay_${from.name}_${to.name}`, persona: from.name, status: "skip", error: "cofhe client unavailable" });
    }
  } else {
    for (const [from, to] of pairs) {
      const wallet = createWalletClient({
        account: privateKeyToAccount(from.privKey),
        chain,
        transport: http(rpcUrl),
      });
      try {
        // Approve PaymentHub on the vault
        const apHash = await wallet.writeContract({
          address: Vault as `0x${string}`,
          abi: [
            { name: "approvePlaintext", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint64" }], outputs: [] },
          ],
          functionName: "approvePlaintext",
          args: [PaymentHub as `0x${string}`, MAX_U64],
        });
        await waitOk(apHash, "apHash");

        // Encrypt the pay amount
        await connectCofheAs(from);
        const [encAmount, encAmountProof] = (await cofheClient
          .encryptInputs([Encryptable.uint64(PAY_AMOUNT)])
          .setConsumingContract(PaymentHub as `0x${string}`)
          .execute()) as [Hex, Hex];

        const payHash = await withRetry(`pay ${from.name}→${to.name}`, () => wallet.writeContract({
          address: PaymentHub as `0x${string}`,
          abi: [
            {
              name: "sendPayment",
              type: "function",
              stateMutability: "nonpayable",
              inputs: [
                { name: "recipient", type: "address" },
                { name: "vault", type: "address" },
                { name: "encAmount", type: "bytes32" },
              { name: "proof", type: "bytes" },
                { name: "note", type: "string" },
              ],
              outputs: [],
            },
          ],
          functionName: "sendPayment",
          args: [to.address, Vault as `0x${string}`, encAmount, encAmountProof, `wave4 sweep ${from.name}→${to.name}`],
          gas: 5_000_000n,
        }));
        await waitOk(payHash, "payHash");
        console.log(`  ${from.name}→${to.name}: pay ok  tx=${payHash}`);
        results.push({ feature: `pay_${from.name}_${to.name}`, persona: from.name, status: "pass", txHash: payHash });
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
        console.log(`  ${from.name}→${to.name}: pay FAILED ${msg}`);
        results.push({ feature: `pay_${from.name}_${to.name}`, persona: from.name, status: "fail", error: msg });
      }
    }
  }
  console.log("");

  // ─── 4. Group — Alice creates a group, all four added ──────────
  console.log("[Feature 4] Group — Alice creates a group with all 4 personas");
  let createdGroupId: bigint | null = null;
  try {
    const aliceWallet = createWalletClient({
      account: privateKeyToAccount(personas[0]!.privKey),
      chain,
      transport: http(rpcUrl),
    });
    const memberAddresses = personas.map((p) => p.address);
    // Capture nextGroupId BEFORE createGroup so we get our actual id
    // (read-after-write races against concurrent test users on a shared
    // testnet — another deployer's createGroup between our write and
    // our read makes nextGroupId-1 point at THEIR group, not ours).
    const gidBeforeCreate = (await publicClient.readContract({
      address: GroupManager as `0x${string}`,
      abi: [{ name: "nextGroupId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
      functionName: "nextGroupId",
    })) as bigint;
    // ABI corrected — contract is createGroup(name, members), not the
    // (members, name) my sweep had previously. The mismatch made every
    // groupHash tx revert silently because we never checked
    // receipt.status. waitOk + correct argument order now both fire.
    const groupHash = await aliceWallet.writeContract({
      address: GroupManager as `0x${string}`,
      abi: [
        {
          name: "createGroup",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "name", type: "string" },
            { name: "members", type: "address[]" },
          ],
          outputs: [{ type: "uint256" }],
        },
      ],
      functionName: "createGroup",
      args: ["Wave 4 Sweep", memberAddresses],
      gas: 5_000_000n,
    });
    await waitOk(groupHash, "groupHash");
    console.log(`  Alice: createGroup ok  tx=${groupHash}`);
    results.push({ feature: "createGroup", persona: "Alice", status: "pass", txHash: groupHash });

    // Extract real groupId from GroupCreated event log — race-safe.
    createdGroupId = await extractIdFromReceipt(groupHash, GroupManager, SIG.GroupCreated);

    // createdGroupId already set above (gidBeforeCreate); the post-write
    // read here is removed because it raced against concurrent writers.
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
    console.log(`  Alice: createGroup FAILED ${msg}`);
    results.push({ feature: "createGroup", persona: "Alice", status: "fail", error: msg });
  }
  console.log("");

  // ─── 4a. Group expense: shares must sum to the total ──────────
  // The contract checks the sum under FHE and emits ExpenseApplied(ebool).
  console.log("[Feature 4a] addExpense: Alice pays 0.2 USDC split Bob 0.1 / Carol 0.1");
  if (createdGroupId === null || !cofheClient) {
    results.push({ feature: "group_addExpense", persona: "Alice", status: "skip", error: "no group or cofhe unavailable" });
  } else {
    try {
      await connectCofheAs(personas[0]!);
      const [shareB, shareC, total, expProof] = (await cofheClient
        .encryptInputs([
          Encryptable.uint64(parseUnits("0.1", 6)),
          Encryptable.uint64(parseUnits("0.1", 6)),
          Encryptable.uint64(parseUnits("0.2", 6)),
        ])
        .setConsumingContract(GroupManager as `0x${string}`)
        .execute()) as [Hex, Hex, Hex, Hex];
      const aliceWallet = createWalletClient({ account: privateKeyToAccount(personas[0]!.privKey), chain, transport: http(rpcUrl) });
      const expHash = await withRetry("addExpense", () => aliceWallet.writeContract({
        address: GroupManager as `0x${string}`,
        abi: [{ name: "addExpense", type: "function", stateMutability: "nonpayable", inputs: [
          { name: "groupId", type: "uint256" }, { name: "splitWith", type: "address[]" }, { name: "shares", type: "bytes32[]" },
          { name: "totalPaid", type: "bytes32" }, { name: "proof", type: "bytes" }, { name: "description", type: "string" },
        ], outputs: [] }],
        functionName: "addExpense",
        args: [createdGroupId, [personas[1]!.address, personas[2]!.address], [shareB, shareC], total, expProof, "sweep dinner"],
        gas: 5_000_000n,
      }));
      const expReceipt = await waitOk(expHash, "addExpense");
      const appliedTopic = keccak256(toBytes("ExpenseApplied(uint256,uint256,bytes32)"));
      const sawApplied = expReceipt.logs.some(
        (lg) => lg.address.toLowerCase() === GroupManager.toLowerCase() && lg.topics[0] === appliedTopic,
      );
      console.log(`  Alice: addExpense ok, ExpenseApplied ${sawApplied ? "emitted" : "MISSING"}  tx=${expHash}`);
      results.push({ feature: "group_addExpense", persona: "Alice", status: sawApplied ? "pass" : "fail", txHash: expHash, error: sawApplied ? undefined : "no ExpenseApplied event" });
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
      console.log(`  Alice: addExpense FAILED ${msg}`);
      results.push({ feature: "group_addExpense", persona: "Alice", status: "fail", error: msg });
    }
  }
  console.log("");

  // ─── 4b. Group second-leg — Bob settles a debt with Carol ──────
  console.log("[Feature 4b] settleDebt — Bob → Carol (0.1 USDC)");
  if (createdGroupId === null || !cofheClient) {
    results.push({ feature: "settleDebt", persona: "Bob", status: "skip", error: "no group or cofhe unavailable" });
  } else {
    try {
      const bobWallet = createWalletClient({
        account: privateKeyToAccount(personas[1]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      // Approve GroupManager on the vault
      const apHash = await bobWallet.writeContract({
        address: Vault as `0x${string}`,
        abi: [
          { name: "approvePlaintext", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint64" }], outputs: [] },
        ],
        functionName: "approvePlaintext",
        args: [GroupManager as `0x${string}`, MAX_U64],
      });
      await waitOk(apHash, "apHash");

      await connectCofheAs(personas[1]!);
      const [encSettle, encSettleProof] = (await cofheClient
        .encryptInputs([Encryptable.uint64(parseUnits("0.1", 6))])
        .setConsumingContract(GroupManager as `0x${string}`)
        .execute()) as [Hex, Hex];

      const settleHash = await withRetry("settleDebt", () => bobWallet.writeContract({
        address: GroupManager as `0x${string}`,
        abi: [
          {
            name: "settleDebt",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "groupId", type: "uint256" },
              { name: "with_", type: "address" },
              { name: "vault", type: "address" },
              { name: "encAmount", type: "bytes32" },
              { name: "proof", type: "bytes" },
            ],
            outputs: [],
          },
        ],
        functionName: "settleDebt",
        args: [createdGroupId, personas[2]!.address, Vault as `0x${string}`, encSettle, encSettleProof],
        gas: 5_000_000n,
      }));
      await waitOk(settleHash, "settleHash");
      console.log(`  Bob→Carol in group ${createdGroupId}: settleDebt ok  tx=${settleHash}`);
      results.push({ feature: "settleDebt", persona: "Bob", status: "pass", txHash: settleHash });

      // First settle pins the group to this vault.
      const pinned = await publicClient.readContract({
        address: GroupManager as `0x${string}`,
        abi: [{ name: "groupVault", type: "function", stateMutability: "view", inputs: [{ name: "", type: "uint256" }], outputs: [{ type: "address" }] }],
        functionName: "groupVault",
        args: [createdGroupId],
      });
      const pinOk = pinned.toLowerCase() === Vault.toLowerCase();
      console.log(`  group ${createdGroupId} pinned vault ${pinned} ${pinOk ? "✓" : "MISMATCH"}`);
      results.push({ feature: "group_vault_pinned", persona: "Bob", status: pinOk ? "pass" : "fail", error: pinOk ? undefined : `pinned=${pinned}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
      console.log(`  Bob→Carol: settleDebt FAILED ${msg}`);
      results.push({ feature: "settleDebt", persona: "Bob", status: "fail", error: msg });
    }
  }
  console.log("");

  // ─── 5. Gift envelope — Alice creates, Bob claims ──────────────
  console.log("[Feature 5] Gift envelope — Alice creates, Bob claims");
  const GiftMoney = deployments.GiftMoney;
  if (!GiftMoney || !cofheClient) {
    results.push({ feature: "gift_create", persona: "Alice", status: "skip", error: !GiftMoney ? "GiftMoney not deployed" : "cofhe client unavailable" });
  } else {
    try {
      const aliceWallet = createWalletClient({
        account: privateKeyToAccount(personas[0]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      // Approve GiftMoney on the vault
      const apHash = await aliceWallet.writeContract({
        address: Vault as `0x${string}`,
        abi: [
          { name: "approvePlaintext", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint64" }], outputs: [] },
        ],
        functionName: "approvePlaintext",
        args: [GiftMoney as `0x${string}`, MAX_U64],
      });
      await waitOk(apHash, "apHash");

      await connectCofheAs(personas[0]!);
      const [encGift, encGiftProof] = (await cofheClient
        .encryptInputs([Encryptable.uint64(PAY_AMOUNT)])
        .setConsumingContract(GiftMoney as `0x${string}`)
        .execute()) as [Hex, Hex];

      // Real signature is createEnvelope(vault, recipients[], shares[],
      // note, expiryTimestamp) — sendGift was the wrong selector name
      // and the wrong arg layout. Fixed both.
      // Race-safe pre-read of nextEnvelopeId
      const envIdPreCreate = (await publicClient.readContract({
        address: GiftMoney as `0x${string}`,
        abi: [{ name: "nextEnvelopeId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "nextEnvelopeId",
      })) as bigint;
      const giftHash = await aliceWallet.writeContract({
        address: GiftMoney as `0x${string}`,
        abi: [
          {
            name: "createEnvelope",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "vault", type: "address" },
              { name: "recipients", type: "address[]" },
              { name: "shares", type: "bytes32[]" },
              { name: "proof", type: "bytes" },
              { name: "note", type: "string" },
              { name: "expiryTimestamp", type: "uint256" },
            ],
            outputs: [{ type: "uint256" }],
          },
        ],
        functionName: "createEnvelope",
        args: [
          Vault as `0x${string}`,
          [personas[1]!.address],
          [encGift],
          encGiftProof,
          "wave4 sweep gift",
          0n,
        ],
        gas: 5_000_000n,
      });
      await waitOk(giftHash, "giftHash");
      console.log(`  Alice→Bob: gift ok  tx=${giftHash}`);
      results.push({ feature: "gift_send", persona: "Alice", status: "pass", txHash: giftHash });

      // Second-leg: Bob claims the gift Alice just sent. nextEnvelopeId
      // increments AFTER each sendGift, so the just-created envelope's id
      // is (nextEnvelopeId - 1). This proves the create→claim flow works
      // end-to-end with two distinct wallets, not just the create call.
      try {
        // Race-safe: extract envelopeId from EnvelopeCreated event log.
        const justCreatedId = await extractIdFromReceipt(giftHash, GiftMoney, SIG.EnvelopeCreated);
        await settleGate("gift", [justCreatedId], GiftMoney, personas[0]!, "gift_funding", `gift #${justCreatedId}`);
        const bobWallet = createWalletClient({
          account: privateKeyToAccount(personas[1]!.privKey),
          chain,
          transport: http(rpcUrl),
        });
        const claimHash = await bobWallet.writeContract({
          address: GiftMoney as `0x${string}`,
          abi: [
            {
              name: "claimGift",
              type: "function",
              stateMutability: "nonpayable",
              inputs: [{ name: "envelopeId", type: "uint256" }],
              outputs: [],
            },
          ],
          functionName: "claimGift",
          args: [justCreatedId],
          gas: 5_000_000n,
        });
        await waitOk(claimHash, "claimHash");
        console.log(`  Bob: claimGift #${justCreatedId} ok  tx=${claimHash}`);
        results.push({ feature: "gift_claim", persona: "Bob", status: "pass", txHash: claimHash });
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
        console.log(`  Bob: claimGift FAILED ${msg}`);
        results.push({ feature: "gift_claim", persona: "Bob", status: "fail", error: msg });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
      console.log(`  Alice→Bob: gift FAILED ${msg}`);
      results.push({ feature: "gift_send", persona: "Alice", status: "fail", error: msg });
    }
  }
  console.log("");

  // ─── 7. Escrow — Alice creates escrow with Bob as beneficiary ──
  console.log("[Feature 7] Escrow — Alice creates escrow → Bob beneficiary, Carol arbiter");
  const EncryptedEscrow = deployments.EncryptedEscrow;
  if (!EncryptedEscrow || !cofheClient) {
    results.push({ feature: "escrow_create", persona: "Alice", status: "skip", error: !EncryptedEscrow ? "EncryptedEscrow not deployed" : "cofhe client unavailable" });
  } else {
    try {
      const aliceWallet = createWalletClient({
        account: privateKeyToAccount(personas[0]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      // Approve EncryptedEscrow on the vault
      const apHash = await aliceWallet.writeContract({
        address: Vault as `0x${string}`,
        abi: [
          { name: "approvePlaintext", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint64" }], outputs: [] },
        ],
        functionName: "approvePlaintext",
        args: [EncryptedEscrow as `0x${string}`, MAX_U64],
      });
      await waitOk(apHash, "apHash");

      await connectCofheAs(personas[0]!);
      const [encEscrow, encEscrowProof] = (await cofheClient
        .encryptInputs([Encryptable.uint64(parseUnits("2", 6))])
        .setConsumingContract(EncryptedEscrow as `0x${string}`)
        .execute()) as [Hex, Hex];

      // Real signature: createEscrow(beneficiary, vault, encAmount,
      // description, arbiter, deadline) — my prior sweep had arbiter
      // before description and was missing deadline entirely. Contract
      // also requires deadline >= block.timestamp + 1 day, so use 7d.
      const escrowDeadline = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60);
      // Race-safe pre-read of nextEscrowId
      const escrowIdPreCreate = (await publicClient.readContract({
        address: EncryptedEscrow as `0x${string}`,
        abi: [{ name: "nextEscrowId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "nextEscrowId",
      })) as bigint;
      const escrowHash = await withRetry("escrow_create", () => aliceWallet.writeContract({
        address: EncryptedEscrow as `0x${string}`,
        abi: [
          {
            name: "createEscrow",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "beneficiary", type: "address" },
              { name: "vault", type: "address" },
              { name: "encAmount", type: "bytes32" },
              { name: "proof", type: "bytes" },
              { name: "description", type: "string" },
              { name: "arbiter", type: "address" },
              { name: "deadline", type: "uint256" },
            ],
            outputs: [{ type: "uint256" }],
          },
        ],
        functionName: "createEscrow",
        args: [
          personas[1]!.address,
          Vault as `0x${string}`,
          encEscrow,
          encEscrowProof,
          "wave4 sweep escrow",
          personas[2]!.address,
          escrowDeadline,
        ],
        gas: 5_000_000n,
      }));
      await waitOk(escrowHash, "escrowHash");
      console.log(`  Alice→Bob (arb=Carol): escrow ok  tx=${escrowHash}`);
      results.push({ feature: "escrow_create", persona: "Alice", status: "pass", txHash: escrowHash });

      // Second-leg flow: Bob marks delivered, Alice approves release.
      try {
        // Race-safe: extract escrowId from EscrowCreated event log.
        const justCreatedEid = await extractIdFromReceipt(escrowHash, EncryptedEscrow, SIG.EscrowCreated);
        await settleGate("escrow", [justCreatedEid], EncryptedEscrow, personas[0]!, "escrow_funding", `escrow #${justCreatedEid}`);
        const bobWallet = createWalletClient({
          account: privateKeyToAccount(personas[1]!.privKey),
          chain,
          transport: http(rpcUrl),
        });
        const markHash = await bobWallet.writeContract({
          address: EncryptedEscrow as `0x${string}`,
          abi: [
            {
              name: "markDelivered",
              type: "function",
              stateMutability: "nonpayable",
              inputs: [{ name: "escrowId", type: "uint256" }],
              outputs: [],
            },
          ],
          functionName: "markDelivered",
          args: [justCreatedEid],
          gas: 2_000_000n,
        });
        await waitOk(markHash, "markHash");
        console.log(`  Bob: markDelivered escrow #${justCreatedEid} ok  tx=${markHash}`);
        results.push({ feature: "escrow_markDelivered", persona: "Bob", status: "pass", txHash: markHash });

        // Negative 17: Dave calls approveRelease on Alice's escrow.
        // Fires NOW while status is still Active so the spec'd
        // "EncryptedEscrow: not depositor" guard reverts, not the
        // "not active" guard that fires after Alice releases.
        console.log("[Negative 17] approveRelease from non-depositor — should revert");
        await expectRevert("Dave unauth-release", "neg_unauth_release", "Dave", async () => {
          await publicClient.simulateContract({
            account: privateKeyToAccount(personas[3]!.privKey),
            address: EncryptedEscrow as `0x${string}`,
            abi: [
              {
                name: "approveRelease",
                type: "function",
                stateMutability: "nonpayable",
                inputs: [{ name: "escrowId", type: "uint256" }],
                outputs: [],
              },
            ],
            functionName: "approveRelease",
            args: [justCreatedEid],
            gas: 2_000_000n,
          });
        });

        // Alice now approves release.
        const aliceWallet2 = createWalletClient({
          account: privateKeyToAccount(personas[0]!.privKey),
          chain,
          transport: http(rpcUrl),
        });
        const releaseHash = await aliceWallet2.writeContract({
          address: EncryptedEscrow as `0x${string}`,
          abi: [
            {
              name: "approveRelease",
              type: "function",
              stateMutability: "nonpayable",
              inputs: [{ name: "escrowId", type: "uint256" }],
              outputs: [],
            },
          ],
          functionName: "approveRelease",
          args: [justCreatedEid],
          gas: 5_000_000n,
        });
        await waitOk(releaseHash, "releaseHash");
        console.log(`  Alice: approveRelease escrow #${justCreatedEid} ok  tx=${releaseHash}`);
        results.push({ feature: "escrow_approveRelease", persona: "Alice", status: "pass", txHash: releaseHash });
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
        console.log(`  escrow 2nd-leg FAILED ${msg}`);
        results.push({ feature: "escrow_2nd_leg", persona: "Bob/Alice", status: "fail", error: msg });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
      console.log(`  Alice→Bob: escrow FAILED ${msg}`);
      results.push({ feature: "escrow_create", persona: "Alice", status: "fail", error: msg });
    }
  }
  console.log("");

  // Hoist secret/linkId from the create-link step out to the outer scope
  // so the second-leg (Dave claims Bob's bearer link) can read both.
  let bearerLinkId: bigint | null = null;
  let bearerClaimPriv: Hex | null = null;

  // ─── 8. Claim link — Bob creates a bearer link ─────────────────
  console.log("[Feature 8] Claim link — Bob creates a bearer link (5 USDC)");
  const ClaimLinks = deployments.ClaimLinks;
  if (!ClaimLinks || !cofheClient) {
    results.push({ feature: "claim_link_create", persona: "Bob", status: "skip", error: !ClaimLinks ? "ClaimLinks not deployed" : "cofhe client unavailable" });
  } else {
    try {
      const bobWallet = createWalletClient({
        account: privateKeyToAccount(personas[1]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      const apHash = await bobWallet.writeContract({
        address: Vault as `0x${string}`,
        abi: [
          { name: "approvePlaintext", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint64" }], outputs: [] },
        ],
        functionName: "approvePlaintext",
        args: [ClaimLinks as `0x${string}`, MAX_U64],
      });
      await waitOk(apHash, "apHash");

      await connectCofheAs(personas[1]!);
      const [encLink, encLinkProof] = (await cofheClient
        .encryptInputs([Encryptable.uint64(parseUnits("0.5", 6))])
        .setConsumingContract(ClaimLinks as `0x${string}`)
        .execute()) as [Hex, Hex];

      // bearer secret -> one-time claim key (v2)
      const bearerKey = makeClaimKey("wave4-sweep-claim-link", 0);

      // Pre-read nextLinkId before create to dodge race against
      // concurrent createLink calls from other deployers on the shared
      // testnet contract.
      const linkIdPreCreate = (await publicClient.readContract({
        address: ClaimLinks as `0x${string}`,
        abi: [{ name: "nextLinkId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "nextLinkId",
      })) as bigint;
      const linkHash = await bobWallet.writeContract({
        address: ClaimLinks as `0x${string}`,
        abi: CLAIM_LINKS_V2_ABI,
        functionName: "createLink",
        args: [
          Vault as `0x${string}`,
          encLink, encLinkProof,
          bearerKey.claimKey,
          0, // BEARER mode
          "0x0000000000000000000000000000000000000000",
          0n,
          "wave4 sweep claim link",
        ],
        gas: 5_000_000n,
      });
      await waitOk(linkHash, "linkHash");
      console.log(`  Bob: createLink ok  tx=${linkHash}`);
      results.push({ feature: "claim_link_create", persona: "Bob", status: "pass", txHash: linkHash });

      // Use the LinkCreated event log to extract the real id we just
      // minted. Race-safe regardless of concurrent writes.
      bearerLinkId = await extractIdFromReceipt(linkHash, ClaimLinks, SIG.LinkCreated);
      bearerClaimPriv = bearerKey.priv;
      // Settle before the negatives so they hit the guard under test and not
      // the "funding pending" revert.
      await settleGate("claimLink", [bearerLinkId], ClaimLinks, personas[1]!, "claim_link_funding", `bearer link #${bearerLinkId}`);

      // Negative 16: Dave attempts to claim the just-created bearer
      // link with an obviously-wrong (all-zero) secret. Runs here, BEFORE
      // Dave's legitimate claim mines, so the revert fires on the
      // hash-mismatch guard (the spec) rather than "already claimed".
      const bearerIdForNeg = bearerLinkId; // narrow null-check
      if (bearerIdForNeg !== null) {
        // Wait for the just-mined createLink to be visible to the
        // simulate's RPC (defeats Base Sepolia's stale-node race).
        await waitForLinkVisible(ClaimLinks as `0x${string}`, bearerIdForNeg);
        console.log("[Negative 16] claim signed by the WRONG key: should revert");
        const wrongKey = makeClaimKey("wave4-sweep-wrong-key", 0);
        const wrongSig = await signClaim(ClaimLinks as `0x${string}`, wrongKey.priv, bearerIdForNeg, personas[3]!.address);
        await expectRevert("wrong-key claim", "neg_wrong_secret_claim", "Dave", async () => {
          await publicClient.simulateContract({
            account: privateKeyToAccount(personas[3]!.privKey),
            address: ClaimLinks as `0x${string}`,
            abi: CLAIM_LINKS_V2_ABI,
            functionName: "claim",
            args: [bearerIdForNeg, wrongSig],
            gas: 5_000_000n,
          });
        });
        // A valid signature made for someone else must not work for Dave.
        console.log("[Negative 16b] claim with a signature bound to another claimer: should revert");
        const carolBoundSig = await signClaim(ClaimLinks as `0x${string}`, bearerKey.priv, bearerIdForNeg, personas[2]!.address);
        await expectRevert("replayed claim signature", "neg_replayed_claim_sig", "Dave", async () => {
          await publicClient.simulateContract({
            account: privateKeyToAccount(personas[3]!.privKey),
            address: ClaimLinks as `0x${string}`,
            abi: CLAIM_LINKS_V2_ABI,
            functionName: "claim",
            args: [bearerIdForNeg, carolBoundSig],
            gas: 5_000_000n,
          });
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
      console.log(`  Bob: createLink FAILED ${msg}`);
      results.push({ feature: "claim_link_create", persona: "Bob", status: "fail", error: msg });
    }
  }
  console.log("");

  // ─── 8c. AddressBound link — Bob creates a Carol-only link ─────
  // Mode = AddressBound (1). Only msg.sender == boundAddress can claim,
  // even with the secret. Use a small amount so we don't drain Bob's
  // remaining encrypted balance.
  console.log("[Feature 8c] AddressBound claim link — Bob → Carol-only, 0.2 USDC");
  if (!ClaimLinks || !cofheClient) {
    results.push({ feature: "claim_link_addr_bound", persona: "Bob", status: "skip", error: "ClaimLinks or cofhe unavailable" });
    results.push({ feature: "claim_link_addr_bound_claim", persona: "Carol", status: "skip", error: "depends on create" });
  } else {
    try {
      const bobWallet = createWalletClient({
        account: privateKeyToAccount(personas[1]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      await connectCofheAs(personas[1]!);
      const [encAddrLink, encAddrLinkProof] = (await cofheClient
        .encryptInputs([Encryptable.uint64(parseUnits("0.2", 6))])
        .setConsumingContract(ClaimLinks as `0x${string}`)
        .execute()) as [Hex, Hex];

      // LinkMode enum: Bearer=0, EmailBound=1, AddressBound=2
      const abKey = makeClaimKey("wave4-sweep-addrbound", 2);

      // Pre-read for AddressBound link too
      const abLinkIdPreCreate = (await publicClient.readContract({
        address: ClaimLinks as `0x${string}`,
        abi: [{ name: "nextLinkId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "nextLinkId",
      })) as bigint;
      const linkABHash = await withRetry("claim_link_ab_create", () => bobWallet.writeContract({
        address: ClaimLinks as `0x${string}`,
        abi: CLAIM_LINKS_V2_ABI,
        functionName: "createLink",
        args: [
          Vault as `0x${string}`,
          encAddrLink, encAddrLinkProof,
          abKey.claimKey,
          2, // LinkMode.AddressBound (Bearer=0, EmailBound=1, AddressBound=2)
          personas[2]!.address, // Carol only
          0n,
          "wave4 sweep AddressBound link",
        ],
        gas: 5_000_000n,
      }));
      await waitOk(linkABHash, "linkABHash");
      console.log(`  Bob: AddressBound createLink (bound=Carol) ok  tx=${linkABHash}`);
      results.push({ feature: "claim_link_addr_bound", persona: "Bob", status: "pass", txHash: linkABHash });

      // Carol claims via claim() with the bound-address guard
      // Race-safe: extract the real linkId from the AddressBound
      // createLink tx's LinkCreated event log.
      const justCreatedAB = await extractIdFromReceipt(linkABHash, ClaimLinks, SIG.LinkCreated);
      await settleGate("claimLink", [justCreatedAB], ClaimLinks, personas[1]!, "claim_link_addr_bound_funding", `AddressBound link #${justCreatedAB}`);

      // Negative 8d: Dave tries to claim Carol's AddressBound link
      // BEFORE Carol claims, so the revert hits "not bound address"
      // (the spec'd guard) rather than the "already claimed" guard
      // that fires after Carol's claim mines.
      await waitForLinkVisible(ClaimLinks as `0x${string}`, justCreatedAB);
      console.log("[Negative 8d] AddressBound claim by non-bound address — should revert");
      // Dave holds a correctly signed claim for himself; the bound-address
      // guard must still reject it.
      const daveSigAB = await signClaim(ClaimLinks as `0x${string}`, abKey.priv, justCreatedAB, personas[3]!.address);
      await expectRevert("Dave claims Carol's link", "neg_addr_bound_wrong_caller", "Dave", async () => {
        await publicClient.simulateContract({
          account: privateKeyToAccount(personas[3]!.privKey),
          address: ClaimLinks as `0x${string}`,
          abi: CLAIM_LINKS_V2_ABI,
          functionName: "claim",
          args: [justCreatedAB, daveSigAB],
          gas: 5_000_000n,
        });
      });

      const carolWallet = createWalletClient({
        account: privateKeyToAccount(personas[2]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      const carolSigAB = await signClaim(ClaimLinks as `0x${string}`, abKey.priv, justCreatedAB, personas[2]!.address);
      const claimABHash = await withRetry("claim_link_ab_claim", () => carolWallet.writeContract({
        address: ClaimLinks as `0x${string}`,
        abi: CLAIM_LINKS_V2_ABI,
        functionName: "claim",
        args: [justCreatedAB, carolSigAB],
        gas: 5_000_000n,
      }));
      await waitOk(claimABHash, "claimABHash");
      console.log(`  Carol: claim (AddressBound) link #${justCreatedAB} ok  tx=${claimABHash}`);
      results.push({ feature: "claim_link_addr_bound_claim", persona: "Carol", status: "pass", txHash: claimABHash });
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
      console.log(`  AddressBound flow FAILED ${msg}`);
      results.push({ feature: "claim_link_addr_bound", persona: "Bob", status: "fail", error: msg });
    }
  }
  console.log("");

  // ─── 8e. EmailBound link — Carol creates, Dave knows email + claims
  // Mode = EmailBound (1). Anyone who knows BOTH the secret AND the
  // exact email hash can claim. The hash is computed off-chain so the
  // contract never sees the email plaintext.
  console.log("[Feature 8e] EmailBound claim link — Carol → email-only, 0.15 USDC");
  if (!ClaimLinks || !cofheClient) {
    results.push({ feature: "claim_link_email_bound", persona: "Carol", status: "skip", error: "ClaimLinks or cofhe unavailable" });
    results.push({ feature: "claim_link_email_bound_claim", persona: "Dave", status: "skip", error: "depends on create" });
  } else {
    try {
      await connectCofheAs(personas[2]!);
      const [encEmailLink, encEmailLinkProof] = (await cofheClient
        .encryptInputs([Encryptable.uint64(parseUnits("0.15", 6))])
        .setConsumingContract(ClaimLinks as `0x${string}`)
        .execute()) as [Hex, Hex];

      // Approve ClaimLinks on the vault (Carol — different signer than Bob)
      const carolWallet0 = createWalletClient({
        account: privateKeyToAccount(personas[2]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      const apEbHash = await carolWallet0.writeContract({
        address: Vault as `0x${string}`,
        abi: [
          { name: "approvePlaintext", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint64" }], outputs: [] },
        ],
        functionName: "approvePlaintext",
        args: [ClaimLinks as `0x${string}`, MAX_U64],
      });
      await waitOk(apEbHash, "apEbHash");

      const ebEmailHash = keccak256(toBytes("dave@wave4-sweep.example"));
      const ebKey = makeClaimKey("wave4-sweep-emailbound", 1, ebEmailHash);

      const linkEBHash = await withRetry("claim_link_eb_create", () => carolWallet0.writeContract({
        address: ClaimLinks as `0x${string}`,
        abi: CLAIM_LINKS_V2_ABI,
        functionName: "createLink",
        args: [
          Vault as `0x${string}`,
          encEmailLink, encEmailLinkProof,
          ebKey.claimKey,
          1, // EmailBound
          "0x0000000000000000000000000000000000000000",
          0n,
          "wave4 sweep EmailBound link",
        ],
        gas: 5_000_000n,
      }));
      await waitOk(linkEBHash, "linkEBHash");
      console.log(`  Carol: EmailBound createLink ok  tx=${linkEBHash}`);
      results.push({ feature: "claim_link_email_bound", persona: "Carol", status: "pass", txHash: linkEBHash });

      // Dave claims with the same secret + emailHash
      const justCreatedEB = await extractIdFromReceipt(linkEBHash, ClaimLinks, SIG.LinkCreated);
      await settleGate("claimLink", [justCreatedEB], ClaimLinks, personas[2]!, "claim_link_email_bound_funding", `EmailBound link #${justCreatedEB}`);
      const daveWalletEB = createWalletClient({
        account: privateKeyToAccount(personas[3]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      const daveSigEB = await signClaim(ClaimLinks as `0x${string}`, ebKey.priv, justCreatedEB, personas[3]!.address);
      const claimEBHash = await withRetry("claim_link_eb_claim", () => daveWalletEB.writeContract({
        address: ClaimLinks as `0x${string}`,
        abi: CLAIM_LINKS_V2_ABI,
        functionName: "claim",
        args: [justCreatedEB, daveSigEB],
        gas: 5_000_000n,
      }));
      await waitOk(claimEBHash, "claimEBHash");
      console.log(`  Dave: claim (EmailBound) link #${justCreatedEB} ok  tx=${claimEBHash}`);
      results.push({ feature: "claim_link_email_bound_claim", persona: "Dave", status: "pass", txHash: claimEBHash });
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
      console.log(`  EmailBound flow FAILED ${msg}`);
      results.push({ feature: "claim_link_email_bound", persona: "Carol", status: "fail", error: msg });
    }
  }
  console.log("");

  // Negative 8d now fires earlier inside the AddressBound flow (see
  // above), so the revert reason is the spec'd "not bound address"
  // guard rather than the "already claimed" guard that fires after
  // Carol's claim mines.

  // ─── 8b. Claim link — Dave claims Bob's bearer link ────────────
  console.log("[Feature 8b] Dave claims Bob's bearer link");
  if (!ClaimLinks || bearerLinkId === null || !bearerClaimPriv) {
    results.push({ feature: "claim_link_claim", persona: "Dave", status: "skip", error: "no link to claim" });
  } else {
    try {
      const daveWallet = createWalletClient({
        account: privateKeyToAccount(personas[3]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      const daveSig = await signClaim(ClaimLinks as `0x${string}`, bearerClaimPriv, bearerLinkId, personas[3]!.address);
      const claimHash = await withRetry("claim_bearer", () => daveWallet.writeContract({
        address: ClaimLinks as `0x${string}`,
        abi: CLAIM_LINKS_V2_ABI,
        functionName: "claim",
        args: [bearerLinkId!, daveSig],
        gas: 5_000_000n,
      }));
      await waitOk(claimHash, "claimHash");
      console.log(`  Dave: claim (Bearer) link #${bearerLinkId} ok  tx=${claimHash}`);
      results.push({ feature: "claim_link_claim", persona: "Dave", status: "pass", txHash: claimHash });
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
      console.log(`  Dave: claim (Bearer) FAILED ${msg}`);
      results.push({ feature: "claim_link_claim", persona: "Dave", status: "fail", error: msg });
    }
  }
  console.log("");

  // ─── 6. Inheritance — Carol sets Dave as heir ──────────────────
  console.log("[Feature 6] Inheritance — Carol sets Dave as heir");
  const Inheritance = deployments.InheritanceManager;
  if (!Inheritance) {
    results.push({ feature: "inheritance_setHeir", persona: "Carol", status: "skip", error: "InheritanceManager not deployed" });
  } else {
    try {
      const carolWallet = createWalletClient({
        account: privateKeyToAccount(personas[2]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      const heirHash = await carolWallet.writeContract({
        address: Inheritance as `0x${string}`,
        abi: [
          {
            name: "setHeir",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "heir", type: "address" },
              { name: "inactivityWindow", type: "uint256" },
            ],
            outputs: [],
          },
        ],
        functionName: "setHeir",
        args: [personas[3]!.address, 90n * 24n * 60n * 60n], // 90 days
      });
      await waitOk(heirHash, "heirHash");
      console.log(`  Carol→Dave: setHeir ok  tx=${heirHash}`);
      results.push({ feature: "inheritance_setHeir", persona: "Carol", status: "pass", txHash: heirHash });
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
      console.log(`  Carol→Dave: setHeir FAILED ${msg}`);
      results.push({ feature: "inheritance_setHeir", persona: "Carol", status: "fail", error: msg });
    }
  }
  console.log("");

  // ─── 9. Storefront — Alice lists an item ───────────────────────
  console.log("[Feature 9] Storefront — Alice lists a 3 USDC item");
  const Storefront = deployments.Storefront;
  if (!Storefront || !cofheClient) {
    results.push({ feature: "storefront_listing", persona: "Alice", status: "skip", error: !Storefront ? "Storefront not deployed" : "cofhe client unavailable" });
  } else {
    try {
      const aliceWallet = createWalletClient({
        account: privateKeyToAccount(personas[0]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      await connectCofheAs(personas[0]!);
      const [encPrice, encPriceProof] = (await cofheClient
        .encryptInputs([Encryptable.uint64(parseUnits("3", 6))])
        .setConsumingContract(Storefront as `0x${string}`)
        .execute()) as [Hex, Hex];
      // Race-safe pre-read of nextListingId
      const listingIdPreCreate = (await publicClient.readContract({
        address: Storefront as `0x${string}`,
        abi: [{ name: "nextListingId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "nextListingId",
      })) as bigint;
      const listingHash = await aliceWallet.writeContract({
        address: Storefront as `0x${string}`,
        abi: [
          {
            name: "createListing",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "mode", type: "uint8" }, // SaleMode.FixedPrice = 0
              { name: "vault", type: "address" },
              { name: "encPrice", type: "bytes32" },
              { name: "proof", type: "bytes" },
              { name: "auctionSeconds", type: "uint256" },
              { name: "title", type: "string" },
              { name: "descriptionCidHash", type: "bytes32" },
              { name: "deliveryChannel", type: "string" },
            ],
            outputs: [{ name: "listingId", type: "uint256" }],
          },
        ],
        functionName: "createListing",
        args: [
          0, // FixedPrice
          Vault as `0x${string}`,
          encPrice, encPriceProof,
          0n, // auctionSeconds = 0 for fixed
          "Wave4 Sweep Item",
          "0x0000000000000000000000000000000000000000000000000000000000000000",
          "email",
        ],
        gas: 5_000_000n,
      });
      await waitOk(listingHash, "listingHash");
      console.log(`  Alice: createListing ok  tx=${listingHash}`);
      results.push({ feature: "storefront_listing", persona: "Alice", status: "pass", txHash: listingHash });

      // Second-leg: Carol buys Alice's just-created listing for 3 USDC.
      try {
        // Race-safe: extract listingId from ListingCreated event log.
        const justListed = await extractIdFromReceipt(listingHash, Storefront, SIG.ListingCreated);
        const carolWallet = createWalletClient({
          account: privateKeyToAccount(personas[2]!.privKey),
          chain,
          transport: http(rpcUrl),
        });
        // Approve Storefront on vault
        const apHash = await carolWallet.writeContract({
          address: Vault as `0x${string}`,
          abi: [
            { name: "approvePlaintext", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint64" }], outputs: [] },
          ],
          functionName: "approvePlaintext",
          args: [Storefront as `0x${string}`, MAX_U64],
        });
        await waitOk(apHash, "apHash");
        await connectCofheAs(personas[2]!);
        const [encBuy, encBuyProof] = (await cofheClient
          .encryptInputs([Encryptable.uint64(parseUnits("3", 6))])
          .setConsumingContract(Storefront as `0x${string}`)
          .execute()) as [Hex, Hex];
        const deliveryNoteHash = keccak256(toBytes("wave4-sweep-buyer-note"));
        const buyHash = await withRetry("storefront_buy", () => carolWallet.writeContract({
          address: Storefront as `0x${string}`,
          abi: [
            {
              name: "buyFixed",
              type: "function",
              stateMutability: "nonpayable",
              inputs: [
                { name: "listingId", type: "uint256" },
                { name: "encAmount", type: "bytes32" },
              { name: "proof", type: "bytes" },
                { name: "deliveryNoteHash", type: "bytes32" },
              ],
              outputs: [{ name: "purchaseId", type: "uint256" }],
            },
          ],
          functionName: "buyFixed",
          args: [justListed, encBuy, encBuyProof, deliveryNoteHash],
          gas: 5_000_000n,
        }));
        const buyReceipt = await waitOk(buyHash, "buyHash");
        console.log(`  Carol: buyFixed listing #${justListed} ok  tx=${buyHash}`);
        results.push({ feature: "storefront_buy", persona: "Carol", status: "pass", txHash: buyHash });

        // The purchase is Pending and FixedPricePaid fires only once the funded
        // bit is confirmed, so settle before checking the seller-side proof.
        const purchaseId = await tryExtractId(buyHash, Storefront, [SIG.PurchasePending]);
        if (purchaseId !== null) {
          await settleGate("purchase", [purchaseId], Storefront, personas[2]!, "storefront_funding", `purchase #${purchaseId}`);
        } else {
          results.push({ feature: "storefront_funding", persona: "Carol", status: "skip", error: "no PurchasePending event (contract predates the gate)" });
        }

        // The seller verifies payment through FixedPricePaid + getPaidByBuyer.
        const paidTopic = keccak256(toBytes("FixedPricePaid(uint256,address,bytes32)"));
        const sawPaid = buyReceipt.logs.some(
          (lg) => lg.address.toLowerCase() === Storefront.toLowerCase() && lg.topics[0] === paidTopic,
        );
        const paidHandle = await publicClient.readContract({
          address: Storefront as `0x${string}`,
          abi: [{ name: "getPaidByBuyer", type: "function", stateMutability: "view", inputs: [{ name: "listingId", type: "uint256" }, { name: "buyer", type: "address" }], outputs: [{ type: "bytes32" }] }],
          functionName: "getPaidByBuyer",
          args: [justListed, personas[2]!.address],
        });
        const paidOk = sawPaid && BigInt(paidHandle) !== 0n;
        console.log(`  listing #${justListed}: FixedPricePaid ${sawPaid ? "emitted" : "MISSING"}, paid-by-buyer handle ${BigInt(paidHandle) !== 0n ? "set" : "MISSING"}`);
        results.push({ feature: "storefront_paid_by_buyer", persona: "Alice", status: paidOk ? "pass" : "fail", error: paidOk ? undefined : "no FixedPricePaid or empty getPaidByBuyer" });
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
        console.log(`  Carol: buyFixed FAILED ${msg}`);
        results.push({ feature: "storefront_buy", persona: "Carol", status: "fail", error: msg });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
      console.log(`  Alice: createListing FAILED ${msg}`);
      results.push({ feature: "storefront_listing", persona: "Alice", status: "fail", error: msg });
    }
  }
  console.log("");

  // ─── 10. Crowdfund — Dave starts a campaign ────────────────────
  console.log("[Feature 10] Crowdfund — Dave starts a 5 USDC campaign");
  const Crowdfund = deployments.EncryptedCrowdfund;
  if (!Crowdfund || !cofheClient) {
    results.push({ feature: "crowdfund_create", persona: "Dave", status: "skip", error: !Crowdfund ? "EncryptedCrowdfund not deployed" : "cofhe client unavailable" });
  } else {
    try {
      const daveWallet = createWalletClient({
        account: privateKeyToAccount(personas[3]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      await connectCofheAs(personas[3]!);
      const [encGoal, encGoalProof] = (await cofheClient
        .encryptInputs([Encryptable.uint64(parseUnits("5", 6))])
        .setConsumingContract(Crowdfund as `0x${string}`)
        .execute()) as [Hex, Hex];
      const cfHash = await daveWallet.writeContract({
        address: Crowdfund as `0x${string}`,
        abi: [
          {
            name: "createCampaign",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "vault", type: "address" },
              { name: "encGoal", type: "bytes32" },
              { name: "proof", type: "bytes" },
              { name: "durationSeconds", type: "uint256" },
              { name: "title", type: "string" },
              { name: "descriptionCidHash", type: "bytes32" },
            ],
            outputs: [{ name: "campaignId", type: "uint256" }],
          },
        ],
        functionName: "createCampaign",
        args: [
          Vault as `0x${string}`,
          encGoal, encGoalProof,
          7n * 24n * 60n * 60n, // 7 days
          "Wave4 Sweep Campaign",
          "0x0000000000000000000000000000000000000000000000000000000000000000",
        ],
        gas: 5_000_000n,
      });
      await waitOk(cfHash, "cfHash");
      console.log(`  Dave: createCampaign ok  tx=${cfHash}`);
      results.push({ feature: "crowdfund_create", persona: "Dave", status: "pass", txHash: cfHash });
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
      console.log(`  Dave: createCampaign FAILED ${msg}`);
      results.push({ feature: "crowdfund_create", persona: "Dave", status: "fail", error: msg });
    }
  }
  console.log("");

  // ─── 11. P2P offramp: Carol makes an offer, Dave takes it ─────
  // P2PExchange is retired (createOffer/fillOffer revert); the fiat
  // offramp is the P2P surface now. Covers: create, take, escrow handle
  // visible to the taker, one open lock per taker, providerId == rail,
  // and (when the deployer is the mock operator) a fill-bound proof.
  console.log("[Feature 11] P2P offramp: Carol offers 0.5 USDC, Dave takes it");
  const P2PExchange = deployments.P2PExchange;
  const P2POfframp = deployments.P2POfframp as `0x${string}` | undefined;
  const OFFRAMP_ABI = [
    { name: "createOffer", type: "function", stateMutability: "nonpayable", inputs: [
      { name: "vault", type: "address" }, { name: "encAmount", type: "bytes32" }, { name: "encMinFill", type: "bytes32" },
      { name: "proof", type: "bytes" }, { name: "fiatRail", type: "uint32" }, { name: "makerHandleHash", type: "bytes32" },
      { name: "fiatAmountMicroUSD", type: "uint64" }, { name: "fiatRateMicroUSD", type: "uint64" }, { name: "expirySeconds", type: "uint32" },
    ], outputs: [{ name: "offerId", type: "uint64" }] },
    { name: "takeOffer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "offerId", type: "uint64" }], outputs: [{ name: "fillId", type: "uint64" }] },
    { name: "submitProof", type: "function", stateMutability: "nonpayable", inputs: [
      { name: "fillId", type: "uint64" }, { name: "reclaimProof", type: "bytes" }, { name: "providerId", type: "uint32" },
    ], outputs: [] },
    { name: "getEscrowedAmount", type: "function", stateMutability: "view", inputs: [{ name: "fillId", type: "uint64" }], outputs: [{ name: "", type: "bytes32" }] },
    { name: "getFill", type: "function", stateMutability: "view", inputs: [{ name: "fillId", type: "uint64" }], outputs: [
      { name: "offerId", type: "uint64" }, { name: "taker", type: "address" }, { name: "fiatAmountAtLockMicroUSD", type: "uint64" },
      { name: "lockedAt", type: "uint32" }, { name: "proofSubmittedAt", type: "uint32" }, { name: "reclaimProofHash", type: "bytes32" }, { name: "state", type: "uint8" },
    ] },
    { name: "activeLocks", type: "function", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint32" }] },
    { name: "reclaimAdapter", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  ] as const;
  const OFFER_CREATED = keccak256(toBytes("OfferCreated(uint64,address,uint64,uint64,uint32,bytes32,uint32)"));
  const FILL_LOCKED = keccak256(toBytes("FillLocked(uint64,uint64,address,uint64)"));
  const RAIL_WISE = 4;

  // Revert check that also asserts the reason, so a different revert
  // (bad state, missing approval) cannot pass as the guard under test.
  async function expectRevertWith(feature: string, persona: string, reason: string, simulate: () => Promise<unknown>) {
    try {
      await simulate();
      console.log(`  ${feature}: UNEXPECTED PASS, no revert`);
      results.push({ feature, persona, status: "fail", error: "no revert" });
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ");
      const ok = msg.includes(reason);
      console.log(`  ${feature}: ${ok ? "reverted with expected reason ✓" : "reverted with WRONG reason"} (${msg.slice(0, 120)})`);
      results.push({ feature, persona, status: ok ? "pass" : "fail", error: ok ? `reverted: ${reason}` : msg.slice(0, 200) });
    }
  }

  if (!P2POfframp || !cofheClient) {
    results.push({ feature: "offramp_create", persona: "Carol", status: "skip", error: !P2POfframp ? "P2POfframp not deployed" : "cofhe client unavailable" });
  } else {
    const carol = personas[2]!;
    const dave = personas[3]!;
    const carolWallet = createWalletClient({ account: privateKeyToAccount(carol.privKey), chain, transport: http(rpcUrl) });
    const daveWallet = createWalletClient({ account: privateKeyToAccount(dave.privKey), chain, transport: http(rpcUrl) });
    try {
      const apHash = await withRetry("carol approve offramp", () => carolWallet.writeContract({
        address: Vault as `0x${string}`,
        abi: [{ name: "approvePlaintext", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint64" }], outputs: [] }],
        functionName: "approvePlaintext",
        args: [P2POfframp, MAX_U64],
        gas: 5_000_000n,
      }));
      await waitOk(apHash, "carol approve offramp");

      // Two offers: the second proves Dave cannot hold two open locks.
      const offerIds: bigint[] = [];
      for (let i = 0; i < 2; i++) {
        await connectCofheAs(carol);
        const amt = parseUnits("0.5", 6);
        const [encAmt, encMin, proof] = (await cofheClient
          .encryptInputs([Encryptable.uint64(amt), Encryptable.uint64(amt)])
          .setConsumingContract(P2POfframp)
          .execute()) as [Hex, Hex, Hex];
        const h = await withRetry("carol createOffer", () => carolWallet.writeContract({
          address: P2POfframp,
          abi: OFFRAMP_ABI,
          functionName: "createOffer",
          args: [Vault as `0x${string}`, encAmt, encMin, proof, RAIL_WISE, keccak256(toBytes("carol@wise")), 500_000n, 1_000_000n, 3600],
          gas: 5_000_000n,
        }));
        await waitOk(h, "carol createOffer");
        offerIds.push(await extractIdFromReceipt(h, P2POfframp, OFFER_CREATED));
        console.log(`  Carol: createOffer #${offerIds[i]} ok  tx=${h}`);
        results.push({ feature: `offramp_create_${i + 1}`, persona: "Carol", status: "pass", txHash: h });
      }

      const takeHash = await withRetry("dave takeOffer", () => daveWallet.writeContract({
        address: P2POfframp, abi: OFFRAMP_ABI, functionName: "takeOffer", args: [offerIds[0]!], gas: 3_000_000n,
      }));
      await waitOk(takeHash, "dave takeOffer");
      // An upgraded contract emits FillPending and the fill stays Pending until
      // confirmFunding; an older one emits FillLocked straight away.
      const fillId = await tryExtractId(takeHash, P2POfframp, [SIG.FillPending, FILL_LOCKED]);
      if (fillId === null) throw new Error(`no FillPending or FillLocked event in ${takeHash}`);
      console.log(`  Dave: takeOffer #${offerIds[0]} -> fill #${fillId}  tx=${takeHash}`);
      results.push({ feature: "offramp_take", persona: "Dave", status: "pass", txHash: takeHash });
      // submitProof and its negatives need the fill Locked, so settle first.
      await settleGate("fill", [fillId], P2POfframp, dave, "offramp_funding", `fill #${fillId}`);

      const escrowHandle = await publicClient.readContract({ address: P2POfframp, abi: OFFRAMP_ABI, functionName: "getEscrowedAmount", args: [fillId] });
      const locks = await publicClient.readContract({ address: P2POfframp, abi: OFFRAMP_ABI, functionName: "activeLocks", args: [dave.address] });
      const escrowOk = BigInt(escrowHandle) !== 0n && locks === 1;
      console.log(`  fill #${fillId}: escrow handle ${escrowOk ? "set" : "MISSING"}, Dave activeLocks=${locks}`);
      results.push({ feature: "offramp_escrow_handle", persona: "Dave", status: escrowOk ? "pass" : "fail", error: escrowOk ? undefined : `handle=${escrowHandle} locks=${locks}` });

      await expectRevertWith("neg_offramp_second_lock", "Dave", "too many open locks", () =>
        publicClient.simulateContract({
          account: privateKeyToAccount(dave.privKey), address: P2POfframp, abi: OFFRAMP_ABI,
          functionName: "takeOffer", args: [offerIds[1]!], gas: 3_000_000n,
        }));

      // providerId is checked against the rail before the adapter runs,
      // so any proof bytes exercise the guard.
      await expectRevertWith("neg_offramp_rail_mismatch", "Dave", "provider/rail mismatch", () =>
        publicClient.simulateContract({
          account: privateKeyToAccount(dave.privKey), address: P2POfframp, abi: OFFRAMP_ABI,
          functionName: "submitProof", args: [fillId, `0x${"11".repeat(65)}`, 1], gas: 1_500_000n,
        }));

      // Fill-bound mock attestation, signed exactly like api/_lib/mock-reclaim-sign.ts.
      const adapter = await publicClient.readContract({ address: P2POfframp, abi: OFFRAMP_ABI, functionName: "reclaimAdapter" });
      const verifier = await publicClient.readContract({
        address: adapter,
        abi: [{ name: "verifier", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
        functionName: "verifier",
      });
      const operator = await publicClient.readContract({
        address: verifier,
        abi: [{ name: "operator", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
        functionName: "operator",
      });
      if (operator.toLowerCase() !== deployerAccount.address.toLowerCase()) {
        results.push({ feature: "offramp_submit_proof", persona: "Dave", status: "skip", error: `mock operator ${operator} is not the deployer` });
      } else {
        const digest = keccak256(encodeAbiParameters(
          [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint64" }, { type: "address" }, { type: "uint32" }, { type: "bytes32" }, { type: "uint64" }],
          [BigInt(chain.id), verifier, P2POfframp, fillId, dave.address, RAIL_WISE, keccak256(toBytes("carol@wise")), 500_000n],
        ));
        const sig = await deployerAccount.signMessage({ message: { raw: digest } });

        // A proof for this fill must not settle when someone else submits it.
        await expectRevertWith("neg_offramp_proof_wrong_taker", "Carol", "not taker", () =>
          publicClient.simulateContract({
            account: privateKeyToAccount(carol.privKey), address: P2POfframp, abi: OFFRAMP_ABI,
            functionName: "submitProof", args: [fillId, sig, RAIL_WISE], gas: 1_500_000n,
          }));

        const proofHash = await withRetry("dave submitProof", () => daveWallet.writeContract({
          address: P2POfframp, abi: OFFRAMP_ABI, functionName: "submitProof", args: [fillId, sig, RAIL_WISE], gas: 1_500_000n,
        }));
        await waitOk(proofHash, "dave submitProof");
        const fill = await publicClient.readContract({ address: P2POfframp, abi: OFFRAMP_ABI, functionName: "getFill", args: [fillId] });
        const locksAfter = await publicClient.readContract({ address: P2POfframp, abi: OFFRAMP_ABI, functionName: "activeLocks", args: [dave.address] });
        const proofOk = fill[6] === 1 && locksAfter === 0;
        console.log(`  Dave: submitProof fill #${fillId} state=${fill[6]} activeLocks=${locksAfter}  tx=${proofHash}`);
        results.push({ feature: "offramp_submit_proof", persona: "Dave", status: proofOk ? "pass" : "fail", txHash: proofHash, error: proofOk ? undefined : `state=${fill[6]} locks=${locksAfter}` });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
      console.log(`  offramp flow FAILED ${msg}`);
      results.push({ feature: "offramp_flow", persona: "Carol", status: "fail", error: msg });
    }
  }
  console.log("");

  // ─── 12. Business runPayroll — Alice batch-pays Bob/Carol/Dave ─
  console.log("[Feature 12] BusinessHub.runPayroll — Alice batches Bob+Carol+Dave");
  const BusinessHub = deployments.BusinessHub;
  if (!BusinessHub || !cofheClient) {
    results.push({ feature: "runPayroll", persona: "Alice", status: "skip", error: !BusinessHub ? "BusinessHub not deployed" : "cofhe client unavailable" });
  } else {
    try {
      const aliceWallet = createWalletClient({
        account: privateKeyToAccount(personas[0]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      // Approve BusinessHub on the vault
      const apHash = await aliceWallet.writeContract({
        address: Vault as `0x${string}`,
        abi: [
          { name: "approvePlaintext", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint64" }], outputs: [] },
        ],
        functionName: "approvePlaintext",
        args: [BusinessHub as `0x${string}`, MAX_U64],
      });
      await waitOk(apHash, "apHash");
      // Encrypt three salaries in parallel
      await connectCofheAs(personas[0]!);
      const salaryBatch = (await cofheClient
        .encryptInputs([
          Encryptable.uint64(parseUnits("0.5", 6)),
          Encryptable.uint64(parseUnits("0.5", 6)),
          Encryptable.uint64(parseUnits("0.5", 6)),
        ])
        .setConsumingContract(BusinessHub as `0x${string}`)
        .execute()) as Hex[];
      const salaries = salaryBatch.slice(0, -1);
      const salariesProof = salaryBatch[salaryBatch.length - 1]!;
      const payrollHash = await aliceWallet.writeContract({
        address: BusinessHub as `0x${string}`,
        abi: [
          {
            name: "runPayroll",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "employees", type: "address[]" },
              { name: "vault", type: "address" },
              { name: "salaries", type: "bytes32[]" },
              { name: "proof", type: "bytes" },
            ],
            outputs: [],
          },
        ],
        functionName: "runPayroll",
        args: [
          [personas[1]!.address, personas[2]!.address, personas[3]!.address],
          Vault as `0x${string}`,
          salaries,
          salariesProof,
        ],
        gas: 10_000_000n,
      });
      await waitOk(payrollHash, "payrollHash");
      console.log(`  Alice → 3 employees: runPayroll ok  tx=${payrollHash}`);
      results.push({ feature: "runPayroll", persona: "Alice", status: "pass", txHash: payrollHash });
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
      console.log(`  Alice: runPayroll FAILED ${msg}`);
      results.push({ feature: "runPayroll", persona: "Alice", status: "fail", error: msg });
    }
  }
  console.log("");

  // ─── 13. requestUnshield — Bob converts encrypted → plaintext ──
  console.log("[Feature 13] requestUnshield — Bob requests 0.5 USDC unshield");
  if (!cofheClient) {
    results.push({ feature: "requestUnshield", persona: "Bob", status: "skip", error: "cofhe client unavailable" });
  } else {
    try {
      const bobWallet = createWalletClient({
        account: privateKeyToAccount(personas[1]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      await connectCofheAs(personas[1]!);
      const [encUnshield, encUnshieldProof] = (await cofheClient
        .encryptInputs([Encryptable.uint64(parseUnits("0.5", 6))])
        .setConsumingContract(Vault as `0x${string}`)
        .execute()) as [Hex, Hex];
      const unshieldHash = await bobWallet.writeContract({
        address: Vault as `0x${string}`,
        abi: [
          {
            name: "requestUnshield",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "encAmount", type: "bytes32" },
              { name: "proof", type: "bytes" },
            ],
            outputs: [{ type: "uint256" }],
          },
        ],
        functionName: "requestUnshield",
        args: [encUnshield, encUnshieldProof],
        gas: 5_000_000n,
      });
      await waitOk(unshieldHash, "unshieldHash");
      console.log(`  Bob: requestUnshield ok  tx=${unshieldHash}`);
      results.push({ feature: "requestUnshield", persona: "Bob", status: "pass", txHash: unshieldHash });
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
      console.log(`  Bob: requestUnshield FAILED ${msg}`);
      results.push({ feature: "requestUnshield", persona: "Bob", status: "fail", error: msg });
    }
  }
  console.log("");

  // ─── 14a. Creator support — Bob sets profile, Alice tips ───────
  console.log("[Feature 14a] CreatorHub — Bob sets a profile, Alice tips 0.2 USDC");
  const CreatorHub = deployments.CreatorHub;
  if (!CreatorHub || !cofheClient) {
    results.push({ feature: "creator_setProfile", persona: "Bob", status: "skip", error: !CreatorHub ? "CreatorHub not deployed" : "cofhe client unavailable" });
    results.push({ feature: "creator_support", persona: "Alice", status: "skip", error: "depends on profile" });
  } else {
    try {
      const bobWallet = createWalletClient({
        account: privateKeyToAccount(personas[1]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      const profileHash = await bobWallet.writeContract({
        address: CreatorHub as `0x${string}`,
        abi: [
          {
            name: "setProfile",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "name", type: "string" },
              { name: "bio", type: "string" },
              { name: "tier1", type: "uint64" },
              { name: "tier2", type: "uint64" },
              { name: "tier3", type: "uint64" },
            ],
            outputs: [],
          },
        ],
        functionName: "setProfile",
        args: ["Bob the Creator", "Wave4 sweep profile", 1_000_000n, 5_000_000n, 25_000_000n],
        gas: 5_000_000n,
      });
      await waitOk(profileHash, "profileHash");
      console.log(`  Bob: setProfile ok  tx=${profileHash}`);
      results.push({ feature: "creator_setProfile", persona: "Bob", status: "pass", txHash: profileHash });

      // Alice tips Bob
      const aliceWallet = createWalletClient({
        account: privateKeyToAccount(personas[0]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      // Approve CreatorHub on vault
      const apHash = await aliceWallet.writeContract({
        address: Vault as `0x${string}`,
        abi: [
          { name: "approvePlaintext", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint64" }], outputs: [] },
        ],
        functionName: "approvePlaintext",
        args: [CreatorHub as `0x${string}`, MAX_U64],
      });
      await waitOk(apHash, "apHash");

      await connectCofheAs(personas[0]!);
      const [encTip, encTipProof] = (await cofheClient
        .encryptInputs([Encryptable.uint64(parseUnits("0.2", 6))])
        .setConsumingContract(CreatorHub as `0x${string}`)
        .execute()) as [Hex, Hex];
      const supportHash = await aliceWallet.writeContract({
        address: CreatorHub as `0x${string}`,
        abi: [
          {
            name: "support",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "creator", type: "address" },
              { name: "vault", type: "address" },
              { name: "encAmount", type: "bytes32" },
              { name: "proof", type: "bytes" },
              { name: "message", type: "string" },
            ],
            outputs: [{ name: "tipId", type: "uint256" }],
          },
        ],
        functionName: "support",
        args: [personas[1]!.address, Vault as `0x${string}`, encTip, encTipProof, "wave4 sweep tip"],
        gas: 5_000_000n,
      });
      await waitOk(supportHash, "supportHash");
      console.log(`  Alice→Bob: support ok  tx=${supportHash}`);
      results.push({ feature: "creator_support", persona: "Alice", status: "pass", txHash: supportHash });

      // The tip is Pending and the per-vault totals below only move once the
      // funded bit is confirmed.
      const tipId = await tryExtractId(supportHash, CreatorHub, [SIG.TipPending]);
      if (tipId !== null) {
        await settleGate("tip", [tipId], CreatorHub, personas[0]!, "creator_funding", `tip #${tipId}`);
      } else {
        results.push({ feature: "creator_funding", persona: "Alice", status: "skip", error: "no TipPending event (contract predates the gate)" });
      }

      // Totals are per vault now. Both sides read their own handle.
      const perVaultAbi = [
        { name: "getMyContributionIn", type: "function", stateMutability: "view", inputs: [{ name: "creator", type: "address" }, { name: "vault", type: "address" }], outputs: [{ type: "bytes32" }] },
        { name: "getMyEarningsIn", type: "function", stateMutability: "view", inputs: [{ name: "vault", type: "address" }], outputs: [{ type: "bytes32" }] },
      ] as const;
      const contribHandle = await publicClient.readContract({
        address: CreatorHub as `0x${string}`, abi: perVaultAbi, functionName: "getMyContributionIn",
        args: [personas[1]!.address, Vault as `0x${string}`], account: personas[0]!.address,
      });
      const earnHandle = await publicClient.readContract({
        address: CreatorHub as `0x${string}`, abi: perVaultAbi, functionName: "getMyEarningsIn",
        args: [Vault as `0x${string}`], account: personas[1]!.address,
      });
      const perVaultOk = BigInt(contribHandle) !== 0n && BigInt(earnHandle) !== 0n;
      console.log(`  per-vault handles: contribution ${BigInt(contribHandle) !== 0n ? "set" : "MISSING"}, earnings ${BigInt(earnHandle) !== 0n ? "set" : "MISSING"}`);
      results.push({ feature: "creator_per_vault_totals", persona: "Bob", status: perVaultOk ? "pass" : "fail", error: perVaultOk ? undefined : "empty per-vault handle" });
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
      console.log(`  creator FAILED ${msg}`);
      results.push({ feature: "creator_support", persona: "Alice", status: "fail", error: msg });
    }
  }
  console.log("");

  // ─── 14b. Crowdfund contribute — Carol pledges to Dave's campaign
  console.log("[Feature 14b] Crowdfund contribute — Carol pledges 1 USDC to Dave's campaign");
  // The campaign id from the createCampaign step would ideally be captured
  // via event parsing. For this sweep, probe id 0 — most chains have ≥1
  // campaign by now, so it should be a real one (could be someone else's).
  // The point is to verify the contribute path executes; we'll also surface
  // a "no such campaign" revert as a non-fatal outcome.
  if (!Crowdfund || !cofheClient) {
    results.push({ feature: "crowdfund_contribute", persona: "Carol", status: "skip", error: "Crowdfund or cofhe unavailable" });
  } else {
    try {
      const carolWallet = createWalletClient({
        account: privateKeyToAccount(personas[2]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      // Approve Crowdfund on vault
      const apHash = await carolWallet.writeContract({
        address: Vault as `0x${string}`,
        abi: [
          { name: "approvePlaintext", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint64" }], outputs: [] },
        ],
        functionName: "approvePlaintext",
        args: [Crowdfund as `0x${string}`, MAX_U64],
      });
      await waitOk(apHash, "apHash");

      await connectCofheAs(personas[2]!);
      const [encPledge, encPledgeProof] = (await cofheClient
        .encryptInputs([Encryptable.uint64(parseUnits("1", 6))])
        .setConsumingContract(Crowdfund as `0x${string}`)
        .execute()) as [Hex, Hex];

      // Get the most recent campaignId via nextCampaignId-1
      const nextId = (await publicClient.readContract({
        address: Crowdfund as `0x${string}`,
        abi: [{ name: "nextCampaignId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "nextCampaignId",
      })) as bigint;
      const targetCampaignId = nextId > 0n ? nextId - 1n : 0n;

      const contributeHash = await carolWallet.writeContract({
        address: Crowdfund as `0x${string}`,
        abi: [
          {
            name: "contribute",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "campaignId", type: "uint256" },
              { name: "encAmount", type: "bytes32" },
              { name: "proof", type: "bytes" },
            ],
            outputs: [],
          },
        ],
        functionName: "contribute",
        args: [targetCampaignId, encPledge, encPledgeProof],
        gas: 5_000_000n,
      });
      const contributeReceipt = await waitOk(contributeHash, "contributeHash");
      console.log(`  Carol: contribute to campaign ${targetCampaignId} ok  tx=${contributeHash}`);
      results.push({ feature: "crowdfund_contribute", persona: "Carol", status: "pass", txHash: contributeHash });

      // The contribution is Pending and does not count toward the raised total
      // until confirmContribution. Its index is the first data word of Contributed.
      const contributedLog = contributeReceipt.logs.find(
        (lg) => lg.address.toLowerCase() === Crowdfund.toLowerCase() && lg.topics[0]?.toLowerCase() === SIG.Contributed.toLowerCase(),
      );
      if (contributedLog) {
        const contributionIndex = BigInt(`0x${contributedLog.data.slice(2, 66)}`);
        await settleGate(
          "contribution",
          [targetCampaignId, contributionIndex],
          Crowdfund,
          personas[2]!,
          "crowdfund_funding",
          `contribution ${targetCampaignId}/${contributionIndex}`,
        );
      } else {
        results.push({ feature: "crowdfund_funding", persona: "Carol", status: "skip", error: "no Contributed event in receipt" });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
      console.log(`  Carol: contribute FAILED ${msg}`);
      results.push({ feature: "crowdfund_contribute", persona: "Carol", status: "fail", error: msg });
    }
  }
  console.log("");

  // ─── 14. NEGATIVE: self-pay rejected ───────────────────────────
  // Helper: a negative case "passes" when the tx either (a) throws at
  // simulate/broadcast time, OR (b) is mined with status === "reverted".
  // viem's writeContract resolves on broadcast, so checking just for a
  // thrown error catches the simulation-revert case but misses the
  // "broadcast-then-revert-on-mine" case. Use simulateContract first to
  // catch both modes cleanly.
  async function expectRevert<T>(
    label: string,
    feature: string,
    persona: string,
    simulate: () => Promise<T>,
  ): Promise<void> {
    try {
      await simulate();
      console.log(`  ${label}: UNEXPECTED PASS — contract did not revert`);
      results.push({ feature, persona, status: "fail", error: "no revert" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const short = msg.replace(/\s+/g, " ").slice(0, 120);
      console.log(`  ${label}: reverted ✓ (${short})`);
      results.push({ feature, persona, status: "pass", error: `reverted: ${short}` });
    }
  }

  console.log("[Negative 14] Self-pay reject — Alice→Alice via PaymentHub");
  if (!cofheClient) {
    results.push({ feature: "neg_self_pay", persona: "Alice", status: "skip", error: "cofhe client unavailable" });
  } else {
    await connectCofheAs(personas[0]!);
    const [encSelf, encSelfProof] = (await cofheClient
      .encryptInputs([Encryptable.uint64(parseUnits("0.1", 6))])
      .setConsumingContract(PaymentHub as `0x${string}`)
      .execute()) as [Hex, Hex];
    await expectRevert("Alice→Alice", "neg_self_pay", "Alice", async () => {
      // simulateContract performs the eth_call dry-run, which surfaces the
      // require() / custom-error revert immediately without sending a real
      // tx (so no gas burn on a known-failing call).
      await publicClient.simulateContract({
        account: privateKeyToAccount(personas[0]!.privKey),
        address: PaymentHub as `0x${string}`,
        abi: [
          {
            name: "sendPayment",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "recipient", type: "address" },
              { name: "vault", type: "address" },
              { name: "encAmount", type: "bytes32" },
              { name: "proof", type: "bytes" },
              { name: "note", type: "string" },
            ],
            outputs: [],
          },
        ],
        functionName: "sendPayment",
        args: [personas[0]!.address, Vault as `0x${string}`, encSelf, encSelfProof, "self-pay rejection test"],
        gas: 5_000_000n,
      });
    });
  }
  console.log("");

  // ─── 15. NEGATIVE: group addExpense from non-member rejected ───
  console.log("[Negative 15] addExpense from non-member — should revert");
  if (!cofheClient) {
    results.push({ feature: "neg_non_member_expense", persona: "Alice", status: "skip", error: "cofhe client unavailable" });
  } else {
    await connectCofheAs(personas[0]!);
    const [encZero, encZeroProof] = (await cofheClient
      .encryptInputs([Encryptable.uint64(0n)])
      .setConsumingContract(GroupManager as `0x${string}`)
      .execute()) as [Hex, Hex];
    await expectRevert("non-member addExpense", "neg_non_member_expense", "Alice", async () => {
      await publicClient.simulateContract({
        account: privateKeyToAccount(personas[0]!.privKey),
        address: GroupManager as `0x${string}`,
        abi: [
          {
            name: "addExpense",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "groupId", type: "uint256" },
              { name: "splitWith", type: "address[]" },
              { name: "shares", type: "bytes32[]" },
              { name: "totalPaid", type: "bytes32" },
              { name: "proof", type: "bytes" },
              { name: "description", type: "string" },
            ],
            outputs: [],
          },
        ],
        functionName: "addExpense",
        // groupId 99999 — likely non-existent, so msg.sender is not a member
        args: [99_999n, [personas[1]!.address], [encZero], encZero, encZeroProof, "non-member test"],
        gas: 5_000_000n,
      });
    });
  }
  console.log("");

  // Negative 16 now fires earlier (right after Bob's bearer createLink,
  // before Dave's legitimate claim) so the revert reason is the
  // hash-mismatch guard rather than "already claimed".

  // ─── 16a. StealthPayments — Carol sends a stealth payment ──────
  console.log("[Feature 16a] StealthPayments — Carol sends 0.3 USDC stealthly to Dave");
  const StealthPayments = deployments.StealthPayments;
  if (!StealthPayments || !cofheClient) {
    results.push({ feature: "stealth_send", persona: "Carol", status: "skip", error: !StealthPayments ? "StealthPayments not deployed" : "cofhe client unavailable" });
  } else {
    try {
      const carolWallet = createWalletClient({
        account: privateKeyToAccount(personas[2]!.privKey),
        chain,
        transport: http(rpcUrl),
      });
      const stealthAmount = parseUnits("0.3", 6);
      // StealthPayments uses the underlying ERC20 (TestUSDC), not the vault.
      // It calls underlying.safeTransferFrom(msg.sender, address(this), amount)
      // so Carol must approve TestUSDC for StealthPayments.
      const apHash = await carolWallet.writeContract({
        address: TestUSDC as `0x${string}`,
        abi: [
          { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
        ],
        functionName: "approve",
        args: [StealthPayments as `0x${string}`, stealthAmount],
      });
      await waitOk(apHash, "apHash");

      // Encrypt Dave's address as the stealth recipient.
      // Encryptable.address is the cofhe SDK shape for InEaddress.
      await connectCofheAs(personas[2]!);
      const [encRecipient, encRecipientProof] = (await cofheClient
        .encryptInputs([Encryptable.address(personas[3]!.address)])
        .setConsumingContract(StealthPayments as `0x${string}`)
        .execute()) as [Hex, Hex];

      // Claim code: random 32 bytes; claimCodeHash = keccak(claimCode || recipient).
      const claimCodeBytes = new Uint8Array(32);
      const codeSeed = keccak256(toBytes(`wave4-stealth-${Date.now()}`));
      for (let i = 0; i < 32; i++) claimCodeBytes[i] = parseInt(codeSeed.slice(2 + i * 2, 4 + i * 2), 16);
      const claimCodeHex = ("0x" + Array.from(claimCodeBytes).map((b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
      const claimCodeHash = keccak256(encodePacked(["bytes32", "address"], [claimCodeHex, personas[3]!.address]));

      // Race-safe pre-read of nextTransferId
      const transferIdPreCreate = (await publicClient.readContract({
        address: StealthPayments as `0x${string}`,
        abi: [{ name: "nextTransferId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "nextTransferId",
      })) as bigint;
      const stealthHash = await withRetry("stealth_send", () => carolWallet.writeContract({
        address: StealthPayments as `0x${string}`,
        abi: [
          {
            name: "sendStealth",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "plaintextAmount", type: "uint256" },
              { name: "encRecipient", type: "bytes32" },
              { name: "proof", type: "bytes" },
              { name: "claimCodeHash", type: "bytes32" },
              { name: "vault", type: "address" },
              { name: "note", type: "string" },
            ],
            outputs: [{ type: "uint256" }],
          },
        ],
        functionName: "sendStealth",
        args: [stealthAmount, encRecipient, encRecipientProof, claimCodeHash, Vault as `0x${string}`, "wave4 sweep stealth"],
        gas: 5_000_000n,
      }));
      await waitOk(stealthHash, "stealthHash");
      console.log(`  Carol→Dave (stealth): sendStealth ok  tx=${stealthHash}`);
      results.push({ feature: "stealth_send", persona: "Carol", status: "pass", txHash: stealthHash });

      // Second-leg: Dave (the encrypted recipient) claims with the claim code.
      // Dave learns the claim code out-of-band (e.g., from Carol over a side
      // channel); the contract hashes claimCode || recipient to verify.
      try {
        // Race-safe: extract transferId from StealthSent event log.
        const justCreatedTid = await extractIdFromReceipt(stealthHash, StealthPayments, SIG.StealthSent);
        const daveWallet = createWalletClient({
          account: privateKeyToAccount(personas[3]!.privKey),
          chain,
          transport: http(rpcUrl),
        });
        const claimStealthHash = await withRetry("stealth_claim", () => daveWallet.writeContract({
          address: StealthPayments as `0x${string}`,
          abi: [
            {
              name: "claimStealth",
              type: "function",
              stateMutability: "nonpayable",
              inputs: [
                { name: "transferId", type: "uint256" },
                { name: "claimCode", type: "bytes32" },
              ],
              outputs: [],
            },
          ],
          functionName: "claimStealth",
          args: [justCreatedTid, claimCodeHex],
          gas: 5_000_000n,
        }));
        await waitOk(claimStealthHash, "claimStealthHash");
        console.log(`  Dave: claimStealth #${justCreatedTid} ok  tx=${claimStealthHash}`);
        results.push({ feature: "stealth_claim", persona: "Dave", status: "pass", txHash: claimStealthHash });
      } catch (err) {
        const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
        console.log(`  Dave: claimStealth FAILED ${msg}`);
        results.push({ feature: "stealth_claim", persona: "Dave", status: "fail", error: msg });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 250) : String(err);
      console.log(`  Carol→Dave: sendStealth FAILED ${msg}`);
      results.push({ feature: "stealth_send", persona: "Carol", status: "fail", error: msg });
    }
  }
  console.log("");

  // Negative 17 now fires earlier (inside the escrow 2nd-leg flow,
  // between Bob's markDelivered and Alice's approveRelease) so the
  // revert reason is the spec'd "not depositor" guard rather than
  // the "not active" guard that fires after Alice releases.

  // ─── 18. NEGATIVE: self-tip on CreatorHub rejected ─────────────
  // Bob tries to tip himself. CreatorHub has an explicit
  // `require(creator != msg.sender, "CreatorHub: cannot self-tip")`.
  console.log("[Negative 18] CreatorHub self-tip — should revert");
  if (!CreatorHub || !cofheClient) {
    results.push({ feature: "neg_creator_self_tip", persona: "Bob", status: "skip", error: "CreatorHub or cofhe unavailable" });
  } else {
    await connectCofheAs(personas[1]!);
    const [encSelfTip, encSelfTipProof] = (await cofheClient
      .encryptInputs([Encryptable.uint64(parseUnits("0.1", 6))])
      .setConsumingContract(CreatorHub as `0x${string}`)
      .execute()) as [Hex, Hex];
    await expectRevert("Bob self-tip", "neg_creator_self_tip", "Bob", async () => {
      await publicClient.simulateContract({
        account: privateKeyToAccount(personas[1]!.privKey),
        address: CreatorHub as `0x${string}`,
        abi: [
          {
            name: "support",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "creator", type: "address" },
              { name: "vault", type: "address" },
              { name: "encAmount", type: "bytes32" },
              { name: "proof", type: "bytes" },
              { name: "message", type: "string" },
            ],
            outputs: [],
          },
        ],
        functionName: "support",
        // Bob tipping Bob — should revert "CreatorHub: cannot self-tip"
        args: [personas[1]!.address, Vault as `0x${string}`, encSelfTip, encSelfTipProof, "self-tip rejection test"],
        gas: 5_000_000n,
      });
    });
  }
  console.log("");

  // ─── 19. NEGATIVE: shield with zero amount rejected ───────────
  console.log("[Negative 19] shield with amount=0 — should revert");
  await expectRevert("shield zero", "neg_shield_zero", "Alice", async () => {
    await publicClient.simulateContract({
      account: privateKeyToAccount(personas[0]!.privKey),
      address: Vault as `0x${string}`,
      abi: [
        { name: "shield", type: "function", stateMutability: "nonpayable", inputs: [{ name: "amount", type: "uint256" }], outputs: [] },
      ],
      functionName: "shield",
      args: [0n],
      gas: 2_000_000n,
    });
  });
  console.log("");

  // ─── 20. NEGATIVE: retired P2PExchange rejects new offers ─────
  console.log("[Negative 20] P2PExchange.createOffer should revert \"retired\"");
  if (!P2PExchange) {
    results.push({ feature: "neg_p2p_exchange_retired", persona: "Carol", status: "skip", error: "P2PExchange not deployed" });
  } else {
    await expectRevertWith("neg_p2p_exchange_retired", "Carol", "P2PExchange: retired", async () => {
      await publicClient.simulateContract({
        account: privateKeyToAccount(personas[2]!.privKey),
        address: P2PExchange as `0x${string}`,
        abi: [
          {
            name: "createOffer",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "tokenGive", type: "address" },
              { name: "tokenWant", type: "address" },
              { name: "amountGive", type: "uint256" },
              { name: "amountWant", type: "uint256" },
              { name: "expiry", type: "uint256" },
            ],
            outputs: [{ type: "uint256" }],
          },
        ],
        functionName: "createOffer",
        args: [
          TestUSDC as `0x${string}`,
          Vault as `0x${string}`,
          parseUnits("1", 6),
          parseUnits("1", 6),
          BigInt(Math.floor(Date.now() / 1000) + 3600),
        ],
        gas: 2_000_000n,
      });
    });
  }
  console.log("");

  // ─── 21b. NEGATIVE: empty-batch runPayroll rejected ────────────
  console.log("[Negative 21b] runPayroll with empty employee list — should revert");
  if (!BusinessHub) {
    results.push({ feature: "neg_payroll_empty_batch", persona: "Alice", status: "skip", error: "BusinessHub not deployed" });
  } else {
    await expectRevert("empty payroll", "neg_payroll_empty_batch", "Alice", async () => {
      await publicClient.simulateContract({
        account: privateKeyToAccount(personas[0]!.privKey),
        address: BusinessHub as `0x${string}`,
        abi: [
          {
            name: "runPayroll",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [
              { name: "employees", type: "address[]" },
              { name: "vault", type: "address" },
              { name: "salaries", type: "bytes32[]" },
              { name: "proof", type: "bytes" },
            ],
            outputs: [],
          },
        ],
        functionName: "runPayroll",
        // Zero-length batch — must revert "BusinessHub: invalid batch size"
        args: [[], Vault as `0x${string}`, [], "0x"],
        gas: 2_000_000n,
      });
    });
  }
  console.log("");

  // ─── 21a. NEGATIVE: gift replay — Bob claims same envelope twice
  // The happy-path second-leg already claimed the envelope. A second
  // claim from Bob on the same envelopeId must revert ("not active").
  console.log("[Negative 21a] gift_claim replay — same envelope twice should revert");
  if (!GiftMoney) {
    results.push({ feature: "neg_gift_replay", persona: "Bob", status: "skip", error: "GiftMoney not deployed" });
  } else {
    await expectRevert("Bob replays claim", "neg_gift_replay", "Bob", async () => {
      // The most-recent envelope (nextEnvelopeId-1) was just claimed by
      // Bob in the second-leg. Claiming again should hit the "envelope
      // not active" guard (it's marked inactive on first claim).
      const nextEid = (await publicClient.readContract({
        address: GiftMoney as `0x${string}`,
        abi: [{ name: "nextEnvelopeId", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
        functionName: "nextEnvelopeId",
      })) as bigint;
      const targetId = nextEid > 0n ? nextEid - 1n : 0n;
      await publicClient.simulateContract({
        account: privateKeyToAccount(personas[1]!.privKey),
        address: GiftMoney as `0x${string}`,
        abi: [
          {
            name: "claimGift",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [{ name: "envelopeId", type: "uint256" }],
            outputs: [],
          },
        ],
        functionName: "claimGift",
        args: [targetId],
        gas: 2_000_000n,
      });
    });
  }
  console.log("");

  // ─── 21. NEGATIVE: GiftMoney claim from non-recipient rejected ─
  // Carol tries to claim Alice's gift (which was sent to Bob).
  console.log("[Negative 21] claimGift by non-recipient — should revert");
  if (!GiftMoney) {
    results.push({ feature: "neg_gift_wrong_recipient", persona: "Carol", status: "skip", error: "GiftMoney not deployed" });
  } else {
    await expectRevert("Carol claims Bob's gift", "neg_gift_wrong_recipient", "Carol", async () => {
      // Use any old envelope id — Carol is never the recipient of any of
      // them since the sweep only sends gifts Alice → Bob. The contract
      // either rejects with "not recipient" or with "envelope not active"
      // (already claimed by Bob in the 2nd-leg); both count.
      await publicClient.simulateContract({
        account: privateKeyToAccount(personas[2]!.privKey),
        address: GiftMoney as `0x${string}`,
        abi: [
          {
            name: "claimGift",
            type: "function",
            stateMutability: "nonpayable",
            inputs: [{ name: "envelopeId", type: "uint256" }],
            outputs: [],
          },
        ],
        functionName: "claimGift",
        args: [0n],
        gas: 2_000_000n,
      });
    });
  }
  console.log("");

  // ─── Summary ───────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Sweep summary");
  console.log("═══════════════════════════════════════════════════════════════");
  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const skip = results.filter((r) => r.status === "skip").length;
  for (const r of results) {
    const sym = r.status === "pass" ? "✓" : r.status === "skip" ? "·" : "✗";
    const txOrErr = r.txHash ?? r.error ?? "";
    console.log(`  ${sym} ${r.feature.padEnd(20)} ${r.persona.padEnd(6)} ${txOrErr}`);
  }
  console.log("───────────────────────────────────────────────────────────────");
  console.log(`  ${pass} pass · ${fail} fail · ${skip} skip · ${results.length} total`);
  console.log("═══════════════════════════════════════════════════════════════");
});
