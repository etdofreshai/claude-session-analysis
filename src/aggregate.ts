import type { HourlyUsage, ModelUsage, SessionStats, StatsResponse } from "./types";
import type { PricingTable } from "./pricing";
import { dayCT, modelsCost, usageCost, usageCostParts } from "./pricing";

export type RangeKey = "1w" | "1m" | "3m" | "6m" | "1y" | "all";
export type HourRangeKey = "6h" | "12h" | "24h" | "48h" | "120h" | "168h";
export type Granularity = "day" | "hour";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Daily lookback ranges (windowMs=null means all-time). */
export const RANGES: { key: RangeKey; label: string; windowMs: number | null }[] = [
  { key: "1w", label: "1W", windowMs: 7 * DAY_MS },
  { key: "1m", label: "1M", windowMs: 30 * DAY_MS },
  { key: "3m", label: "3M", windowMs: 91 * DAY_MS },
  { key: "6m", label: "6M", windowMs: 182 * DAY_MS },
  { key: "1y", label: "1Y", windowMs: 365 * DAY_MS },
  { key: "all", label: "All", windowMs: null },
];

/** Hourly lookback ranges (all finite). 120h = 5 days, 168h = 1 week. */
export const HOUR_RANGES: { key: HourRangeKey; label: string; windowMs: number }[] = [
  { key: "6h", label: "6H", windowMs: 6 * HOUR_MS },
  { key: "12h", label: "12H", windowMs: 12 * HOUR_MS },
  { key: "24h", label: "24H", windowMs: 24 * HOUR_MS },
  { key: "48h", label: "48H", windowMs: 48 * HOUR_MS },
  { key: "120h", label: "120H", windowMs: 120 * HOUR_MS },
  { key: "168h", label: "1W", windowMs: 168 * HOUR_MS },
];

export interface FlatSession extends SessionStats {
  projectDisplay: string;
  cost: number;
  subagentCost: number;
  totalTokensAll: number;
  /** Estimated cost (session + subagents) in the trailing hour */
  costLastHour: number;
}

/** Stable identity for a session across hosts and agent data sources. */
export function sessionIdentity(
  session: Pick<SessionStats, "host" | "source" | "project" | "id">
): string {
  return [session.host, session.source, session.project, session.id].join("\u0000");
}

/**
 * Cost of hourly buckets intersecting [now - windowMs, now]. Buckets that
 * partially overlap the window are weighted by overlap fraction (activity
 * is assumed uniform within an hour — fine for a monitoring estimate).
 */
export function windowCost(
  hourly: HourlyUsage,
  pricing: PricingTable,
  windowMs: number,
  now: number
): number {
  const from = now - windowMs;
  let cost = 0;
  for (const [hour, models] of Object.entries(hourly)) {
    const start = Date.parse(hour + ":00:00Z");
    if (Number.isNaN(start)) continue;
    const end = start + 3600_000;
    const overlap = Math.min(end, now) - Math.max(start, from);
    if (overlap <= 0) continue;
    const weight = Math.min(1, overlap / 3600_000);
    for (const [m, u] of Object.entries(models)) {
      cost += usageCost(m, u, pricing) * weight;
    }
  }
  return cost;
}

export function shortProject(name: string, displayPath: string | null): string {
  if (displayPath) {
    const parts = displayPath.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || name;
  }
  return name;
}

export function mergeUsage(into: Record<string, ModelUsage>, from: Record<string, ModelUsage>) {
  for (const [m, u] of Object.entries(from)) {
    const t = (into[m] ??= {
      calls: 0, input: 0, output: 0, cacheRead: 0,
      cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0,
    });
    t.calls += u.calls;
    t.input += u.input;
    t.output += u.output;
    t.cacheRead += u.cacheRead;
    t.cacheWrite5m += u.cacheWrite5m;
    t.cacheWrite1h += u.cacheWrite1h;
    t.webSearch += u.webSearch;
  }
}

/** Session + subagent usage merged into one map */
export function allUsage(s: SessionStats): Record<string, ModelUsage> {
  const merged: Record<string, ModelUsage> = {};
  mergeUsage(merged, s.models);
  for (const sub of s.subagents) mergeUsage(merged, sub.models);
  return merged;
}

/** Session + subagent usage merged per Central-Time day: day -> model -> usage */
export function allDailyUsage(s: SessionStats): Record<string, Record<string, ModelUsage>> {
  const byDayMap: Record<string, Record<string, ModelUsage>> = {};
  const add = (daily: Record<string, Record<string, ModelUsage>> | undefined) => {
    for (const [day, models] of Object.entries(daily ?? {}))
      mergeUsage((byDayMap[day] ??= {}), models);
  };
  add(s.dailyUsage);
  for (const sub of s.subagents) add(sub.dailyUsage);
  return byDayMap;
}

/** Start-of-hour epoch ms for an hourly bucket key "YYYY-MM-DDTHH" (UTC). */
export function hourStartMs(hourKey: string): number {
  return Date.parse(hourKey + ":00:00Z");
}

/** Session + subagent usage merged per UTC hour: "YYYY-MM-DDTHH" -> model -> usage */
export function allHourlyUsage(s: SessionStats): HourlyUsage {
  const merged: HourlyUsage = {};
  const add = (h: HourlyUsage | undefined) => {
    for (const [hr, models] of Object.entries(h ?? {}))
      mergeUsage((merged[hr] ??= {}), models);
  };
  add(s.hourlyUsage);
  for (const sub of s.subagents) add(sub.hourlyUsage);
  return merged;
}

/**
 * model→usage merged across only the hourly buckets of `s` that start on/after
 * fromMs (null = all time). Hourly buckets are the finest data we keep, so this
 * windows precisely to the hour for both the daily and hourly views.
 */
export function windowedUsage(
  s: SessionStats,
  fromMs: number | null
): Record<string, ModelUsage> {
  if (fromMs == null) return allUsage(s);
  // Fast reject: if the session's last activity predates the window, no bucket
  // can qualify — skip building its hourly map.
  const last = s.lastTs ? Date.parse(s.lastTs) : NaN;
  if (!Number.isNaN(last) && last < fromMs) return {};
  const hourly = allHourlyUsage(s);
  const keys = Object.keys(hourly);
  if (keys.length === 0) {
    // Degenerate transcript with no per-hour usage: attribute to its
    // last-activity time, included only if it falls in the window.
    const ts = s.lastTs ?? s.firstTs;
    return ts && Date.parse(ts) >= fromMs ? allUsage(s) : {};
  }
  const merged: Record<string, ModelUsage> = {};
  for (const [hr, models] of Object.entries(hourly))
    if (hourStartMs(hr) >= fromMs) mergeUsage(merged, models);
  return merged;
}

/** Did `s` have any activity on/after fromMs (null = always true)? */
export function sessionInWindow(s: SessionStats, fromMs: number | null): boolean {
  if (fromMs == null) return true;
  const last = s.lastTs ? Date.parse(s.lastTs) : NaN;
  if (!Number.isNaN(last) && last < fromMs) return false;
  const keys = Object.keys(allHourlyUsage(s));
  if (keys.length) return keys.some((hr) => hourStartMs(hr) >= fromMs);
  const ts = s.lastTs ?? s.firstTs;
  return ts ? Date.parse(ts) >= fromMs : false;
}

export interface WindowTotals {
  cost: number;
  allTok: number;
  prompts: number;
  asst: number;
  subagents: number;
  errors: number;
  toolUses: number;
  sessions: number;
}

/**
 * Overview header totals scoped to a window. Cost/tokens are hour-accurate (only
 * the in-window hourly buckets of each session count); the message/tool COUNTS
 * are whole-session (no per-hour breakdown exists) for every session active in
 * the window. The trailing-hour cost is intentionally excluded — it's a
 * window-independent live metric computed separately by the caller.
 */
export function windowTotals(
  sessions: FlatSession[],
  pricing: PricingTable,
  fromMs: number | null = null
): WindowTotals {
  const t: WindowTotals = {
    cost: 0, allTok: 0, prompts: 0, asst: 0,
    subagents: 0, errors: 0, toolUses: 0, sessions: 0,
  };
  for (const s of sessions) {
    if (!sessionInWindow(s, fromMs)) continue;
    const u = windowedUsage(s, fromMs);
    t.cost += modelsCost(u, pricing);
    for (const m of Object.values(u))
      t.allTok += m.input + m.output + m.cacheRead + m.cacheWrite5m + m.cacheWrite1h;
    t.prompts += s.counts.userPrompts;
    t.asst += s.counts.assistantMsgs;
    t.subagents += s.subagents.length;
    t.errors += s.counts.apiErrors;
    t.toolUses += s.counts.toolUses;
    t.sessions++;
  }
  return t;
}

export function flatten(stats: StatsResponse, pricing: PricingTable): FlatSession[] {
  const out: FlatSession[] = [];
  const now = Date.now();
  for (const p of stats.projects) {
    const disp = shortProject(p.name, p.displayPath);
    for (const s of p.sessions) {
      const cost = modelsCost(s.models, pricing);
      let subagentCost = 0;
      for (const sub of s.subagents) subagentCost += modelsCost(sub.models, pricing);
      const merged = allUsage(s);
      let totalTokensAll = 0;
      for (const u of Object.values(merged))
        totalTokensAll += u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
      let costLastHour = windowCost(s.hourlyUsage, pricing, 3600_000, now);
      for (const sub of s.subagents)
        costLastHour += windowCost(sub.hourlyUsage, pricing, 3600_000, now);
      out.push({ ...s, projectDisplay: disp, cost, subagentCost, totalTokensAll, costLastHour });
    }
  }
  return out;
}

export interface BucketAgg {
  key: string;    // sort key: "YYYY-MM-DD" (day) or "YYYY-MM-DDTHH" (hour, UTC)
  label: string;  // x-axis display: "MM-DD" (day) or "MM-DD HH:00" (hour, CT)
  cost: number;
  output: number;
  sessions: number;
  byModel: Record<string, { cache: number; input: number; output: number }>;
}

// Central-Time formatter for hourly bucket labels.
const hourFmtCT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
});
function hourLabelCT(ms: number): string {
  const p = hourFmtCT.formatToParts(new Date(ms));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${get("month")}-${get("day")} ${get("hour")}:00`;
}

function makeBucketer(pricing: PricingTable) {
  const map = new Map<string, BucketAgg>();
  const bucket = (key: string, label: string): BucketAgg => {
    let agg = map.get(key);
    if (!agg) {
      agg = { key, label, cost: 0, output: 0, sessions: 0, byModel: {} };
      map.set(key, agg);
    }
    return agg;
  };
  const addUsage = (key: string, label: string, models: Record<string, ModelUsage>) => {
    const agg = bucket(key, label);
    for (const [m, u] of Object.entries(models)) {
      const parts = usageCostParts(m, u, pricing);
      const c = parts.cache + parts.input + parts.output;
      agg.cost += c;
      agg.output += u.output;
      const model = (agg.byModel[m] ??= { cache: 0, input: 0, output: 0 });
      model.cache += parts.cache;
      model.input += parts.input;
      model.output += parts.output;
    }
  };
  const result = () => [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  return { bucket, addUsage, result };
}

/** Per-Central-Time-day cost by model, for days whose data starts on/after fromMs. */
export function byDay(
  sessions: FlatSession[],
  pricing: PricingTable,
  fromMs: number | null = null
): BucketAgg[] {
  const fromDay = fromMs == null ? null : dayCT(new Date(fromMs).toISOString());
  const b = makeBucketer(pricing);
  for (const s of sessions) {
    // Attribute each day's cost to the day it actually happened, spreading a
    // multi-day session across all the days it ran instead of dumping its whole
    // lifetime cost onto its last-activity day.
    const daily = allDailyUsage(s);
    const days = Object.keys(daily);
    if (days.length === 0) {
      // No timestamped usage (degenerate transcript) — fall back to the
      // session's last-activity day so its cost isn't dropped entirely.
      const ts = s.lastTs ?? s.firstTs;
      if (!ts) continue;
      const day = dayCT(ts);
      if (fromDay && day < fromDay) continue;
      b.addUsage(day, day.slice(5), allUsage(s));
      b.bucket(day, day.slice(5)).sessions++;
      continue;
    }
    for (const [day, models] of Object.entries(daily)) {
      if (fromDay && day < fromDay) continue;
      b.addUsage(day, day.slice(5), models);
    }
    for (const day of days) {
      if (fromDay && day < fromDay) continue;
      b.bucket(day, day.slice(5)).sessions++;
    }
  }
  return b.result();
}

/** Per-hour cost by model, for hourly buckets starting on/after fromMs. */
export function byHour(
  sessions: FlatSession[],
  pricing: PricingTable,
  fromMs: number | null = null
): BucketAgg[] {
  const b = makeBucketer(pricing);
  for (const s of sessions) {
    const last = s.lastTs ? Date.parse(s.lastTs) : NaN;
    if (fromMs != null && !Number.isNaN(last) && last < fromMs) continue;
    const hourly = allHourlyUsage(s);
    for (const [hr, models] of Object.entries(hourly)) {
      const start = hourStartMs(hr);
      if (Number.isNaN(start)) continue;
      if (fromMs != null && start < fromMs) continue;
      const label = hourLabelCT(start);
      b.addUsage(hr, label, models);
      b.bucket(hr, label).sessions++;
    }
  }
  return b.result();
}

export function costByModel(sessions: FlatSession[], pricing: PricingTable, fromMs: number | null = null) {
  const map = new Map<string, {
    model: string;
    cost: number;
    cacheCost: number;
    inputCost: number;
    outputCost: number;
    tokens: number;
    calls: number;
  }>();
  for (const s of sessions) {
    for (const [m, u] of Object.entries(windowedUsage(s, fromMs))) {
      let e = map.get(m);
      if (!e) {
        e = {
          model: m, cost: 0, cacheCost: 0, inputCost: 0,
          outputCost: 0, tokens: 0, calls: 0,
        };
        map.set(m, e);
      }
      const parts = usageCostParts(m, u, pricing);
      e.cacheCost += parts.cache;
      e.inputCost += parts.input;
      e.outputCost += parts.output;
      e.cost += parts.cache + parts.input + parts.output;
      e.tokens += u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
      e.calls += u.calls;
    }
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

export function costByProject(
  sessions: FlatSession[],
  pricing: PricingTable,
  fromMs: number | null = null
) {
  const map = new Map<string, { project: string; cost: number; sessions: number }>();
  for (const s of sessions) {
    if (!sessionInWindow(s, fromMs)) continue;
    let e = map.get(s.projectDisplay);
    if (!e) {
      e = { project: s.projectDisplay, cost: 0, sessions: 0 };
      map.set(s.projectDisplay, e);
    }
    e.cost += modelsCost(windowedUsage(s, fromMs), pricing);
    e.sessions++;
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

export function topTools(sessions: FlatSession[], n = 15, fromMs: number | null = null) {
  const map = new Map<string, number>();
  for (const s of sessions) {
    if (!sessionInWindow(s, fromMs)) continue;
    for (const [tool, c] of Object.entries(s.toolCalls))
      map.set(tool, (map.get(tool) || 0) + c);
    for (const sub of s.subagents)
      for (const [tool, c] of Object.entries(sub.toolCalls))
        map.set(tool, (map.get(tool) || 0) + c);
  }
  return [...map.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

export const MODEL_COLORS: Record<string, string> = {
  "claude-opus-4-8": "#e8714a",
  "claude-opus-4-7": "#d4543a",
  "claude-opus-4-6": "#b8432f",
  "claude-fable-5": "#9d6bff",
  "claude-sonnet-4-6": "#4aa3e8",
  "claude-sonnet-4-5": "#3a8ad4",
  "claude-haiku-4-5": "#4ae8b0",
  "glm-5.1": "#e8d44a",
  "gpt-5.5": "#5ee84a",
  "<synthetic>": "#777",
};

/**
 * Semantic model-family colors. These are checked after exact model entries so
 * provider-qualified and future versioned variants keep the same visual identity.
 */
export const SEMANTIC_MODEL_COLORS = {
  sol: "#f4a62a",      // warm sunlight / amber
  luna: "#a9bddb",     // cool moonlight / silver blue
  terra: "#4f9a6d",    // living earth / forest green
  ox: "#9b4a3c",       // oxblood / hide brown-red
  spark: "#f4df32",    // electric spark / lemon yellow
} as const;

const FALLBACK_COLORS = ["#ff7eb6", "#82cfff", "#ffd166", "#06d6a0", "#b39ddb", "#ef9a9a"];

export function modelColor(model: string, i = 0): string {
  const exact = MODEL_COLORS[model];
  if (exact) return exact;

  const normalized = model.toLowerCase();
  if (normalized === "x-preview-f-free" || normalized.includes("/x-preview-f-free"))
    return SEMANTIC_MODEL_COLORS.ox;
  if (/(?:^|[-/])spark(?:$|[-/])/.test(normalized))
    return SEMANTIC_MODEL_COLORS.spark;
  if (/(?:^|[-/])sol(?:$|[-/])/.test(normalized))
    return SEMANTIC_MODEL_COLORS.sol;
  if (/(?:^|[-/])luna(?:$|[-/])/.test(normalized))
    return SEMANTIC_MODEL_COLORS.luna;
  if (/(?:^|[-/])terra(?:$|[-/])/.test(normalized))
    return SEMANTIC_MODEL_COLORS.terra;

  return FALLBACK_COLORS[i % FALLBACK_COLORS.length];
}
