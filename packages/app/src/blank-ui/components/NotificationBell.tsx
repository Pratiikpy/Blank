import { useState } from "react";
import { Bell, BellRing } from "lucide-react";

import { useNotifications, type NotificationRow } from "@/hooks/useNotifications";
import { NOTIFICATION_EVENTS, fillBody } from "@/lib/notification-events";

// Wave 5 Block 5 — header notification bell.
//
// Drops into the existing DesktopSidebar / MobileHeader.
// Opens a small popover with the last ~10 unread rows.

function bodyFor(row: NotificationRow): string {
  const def = NOTIFICATION_EVENTS[row.event_type];
  if (!def) return `Event ${row.event_type}`;
  return fillBody(def.bodyTemplate, (row.payload ?? {}) as Record<string, string | number>);
}

function labelFor(row: NotificationRow): string {
  return NOTIFICATION_EVENTS[row.event_type]?.label ?? row.event_type;
}

function timeAgo(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.floor((now - then) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function NotificationBell() {
  const { rows, unreadCount, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);

  const toggle = () => {
    if (!open) {
      // Marking-read happens on close so the user can still see the
      // bold styling for the rows that were unread on open.
      setOpen(true);
    } else {
      setOpen(false);
      void markAllRead();
    }
  };

  return (
    <div className="relative">
      <button
        data-testid="notification-bell"
        onClick={toggle}
        aria-label={`Notifications (${unreadCount} unread)`}
        className="relative h-10 w-10 rounded-2xl flex items-center justify-center hover:bg-black/5"
      >
        {unreadCount > 0 ? (
          <BellRing size={18} className="text-[var(--text-primary)]" />
        ) : (
          <Bell size={18} className="text-[var(--text-secondary)]" />
        )}
        {unreadCount > 0 && (
          <span
            data-testid="notification-bell-count"
            className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full bg-rose-500 text-white text-[10px] font-medium flex items-center justify-center px-1"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div
          data-testid="notification-bell-popover"
          className="absolute right-0 top-12 w-80 max-h-96 overflow-y-auto rounded-2xl bg-white shadow-2xl border border-black/5 z-50"
        >
          <header className="sticky top-0 bg-white border-b border-black/5 px-4 py-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Notifications</h3>
            {rows.length > 0 && (
              <button
                data-testid="notification-mark-read"
                onClick={() => { void markAllRead(); }}
                className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                Mark all read
              </button>
            )}
          </header>
          {rows.length === 0 ? (
            <div className="p-6 text-sm text-[var(--text-secondary)] text-center">
              No notifications yet. We'll let you know when something happens.
            </div>
          ) : (
            <ul className="divide-y divide-black/5">
              {rows.slice(0, 10).map((r) => (
                <li
                  key={r.id}
                  data-testid="notification-row"
                  className={r.read ? "bg-white" : "bg-blue-50/40"}
                >
                  <div className="px-4 py-3">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-xs font-medium text-[var(--text-primary)]">{labelFor(r)}</span>
                      <span className="text-[10px] text-[var(--text-secondary)]">{timeAgo(r.created_at)}</span>
                    </div>
                    <div className="text-xs text-[var(--text-secondary)] leading-snug">
                      {bodyFor(r)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
