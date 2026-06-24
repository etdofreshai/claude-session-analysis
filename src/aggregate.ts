import type { HourlyUsage, ModelUsage, SessionStats, StatsResponse } from "./types";
import type { PricingTable } from "./pricing";
import { dayCT, modelsCost, usageCost } from "./pricing";

export type RangeKey = "1w" | "1m" | "3m" | "6m" | "1y" | "all";

/** Overview lookback ranges. days=null means all-time. */
export const RANGES: { key: RangeKey; label: string; days: number | null }[] = [
  { key: "1w", label: "1W", days: 7 },
  { key: "1m", label: "1M", days: 30 },
  { key: "3m", label: "3M", days: 91 },
  { key: "6m", label: "6M", days: 182 },
  { key: "1y", label: "1Y", days: 365 },
  { key: "all", label: "All", days: null },
];

/** First Central-Time day (YYYY-MM-DD) included by a range, or null for all-time. */
export function rangeFromDay(days: number | null, now: number): string | null {
  if (days == null) return null;
  return dayCT(new Date(now - days * 86_400_000).toISOString());
}

export interface FlatSession extends SessionStats {
  projectDisplay: string;
  cost: number;
  subagentCost: number;
  totalTokensAll: number;
  /** Estimated cost (session + subagents) in the trailing hour */
  costLastHour: number;
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

/** model→usage merged across only the days of `s` on/after fromDay (null = all). */
export function windowedUsage(
  s: SessionStats,
  fromDay: string | null
): Record<string, ModelUsage> {
  if (!fromDay) return allUsage(s);
  const daily = allDailyUsage(s);
  const days = Object.keys(daily);
  if (days.length === 0) {
    // Degenerate transcript with no per-day usage: attribute to its
    // last-activity day, included only if that day falls in the window.
    const ts = s.lastTs ?? s.firstTs;
    return ts && dayCT(ts) >= fromDay ? allUsage(s) : {};
  }
  const merged: Record<string, ModelUsage> = {};
  for (const [day, models] of Object.entries(daily))
    if (day >= fromDay) mergeUsage(merged, models);
  return merged;
}

/** Did `s` have any activity on/after fromDay (null = always true)? */
export function sessionInWindow(s: SessionStats, fromDay: string | null): boolean {
  if (!fromDay) return true;
  const days = Object.keys(allDailyUsage(s));
  if (days.length) return days.some((d) => d >= fromDay);
  const ts = s.lastTs ?? s.firstTs;
  return ts ? dayCT(ts) >= fromDay : false;
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
 * Overview header totals scoped to a window. Cost/tokens are day-accurate (only
 * the in-window days of each session count); the message/tool COUNTS are
 * whole-session (no per-day breakdown exists) for every session active in the
 * window. The trailing-hour cost is intentionally excluded — it's a
 * window-independent live metric computed separately by the caller.
 */
export function windowTotals(
  sessions: FlatSession[],
  pricing: PricingTable,
  fromDay: string | null = null
): WindowTotals {
  const t: WindowTotals = {
    cost: 0, allTok: 0, prompts: 0, asst: 0,
    subagents: 0, errors: 0, toolUses: 0, sessions: 0,
  };
  for (const s of sessions) {
    if (!sessionInWindow(s, fromDay)) continue;
    const u = windowedUsage(s, fromDay);
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

export interface DayAgg {
  day: string; // YYYY-MM-DD
  cost: number;
  output: number;
  sessions: number;
  byModel: Record<string, number>; // cost
}

export function byDay(sessions: FlatSession[], pricing: PricingTable, fromDay: string | null = null): DayAgg[] {
  const map = new Map<string, DayAgg>();
  const dayAgg = (day: string): DayAgg => {
    let agg = map.get(day);
    if (!agg) {
      agg = { day, cost: 0, output: 0, sessions: 0, byModel: {} };
      map.set(day, agg);
    }
    return agg;
  };
  const addUsage = (day: string, models: Record<string, ModelUsage>) => {
    const agg = dayAgg(day);
    for (const [m, u] of Object.entries(models)) {
      const c = usageCost(m, u, pricing);
      agg.cost += c;
      agg.output += u.output;
      agg.byModel[m] = (agg.byModel[m] || 0) + c;
    }
  };
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
      addUsage(day, allUsage(s));
      dayAgg(day).sessions++;
      continue;
    }
    for (const [day, models] of Object.entries(daily)) {
      if (fromDay && day < fromDay) continue;
      addUsage(day, models);
    }
    for (const day of days) {
      if (fromDay && day < fromDay) continue;
      dayAgg(day).sessions++;
    }
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function costByModel(sessions: FlatSession[], pricing: PricingTable, fromDay: string | null = null) {
  const map = new Map<string, { model: string; cost: number; tokens: number; calls: number }>();
  for (const s of sessions) {
    for (const [m, u] of Object.entries(windowedUsage(s, fromDay))) {
      let e = map.get(m);
      if (!e) {
        e = { model: m, cost: 0, tokens: 0, calls: 0 };
        map.set(m, e);
      }
      e.cost += usageCost(m, u, pricing);
      e.tokens += u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
      e.calls += u.calls;
    }
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

export function costByProject(
  sessions: FlatSession[],
  pricing: PricingTable,
  fromDay: string | null = null
) {
  const map = new Map<string, { project: string; cost: number; sessions: number }>();
  for (const s of sessions) {
    if (!sessionInWindow(s, fromDay)) continue;
    let e = map.get(s.projectDisplay);
    if (!e) {
      e = { project: s.projectDisplay, cost: 0, sessions: 0 };
      map.set(s.projectDisplay, e);
    }
    e.cost += modelsCost(windowedUsage(s, fromDay), pricing);
    e.sessions++;
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

export function topTools(sessions: FlatSession[], n = 15, fromDay: string | null = null) {
  const map = new Map<string, number>();
  for (const s of sessions) {
    if (!sessionInWindow(s, fromDay)) continue;
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

const FALLBACK_COLORS = ["#ff7eb6", "#82cfff", "#ffd166", "#06d6a0", "#b39ddb", "#ef9a9a"];

export function modelColor(model: string, i = 0): string {
  return MODEL_COLORS[model] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length];
}
