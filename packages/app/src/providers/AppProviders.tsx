import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CofheProvider, useCofheConnection, useCofheActivePermit } from "@cofhe/react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { Toaster } from "react-hot-toast";
import toast from "react-hot-toast";
import { useEffect, useRef } from "react";
import { wagmiConfig } from "@/lib/wagmi-config";
import { cleanupOldStorage } from "@/lib/storage";
import { cofheConfig } from "@/lib/cofhe-config";
import { setQueryClient } from "@/lib/query-invalidation";
import { invalidateAllQueries } from "@/lib/query-invalidation";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 2,
    },
  },
});

// Register queryClient for global invalidation from hooks
setQueryClient(queryClient);

// ─── TASK 1: CofheAutoConnect Bridge ─────────────────────────────────
// The CofheProvider internally uses useCofheAutoConnect when walletClient
// and publicClient are passed as props. This bridge component monitors
// the connection state and provides user feedback via toasts.

function CofheConnectionMonitor() {
  const { connected, connecting } = useCofheConnection();
  const prevConnectedRef = useRef(false);

  useEffect(() => {
    if (connected && !prevConnectedRef.current) {
      toast.success("CoFHE connected", { id: "cofhe-connected", duration: 2000 });
    }
    if (!connected && prevConnectedRef.current && !connecting) {
      toast("CoFHE disconnected", { id: "cofhe-disconnected", duration: 2000 });
    }
    prevConnectedRef.current = connected;
  }, [connected, connecting]);

  return null;
}

// ─── TASK 2: Permit Status Watcher ───────────────────────────────────
// Adapted from the SDK's useWatchPermitStatus, which uses internal portal
// stores we don't have. This version uses toast notifications instead.
// Checks every 30s: warns when permit expires in <1 hour, errors when expired.

function PermitStatusWatcher() {
  const activePermit = useCofheActivePermit();
  const { connected } = useCofheConnection();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastWarningRef = useRef<string | null>(null);

  useEffect(() => {
    const checkPermitStatus = () => {
      if (!connected || !activePermit?.permit) {
        // Clear warning state when disconnected or no permit
        if (lastWarningRef.current) {
          lastWarningRef.current = null;
        }
        return;
      }

      const permit = activePermit.permit;
      const now = Math.floor(Date.now() / 1000);
      const expiration = permit.expiration;

      if (!expiration || expiration === 0) return;

      const isExpired = expiration < now;
      const isExpiringSoon = !isExpired && expiration - now < 3600; // <1 hour

      if (isExpired && lastWarningRef.current !== "expired") {
        toast.error("Your FHE permit has expired. Please create a new one to decrypt balances.", {
          id: "permit-expired",
          duration: 8000,
        });
        lastWarningRef.current = "expired";
      } else if (isExpiringSoon && lastWarningRef.current !== "expiring-soon") {
        const minutesLeft = Math.ceil((expiration - now) / 60);
        toast(`FHE permit expires in ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}. Consider renewing.`, {
          id: "permit-expiring-soon",
          icon: "\u26A0\uFE0F",
          duration: 6000,
        });
        lastWarningRef.current = "expiring-soon";
      } else if (!isExpired && !isExpiringSoon) {
        lastWarningRef.current = null;
      }
    };

    // Check immediately on mount / permit change
    checkPermitStatus();

    // Poll every 30 seconds
    intervalRef.current = setInterval(checkPermitStatus, 30_000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [activePermit, connected]);

  return null;
}

// ─── TASK 82: Wallet-App State Desync Detection ─────────────────────
// When the wallet account or chain changes, cached query data becomes
// stale. Invalidate all queries to force refetch with the new context.

function WalletDesyncGuard() {
  const { address } = useAccount();
  const prevAddressRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    // Skip initial mount — only invalidate on actual address change
    if (prevAddressRef.current !== undefined && prevAddressRef.current !== address) {
      invalidateAllQueries();
    }
    prevAddressRef.current = address;
  }, [address]);

  return null;
}

// ─── CofheProvider Wrapper ────────────────────────────────────────────

function CofheProviderWrapper({ children }: { children: React.ReactNode }) {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { chain } = useAccount();

  const isConnectedToSupportedChain = chain?.id === 84532;

  return (
    <CofheProvider
      walletClient={isConnectedToSupportedChain ? walletClient : undefined}
      publicClient={isConnectedToSupportedChain ? publicClient : undefined}
      config={cofheConfig}
    >
      {/* TASK 1: Monitor auto-connect state and provide feedback */}
      <CofheConnectionMonitor />
      {/* TASK 2: Watch permit expiry and warn user */}
      <PermitStatusWatcher />
      {children}
    </CofheProvider>
  );
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    cleanupOldStorage();
  }, []);

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <WalletDesyncGuard />
        <CofheProviderWrapper>
          {children}
          <Toaster
            position="top-right"
            containerStyle={{ zIndex: 99999 }}
            toastOptions={{
              duration: 5000,
              style: {
                zIndex: 99999,
                background: "#1C1C1E",
                color: "#F5F5F7",
                border: "1px solid rgba(255, 255, 255, 0.06)",
                borderRadius: "12px",
                backdropFilter: "blur(24px)",
                fontSize: "14px",
              },
              success: {
                iconTheme: { primary: "#10b981", secondary: "#000" },
              },
              error: {
                iconTheme: { primary: "#ef4444", secondary: "#000" },
              },
            }}
          />
        </CofheProviderWrapper>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
