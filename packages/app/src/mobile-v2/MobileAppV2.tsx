import { lazy, Suspense } from "react";
import { Routes, Route } from "react-router-dom";
import { MobileBottomNav } from "./MobileBottomNav";
import "./mobile-theme.css";

// ── Lazy-loaded screens (code-split per route) ──────────────────────
const MobileDashboard = lazy(() =>
  import("./screens/MobileDashboard").then((m) => ({
    default: m.MobileDashboard,
  })),
);
const MobileHistory = lazy(() =>
  import("./screens/MobileHistory").then((m) => ({
    default: m.MobileHistory,
  })),
);
const MobileExplore = lazy(() =>
  import("./screens/MobileExplore").then((m) => ({
    default: m.MobileExplore,
  })),
);
const MobileProfile = lazy(() =>
  import("./screens/MobileProfile").then((m) => ({
    default: m.MobileProfile,
  })),
);
const MobileAnalytics = lazy(() =>
  import("./screens/MobileAnalytics").then((m) => ({
    default: m.MobileAnalytics,
  })),
);
const MobileSendContacts = lazy(() =>
  import("./screens/MobileSendContacts").then((m) => ({
    default: m.MobileSendContacts,
  })),
);
const MobileSendAmount = lazy(() =>
  import("./screens/MobileSendAmount").then((m) => ({
    default: m.MobileSendAmount,
  })),
);
const MobileSendConfirm = lazy(() =>
  import("./screens/MobileSendConfirm").then((m) => ({
    default: m.MobileSendConfirm,
  })),
);
const MobileSendSuccess = lazy(() =>
  import("./screens/MobileSendSuccess").then((m) => ({
    default: m.MobileSendSuccess,
  })),
);
const MobileReceive = lazy(() =>
  import("./screens/MobileReceive").then((m) => ({
    default: m.MobileReceive,
  })),
);

// ── Loading spinner ─────────────────────────────────────────────────
function RouteLoader() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "80vh",
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          border: "2.5px solid rgba(108, 99, 255, 0.2)",
          borderTopColor: "#6C63FF",
          borderRadius: "50%",
          animation: "spin 0.7s linear infinite",
        }}
      />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MOBILE APP SHELL
// ═══════════════════════════════════════════════════════════════════

export function MobileAppV2() {
  return (
    <div className="mobile-app">
      <Suspense fallback={<RouteLoader />}>
        {/* pb-20 = 80px clearance for the fixed bottom nav */}
        <div style={{ paddingBottom: 80 }}>
          <Routes>
            <Route path="/" element={<MobileDashboard />} />
            <Route path="/send" element={<MobileSendContacts />} />
            <Route path="/send/amount" element={<MobileSendAmount />} />
            <Route path="/send/confirm" element={<MobileSendConfirm />} />
            <Route path="/send/success" element={<MobileSendSuccess />} />
            <Route path="/receive" element={<MobileReceive />} />
            <Route path="/history" element={<MobileHistory />} />
            <Route path="/explore" element={<MobileExplore />} />
            <Route path="/profile" element={<MobileProfile />} />
            <Route path="/analytics" element={<MobileAnalytics />} />
            {/* Catch-all falls back to dashboard */}
            <Route path="*" element={<MobileDashboard />} />
          </Routes>
        </div>
      </Suspense>
      <MobileBottomNav />
    </div>
  );
}

export default MobileAppV2;
