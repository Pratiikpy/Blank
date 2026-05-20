import "@testing-library/jest-dom";
import { vi } from "vitest";

// CI intentionally clears public env vars. Unit tests that mock Supabase still
// need valid-looking values so module-load constants do not force offline mode.
vi.stubEnv("VITE_SUPABASE_URL", "https://fake.supabase.test");
vi.stubEnv("VITE_SUPABASE_ANON_KEY", "fake-anon-key");
vi.stubEnv("VITE_AGENT_ATTESTATION_ADDRESS", "0x0000000000000000000000000000000000000001");

// jsdom doesn't implement matchMedia — stub it so useMediaQuery doesn't crash
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
