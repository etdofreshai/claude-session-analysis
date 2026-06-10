import type { SessionDetail, StatsResponse } from "./types";

export async function fetchStats(): Promise<StatsResponse> {
  const res = await fetch("/api/stats");
  if (!res.ok) throw new Error(`GET /api/stats → ${res.status}`);
  return res.json();
}

export async function fetchSessionDetail(
  project: string,
  id: string
): Promise<SessionDetail> {
  const res = await fetch(
    `/api/session?project=${encodeURIComponent(project)}&id=${encodeURIComponent(id)}`
  );
  if (!res.ok) throw new Error(`GET /api/session → ${res.status}`);
  return res.json();
}
