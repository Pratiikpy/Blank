import { useMemo } from "react";
import { Link } from "react-router-dom";
import {
  Shield,
  Users,
  UserCheck,
  DollarSign,
  FileText,
  PackageCheck,
  ArrowRight,
  Inbox,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useMyRoles, type MyRole, roleKey } from "@/hooks/useMyRoles";
import { truncateAddress } from "@/lib/address";
import { cn } from "@/lib/cn";

/**
 * "Roles assigned to you" panel — a compact list of every designation the
 * connected user currently holds: arbiter, heir, group member, pending payer,
 * escrow beneficiary. Surfaces roles the user might otherwise miss because
 * they never visited the relevant screen.
 *
 * Render inline in the Dashboard sidebar or pop inside a modal behind a
 * notification-bell badge. Clicking a role navigates to its screen AND
 * marks it seen so the unread count drops.
 */
interface MyRolesPanelProps {
  /** Called after the user taps a row — hosts close the modal with this. */
  onNavigate?: () => void;
  /** Hide the "Mark all seen" footer (useful when rendered inline). */
  hideMarkAll?: boolean;
  className?: string;
}

interface RolePresentation {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  to: string;
  badgeTone: "emerald" | "amber" | "violet" | "blue" | "rose";
}

function presentRole(r: MyRole): RolePresentation {
  switch (r.kind) {
    case "arbiter":
      return {
        icon: Shield,
        title: `Arbiter · Escrow #${r.escrowId}`,
        subtitle: `${truncateAddress(r.depositor)} named you arbiter${
          r.description ? ` · "${r.description}"` : ""
        }`,
        to: "/app/business",
        badgeTone: "violet",
      };
    case "escrow_beneficiary":
      return {
        icon: PackageCheck,
        title: `Escrow · mark delivered`,
        subtitle: `${truncateAddress(r.depositor)} is paying you${
          r.description ? ` · "${r.description}"` : ""
        }`,
        to: "/app/business",
        badgeTone: "emerald",
      };
    case "heir":
      return {
        icon: UserCheck,
        title: "Heir designation",
        subtitle: `${truncateAddress(r.principal)} named you as heir`,
        to: "/app/inheritance",
        badgeTone: "blue",
      };
    case "group_member":
      return {
        icon: Users,
        title: r.groupName || `Group #${r.groupId}`,
        subtitle: "You are a member of this group",
        to: "/app/groups",
        badgeTone: "emerald",
      };
    case "invoice_pending":
      return {
        icon: FileText,
        title: `Invoice #${r.invoiceId} · pending`,
        subtitle: `${truncateAddress(r.vendor)} sent you an invoice${
          r.description ? ` · "${r.description}"` : ""
        }`,
        to: "/app/business",
        badgeTone: "amber",
      };
    case "request_pending":
      return {
        icon: DollarSign,
        title: `Payment request · pending`,
        subtitle: `${truncateAddress(r.requester)} requested payment${
          r.note ? ` · "${r.note}"` : ""
        }`,
        to: "/app/requests",
        badgeTone: "rose",
      };
  }
}

const toneClass: Record<RolePresentation["badgeTone"], string> = {
  emerald: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  violet: "bg-violet-50 text-violet-600",
  blue: "bg-blue-50 text-blue-600",
  rose: "bg-rose-50 text-rose-600",
};

export function MyRolesPanel({
  onNavigate,
  hideMarkAll,
  className,
}: MyRolesPanelProps) {
  const { roles, unreadCount, loading, markAllSeen, markSeen } = useMyRoles();

  const entries = useMemo(
    () => roles.map((r) => ({ role: r, key: roleKey(r), view: presentRole(r) })),
    [roles],
  );

  return (
    <div
      className={cn(
        "glass-card-static rounded-[2rem] p-6 space-y-4",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-label text-[var(--text-secondary)]">
            ROLES ASSIGNED TO YOU
          </p>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            {roles.length === 0
              ? loading
                ? "Checking your designations..."
                : "No active roles yet"
              : `${roles.length} role${roles.length === 1 ? "" : "s"}${
                  unreadCount > 0 ? ` · ${unreadCount} new` : ""
                }`}
          </p>
        </div>
        {!hideMarkAll && unreadCount > 0 && (
          <button
            onClick={markAllSeen}
            className="h-9 px-3 rounded-full bg-white/60 dark:bg-white/5 border border-black/5 dark:border-white/10 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            aria-label="Mark all roles as seen"
          >
            Mark all seen
          </button>
        )}
      </div>

      {loading && roles.length === 0 ? (
        <div className="space-y-2" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-16 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04] animate-pulse"
            />
          ))}
        </div>
      ) : roles.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <div className="w-12 h-12 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04] flex items-center justify-center">
            <Inbox size={22} className="text-[var(--text-tertiary)]" />
          </div>
          <p className="text-sm text-[var(--text-tertiary)] max-w-xs">
            Anyone who names you as arbiter, heir, group member, or sends you an
            invoice or request will show up here.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {entries.map(({ role, key, view }) => {
            const Icon = view.icon;
            return (
              <li key={key}>
                <Link
                  to={view.to}
                  onClick={() => {
                    markSeen(role);
                    onNavigate?.();
                  }}
                  className="flex items-center gap-3 p-3 rounded-2xl hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors group"
                >
                  <div
                    className={cn(
                      "w-10 h-10 rounded-2xl flex items-center justify-center flex-shrink-0",
                      toneClass[view.badgeTone],
                    )}
                  >
                    <Icon size={18} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                      {view.title}
                    </p>
                    <p className="text-xs text-[var(--text-tertiary)] truncate">
                      {view.subtitle}
                    </p>
                  </div>
                  <ArrowRight
                    size={16}
                    className="text-[var(--text-tertiary)] group-hover:text-[var(--text-primary)] transition-colors flex-shrink-0"
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default MyRolesPanel;
