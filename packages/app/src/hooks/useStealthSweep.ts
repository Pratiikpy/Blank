/**
 * Phase 9.5 — sweep flow.
 *
 * Recovers funds from a stealth address into the recipient's main
 * account. Two-transaction flow:
 *
 *   1. **Fund the stealth EOA with gas.** Main AA sends ~0.001 ETH to
 *      the stealth address via a paymaster-sponsored UserOp. The user
 *      doesn't pay anything visible.
 *
 *   2. **Transfer ERC-20 from stealth → main.** We derive the stealth
 *      private key locally (`computeStealthKey` over the stored
 *      spending+viewing privs and the announcement's ephemeralPubKey),
 *      sign a plain `ERC20.transfer(mainAccount, amount)` transaction
 *      with that key, and broadcast it via the public RPC.
 *
 * Why not the plan's "Option B" (deploy AA at stealth address)?
 *   • BlankAccount uses P-256 ownership; the stealth-derived key is
 *     secp256k1. Adapting BlankAccount for that curve is a multi-day
 *     Solidity build (new validator + factory + tests + deploy).
 *   • For a testnet MVP, two-tx fund-then-sweep is dramatically simpler
 *     and works today. We can revisit the AA-at-stealth-address pattern
 *     in a future wave when it justifies the complexity.
 *
 * Privacy: the user's main AA address IS visible as the funder of the
 * stealth EOA's gas (one ETH transfer linkable to main → stealth) and
 * as the destination of the ERC-20 sweep (USDC out from stealth → main).
 * That's an EXPLICIT trade-off documented to the user — full privacy
 * preservation requires Option B's AA-at-stealth pattern, which is not
 * yet implemented. UI surfaces this caveat before the user clicks Sweep.
 */
import { useCallback, useState } from "react";
import {
  createWalletClient,
  http,
  parseEther,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, baseSepolia } from "viem/chains";
import { erc20Abi } from "viem";
import { usePublicClient } from "wagmi";

import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { useUnifiedWrite } from "./useUnifiedWrite";
import { computeStealthKey } from "@/lib/stealth";
import { loadStealthKeys } from "@/lib/stealth-keystore";
import { useStealthInbox, type StealthInboxEntry } from "./useStealthInbox";
import { ETH_SEPOLIA_ID, BASE_SEPOLIA_ID } from "@/lib/constants";
import { BlankAccountAbi } from "@/lib/abis";

/** Gas budget for the stealth EOA's outgoing ERC-20 transfer + a small
 *  buffer. ERC-20 transfer ≈ 50_000 gas. Sepolia/Base Sepolia gas price
 *  ≈ 1 gwei. 0.0005 ETH covers ~10× headroom. */
const FUND_AMOUNT_WEI = parseEther("0.0005");

const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

interface SweepResult {
  fundTxHash: Hex;
  sweepTxHash: Hex;
  amount: string;
  destination: Address;
}

interface UseStealthSweepResult {
  sweep: (entry: StealthInboxEntry) => Promise<SweepResult>;
  isSweeping: boolean;
  step: "idle" | "funding" | "waitingFund" | "sweeping" | "waitingSweep" | "done" | "error";
  error: string | null;
}

function getViemChain(chainId: number) {
  if (chainId === ETH_SEPOLIA_ID) return sepolia;
  if (chainId === BASE_SEPOLIA_ID) return baseSepolia;
  throw new Error(`Stealth sweep: unsupported chain ${chainId}`);
}

/** Build a wallet client signed by the stealth-derived privkey. The
 *  RPC URL comes from the user's wagmi config — we re-use the public
 *  client's transport so we hit the same endpoint they're already
 *  using. (publicClient.transport.url is the RPC URL on http transport.) */
function buildStealthWalletClient(
  stealthPriv: Hex,
  chainId: number,
  rpcUrl: string,
): WalletClient {
  const account = privateKeyToAccount(stealthPriv);
  return createWalletClient({
    account,
    chain: getViemChain(chainId),
    transport: http(rpcUrl),
  });
}

export function useStealthSweep(): UseStealthSweepResult {
  const { activeChainId } = useChain();
  const { effectiveAddress } = useEffectiveAddress();
  const publicClient = usePublicClient({ chainId: activeChainId });
  const { unifiedWrite, senderAddress } = useUnifiedWrite();
  const inbox = useStealthInbox();

  const [step, setStep] = useState<UseStealthSweepResult["step"]>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isSweeping, setIsSweeping] = useState(false);

  const sweep = useCallback(
    async (entry: StealthInboxEntry): Promise<SweepResult> => {
      if (!publicClient) throw new Error("Public RPC client unavailable");
      if (!effectiveAddress) throw new Error("Wallet not connected");

      // Only ERC-20 sweeps are wired today. Native-ETH sweeps would
      // skip step 1 and use the existing balance, but require slightly
      // different math (subtract gas from balance). Out of scope for v1.
      if (entry.functionSelector.toLowerCase() !== ERC20_TRANSFER_SELECTOR) {
        throw new Error(
          `Stealth sweep: only ERC-20 announcements are supported in v1 (function selector ${entry.functionSelector})`,
        );
      }

      const keysRecord = loadStealthKeys(effectiveAddress);
      if (!keysRecord) {
        throw new Error("Stealth keys not configured for this account");
      }

      setIsSweeping(true);
      setError(null);
      try {
        // Step 1: derive the stealth private key. This is purely client-side
        // crypto over the announcement's ephemeralPubKey + the user's stored
        // spending/viewing privkeys. Never leaves the browser.
        const stealthPriv = computeStealthKey({
          ephemeralPublicKey: entry.ephemeralPubKey as `0x${string}`,
          viewingPrivateKey: keysRecord.viewingPrivateKey,
          spendingPrivateKey: keysRecord.spendingPrivateKey,
        });

        // Step 2: fund the stealth EOA so it has gas for the outgoing
        // transfer. The cleanest way to send plain ETH from an AA via
        // unifiedWrite is a self-call to BlankAccount.execute — the AA
        // calls itself, which in turn calls execute(stealth, FUND, "0x")
        // on itself, which finally does a plain ETH transfer to the
        // stealth EOA. Indirect, but reuses the existing sponsored-UserOp
        // path without bypassing the passphrase prompt.
        if (!senderAddress) {
          throw new Error("Smart account not connected");
        }
        setStep("funding");
        const fundTxHash = await unifiedWrite({
          address: senderAddress,
          abi: BlankAccountAbi,
          functionName: "execute",
          args: [entry.stealthAddress, FUND_AMOUNT_WEI, "0x"],
        });

        // Step 3: wait for the funding tx to confirm. We pass the AA's
        // tx hash directly — wait silently for receipt to land.
        setStep("waitingFund");
        const fundReceipt = await publicClient.waitForTransactionReceipt({
          hash: fundTxHash,
          confirmations: 1,
        });
        if (fundReceipt.status !== "success") {
          throw new Error(
            `Funding transaction reverted on-chain (tx ${fundTxHash}). Try again — the AA may need ETH itself to self-pay if paymaster is unavailable.`,
          );
        }

        // Sanity: confirm the stealth EOA actually received the funding.
        // Race condition guard — receipt landed but balance may lag on
        // some RPCs. Loop a couple of times.
        let stealthBal = 0n;
        for (let i = 0; i < 5; i++) {
          stealthBal = await publicClient.getBalance({ address: entry.stealthAddress });
          if (stealthBal >= FUND_AMOUNT_WEI / 2n) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (stealthBal < FUND_AMOUNT_WEI / 2n) {
          throw new Error(
            `Funding tx confirmed but stealth address still empty (${stealthBal} wei). Try again — RPC may be lagging.`,
          );
        }

        // Step 4: build, sign, and broadcast the ERC-20 transfer from
        // the stealth EOA to the user's main account.
        setStep("sweeping");
        const rpcUrl =
          publicClient.transport.type === "http"
            ? (publicClient.transport as any).url
            : undefined;
        if (!rpcUrl) {
          throw new Error("Could not extract RPC URL from public client transport");
        }
        const stealthWallet = buildStealthWalletClient(stealthPriv, activeChainId, rpcUrl);

        // Read the live token balance at the stealth address. The
        // announcement records the AMOUNT THE SENDER CLAIMED to send,
        // but we should sweep `min(announced, actual_balance)` because:
        //   • The token may be fee-on-transfer (smaller balance landed)
        //   • Some other path already partially swept (rare but possible)
        //   • Two announcements may collide on one stealth address
        // Without this min, transfer() reverts and the funding ETH is
        // stranded forever at the stealth EOA with no recovery path.
        const announcedAmount = BigInt(entry.amount);
        const liveBalance = (await publicClient.readContract({
          address: entry.token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [entry.stealthAddress],
        })) as bigint;
        if (liveBalance === 0n) {
          throw new Error(
            `Stealth address has zero balance of token ${entry.token} — already swept, or token never delivered`,
          );
        }
        const sweepAmount = liveBalance < announcedAmount ? liveBalance : announcedAmount;

        const sweepTxHash = await stealthWallet.writeContract({
          chain: getViemChain(activeChainId),
          account: privateKeyToAccount(stealthPriv),
          address: entry.token,
          abi: erc20Abi,
          functionName: "transfer",
          args: [effectiveAddress as Address, sweepAmount],
        });

        setStep("waitingSweep");
        const sweepReceipt = await publicClient.waitForTransactionReceipt({
          hash: sweepTxHash,
          confirmations: 1,
        });
        // viem returns the receipt regardless of status — surface
        // reverted transactions as failures so the inbox doesn't
        // mark a real revert as "swept".
        if (sweepReceipt.status !== "success") {
          throw new Error(
            `Sweep transaction reverted on-chain (tx ${sweepTxHash}). Funding ETH may still be at the stealth address — manually rescue if needed.`,
          );
        }

        // Mark this inbox entry as swept so it grays out in the UI.
        inbox.markSwept(entry.txHash, entry.stealthAddress);
        setStep("done");

        return {
          fundTxHash,
          sweepTxHash,
          amount: entry.amount,
          destination: effectiveAddress as Address,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStep("error");
        throw err;
      } finally {
        setIsSweeping(false);
      }
    },
    [publicClient, effectiveAddress, unifiedWrite, activeChainId, inbox],
  );

  return { sweep, isSweeping, step, error };
}
