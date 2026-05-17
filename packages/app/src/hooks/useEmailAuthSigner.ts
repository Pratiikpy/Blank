/**
 * useEmailAuthSigner — wallet-signed auth for the /api/invoices/send-email
 * and /api/requests/send-email endpoints.
 *
 * Produces a {signature, signerAddress, signedAt, signerChainId} bundle
 * that the server verifies via viem's `publicClient.verifyMessage`. The
 * verifier handles both EOA ECDSA and ERC-1271 (BlankAccount / passkey
 * AA) sigs transparently — but the FRONTEND has to produce the right
 * shape for each:
 *
 *   • EOA path (MetaMask, Rainbow, etc.) — wagmi's `signMessage` returns
 *     a 65-byte (r, s, v) sig over the EIP-191 prefixed hash. viem
 *     ecrecovers and matches against `signerAddress`.
 *
 *   • Passkey-AA path — `BlankAccount.isValidSignature(hash, sig)`
 *     decodes `sig` as `abi.encode(uint256 r, uint256 s)` (64 bytes,
 *     NOT 65 — no v byte) and runs P256.verify(hash, r, s, ownerX,
 *     ownerY). We compute the EIP-191 prefixed hash ourselves, prompt
 *     for the passphrase, sign via `signHash`, and encode (r, s) as
 *     a 64-byte blob.
 *
 * Tip for new readers: viem's verifyMessage HAS a quirk — for ERC-1271
 * sigs it computes the EIP-191 prefixed hash from the message string
 * BEFORE calling isValidSignature(hash, sig). Our 64-byte (r, s) blob
 * is what BlankAccount expects to decode. This is end-to-end consistent
 * because the server-side viem.verifyMessage builds the same prefixed
 * hash, and we sign that exact hash — no double-hashing pitfalls.
 */
import { useCallback } from "react";
import { useAccount, useSignMessage } from "wagmi";
import {
  type Hex,
  hashMessage,
  encodeAbiParameters,
} from "viem";

import { useChain } from "@/providers/ChainProvider";
import { useEffectiveAddress } from "./useEffectiveAddress";
import { usePassphrasePrompt } from "@/components/PassphrasePrompt";
import { useSmartAccount } from "./useSmartAccount";
import { signHash } from "@/lib/passkey";

export interface EmailAuthSignature {
  signature: Hex;
  signerAddress: `0x${string}`;
  signedAt: number;
  signerChainId: number;
}

interface UseEmailAuthSignerResult {
  /**
   * Sign the given message string. The caller is responsible for
   * embedding `signedAt` into the message bytes via the build helpers
   * in `lib/email-client` and passing that same `signedAt` here so the
   * returned `signedAt` matches the bytes that were signed. This keeps
   * caller and signer aligned without needing to pass message-and-args
   * separately.
   */
  signEmailAuth: (message: string, signedAt: number) => Promise<EmailAuthSignature | null>;
  canSign: boolean;
}

export function useEmailAuthSigner(): UseEmailAuthSignerResult {
  const { activeChainId } = useChain();
  const { effectiveAddress } = useEffectiveAddress();
  const wagmiAccount = useAccount();
  const { signMessageAsync } = useSignMessage();
  const smartAccount = useSmartAccount();
  const passphrasePrompt = usePassphrasePrompt();

  const isSmartAccount =
    smartAccount.status === "ready" && smartAccount.account !== null;
  const canSign = !!effectiveAddress && (isSmartAccount || !!wagmiAccount.address);

  const signEmailAuth = useCallback(
    async (message: string, signedAt: number): Promise<EmailAuthSignature | null> => {
      if (!effectiveAddress) return null;

      // Same passkey-only-still-loading guard as useShield + useUnifiedWrite.
      // Without this, a passkey-only user calling this during AA load
      // resolution gets null silently — caller has no idea why the
      // email-auth signature is missing. Surface explicitly.
      if (
        !isSmartAccount &&
        !wagmiAccount.address &&
        smartAccount.status !== "no-passkey"
      ) {
        throw new Error(
          "Wallet still loading — try again in a moment (smart account resolving)",
        );
      }

      // ── Smart-account (passkey) path ──────────────────────────────────
      // BlankAccount.isValidSignature expects sig = abi.encode(uint256 r,
      // uint256 s) over the EIP-191 prefixed hash. We compute the hash
      // ourselves (matching viem's hashMessage on the server side), then
      // sign via the existing passkey infrastructure.
      if (isSmartAccount) {
        const passphrase = await passphrasePrompt.request({
          title: "Sign email request",
          subtitle: "We'll attach this signature so the server knows the email request really came from you.",
        });
        if (!passphrase) return null;

        const eip191Hash = hashMessage(message);
        const { r, s } = await signHash(activeChainId, passphrase, eip191Hash);
        const signature = encodeAbiParameters(
          [{ type: "uint256" }, { type: "uint256" }],
          [BigInt(r), BigInt(s)],
        );
        return {
          signature,
          signerAddress: effectiveAddress as `0x${string}`,
          signedAt,
          signerChainId: activeChainId,
        };
      }

      // ── EOA path ──────────────────────────────────────────────────────
      // wagmi handles the EIP-191 prefix internally; the resulting
      // 65-byte sig verifies via ecrecover on the server.
      if (!wagmiAccount.address) return null;
      const signature = await signMessageAsync({ message });
      return {
        signature,
        signerAddress: wagmiAccount.address,
        signedAt,
        signerChainId: activeChainId,
      };
    },
    [
      effectiveAddress,
      activeChainId,
      isSmartAccount,
      wagmiAccount.address,
      signMessageAsync,
      passphrasePrompt,
    ],
  );

  return { signEmailAuth, canSign };
}
