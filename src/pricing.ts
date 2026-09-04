import type { ModelUsage } from "./types";

/** USD per million tokens */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export type PricingTable = Record<string, ModelPricing>;

/**
 * Defaults are editable in the Pricing tab (persisted to localStorage).
 * Matching is by longest prefix, so "claude-opus-4" covers 4-6/4-7/4-8
 * unless a more specific row exists.
 */
export const DEFAULT_PRICING: PricingTable = {
  // Anthropic standard API rates (USD / 1M tokens, 2026-08).
  "claude-opus-4": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  // deprecated Opus 4.1 / 4.0 kept the old tier
  "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 },
  "claude-opus-4-2": { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  "claude-haiku-4": { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  "glm-": { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite5m: 0, cacheWrite1h: 0 },
  // Official OpenAI Codex / ChatGPT Work rates (USD / 1M tokens).
  // Astra: 2026-09 rate card. Codex does not charge for cache writes.
  // Keep exact model rows above the generic gpt- legacy fallback.
  "gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gpt-5.6-terra": { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gpt-5.6-luna": { input: 1, output: 6, cacheRead: 0.1, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gpt-": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 0, cacheWrite1h: 0 },
  "codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gemini-": { input: 2, output: 12, cacheRead: 0.2, cacheWrite5m: 0, cacheWrite1h: 0 },
  "<synthetic>": { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  "*": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
};

const STORAGE_KEY = "csa-pricing-v2";

export function loadPricing(): PricingTable {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_PRICING, ...JSON.parse(raw) };
  } catch {
    /* fall through */
  }
  return { ...DEFAULT_PRICING };
}

export function savePricing(table: PricingTable) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(table));
}

export function resetPricing() {
  localStorage.removeItem(STORAGE_KEY);
}

export function pricingFor(model: string, table: PricingTable): ModelPricing {
  let best: string | null = null;
  for (const key of Object.keys(table)) {
    if (key === "*") continue;
    if (model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return table[best ?? "*"] ?? DEFAULT_PRICING["*"];
}

export function usageCost(model: string, u: ModelUsage, table: PricingTable): number {
  const parts = usageCostParts(model, u, table);
  return parts.cache + parts.input + parts.output;
}

/** Cost split used by charts to give cache, fresh input, and output distinct shades. */
export function usageCostParts(
  model: string,
  u: ModelUsage,
  table: PricingTable
): { cache: number; input: number; output: number } {
  const p = pricingFor(model, table);
  return {
    cache:
      (u.cacheRead * p.cacheRead +
        u.cacheWrite5m * p.cacheWrite5m +
        u.cacheWrite1h * p.cacheWrite1h) /
      1_000_000,
    input: (u.input * p.input) / 1_000_000,
    output: (u.output * p.output) / 1_000_000,
  };
}

export function modelsCost(
  models: Record<string, ModelUsage>,
  table: PricingTable
): number {
  return Object.entries(models).reduce(
    (sum, [m, u]) => sum + usageCost(m, u, table),
    0
  );
}

export function totalTokens(u: ModelUsage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
}

export function fmtUsd(n: number): string {
  if (n >= 100) return "$" + n.toFixed(0);
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toFixed(3);
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export const DISPLAY_TZ = "America/Chicago";

const dateTimeFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
const timeFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: DISPLAY_TZ,
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TZ,
  year: "numeric", month: "2-digit", day: "2-digit",
});

/** "2026-06-10 11:31" in Central Time */
export function fmtDateTimeCT(ts: string | null): string {
  if (!ts) return "";
  return dateTimeFmt.format(new Date(ts)).replace(",", "");
}

/** "11:31:05" in Central Time */
export function fmtTimeCT(ts: string | null): string {
  if (!ts) return "";
  return timeFmt.format(new Date(ts));
}

/** "2026-06-10" in Central Time (for daily bucketing) */
export function dayCT(ts: string): string {
  return dayFmt.format(new Date(ts));
}

export function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60);
  if (h < 48) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}
