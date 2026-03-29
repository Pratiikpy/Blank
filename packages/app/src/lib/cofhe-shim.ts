/**
 * CoFHE React Hook Shims
 *
 * Replaces @cofhe/react imports to avoid the MUI/emotion dependency chain
 * that crashes in production builds. These provide the same API surface
 * with graceful fallbacks until the app connects to a real CoFHE provider.
 *
 * When @cofhe/react fixes its MUI peer dependency issue, remove this file
 * and restore the direct imports.
 */

// ─── useCofheEncrypt ────────────────────────────────────────────────

export function useCofheEncrypt() {
  return {
    encryptInputsAsync: async (..._args: unknown[]) => {
      console.warn("[CoFHE Shim] encryptInputsAsync called — CoFHE provider not loaded");
      return [];
    },
    isEncrypting: false,
  };
}

// ─── useCofheConnection ─────────────────────────────────────────────

export function useCofheConnection() {
  return {
    connected: false,
    connecting: false,
  };
}

// ─── useCofheEncryptAndWriteContract ────────────────────────────────

export function useCofheEncryptAndWriteContract() {
  return {
    encryptAndWrite: async (..._args: unknown[]) => {
      console.warn("[CoFHE Shim] encryptAndWrite called — CoFHE provider not loaded");
      throw new Error("CoFHE not available. Please try again later.");
    },
    atomicEncryption: { isEncrypting: false },
    atomicWrite: { isPending: false },
  };
}

// ─── useCofheReadContractAndDecrypt ─────────────────────────────────

export function useCofheReadContractAndDecrypt(_config: unknown) {
  return {
    encrypted: { data: undefined, isFetching: false },
    decrypted: { data: undefined, isFetching: false, error: null },
    disabledDueToMissingPermit: true,
  };
}

// ─── useCofheActivePermit ───────────────────────────────────────────

export function useCofheActivePermit() {
  return {
    data: null,
    isLoading: false,
  };
}

// ─── useCoingeckoUsdPrice ───────────────────────────────────────────

export function useCoingeckoUsdPrice(_config?: unknown) {
  return {
    data: 1.0, // USDC ≈ $1
    isLoading: false,
    error: null,
  };
}

// ─── CofheProvider (no-op wrapper) ──────────────────────────────────

export function CofheProvider({ children }: { children: React.ReactNode }) {
  return children;
}

// ─── createCofheConfig ──────────────────────────────────────────────

export function createCofheConfig(_config: unknown) {
  return {};
}
