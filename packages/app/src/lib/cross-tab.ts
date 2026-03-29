const CHANNEL_NAME = "blank-cross-tab";

let channel: BroadcastChannel | null = null;

export function getCrossTabChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
  }
  return channel;
}

export function broadcastAction(action: string, data?: Record<string, unknown>) {
  getCrossTabChannel()?.postMessage({ action, data, timestamp: Date.now() });
}

export function onCrossTabAction(callback: (action: string, data?: Record<string, unknown>) => void) {
  const ch = getCrossTabChannel();
  if (!ch) return () => {};
  const handler = (e: MessageEvent) => callback(e.data.action, e.data.data);
  ch.addEventListener("message", handler);
  return () => ch.removeEventListener("message", handler);
}
