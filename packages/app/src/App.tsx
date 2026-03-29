import { Suspense, lazy } from "react";
import { useRealtimeNotifications } from "@/hooks/useRealtimeNotifications";

const BlankApp = lazy(() => import("@/blank-ui/BlankApp").then(m => ({ default: m.BlankApp })));

function LoadingScreen() {
  return (
    <div className="min-h-dvh flex items-center justify-center" style={{ background: "#F9FAFB" }}>
      <div className="flex flex-col items-center gap-4">
        <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    </div>
  );
}

export function App() {
  // Global real-time notifications
  useRealtimeNotifications();

  return (
    <Suspense fallback={<LoadingScreen />}>
      <BlankApp />
    </Suspense>
  );
}
