import type { HourlyUsage, ModelUsage, SessionStats, StatsResponse } from "./types";
import type { PricingTable } from "./pricing";
import { dayCT, modelsCost, usageCost } from "./pricing";

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

export function byDay(sessions: FlatSession[], pricing: PricingTable): DayAgg[] {
  const map = new Map<string, DayAgg>();
  for (const s of sessions) {
    const ts = s.lastTs ?? s.firstTs;
    if (!ts) continue;
    const day = dayCT(ts);
    let agg = map.get(day);
    if (!agg) {
      agg = { day, cost: 0, output: 0, sessions: 0, byModel: {} };
      map.set(day, agg);
    }
    agg.sessions++;
    const merged = allUsage(s);
    for (const [m, u] of Object.entries(merged)) {
      const c = usageCost(m, u, pricing);
      agg.cost += c;
      agg.output += u.output;
      agg.byModel[m] = (agg.byModel[m] || 0) + c;
    }
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function costByModel(sessions: FlatSession[], pricing: PricingTable) {
  const map = new Map<string, { model: string; cost: number; tokens: number; calls: number }>();
  for (const s of sessions) {
    for (const [m, u] of Object.entries(allUsage(s))) {
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

export function costByProject(sessions: FlatSession[]) {
  const map = new Map<string, { project: string; cost: number; sessions: number }>();
  for (const s of sessions) {
    let e = map.get(s.projectDisplay);
    if (!e) {
      e = { project: s.projectDisplay, cost: 0, sessions: 0 };
      map.set(s.projectDisplay, e);
    }
    e.cost += s.cost + s.subagentCost;
    e.sessions++;
  }
  return [...map.values()].sort((a, b) => b.cost - a.cost);
}

export function topTools(sessions: FlatSession[], n = 15) {
  const map = new Map<string, number>();
  for (const s of sessions) {
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
