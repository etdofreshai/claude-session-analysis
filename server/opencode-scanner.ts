import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ctDay } from "./ct-day";
import type {
  DailyUsage,
  HourlyUsage,
  ModelUsage,
  ProjectStats,
  SessionDetail,
  SessionStats,
  SubagentStats,
  TimelineEvent,
} from "../src/types";

// OpenCode 1.x stores sessions in its XDG data directory.
export function opencodeDbPath(): string {
  return path.join(
    process.env.OPENCODE_DATA_DIR ?? path.join(os.homedir(), ".local", "share", "opencode"),
    "opencode.db"
  );
}

interface SessionRow {
  id: string; parent_id: string | null; directory: string; title: string;
  version: string; agent: string | null; model: string | null;
  time_created: number; time_updated: number;
}
interface MessageRow {
  id: string; session_id: string; time_created: number; time_updated: number; data: string;
}
interface PartRow {
  session_id: string; message_id: string; time_created: number; time_updated: number;
  type: string | null; tool: string | null; status: string | null; text: string | null;
}

function emptyUsage(): ModelUsage {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 };
}

function addUsage(
  models: Record<string, ModelUsage>, hourly: HourlyUsage, daily: DailyUsage,
  model: string, tokens: any, ts: string
) {
  const targets = [(models[model] ??= emptyUsage())];
  targets.push(((hourly[ts.slice(0, 13)] ??= {})[model] ??= emptyUsage()));
  targets.push(((daily[ctDay(ts)] ??= {})[model] ??= emptyUsage()));
  for (const u of targets) {
    u.calls++;
    u.input += Number(tokens?.input ?? 0);
    u.output += Number(tokens?.output ?? 0);
    u.cacheRead += Number(tokens?.cache?.read ?? 0);
    u.cacheWrite5m += Number(tokens?.cache?.write ?? 0);
  }
}

function iso(ms: number | null | undefined): string | null {
  return ms && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function projectFromCwd(cwd: string | null): string {
  if (!cwd) return "opencode:unknown";
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

function dbSignature(dbPath: string): string | null {
  try {
    return [dbPath, dbPath + "-wal"].map((file) => {
      try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; }
      catch { return "missing"; }
    }).join("|");
  } catch { return null; }
}

interface OpenCodeScan {
  projects: ProjectStats[];
  byId: Map<string, SessionStats>;
  children: Map<string, string[]>;
}
interface ScanCache { signature: string; host: string; value: OpenCodeScan }
const cache = new Map<string, ScanCache>();

function queryRows(db: DatabaseSync) {
  const sessions = db.prepare(`
    select id, parent_id, directory, title, version, agent, model,
           time_created, time_updated from session
  `).all() as unknown as SessionRow[];
  const messages = db.prepare(`
    select id, session_id, time_created, time_updated, data from message
    order by session_id, time_created, id
  `).all() as unknown as MessageRow[];
  const parts = db.prepare(`
    select session_id, message_id, time_created, time_updated,
           json_extract(data, '$.type') as type,
           json_extract(data, '$.tool') as tool,
           json_extract(data, '$.state.status') as status,
           json_extract(data, '$.text') as text
      from part order by session_id, time_created, id
  `).all() as unknown as PartRow[];
  return { sessions, messages, parts };
}

function childStats(s: SessionStats): SubagentStats {
  return {
    id: s.id, host: s.host, file: s.file, sizeBytes: s.sizeBytes,
    firstTs: s.firstTs, lastTs: s.lastTs, assistantMsgs: s.counts.assistantMsgs,
    userMsgs: s.counts.userPrompts + s.counts.toolResults, models: s.models,
    toolCalls: s.toolCalls, agentName: s.agentName, hourlyUsage: s.hourlyUsage,
    dailyUsage: s.dailyUsage,
  };
}

function buildScan(dbPath: string, host: string): OpenCodeScan {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows: ReturnType<typeof queryRows>;
  try { rows = queryRows(db); } finally { db.close(); }

  const messagesBySession = new Map<string, MessageRow[]>();
  const messageData = new Map<string, any>();
  for (const m of rows.messages) {
    (messagesBySession.get(m.session_id) ?? messagesBySession.set(m.session_id, []).get(m.session_id)!).push(m);
    try { messageData.set(m.id, JSON.parse(m.data)); } catch { messageData.set(m.id, {}); }
  }
  const partsBySession = new Map<string, PartRow[]>();
  for (const p of rows.parts)
    (partsBySession.get(p.session_id) ?? partsBySession.set(p.session_id, []).get(p.session_id)!).push(p);

  const byId = new Map<string, SessionStats>();
  const children = new Map<string, string[]>();
  for (const row of rows.sessions) {
    if (row.parent_id) {
      const ids = children.get(row.parent_id) ?? [];
      ids.push(row.id);
      children.set(row.parent_id, ids);
    }
    const messages = messagesBySession.get(row.id) ?? [];
    const parts = partsBySession.get(row.id) ?? [];
    const models: Record<string, ModelUsage> = {};
    const hourlyUsage: HourlyUsage = {};
    const dailyUsage: DailyUsage = {};
    const toolCalls: Record<string, number> = {};
    const recordTypes: Record<string, number> = {};
    let userPrompts = 0, assistantMsgs = 0, apiErrors = 0;
    let firstMs = row.time_created, lastMs = row.time_updated;
    let lastPrompt: string | null = null;
    const roles = new Map<string, string>();
    for (const m of messages) {
      const data = messageData.get(m.id) ?? {};
      const role = String(data.role ?? "unknown");
      roles.set(m.id, role);
      recordTypes[`message:${role}`] = (recordTypes[`message:${role}`] ?? 0) + 1;
      firstMs = Math.min(firstMs, m.time_created);
      lastMs = Math.max(lastMs, m.time_updated, Number(data.time?.completed ?? 0));
      if (role === "user") userPrompts++;
      if (role === "assistant") {
        assistantMsgs++;
        const model = String(data.modelID ?? "unknown");
        const ts = iso(Number(data.time?.created ?? m.time_created))!;
        if (data.tokens) addUsage(models, hourlyUsage, dailyUsage, model, data.tokens, ts);
        if (data.error) apiErrors++;
      }
    }
    let toolUses = 0, toolResults = 0;
    for (const p of parts) {
      const type = String(p.type ?? "unknown");
      recordTypes[type] = (recordTypes[type] ?? 0) + 1;
      firstMs = Math.min(firstMs, p.time_created);
      lastMs = Math.max(lastMs, p.time_updated);
      if (type === "tool") {
        toolUses++;
        const name = String(p.tool ?? "tool");
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
        if (p.status === "completed" || p.status === "error") toolResults++;
        if (p.status === "error") apiErrors++;
      }
      if (type === "text" && roles.get(p.message_id) === "user" && p.text?.trim())
        lastPrompt = p.text.trim().slice(0, 500);
    }
    let variant: string | null = null;
    if (row.model) {
      try { variant = JSON.parse(row.model)?.variant ?? null; } catch { /* old plain value */ }
    }
    if (lastMs && Object.keys(hourlyUsage).length) {
      const cutoff = lastMs - 48 * 3_600_000;
      for (const hour of Object.keys(hourlyUsage))
        if (Date.parse(hour + ":00:00Z") < cutoff) delete hourlyUsage[hour];
    }
    const cwd = row.directory || null;
    const session: SessionStats = {
      id: row.id, host, project: projectFromCwd(cwd), file: dbPath, source: "opencode",
      sizeBytes: 0, title: row.title || null, lastPrompt, agentName: row.agent,
      firstTs: iso(firstMs), lastTs: iso(lastMs), durationMs: Math.max(0, lastMs - firstMs),
      version: row.version || null, gitBranch: null, cwd, entrypoint: row.agent ?? "opencode",
      permissionModes: [], effortModes: variant && variant !== "default" ? [variant] : [],
      counts: {
        records: messages.length + parts.length, userPrompts, toolResults, assistantMsgs,
        toolUses, attachments: 0, system: 0, apiErrors, sidechain: row.parent_id ? 1 : 0,
      },
      models, toolCalls, subagents: [], recordTypes, hourlyUsage, dailyUsage,
    };
    byId.set(row.id, session);
  }

  for (const [parentId, ids] of children) {
    const parent = byId.get(parentId);
    if (parent) parent.subagents = ids.map((id) => byId.get(id)).filter(Boolean).map((s) => childStats(s!));
  }
  const grouped = new Map<string, SessionStats[]>();
  for (const row of rows.sessions) {
    if (row.parent_id) continue;
    const session = byId.get(row.id)!;
    const sessions = grouped.get(session.project) ?? [];
    sessions.push(session);
    grouped.set(session.project, sessions);
  }
  const projects = [...grouped].map(([name, sessions]) => ({
    name: `opencode:${name}`, host, displayPath: sessions.find((s) => s.cwd)?.cwd ?? null, sessions,
  }));
  return { projects, byId, children };
}

function scan(dbPath: string, host: string): OpenCodeScan {
  const signature = dbSignature(dbPath);
  const hit = cache.get(dbPath);
  if (!signature) return { projects: [], byId: new Map(), children: new Map() };
  if (hit && hit.signature === signature && hit.host === host) return hit.value;
  try {
    const value = buildScan(dbPath, host);
    cache.set(dbPath, { signature, host, value });
    return value;
  } catch {
    // A background rsync may briefly replace the DB and WAL at different
    // instants. Keep serving the last internally-consistent snapshot.
    return hit?.value ?? { projects: [], byId: new Map(), children: new Map() };
  }
}

export function scanOpenCodeAll(dbPath = opencodeDbPath(), host = "local"): ProjectStats[] {
  return scan(dbPath, host).projects;
}

function timelineFor(db: DatabaseSync, sessionId: string, agent?: string): TimelineEvent[] {
  const messages = db.prepare(`
    select id, time_created, data from message where session_id = ? order by time_created, id
  `).all(sessionId) as unknown as Pick<MessageRow, "id" | "time_created" | "data">[];
  const parts = db.prepare(`
    select message_id, time_created,
           json_extract(data, '$.type') as type,
           json_extract(data, '$.tool') as tool,
           json_extract(data, '$.state.status') as status,
           json_extract(data, '$.text') as text
      from part where session_id = ? order by time_created, id
  `).all(sessionId) as unknown as Pick<PartRow, "message_id" | "time_created" | "type" | "tool" | "status" | "text">[];
  const dataByMessage = new Map<string, any>();
  for (const m of messages) {
    try { dataByMessage.set(m.id, JSON.parse(m.data)); } catch { dataByMessage.set(m.id, {}); }
  }
  const events: TimelineEvent[] = [];
  for (const p of parts) {
    const data = dataByMessage.get(p.message_id) ?? {};
    const ts = iso(Number(data.time?.created ?? p.time_created));
    if ((p.type === "text" || p.type === "reasoning") && p.text?.trim()) {
      events.push({
        ts, kind: data.role === "user" ? "user" : "assistant",
        model: data.role === "assistant" ? data.modelID : undefined,
        text: p.text.trim().slice(0, 500),
        outputTokens: data.role === "assistant" ? Number(data.tokens?.output ?? 0) : undefined,
        inputTokens: data.role === "assistant" ? Number(data.tokens?.input ?? 0) : undefined,
        cacheRead: data.role === "assistant" ? Number(data.tokens?.cache?.read ?? 0) : undefined,
        agent,
      });
    } else if (p.type === "tool") {
      events.push({ ts, kind: p.status === "error" ? "error" : "tool_use", tool: p.tool ?? "tool", model: data.modelID, agent });
    }
  }
  return events;
}

export function opencodeSessionDetail(
  sessionId: string, dbPath = opencodeDbPath(), host = "local"
): SessionDetail | null {
  const snapshot = scan(dbPath, host);
  const session = snapshot.byId.get(sessionId);
  if (!session) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const timeline: TimelineEvent[] = [];
  try {
    timeline.push(...timelineFor(db, sessionId));
    for (const childId of snapshot.children.get(sessionId) ?? []) {
      const child = snapshot.byId.get(childId);
      timeline.push(...timelineFor(db, childId, child?.agentName ?? childId.slice(0, 8)));
    }
  } finally { db.close(); }
  timeline.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  return { session, timeline };
}
