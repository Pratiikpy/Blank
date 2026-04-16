import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { Toaster } from "react-hot-toast";
import { useEffect } from "react";
import { wagmiConfig } from "@/lib/wagmi-config";
import { cleanupOldStorage } from "@/lib/storage";
import { setQueryClient, invalidateAllQueries, invalidateBalanceQueries } from "@/lib/query-invalidation";
import { PassphrasePromptProvider } from "@/components/PassphrasePrompt";
import { PrivacyModeProvider } from "./PrivacyModeProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ServiceHealthBanner } from "@/components/ServiceHealthBanner";
import { setApprovalContext } from "@/lib/approval";
import { onCrossTabAction } from "@/lib/cross-tab";
import { ChainProvider } from "./ChainProvider";
import { CofheProvider } from "./CofheProvider";
import { RealtimeProvider } from "./RealtimeProvider";
import { SmartAccountCofheBinder } from "./SmartAccountCofheBinder";


const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 2,
    },
  },
});

setQueryClient(queryClient);

// #20 + #109: invalidate on BOTH address AND chain change. Previously only
// address was watched, so a user who stayed on the same address but switched
// chains in their wallet kept stale queries scoped to the old chain.
function WalletDesyncGuard() {
  const { address, chain } = useAccount();
  useEffect(() => {
    invalidateAllQueries();
  }, [address, chain?.id]);

  // #102: keep the approval cache module scoped to the current wallet+chain
  // so approvals don't leak across wallet switches.
  useEffect(() => {
    setApprovalContext(address, chain?.id);
  }, [address, chain?.id]);

  // #106: when another tab broadcasts a balance change, invalidate here too.
  // Previously the broadcast was fire-and-forget — every tab broadcast, no
  // tab listened, so the whole purpose of broadcasting was defeated.
  useEffect(() => {
    return onCrossTabAction((action) => {
      if (action === "balance_changed" || action === "activity_added") {
        invalidateBalanceQueries();
      }
    });
  }, []);

  return null;
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    cleanupOldStorage();
  }, []);

  return (
    <ChainProvider>
      <CofheProvider>
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <PassphrasePromptProvider>
              <PrivacyModeProvider>
              <RealtimeProvider>
                <WalletDesyncGuard />
                {/* R5-D: binds cofhe SDK to the passkey smart wallet when
                    ready. Passkey-only users get encrypted reads via the
                    ERC-1271 path. EOA users are unaffected (null client). */}
                <SmartAccountCofheBinder />
                <ErrorBoundary>
                  <ServiceHealthBanner />
                  {children}
                </ErrorBoundary>
              </RealtimeProvider>
              </PrivacyModeProvider>
            </PassphrasePromptProvider>
            <Toaster
              position="top-right"
              toastOptions={{
                style: {
                  zIndex: 99999,
                  background: "#FFFFFF",
                  color: "#1D1D1F",
                  border: "1px solid rgba(0,0,0,0.06)",
                  borderRadius: "16px",
                  boxShadow: "0 8px 32px rgba(0,0,0,0.08)",
                },
              }}
              containerStyle={{ zIndex: 99999 }}
            />
          </QueryClientProvider>
        </WagmiProvider>
      </CofheProvider>
    </ChainProvider>
  );
}
