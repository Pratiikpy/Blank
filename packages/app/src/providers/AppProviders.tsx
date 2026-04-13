import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { Toaster } from "react-hot-toast";
import { useEffect } from "react";
import { wagmiConfig } from "@/lib/wagmi-config";
import { cleanupOldStorage } from "@/lib/storage";
import { setQueryClient, invalidateAllQueries } from "@/lib/query-invalidation";
import { PassphrasePromptProvider } from "@/components/PassphrasePrompt";


const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 2,
    },
  },
});

setQueryClient(queryClient);

function WalletDesyncGuard() {
  const { address } = useAccount();
  useEffect(() => {
    invalidateAllQueries();
  }, [address]);
  return null;
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    cleanupOldStorage();
  }, []);

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <PassphrasePromptProvider>
          <WalletDesyncGuard />
          {children}
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
  );
}
