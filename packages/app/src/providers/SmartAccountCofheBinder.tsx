import { useMemo } from "react";
import { usePublicClient, useAccount } from "wagmi";
import { sepolia, baseSepolia } from "wagmi/chains";
import { useSmartAccount } from "@/hooks/useSmartAccount";
import { usePassphrasePrompt } from "@/components/PassphrasePrompt";
import { useChain } from "./ChainProvider";
import { useCofheSmartWalletBinding } from "@/lib/cofhe-shim";
import { buildBlankSmartAccountClient } from "@/lib/smart-account-cofhe-bridge";
import type { CofheSmartAccountClient } from "@/lib/smart-account-cofhe-bridge";

// R5-D: wire-up provider. Mounts once under CofheProvider +
// PassphrasePromptProvider. When a passkey-backed smart account is ready,
// constructs a CofheSmartAccountClient (passphrase-prompting signer routed
// through @cofhe/sdk/adapters/smartWalletViemAdapter) and binds the SDK
// to it. When the account is gone, the binding clears so useCofheConnection
// falls back to the EOA path.
//
// Side-effect component — renders nothing.
export function SmartAccountCofheBinder() {
  const { status, account } = useSmartAccount();
  const { activeChainId } = useChain();
  const { chain: wagmiChain } = useAccount();
  const publicClient = usePublicClient();
  const { request: requestPassphrase } = usePassphrasePrompt();

  // Build the SmartAccountClient when the smart account is ready AND
  // on-chain code exists (ERC-1271 verification requires the account
  // to be deployed before the SDK can verify our signatures via
  // ACL.checkPermitValidity). Undeployed accounts stay null here; the
  // first UserOp (shield/send/etc.) will deploy, then the next mount
  // cycle picks up isDeployed=true and activates the binding.
  const client: CofheSmartAccountClient | null = useMemo(() => {
    console.log("[SmartAccountCofheBinder] state check", {
      status, hasAccount: !!account, isDeployed: account?.isDeployed,
      hasPublicClient: !!publicClient, activeChainId,
    });
    if (status !== "ready" || !account || !publicClient) return null;
    if (!account.isDeployed) return null; // see comment above

    // Prefer the wagmi `chain` object so viem's typed clients line up;
    // fall back to the canonical chain for activeChainId when no EOA
    // is connected (passkey-only mode).
    const chain =
      wagmiChain ??
      (activeChainId === baseSepolia.id ? baseSepolia : sepolia);

    return buildBlankSmartAccountClient({
      account,
      chainId: activeChainId,
      publicClient,
      chain,
      requestPassphrase,
    });
    // `requestPassphrase` is stable across renders (useCallback inside
    // PassphrasePromptProvider with empty deps), so it doesn't force a
    // rebuild. `account.address` + `account.isDeployed` changes do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, account?.address, account?.isDeployed, activeChainId, publicClient, wagmiChain]);

  // Actually bind the SDK — pass null when client is null so the
  // EOA path can reclaim the connection on the next tick.
  // Pass activeChainId explicitly so the binding's publicClient resolves
  // for the active chain even when no EOA is connected.
  useCofheSmartWalletBinding(client, activeChainId);

  return null;
}
