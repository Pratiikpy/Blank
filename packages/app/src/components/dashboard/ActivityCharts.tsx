"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  format,
  subDays,
  startOfDay,
  isSameDay,
} from "date-fns";
import { BarChart3, PieChart as PieChartIcon } from "lucide-react";
import type { ActivityRow } from "@/lib/supabase";

// ─── Constants ────────────────────────────────────────────────────────

const DAYS = 10;

const TYPE_COLORS: Record<string, string> = {
  payment: "#34d399",
  request: "#60a5fa",
  tip: "#f472b6",
  invoice: "#a78bfa",
  group: "#fb923c",
};

const FALLBACK_COLOR = "#525252";

const BAR_FILL = "#34d399";
const BAR_HOVER_FILL = "#6ee7b7";

// ─── Data Processing ──────────────────────────────────────────────────

interface DayBucket {
  date: Date;
  label: string;
  count: number;
}

interface TypeBucket {
  name: string;
  value: number;
  color: string;
}

function buildDayBuckets(activities: ActivityRow[]): DayBucket[] {
  const now = new Date();
  const buckets: DayBucket[] = [];

  for (let i = DAYS - 1; i >= 0; i--) {
    const day = startOfDay(subDays(now, i));
    buckets.push({
      date: day,
      label: format(day, "EEE"),
      count: 0,
    });
  }

  for (const a of activities) {
    const actDate = new Date(a.created_at);
    const bucket = buckets.find((b) => isSameDay(b.date, actDate));
    if (bucket) bucket.count += 1;
  }

  return buckets;
}

function resolveTypeKey(activityType: string): string {
  if (activityType.startsWith("invoice")) return "invoice";
  if (activityType.startsWith("group")) return "group";
  if (activityType.startsWith("request")) return "request";
  if (activityType === "payment" || activityType === "tip") return activityType;
  return "other";
}

function buildTypeBuckets(activities: ActivityRow[]): TypeBucket[] {
  const counts = new Map<string, number>();

  for (const a of activities) {
    const key = resolveTypeKey(a.activity_type);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([name, value]) => ({
      name,
      value,
      color: TYPE_COLORS[name] ?? FALLBACK_COLOR,
    }))
    .sort((a, b) => b.value - a.value);
}

// ─── Custom Tooltips ──────────────────────────────────────────────────

const tooltipContainerClass = [
  "bg-[#0a0a0c]/95 border border-white/[0.06]",
  "backdrop-blur-xl rounded-xl p-3 shadow-2xl",
].join(" ");

interface BarTooltipPayloadEntry {
  value: number;
  payload: DayBucket;
}

interface BarTooltipProps {
  active?: boolean;
  payload?: BarTooltipPayloadEntry[];
}

function BarTooltip({ active, payload }: BarTooltipProps) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  const dateLabel = format(entry.payload.date, "EEE, MMM d");
  return (
    <div className={tooltipContainerClass}>
      <p className="text-[11px] text-neutral-400 mb-1">{dateLabel}</p>
      <p className="text-sm font-semibold text-white">
        {entry.value} transaction{entry.value !== 1 ? "s" : ""}
      </p>
    </div>
  );
}

interface DonutTooltipPayloadEntry {
  name: string;
  value: number;
  payload: TypeBucket;
}

interface DonutTooltipProps {
  active?: boolean;
  payload?: DonutTooltipPayloadEntry[];
}

function DonutTooltip({ active, payload }: DonutTooltipProps) {
  if (!active || !payload?.length) return null;
  const entry = payload[0];
  return (
    <div className={tooltipContainerClass}>
      <div className="flex items-center gap-2 mb-1">
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: entry.payload.color }}
        />
        <span className="text-[11px] text-neutral-400 capitalize">
          {entry.name}
        </span>
      </div>
      <p className="text-sm font-semibold text-white">
        {entry.value} transaction{entry.value !== 1 ? "s" : ""}
      </p>
    </div>
  );
}

// ─── Section Label ────────────────────────────────────────────────────

function SectionLabel({
  icon: Icon,
  text,
}: {
  icon: typeof BarChart3;
  text: string;
}) {
  return (
    <div className="flex items-center gap-1.5 mb-4">
      <Icon className="w-3.5 h-3.5 text-neutral-600" />
      <span className="text-[10px] uppercase tracking-widest text-neutral-500 font-medium">
        {text}
      </span>
    </div>
  );
}

// ─── Glass Card Wrapper ───────────────────────────────────────────────

function ChartCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={[
        "bg-white/[0.02] border border-white/[0.04] rounded-2xl p-5",
        "backdrop-blur-xl",
      ].join(" ")}
    >
      {children}
    </div>
  );
}

// ─── Empty State ──────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="col-span-full flex flex-col items-center justify-center py-16 text-center">
      <BarChart3 className="w-8 h-8 text-neutral-700 mb-3" />
      <p className="text-sm text-neutral-500">No activity data yet</p>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────

interface ActivityChartsProps {
  activities: ActivityRow[];
}

export function ActivityCharts({ activities }: ActivityChartsProps) {
  const dayData = useMemo(() => buildDayBuckets(activities), [activities]);
  const typeData = useMemo(() => buildTypeBuckets(activities), [activities]);
  const total = useMemo(
    () => typeData.reduce((sum, t) => sum + t.value, 0),
    [typeData],
  );

  if (activities.length === 0) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* ── Bar Chart ── */}
      <ChartCard>
        <SectionLabel icon={BarChart3} text="Activity (10 days)" />
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={dayData}
              margin={{ top: 4, right: 4, bottom: 0, left: 4 }}
            >
              <CartesianGrid
                horizontal
                vertical={false}
                stroke="rgba(255,255,255,0.04)"
              />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{
                  fill: "#525252",
                  fontSize: 11,
                }}
                dy={8}
              />
              <Tooltip
                content={<BarTooltip />}
                cursor={{ fill: "rgba(255,255,255,0.03)", radius: 4 }}
              />
              <Bar
                dataKey="count"
                fill={BAR_FILL}
                radius={[4, 4, 0, 0]}
                maxBarSize={32}
                activeBar={{ fill: BAR_HOVER_FILL }}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </ChartCard>

      {/* ── Donut Chart ── */}
      <ChartCard>
        <SectionLabel icon={PieChartIcon} text="By Type" />
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={typeData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={80}
                paddingAngle={2}
                strokeWidth={0}
              >
                {typeData.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip content={<DonutTooltip />} />
              {/* Render center label via a custom SVG layer */}
            </PieChart>
          </ResponsiveContainer>

          {/* Center label overlay (absolute positioning) */}
          <div className="relative">
            <div
              className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none"
              style={{ marginTop: "-200px", height: "200px" }}
            >
              <span
                className="text-2xl font-bold text-white"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                {total}
              </span>
              <span className="text-[10px] uppercase tracking-widest text-neutral-500">
                total
              </span>
            </div>
          </div>
        </div>
      </ChartCard>
    </div>
  );
}
