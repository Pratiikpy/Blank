import { Suspense, useState, useEffect, type ComponentType } from "react";

// ─── Dynamic import to prevent crash if Three.js/R3F fails to load ───
// @react-three/fiber crashes at MODULE LOAD level on some environments
// (headless browsers, old devices). We catch this at the dynamic import boundary.

let CanvasModule: ComponentType<any> | null = null;
let EncryptedParticlesModule: ComponentType | null = null;
let loadAttempted = false;
let loadSucceeded = false;

function useThreeComponents() {
  const [ready, setReady] = useState(loadSucceeded);

  useEffect(() => {
    if (loadAttempted) {
      setReady(loadSucceeded);
      return;
    }
    loadAttempted = true;

    // Check WebGL first
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (!gl) {
        loadSucceeded = false;
        return;
      }
    } catch {
      loadSucceeded = false;
      return;
    }

    // Dynamically import Three.js + R3F
    Promise.all([
      import("@react-three/fiber"),
      import("./EncryptedParticles"),
    ])
      .then(([fiber, particles]) => {
        CanvasModule = fiber.Canvas;
        EncryptedParticlesModule = particles.EncryptedParticles;
        loadSucceeded = true;
        setReady(true);
      })
      .catch((err) => {
        console.warn("[Blank] Three.js failed to load:", err.message);
        loadSucceeded = false;
      });
  }, []);

  return ready;
}

export function ParticleScene() {
  const ready = useThreeComponents();

  if (!ready || !CanvasModule || !EncryptedParticlesModule) return null;

  const Canvas = CanvasModule;
  const EncryptedParticles = EncryptedParticlesModule;

  return (
    <div className="absolute inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <Canvas
        camera={{ position: [0, 0, 5], fov: 60 }}
        dpr={[1, 2]}
        gl={{
          alpha: true,
          antialias: true,
          powerPreference: "high-performance",
        }}
        style={{ background: "transparent" }}
        onCreated={({ gl }: any) => {
          gl.setClearColor(0x000000, 0);
        }}
      >
        <Suspense fallback={null}>
          <EncryptedParticles />
        </Suspense>
      </Canvas>
    </div>
  );
}
