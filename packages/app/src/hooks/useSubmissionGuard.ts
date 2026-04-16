import { useCallback, useRef } from "react";

/**
 * Concurrency primitive: prevents double-submit regardless of how the
 * second click arrives (double-click, Enter + onClick, double-mount under
 * StrictMode, etc.).
 *
 * Usage:
 *   const guard = useSubmissionGuard();
 *   const onSubmit = () => guard(async () => {
 *     // write logic
 *   });
 *
 * If the guarded function is called while another call is in flight, the
 * second call returns immediately with undefined (and a `guarded` flag so
 * callers can differentiate).
 *
 * Uses a ref (not state) so the guard is synchronous — no React-batching
 * race window where both callers see `step !== "sending"`.
 */
export function useSubmissionGuard() {
  const inFlightRef = useRef(false);

  return useCallback(
    async <T,>(fn: () => Promise<T>): Promise<{ result: T | undefined; guarded: boolean }> => {
      if (inFlightRef.current) return { result: undefined, guarded: true };
      inFlightRef.current = true;
      try {
        const result = await fn();
        return { result, guarded: false };
      } finally {
        inFlightRef.current = false;
      }
    },
    [],
  );
}
