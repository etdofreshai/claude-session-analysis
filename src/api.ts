import type { SessionDetail, StatsResponse } from "./types";

export async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch("/api/stats");
  if (!res.ok) throw new Error(`GET /api/stats → ${res.status}`);
  return res.json();
}

export async function fetchSessionDetail(
  project: string,
  id: string,
  source?: string
): Promise<SessionDetail> {
  const params = new URLSearchParams({ project, id });
  if (source) params.set("source", source);
  const res = await fetch(`/api/session?${params.toString()}`);
  if (!res.ok) throw new Error(`GET /api/session → ${res.status}`);
  return res.json();
}
