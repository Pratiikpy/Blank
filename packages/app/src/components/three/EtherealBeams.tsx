import { Suspense, useState, useEffect, type ComponentType } from "react";

// ─── Types ──────────────────────────────────────────────────────────

export interface EtherealBeamsProps {
  /** Width of each beam plane */
  beamWidth?: number;
  /** Height of each beam plane */
  beamHeight?: number;
  /** Number of beam planes */
  beamNumber?: number;
  /** Light/beam color (hex string) */
  lightColor?: string;
  /** Noise scroll speed multiplier */
  speed?: number;
  /** Fragment noise grain intensity */
  noiseIntensity?: number;
  /** Vertex noise frequency scale */
  scale?: number;
  /** Rotation in degrees around the Z axis */
  rotation?: number;
}

// ─── Dynamic import to prevent crash if Three.js/R3F fails to load ──

let CanvasModule: ComponentType<any> | null = null;
let BeamsSceneModule: ComponentType<EtherealBeamsProps> | null = null;
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

    // Dynamically import Three.js + R3F + scene component
    // drei is imported inside EtherealBeamsScene directly
    Promise.all([
      import("@react-three/fiber"),
      import("./EtherealBeamsScene"),
    ])
      .then(([fiber, scene]) => {
        CanvasModule = fiber.Canvas;
        BeamsSceneModule = scene.EtherealBeamsScene;
        loadSucceeded = true;
        setReady(true);
      })
      .catch((err) => {
        console.warn("[EtherealBeams] Three.js failed to load:", err.message);
        loadSucceeded = false;
      });
  }, []);

  return ready;
}

// ─── Safe Wrapper Component ─────────────────────────────────────────

export function EtherealBeams(props: EtherealBeamsProps) {
  const ready = useThreeComponents();

  if (!ready || !CanvasModule || !BeamsSceneModule) return null;

  const Canvas = CanvasModule;
  const BeamsScene = BeamsSceneModule;

  return (
    <div
      className="absolute inset-0 -z-10 overflow-hidden pointer-events-none"
      aria-hidden="true"
    >
      <Canvas
        dpr={[1, 1.5]}
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
          <BeamsScene {...props} />
        </Suspense>
      </Canvas>
    </div>
  );
}
