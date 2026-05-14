import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

// §15.x test for useRealtimeNotifications. Pins the recipient-only
// toast filter (toIsUs && !fromIsUs — no self-send notifications),
// the 5-minute initial-fetch window for offline-missed notifications,
// and the dual-Set dedup that prevents duplicate toasts.

const fetchActivitiesMock = vi.hoisted(() => vi.fn());
const useEffectiveAddressMock = vi.hoisted(() => vi.fn());
const useChainMock = vi.hoisted(() => vi.fn());
const acceptTxMock = vi.hoisted(() => vi.fn());

// Captured channel handlers per (channel-name-substring) so tests can
// invoke the right one.
const channelHandlers = vi.hoisted(() => ({
  byChannelName: new Map<string, (payload: { new: Record<string, unknown> }) => void>(),
}));

const supabaseChannelMock = vi.hoisted(() => vi.fn());
const supabaseRemoveChannelMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase", () => ({
  supabase: {
    channel: supabaseChannelMock,
    removeChannel: supabaseRemoveChannelMock,
  },
  fetchActivities: fetchActivitiesMock,
}));

vi.mock("./useEffectiveAddress", () => ({
  useEffectiveAddress: useEffectiveAddressMock,
}));

vi.mock("@/providers/ChainProvider", () => ({
  useChain: useChainMock,
}));

vi.mock("./useActivityDedup", () => ({
  useActivityDedup: () => ({ accept: acceptTxMock }),
}));

vi.mock("@/lib/activity-messages", () => ({
  formatActivityMessage: (type: string, from: string, note: string) =>
    `${from} sent you a ${type}${note ? `: ${note}` : ""}`,
  iconForActivityType: () => "💸",
}));

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("react-hot-toast", () => ({
  default: toastMock,
}));

import { useRealtimeNotifications } from "./useRealtimeNotifications";

const ME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const EOA = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ALICE = "0xcccccccccccccccccccccccccccccccccccccccc";

beforeEach(() => {
  fetchActivitiesMock.mockReset();
  useEffectiveAddressMock.mockReset();
  useChainMock.mockReset();
  acceptTxMock.mockReset();
  supabaseChannelMock.mockReset();
  supabaseRemoveChannelMock.mockReset();
  toastMock.mockReset();
  channelHandlers.byChannelName.clear();

  // Default: AA only (no separate EOA).
  useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME, eoa: undefined });
  useChainMock.mockReturnValue({ activeChainId: 11155111 });
  fetchActivitiesMock.mockResolvedValue([]);
  acceptTxMock.mockReturnValue(true);

  // Channel mock captures the handler keyed by channel-name fragment.
  supabaseChannelMock.mockImplementation((channelName: string) => {
    const chain: Record<string, unknown> = {
      on: (_evt: string, _opts: unknown, h: (payload: { new: Record<string, unknown> }) => void) => {
        channelHandlers.byChannelName.set(channelName, h);
        return chain;
      },
      subscribe: () => chain,
    };
    return chain;
  });
});

describe("useRealtimeNotifications — channel registration (§15.x)", () => {
  it("registers 4 channels for a single-address user (in / out / requests / invoices)", () => {
    renderHook(() => useRealtimeNotifications());
    const names = Array.from(channelHandlers.byChannelName.keys());
    expect(names).toContain(`notify_activity_incoming_${ME.toLowerCase()}`);
    expect(names).toContain(`notify_activity_outgoing_${ME.toLowerCase()}`);
    expect(names).toContain(`notify_requests_${ME.toLowerCase()}`);
    expect(names).toContain(`notify_invoices_${ME.toLowerCase()}`);
  });

  it("opens DOUBLE channels (8 total) when AA and EOA both present and distinct (#190)", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME, eoa: EOA });
    renderHook(() => useRealtimeNotifications());
    const names = Array.from(channelHandlers.byChannelName.keys());
    // 4 per address × 2 addresses = 8 channels.
    expect(names.length).toBe(8);
    expect(names).toContain(`notify_activity_incoming_${ME.toLowerCase()}`);
    expect(names).toContain(`notify_activity_incoming_${EOA.toLowerCase()}`);
  });

  it("does NOT double-register when eoa equals effectiveAddress (case-insensitive)", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: ME, eoa: ME.toUpperCase() });
    renderHook(() => useRealtimeNotifications());
    const names = Array.from(channelHandlers.byChannelName.keys());
    // Should still be 4 channels (one address only).
    expect(names.length).toBe(4);
  });

  it("registers ZERO channels when no effective address (not connected)", () => {
    useEffectiveAddressMock.mockReturnValue({ effectiveAddress: undefined, eoa: undefined });
    renderHook(() => useRealtimeNotifications());
    expect(channelHandlers.byChannelName.size).toBe(0);
    expect(fetchActivitiesMock).not.toHaveBeenCalled();
  });

  it("cleanup unmount removes every channel via supabase.removeChannel", () => {
    const { unmount } = renderHook(() => useRealtimeNotifications());
    expect(channelHandlers.byChannelName.size).toBe(4);
    unmount();
    expect(supabaseRemoveChannelMock).toHaveBeenCalledTimes(4);
  });
});

describe("useRealtimeNotifications — initial fetch (5-min window) (§15.x)", () => {
  it("toasts for activity within the last 5 minutes where user is recipient", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    fetchActivitiesMock.mockResolvedValue([
      {
        tx_hash: "0xrecent",
        user_from: ALICE,
        user_to: ME,
        activity_type: "payment",
        note: "rent",
        created_at: recent,
      },
    ]);
    renderHook(() => useRealtimeNotifications());
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    const [msg, opts] = toastMock.mock.calls[0];
    expect(msg).toContain("sent you a payment");
    expect(opts.duration).toBe(5000);
    expect(opts.icon).toBe("💸");
  });

  it("SKIPS rows older than 5 minutes (offline-window guard)", async () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago
    fetchActivitiesMock.mockResolvedValue([
      {
        tx_hash: "0xold",
        user_from: ALICE,
        user_to: ME,
        activity_type: "payment",
        note: "",
        created_at: old,
      },
    ]);
    renderHook(() => useRealtimeNotifications());
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalled());
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("CRITICAL: SKIPS self-sends (toIsUs && fromIsUs) — no notification for own payments", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    fetchActivitiesMock.mockResolvedValue([
      {
        tx_hash: "0xself",
        user_from: ME,
        user_to: ME,
        activity_type: "payment",
        note: "self transfer",
        created_at: recent,
      },
    ]);
    renderHook(() => useRealtimeNotifications());
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalled());
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("SKIPS rows where user is sender but not recipient (no 'I sent payment' self-toast)", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    fetchActivitiesMock.mockResolvedValue([
      {
        tx_hash: "0xoutbound",
        user_from: ME,
        user_to: ALICE,
        activity_type: "payment",
        note: "",
        created_at: recent,
      },
    ]);
    renderHook(() => useRealtimeNotifications());
    await waitFor(() => expect(fetchActivitiesMock).toHaveBeenCalled());
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("acceptTx dedup gate prevents duplicate toasts for the same tx_hash", async () => {
    acceptTxMock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false); // 2nd call: dedup blocks

    const recent = new Date(Date.now() - 60_000).toISOString();
    fetchActivitiesMock.mockResolvedValue([
      { tx_hash: "0xdup", user_from: ALICE, user_to: ME, activity_type: "payment", note: "", created_at: recent },
      { tx_hash: "0xdup", user_from: ALICE, user_to: ME, activity_type: "payment", note: "", created_at: recent },
    ]);
    renderHook(() => useRealtimeNotifications());
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    // Only 1 toast despite 2 rows.
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("does not throw when fetchActivities rejects (best-effort initial fetch)", async () => {
    fetchActivitiesMock.mockRejectedValue(new Error("RPC down"));
    expect(() => renderHook(() => useRealtimeNotifications())).not.toThrow();
  });
});

describe("useRealtimeNotifications — realtime INSERT handler (§15.x)", () => {
  it("incoming-activity channel: toasts for payment from ALICE to ME", async () => {
    renderHook(() => useRealtimeNotifications());
    await waitFor(() => expect(channelHandlers.byChannelName.size).toBeGreaterThan(0));

    const handler = channelHandlers.byChannelName.get(`notify_activity_incoming_${ME.toLowerCase()}`)!;
    act(() => {
      handler({
        new: {
          tx_hash: "0xpay",
          user_from: ALICE,
          user_to: ME,
          activity_type: "payment",
          note: "lunch",
        },
      });
    });

    expect(toastMock).toHaveBeenCalled();
    expect(toastMock.mock.calls[0][0]).toContain("sent you a payment");
  });

  it("CRITICAL: incoming-activity DOES NOT toast on self-send (toIsUs && fromIsUs)", async () => {
    renderHook(() => useRealtimeNotifications());
    await waitFor(() => expect(channelHandlers.byChannelName.size).toBeGreaterThan(0));

    const handler = channelHandlers.byChannelName.get(`notify_activity_incoming_${ME.toLowerCase()}`)!;
    act(() => {
      handler({
        new: {
          tx_hash: "0xself",
          user_from: ME,
          user_to: ME,
          activity_type: "payment",
          note: "",
        },
      });
    });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("payment-request channel: toasts with '<from> requested money' format", async () => {
    renderHook(() => useRealtimeNotifications());
    await waitFor(() => expect(channelHandlers.byChannelName.size).toBeGreaterThan(0));

    const handler = channelHandlers.byChannelName.get(`notify_requests_${ME.toLowerCase()}`)!;
    act(() => {
      handler({
        new: { to_address: ALICE, note: "dinner" },
      });
    });

    expect(toastMock).toHaveBeenCalled();
    expect(toastMock.mock.calls[0][0]).toContain("requested money");
    expect(toastMock.mock.calls[0][0]).toContain("dinner");
  });

  it("invoice channel: toasts with 'New invoice from <vendor>: <description>'", async () => {
    renderHook(() => useRealtimeNotifications());
    await waitFor(() => expect(channelHandlers.byChannelName.size).toBeGreaterThan(0));

    const handler = channelHandlers.byChannelName.get(`notify_invoices_${ME.toLowerCase()}`)!;
    act(() => {
      handler({
        new: { vendor_address: ALICE, description: "Web design" },
      });
    });

    expect(toastMock).toHaveBeenCalled();
    expect(toastMock.mock.calls[0][0]).toContain("New invoice from");
    expect(toastMock.mock.calls[0][0]).toContain("Web design");
  });

  it("realtime activity handler respects acceptTx dedup", async () => {
    acceptTxMock.mockReturnValue(false); // dedup blocks every call
    renderHook(() => useRealtimeNotifications());
    await waitFor(() => expect(channelHandlers.byChannelName.size).toBeGreaterThan(0));

    const handler = channelHandlers.byChannelName.get(`notify_activity_incoming_${ME.toLowerCase()}`)!;
    act(() => {
      handler({
        new: { tx_hash: "0xpay", user_from: ALICE, user_to: ME, activity_type: "payment", note: "" },
      });
    });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("realtime activity handler uses LOCAL notified Set as backup dedup", async () => {
    renderHook(() => useRealtimeNotifications());
    await waitFor(() => expect(channelHandlers.byChannelName.size).toBeGreaterThan(0));

    // acceptTx allows both; local Set should block the 2nd.
    acceptTxMock.mockReturnValue(true);
    const handler = channelHandlers.byChannelName.get(`notify_activity_incoming_${ME.toLowerCase()}`)!;
    const row = { tx_hash: "0xdup", user_from: ALICE, user_to: ME, activity_type: "payment", note: "" };

    act(() => handler({ new: row }));
    act(() => handler({ new: row }));

    expect(toastMock).toHaveBeenCalledTimes(1);
  });
});
