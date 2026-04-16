import toast from "react-hot-toast";
import { insertActivity, type ActivityRow } from "./supabase";
import { log } from "./log";

type ActivityPayload = Omit<ActivityRow, "id" | "created_at">;

interface FanoutResult {
  successes: number;
  failures: number;
  errors: Array<{ tx_hash: string; error: string }>;
}

/**
 * Insert N activity rows in parallel using Promise.allSettled.
 * Unlike a sequential await-loop that halts on first failure, this
 * guarantees every recipient gets a chance even if some fail.
 *
 * Use for fanout flows — payroll, gift splits, group expenses — where
 * partial Supabase sync is far better than halted-at-first-failure.
 *
 * On any failure: structured log via lib/log so Sentry captures it.
 * Returns a summary the caller can use for a "sent N, X failed" toast.
 */
export async function insertActivitiesFanout(
  activities: ActivityPayload[],
  opts?: { userToastOnFailure?: boolean; context?: string },
): Promise<FanoutResult> {
  const results = await Promise.allSettled(
    activities.map((a) => insertActivity(a)),
  );

  const successes = results.filter((r) => r.status === "fulfilled").length;
  const failed = results
    .map((r, i) => ({ r, a: activities[i] }))
    .filter((x) => x.r.status === "rejected");

  const errors = failed.map(({ r, a }) => ({
    tx_hash: a.tx_hash,
    error:
      r.status === "rejected"
        ? r.reason instanceof Error
          ? r.reason.message
          : String(r.reason)
        : "",
  }));

  if (errors.length > 0) {
    log.warn("activity-fanout.partial", {
      context: opts?.context,
      total: activities.length,
      successes,
      failures: errors.length,
      sampleErrors: errors.slice(0, 3),
    });

    if (opts?.userToastOnFailure) {
      toast(
        `${successes}/${activities.length} activity rows synced — ${errors.length} failed (will retry)`,
        { icon: "\u26A0\uFE0F", duration: 6000 }, // warning sign
      );
    }
  }

  return { successes, failures: errors.length, errors };
}
