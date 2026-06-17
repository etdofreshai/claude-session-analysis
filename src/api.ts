import type { SessionDetail, StatsResponse } from "./types";

export async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch("/api/stats");
  if (!res.ok) throw new Error(`GET /api/stats → ${res.status}`);
  return res.json();
}

export async function fetchSessionDetail(
  project: string,
  id: string,
  source?: string,
  host?: string
): Promise<SessionDetail> {
  const params = new URLSearchParams({ project, id });
  if (source) params.set("source", source);
  if (host) params.set("host", host);
  const res = await fetch(`/api/session?${params.toString()}`);
  if (!res.ok) throw new Error(`GET /api/session → ${res.status}`);
  return res.json();
}
