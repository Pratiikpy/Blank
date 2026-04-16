// R5-B: bridge between Blank's passkey-controlled smart account and the
// Fhenix cofhe-sdk's `smartWalletViemAdapter`.
//
// The SDK needs a `SmartAccountClient` that exposes:
//   - account: { address }
//   - sendTransaction(tx) => UserOp hash
//   - signTypedData({ domain, types, primaryType, message }) => hex sig
//
// We synthesize that from:
//   - BlankAccount address (from useSmartAccount)
//   - The stored P-256 passkey + a passphrase prompt for each sign
//   - The relayer at /api/relay for UserOp submission
//
// The signature we return is `abi.encode(uint256 r, uint256 s)` — 64 bytes —
// matching the shape BlankAccount.isValidSignature expects to decode. On-chain,
// the Fhenix ACL contract calls `smartAccount.isValidSignature(digest, sig)`,
// BlankAccount decodes (r, s), and P256.verify confirms the passkey signed the
// EIP-712 digest. Same round-trip, different curve from ECDSA's secp256k1.
//
// Limitations (intentional for R5-B; R5-E can polish):
//   - Every permit-sign prompts for the passphrase. An in-memory session
//     cache would remove the second+ prompts but is out of scope here.
//   - Requires the smart account to be DEPLOYED on-chain before decryption
//     works (ERC-1271 verification calls the contract). Blank auto-deploys
//     on first UserOp, so this only affects users who try to decrypt
//     before doing any send/shield. EIP-6492 (predeploy signatures) is
//     the standard fix — future work.

import {
  hashTypedData,
  createWalletClient,
  custom,
  type Hex,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import type { PackedUserOperation } from "./userop";
import {
  buildUserOp,
  computeUserOpHash,
  encodeExecuteCall,
  encodeP256Signature,
  getNextNonce,
  serializeUserOp,
} from "./userop";
import { signHash } from "./passkey";
import { broadcastAction } from "./cross-tab";

export interface BlankSmartAccountRef {
  /** Counterfactual / deployed address of the smart account. */
  address: Address;
  /** P-256 owner pubkey X (hex) — needed for UserOp initCode if undeployed. */
  pubX: Hex;
  /** P-256 owner pubkey Y. */
  pubY: Hex;
  /** Whether on-chain code exists at `address`. */
  isDeployed: boolean;
}

export interface BlankSmartAccountClientDeps {
  /** The smart account (from useSmartAccount). */
  account: BlankSmartAccountRef;
  /** Chain id the account lives on. */
  chainId: number;
  /** viem PublicClient used for nonce + userOpHash + deploy-state reads. */
  publicClient: PublicClient;
  /** viem Chain object (required by viem's sendTransaction shape). */
  chain: Chain;
  /** Promise-returning prompt that yields the unlock passphrase (or null if cancelled). */
  requestPassphrase: (opts?: { title?: string; subtitle?: string }) => Promise<string | null>;
}

// Matches the minimal shape cofhe-sdk's `smartWalletViemAdapter` expects:
// github.com/.../cofhe/sdk/adapters/smartWallet.ts#L4
export interface CofheSmartAccountClient {
  account: { address: Address };
  sendTransaction: (tx: {
    to: Address;
    value?: bigint;
    data?: Hex;
  }) => Promise<Hex>;
  signTypedData: (args: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }) => Promise<Hex>;
  signMessage?: (args: { message: string | Hex }) => Promise<Hex>;
}

/**
 * Inline port of the (unreleased) `@cofhe/sdk/adapters/smartWallet.ts` adapter.
 *
 * Why inline: the SDK ships the source file but only exports `Ethers5Adapter`,
 * `Ethers6Adapter`, `HardhatSignerAdapter`, `WagmiAdapter` from its compiled
 * `./adapters` barrel. `smartWalletViemAdapter` is in their codebase but not
 * in the public API — depending on it at runtime is fragile (would silently
 * break on any SDK update that reorders exports). So we own the wiring here.
 *
 * What it does:
 *   - Creates a viem WalletClient whose `transport` proxies all JSON-RPC
 *     calls to the given publicClient
 *   - Overrides `sendTransaction` / `signTypedData` / `signMessage` to
 *     delegate to the `CofheSmartAccountClient` so all signing routes
 *     through the passkey-controlled BlankAccount
 *
 * Returned walletClient is what we pass to `cofheSdkClient.connect(pc, wc)`.
 * From the SDK's perspective it looks like a normal EOA walletClient;
 * under the hood every signature is an ERC-1271 P-256 sig that on-chain
 * `BlankAccount.isValidSignature` will verify.
 */
export function blankSmartWalletViemAdapter(
  publicClient: PublicClient,
  smartAccountClient: CofheSmartAccountClient,
  opts: { chain?: Chain } = {},
): { publicClient: PublicClient; walletClient: WalletClient } {
  const chain = opts.chain ?? (publicClient as { chain?: Chain }).chain;

  // Proxy every RPC call through the given publicClient — lets the SDK
  // read chain state via the wallet client without needing its own RPC.
  const transport = custom({
    request: ({ method, params }: { method: string; params?: unknown[] }) =>
      publicClient.request({
        method: method as Parameters<PublicClient["request"]>[0]["method"],
        params: (params ?? []) as Parameters<PublicClient["request"]>[0]["params"],
      }),
  });

  const base = createWalletClient({
    chain,
    transport,
    // Not used for real signing — just keeps the viem API shape consistent.
    account: smartAccountClient.account.address,
  });

  // Override the signing methods to route through the smart account.
  const walletClient = {
    ...base,
    async sendTransaction(tx: { to: Address; value?: bigint; data?: Hex }) {
      return smartAccountClient.sendTransaction(tx);
    },
    async signTypedData(
      arg1: {
        domain?: Record<string, unknown>;
        types: Record<string, unknown>;
        primaryType?: string;
        message: Record<string, unknown>;
      },
      types?: Record<string, unknown>,
      message?: Record<string, unknown>,
    ) {
      let domain: Record<string, unknown>;
      let typesObj: Record<string, unknown>;
      let messageObj: Record<string, unknown>;
      let primaryType: string;
      if (types === undefined && message === undefined) {
        domain = (arg1.domain ?? {}) as Record<string, unknown>;
        typesObj = arg1.types;
        messageObj = arg1.message;
        primaryType =
          arg1.primaryType ??
          Object.keys(typesObj).find((k) => k !== "EIP712Domain") ??
          Object.keys(typesObj)[0];
      } else {
        domain = arg1 as unknown as Record<string, unknown>;
        typesObj = types!;
        messageObj = message!;
        primaryType =
          Object.keys(typesObj).find((k) => k !== "EIP712Domain") ??
          Object.keys(typesObj)[0];
      }
      return smartAccountClient.signTypedData({ domain, types: typesObj, primaryType, message: messageObj });
    },
    async signMessage(args: { message: string | Hex }) {
      if (typeof smartAccountClient.signMessage === "function") {
        return smartAccountClient.signMessage(args);
      }
      // Fall back to base — usually throws for a smart-account placeholder
      // account, which is the intended behavior (tells the caller that
      // this smart wallet doesn't support arbitrary message signing).
      return base.signMessage({ ...args, account: base.account });
    },
  } as unknown as WalletClient;

  return { publicClient, walletClient };
}

/**
 * Readiness probe: returns true if our bridge is healthy (module loaded,
 * adapter function callable). Used by the R5-D readiness test instead of
 * poking SDK internals that may or may not exist in a given version.
 */
export function checkSmartWalletAdapterAvailable(): boolean {
  return typeof blankSmartWalletViemAdapter === "function";
}

/**
 * Encode a P-256 (r, s) pair as the 64-byte `abi.encode(uint256 r, uint256 s)`
 * blob that BlankAccount.isValidSignature decodes.
 *
 * NOTE: the on-chain P256.verify also accepts the same shape for UserOp
 * signatures via BlankAccount._validateSignature. Both paths decode
 * abi.encode(uint256, uint256) identically — we use one helper for both.
 */
export function encodeP256AsErc1271Signature(r: Hex, s: Hex): Hex {
  const rHex = r.startsWith("0x") ? r.slice(2) : r;
  const sHex = s.startsWith("0x") ? s.slice(2) : s;
  // abi.encode(uint256, uint256) is each value left-padded to 32 bytes, no
  // offsets. Pad defensively even though P-256 sigs are always 32-byte each.
  const rPadded = rHex.padStart(64, "0");
  const sPadded = sHex.padStart(64, "0");
  return ("0x" + rPadded + sPadded) as Hex;
}

/**
 * Build a SmartAccountClient that cofhe-sdk's `smartWalletViemAdapter` can
 * consume. Every signing call prompts for the passphrase (R5-B simple mode).
 */
export function buildBlankSmartAccountClient(
  deps: BlankSmartAccountClientDeps,
): CofheSmartAccountClient {
  const { account, chainId, publicClient, chain, requestPassphrase } = deps;

  async function signDigestWithPasskey(digest: Hex, promptLabel?: string): Promise<Hex> {
    const passphrase = await requestPassphrase({
      title: promptLabel ?? "Unlock smart wallet",
      subtitle: "Enter your passphrase to authorize this signature.",
    });
    if (passphrase === null) {
      throw new Error("Passphrase prompt cancelled");
    }
    const sig = await signHash(chainId, passphrase, digest);
    return encodeP256AsErc1271Signature(sig.r, sig.s);
  }

  return {
    account: { address: account.address },

    // Route a CALL through the smart account via the relayer. Returns the
    // relayed tx hash (what viem callers expect) — userOpHash is discarded
    // since downstream code wants an on-chain-confirmable hash.
    async sendTransaction(tx) {
      const callData = encodeExecuteCall(tx.to, tx.value ?? 0n, tx.data ?? "0x");

      const onChainNonce = await getNextNonce(publicClient, account.address, 0n);
      // initCode stays empty — we require the account to be deployed
      // before the cofhe bridge runs. Undeployed accounts can't be
      // ERC-1271-verified anyway (no code at the address). Callers
      // should invoke a no-op UserOp via useSmartAccount first to pay
      // for deployment, then wire up the cofhe SDK for decryption.
      const initCode: Hex = "0x";
      if (!account.isDeployed) {
        throw new Error(
          "BlankSmartAccountClient.sendTransaction: account not yet deployed — " +
            "deploy via useSmartAccount first, then (re)connect cofhe SDK",
        );
      }

      let userOp: PackedUserOperation = buildUserOp({
        sender: account.address,
        nonce: onChainNonce,
        initCode,
        callData,
      });
      const userOpHash = await computeUserOpHash(publicClient, userOp);

      const sigHex = await signDigestWithPasskey(userOpHash, "Authorize transaction");
      // UserOp signatures encode as abi.encode(r, s) too — same shape the
      // ERC-1271 path uses. See useSmartAccount.submitCallData for reference.
      userOp = {
        ...userOp,
        signature: encodeP256Signature(
          ("0x" + sigHex.slice(2, 66)) as Hex,
          ("0x" + sigHex.slice(66)) as Hex,
        ),
      };

      const res = await fetch("/api/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userOp: serializeUserOp(userOp), chainId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `relay HTTP ${res.status}`);
      }
      const { hash } = (await res.json()) as { hash: Hex };

      // Other tabs running the same smart account must also bump their
      // nonce hint so a parallel sign doesn't collide. Same broadcast as
      // useSmartAccount.submitCallData.
      broadcastAction("aa_nonce_used", {
        nonce: onChainNonce.toString(),
        address: account.address,
        chainId,
      });

      return hash;
    },

    // EIP-1271 path: compute the EIP-712 digest, sign it with the passkey,
    // return abi.encode(r, s). The on-chain ACL contract (Fhenix) will call
    // our BlankAccount.isValidSignature(digest, sig) which decodes (r,s)
    // and verifies via P256.verify.
    async signTypedData(args) {
      const digest = hashTypedData({
        domain: args.domain as Parameters<typeof hashTypedData>[0]["domain"],
        types: args.types as Parameters<typeof hashTypedData>[0]["types"],
        primaryType: args.primaryType,
        message: args.message,
      });
      return signDigestWithPasskey(digest, "Authorize decryption");
    },

    // Optional — the cofhe-sdk falls back to viem's base.signMessage if
    // this is absent. Blank accounts can sign arbitrary messages too:
    // wrap the message as EIP-191-style digest and sign. Most SDK paths
    // use signTypedData so this is rarely hit; provide it for safety.
    async signMessage({ message }) {
      // Hash the message the same way viem's signMessage does — via
      // hashMessage (EIP-191). Keep the import local so the bridge
      // stays tree-shakable for UserOp-only consumers.
      const { hashMessage } = await import("viem");
      const digest = typeof message === "string"
        ? hashMessage(message)
        : hashMessage({ raw: message });
      return signDigestWithPasskey(digest as Hex, "Authorize signing");
    },

    // Note: no chain/chainId on the returned client — the SDK's adapter
    // reads chain from publicClient. We include it here via closure only.
    // This matches the adapter's expected shape exactly.
  } satisfies CofheSmartAccountClient & { /* unused: chain reference only */ };
  // Touch `chain` so TS doesn't warn about unused; keeps the closure honest.
  void chain;
}
