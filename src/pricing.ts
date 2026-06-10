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
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 },
  "claude-fable-5": { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  "claude-haiku-4": { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  "glm-": { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gpt-": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 0, cacheWrite1h: 0 },
  "codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite5m: 0, cacheWrite1h: 0 },
  "gemini-": { input: 2, output: 12, cacheRead: 0.2, cacheWrite5m: 0, cacheWrite1h: 0 },
  "<synthetic>": { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  "*": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
};

const STORAGE_KEY = "csa-pricing-v1";

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
  const p = pricingFor(model, table);
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.cacheRead +
      u.cacheWrite5m * p.cacheWrite5m +
      u.cacheWrite1h * p.cacheWrite1h) /
    1_000_000
  );
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
