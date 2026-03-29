import { useRef, useMemo, useEffect, useCallback } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";

// ─── Constants ──────────────────────────────────────────────────────

const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
const PARTICLE_COUNT = isMobile ? 1500 : 4000;
const SPHERE_RADIUS = 2.2;
const ORBIT_SPEED = (2 * Math.PI) / 30; // 30s per revolution
const MOUSE_REPEL_RADIUS = 1.2;
const MOUSE_REPEL_STRENGTH = 0.4;
const PULSE_INTERVAL = 5; // seconds between encryption pulses
const PULSE_DURATION = 1.5; // seconds the pulse lasts
const PULSE_SCATTER = 0.8; // how far particles scatter during pulse

// Emerald accent from design system: #34d399 = rgb(52, 211, 153)
const COLOR_WHITE = new THREE.Color(1, 1, 1);
const COLOR_EMERALD = new THREE.Color(52 / 255, 211 / 255, 153 / 255);

// ─── Shaders ────────────────────────────────────────────────────────

const vertexShader = /* glsl */ `
  attribute float aOpacity;
  attribute float aSize;
  varying float vOpacity;
  varying vec3 vColor;

  void main() {
    vOpacity = aOpacity;
    vColor = color;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = /* glsl */ `
  varying float vOpacity;
  varying vec3 vColor;

  void main() {
    float dist = length(gl_PointCoord - vec2(0.5));
    if (dist > 0.5) discard;
    float core = smoothstep(0.5, 0.1, dist);
    float glow = exp(-dist * dist * 8.0) * 0.35;
    float alpha = (core + glow) * vOpacity;
    gl_FragColor = vec4(vColor * (1.0 + glow * 0.4), alpha);
  }
`;

// ─── Helpers ────────────────────────────────────────────────────────

/** Generate a random point within a sphere volume (Marsaglia method). */
function randomInSphere(radius: number): [number, number, number] {
  const u = Math.random() * 2 - 1;
  const theta = Math.random() * 2 * Math.PI;
  const r = Math.sqrt(1 - u * u);
  const scale = radius * Math.cbrt(Math.random());
  return [scale * r * Math.cos(theta), scale * r * Math.sin(theta), scale * u];
}

// ─── Component ──────────────────────────────────────────────────────

export function EncryptedParticles() {
  const pointsRef = useRef<THREE.Points>(null);
  const { size, viewport, gl } = useThree();

  // Mouse position in approximate world coordinates (start off-screen)
  const mouse = useRef(new THREE.Vector2(10000, 10000));

  // Pulse state (mutated in-place to avoid re-renders)
  const pulseRef = useRef({ lastPulse: 0, active: false, progress: 0 });

  // ── Initial particle data (stable arrays, never re-allocated) ───

  const { positions, basePositions, opacities, sizes, velocities, colors } =
    useMemo(() => {
      const pos = new Float32Array(PARTICLE_COUNT * 3);
      const base = new Float32Array(PARTICLE_COUNT * 3);
      const opa = new Float32Array(PARTICLE_COUNT);
      const sz = new Float32Array(PARTICLE_COUNT);
      const vel = new Float32Array(PARTICLE_COUNT * 3);
      const col = new Float32Array(PARTICLE_COUNT * 3);

      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const [x, y, z] = randomInSphere(SPHERE_RADIUS);
        const i3 = i * 3;

        pos[i3] = x;
        pos[i3 + 1] = y;
        pos[i3 + 2] = z;

        base[i3] = x;
        base[i3 + 1] = y;
        base[i3 + 2] = z;

        vel[i3] = 0;
        vel[i3 + 1] = 0;
        vel[i3 + 2] = 0;

        // Subtle opacity range: 0.08 - 0.35
        opa[i] = 0.08 + Math.random() * 0.27;

        // Particle size: 0.8 - 2.0px (with attenuation in shader)
        sz[i] = 0.8 + Math.random() * 1.2;

        // 90% white, 10% emerald tint
        const c = Math.random() < 0.1 ? COLOR_EMERALD : COLOR_WHITE;
        col[i3] = c.r;
        col[i3 + 1] = c.g;
        col[i3 + 2] = c.b;
      }

      return {
        positions: pos,
        basePositions: base,
        opacities: opa,
        sizes: sz,
        velocities: vel,
        colors: col,
      };
    }, []);

  // ── Mouse tracking ────────────────────────────────────────────

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const x = ((event.clientX / size.width) * 2 - 1) * (viewport.width / 2);
      const y =
        (-(event.clientY / size.height) * 2 + 1) * (viewport.height / 2);
      mouse.current.set(x, y);
    },
    [size.width, size.height, viewport.width, viewport.height]
  );

  const handlePointerLeave = useCallback(() => {
    mouse.current.set(10000, 10000);
  }, []);

  useEffect(() => {
    const canvas = gl.domElement;
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerleave", handlePointerLeave);
    return () => {
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerleave", handlePointerLeave);
    };
  }, [gl.domElement, handlePointerMove, handlePointerLeave]);

  // ── Animation Loop ────────────────────────────────────────────

  useFrame((state, delta) => {
    const points = pointsRef.current;
    if (!points) return;

    const posAttr = points.geometry.getAttribute(
      "position"
    ) as THREE.BufferAttribute;
    const opaAttr = points.geometry.getAttribute(
      "aOpacity"
    ) as THREE.BufferAttribute;
    const colAttr = points.geometry.getAttribute(
      "color"
    ) as THREE.BufferAttribute;
    const posArr = posAttr.array as Float32Array;
    const opaArr = opaAttr.array as Float32Array;
    const colArr = colAttr.array as Float32Array;

    const elapsed = state.clock.elapsedTime;
    const pulse = pulseRef.current;

    // ── Trigger encryption pulse ────────────────────────────────
    if (elapsed - pulse.lastPulse >= PULSE_INTERVAL && !pulse.active) {
      pulse.active = true;
      pulse.progress = 0;
      pulse.lastPulse = elapsed;

      // Assign each particle a random outward scatter velocity
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const i3 = i * 3;
        const dx = basePositions[i3];
        const dy = basePositions[i3 + 1];
        const dz = basePositions[i3 + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const scatter = PULSE_SCATTER * (0.5 + Math.random() * 0.5);
        velocities[i3] = (dx / len) * scatter;
        velocities[i3 + 1] = (dy / len) * scatter;
        velocities[i3 + 2] = (dz / len) * scatter;
      }
    }

    // ── Advance pulse ───────────────────────────────────────────
    if (pulse.active) {
      pulse.progress += delta / PULSE_DURATION;
      if (pulse.progress >= 1) {
        pulse.active = false;
        pulse.progress = 1;
      }
    }

    // Ease: fast expand (0-30%), slow contract (30-100%)
    const pulseEase = pulse.active
      ? pulse.progress < 0.3
        ? pulse.progress / 0.3
        : 1 - (pulse.progress - 0.3) / 0.7
      : 0;

    // ── Orbit rotation (Y-axis) ─────────────────────────────────
    const rotAngle = ORBIT_SPEED * delta;
    const cosR = Math.cos(rotAngle);
    const sinR = Math.sin(rotAngle);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const i3 = i * 3;
      const bx = basePositions[i3];
      const bz = basePositions[i3 + 2];
      basePositions[i3] = bx * cosR - bz * sinR;
      basePositions[i3 + 2] = bx * sinR + bz * cosR;
    }

    // ── Per-particle update ─────────────────────────────────────
    const mx = mouse.current.x;
    const my = mouse.current.y;
    const lerp = 1 - Math.pow(0.05, delta); // frame-rate independent smoothing

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const i3 = i * 3;

      // Target = home position + pulse scatter offset
      let tx = basePositions[i3] + velocities[i3] * pulseEase;
      let ty = basePositions[i3 + 1] + velocities[i3 + 1] * pulseEase;
      const tz = basePositions[i3 + 2] + velocities[i3 + 2] * pulseEase;

      // Mouse repulsion (XY plane, camera faces -Z)
      const dx = tx - mx;
      const dy = ty - my;
      const distSq = dx * dx + dy * dy;
      if (
        distSq < MOUSE_REPEL_RADIUS * MOUSE_REPEL_RADIUS &&
        distSq > 0.001
      ) {
        const dist = Math.sqrt(distSq);
        const force = (1 - dist / MOUSE_REPEL_RADIUS) * MOUSE_REPEL_STRENGTH;
        tx += (dx / dist) * force;
        ty += (dy / dist) * force;
      }

      // Smoothly interpolate current position toward target
      posArr[i3] += (tx - posArr[i3]) * lerp;
      posArr[i3 + 1] += (ty - posArr[i3 + 1]) * lerp;
      posArr[i3 + 2] += (tz - posArr[i3 + 2]) * lerp;

      // Opacity: gentle breathing + pulse brightening
      const baseOpa = opacities[i];
      if (pulse.active && pulseEase > 0.1) {
        opaArr[i] = baseOpa + pulseEase * 0.15;

        // Color shift toward emerald during pulse
        const t = pulseEase * 0.5;
        colArr[i3] = colArr[i3] + (COLOR_EMERALD.r - colArr[i3]) * t * delta * 3;
        colArr[i3 + 1] = colArr[i3 + 1] + (COLOR_EMERALD.g - colArr[i3 + 1]) * t * delta * 3;
        colArr[i3 + 2] = colArr[i3 + 2] + (COLOR_EMERALD.b - colArr[i3 + 2]) * t * delta * 3;
      } else {
        opaArr[i] = baseOpa + Math.sin(elapsed * 0.5 + i * 0.01) * 0.03;
      }
    }

    posAttr.needsUpdate = true;
    opaAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  });

  // ── Geometry (built once) ─────────────────────────────────────

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aOpacity", new THREE.BufferAttribute(opacities, 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geo;
  }, [positions, opacities, sizes, colors]);

  // ── Material (built once) ─────────────────────────────────────

  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexColors: true,
      }),
    []
  );

  return <points ref={pointsRef} geometry={geometry} material={material} />;
}
