import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";

/**
 * Cleanup-safe polling primitive.
 *
 * Problem this solves: manual setInterval in hooks orphans on address/chain
 * change, double-fires under StrictMode, and leaks on unmount. Every
 * polling path (decryption, pending-unshield auto-resume, group refresh)
 * should go through this.
 *
 * Guarantees:
 *   - Single interval per mounted hook (no StrictMode duplicates).
 *   - Cleared on unmount, address change, chain change, enabled→false.
 *   - `fn` receives an AbortSignal that fires on cleanup so in-flight
 *     network calls can cancel instead of racing the next tick.
 *   - Honors `document.hidden` — pauses when tab is backgrounded.
 */
export interface PollingOptions {
  fn: (signal: AbortSignal) => void | Promise<void>;
  intervalMs: number;
  enabled: boolean;
  /** Run once immediately on start (in addition to interval ticks). */
  runImmediately?: boolean;
  /** Pause when document.hidden. Default: true. */
  pauseWhenHidden?: boolean;
}

export function usePolling({
  fn,
  intervalMs,
  enabled,
  runImmediately = true,
  pauseWhenHidden = true,
}: PollingOptions) {
  const { address, chain } = useAccount();
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (pauseWhenHidden && typeof document !== "undefined" && document.hidden) return;
      if (controller.signal.aborted) return;
      try {
        await fnRef.current(controller.signal);
      } catch (err) {
        if (!controller.signal.aborted) {
          console.warn("[usePolling] tick error:", err);
        }
      }
    };

    if (runImmediately) void tick();
    timer = setInterval(tick, intervalMs);

    return () => {
      controller.abort();
      if (timer) clearInterval(timer);
    };
    // Intentional deps: restart polling whenever scope changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, runImmediately, pauseWhenHidden, address, chain?.id]);
}
