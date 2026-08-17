import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ctDay } from "./ct-day";
import type {
  DailyUsage,
  HourlyUsage,
  ModelUsage,
  ProjectStats,
  SessionDetail,
  SessionStats,
  TimelineEvent,
} from "../src/types";

// Pi stores one JSONL transcript per session under
// ~/.pi/agent/sessions/<encoded-cwd>/*.jsonl.
export function piRoot(): string {
  return process.env.PI_SESSIONS_DIR ?? path.join(os.homedir(), ".pi", "agent", "sessions");
}

function emptyUsage(): ModelUsage {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0 };
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => String(b.text ?? ""))
    .join("\n")
    .trim();
}

function addUsage(
  models: Record<string, ModelUsage>,
  hourly: HourlyUsage,
  daily: DailyUsage,
  model: string,
  usage: any,
  ts: string | null
) {
  const targets = [(models[model] ??= emptyUsage())];
  if (ts) {
    targets.push(((hourly[ts.slice(0, 13)] ??= {})[model] ??= emptyUsage()));
    targets.push(((daily[ctDay(ts)] ??= {})[model] ??= emptyUsage()));
  }
  for (const u of targets) {
    u.calls++;
    u.input += Number(usage?.input ?? usage?.input_tokens ?? 0);
    u.output += Number(usage?.output ?? usage?.output_tokens ?? 0);
    u.cacheRead += Number(usage?.cacheRead ?? usage?.cache_read_input_tokens ?? 0);
    u.cacheWrite5m += Number(usage?.cacheWrite ?? usage?.cache_creation_input_tokens ?? 0);
  }
}

interface ParsedPi {
  id: string;
  version: string | null;
  cwd: string | null;
  firstTs: string | null;
  lastTs: string | null;
  title: string | null;
  lastPrompt: string | null;
  records: number;
  userPrompts: number;
  toolResults: number;
  assistantMsgs: number;
  toolUses: number;
  attachments: number;
  apiErrors: number;
  models: Record<string, ModelUsage>;
  toolCalls: Record<string, number>;
  recordTypes: Record<string, number>;
  effortModes: string[];
  hourlyUsage: HourlyUsage;
  dailyUsage: DailyUsage;
}

function parsePi(file: string): ParsedPi {
  const out: ParsedPi = {
    id: path.basename(file, ".jsonl"), version: null, cwd: null,
    firstTs: null, lastTs: null, title: null, lastPrompt: null,
    records: 0, userPrompts: 0, toolResults: 0, assistantMsgs: 0,
    toolUses: 0, attachments: 0, apiErrors: 0, models: {}, toolCalls: {},
    recordTypes: {}, effortModes: [], hourlyUsage: {}, dailyUsage: {},
  };
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    out.records++;
    const type = String(o.type ?? "unknown");
    out.recordTypes[type] = (out.recordTypes[type] ?? 0) + 1;
    const ts = String(o.timestamp ?? o.message?.timestamp ?? "") || null;
    if (ts && (!out.firstTs || ts < out.firstTs)) out.firstTs = ts;
    if (ts && (!out.lastTs || ts > out.lastTs)) out.lastTs = ts;
    if (type === "session") {
      out.id = String(o.id ?? out.id);
      out.version = o.version != null ? String(o.version) : out.version;
      out.cwd = typeof o.cwd === "string" ? o.cwd : out.cwd;
    } else if (type === "thinking_level_change") {
      const effort = String(o.thinkingLevel ?? "");
      if (effort && !out.effortModes.includes(effort)) out.effortModes.push(effort);
    } else if (type === "message") {
      const m = o.message ?? {};
      const role = m.role;
      if (role === "user") {
        out.userPrompts++;
        const prompt = textContent(m.content);
        if (prompt) {
          if (!out.title) out.title = prompt.slice(0, 200);
          out.lastPrompt = prompt.slice(0, 500);
        }
        if (Array.isArray(m.content))
          out.attachments += m.content.filter((b: any) => b?.type === "image").length;
      } else if (role === "assistant") {
        out.assistantMsgs++;
        const model = String(m.model ?? "unknown");
        if (m.usage) addUsage(out.models, out.hourlyUsage, out.dailyUsage, model, m.usage, ts);
        if (m.stopReason === "error" || m.error) out.apiErrors++;
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b?.type !== "toolCall" && b?.type !== "tool_use") continue;
            const name = String(b.name ?? b.toolName ?? "tool");
            out.toolUses++;
            out.toolCalls[name] = (out.toolCalls[name] ?? 0) + 1;
          }
        }
      } else if (role === "toolResult") {
        out.toolResults++;
        if (m.isError) out.apiErrors++;
      }
    }
  }
  if (out.lastTs) {
    const cutoff = Date.parse(out.lastTs) - 48 * 3_600_000;
    for (const hour of Object.keys(out.hourlyUsage))
      if (Date.parse(hour + ":00:00Z") < cutoff) delete out.hourlyUsage[hour];
  }
  return out;
}

interface CacheEntry { mtimeMs: number; size: number; value: SessionStats }
const cache = new Map<string, CacheEntry>();

function projectFromCwd(cwd: string | null): string {
  if (!cwd) return "pi:unknown";
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

function scanPiSession(file: string, host: string): SessionStats {
  let st: fs.Stats | null = null;
  try { st = fs.statSync(file); } catch { /* parsed below as empty */ }
  const hit = cache.get(file);
  if (st && hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  const p = parsePi(file);
  const value: SessionStats = {
    id: p.id, host, project: projectFromCwd(p.cwd), file, source: "pi",
    sizeBytes: st?.size ?? 0, title: p.title, lastPrompt: p.lastPrompt,
    agentName: null, firstTs: p.firstTs, lastTs: p.lastTs,
    durationMs: p.firstTs && p.lastTs ? Date.parse(p.lastTs) - Date.parse(p.firstTs) : 0,
    version: p.version, gitBranch: null, cwd: p.cwd, entrypoint: "pi",
    permissionModes: [], effortModes: p.effortModes,
    counts: {
      records: p.records, userPrompts: p.userPrompts, toolResults: p.toolResults,
      assistantMsgs: p.assistantMsgs, toolUses: p.toolUses, attachments: p.attachments,
      system: 0, apiErrors: p.apiErrors, sidechain: 0,
    },
    models: p.models, toolCalls: p.toolCalls, subagents: [], recordTypes: p.recordTypes,
    hourlyUsage: p.hourlyUsage, dailyUsage: p.dailyUsage,
  };
  if (st) cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

function listPiFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(root, 0);
  return files;
}

export function scanPiAll(root = piRoot(), host = "local"): ProjectStats[] {
  const grouped = new Map<string, SessionStats[]>();
  for (const file of listPiFiles(root)) {
    const session = scanPiSession(file, host);
    const sessions = grouped.get(session.project) ?? [];
    sessions.push(session);
    grouped.set(session.project, sessions);
  }
  return [...grouped].map(([name, sessions]) => ({
    name: `pi:${name}`, host, displayPath: sessions.find((s) => s.cwd)?.cwd ?? null, sessions,
  }));
}

function piTimeline(file: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return events; }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== "message") continue;
    const m = o.message ?? {};
    const ts = o.timestamp ?? m.timestamp ?? null;
    if (m.role === "user") {
      const value = textContent(m.content);
      if (value) events.push({ ts, kind: "user", text: value.slice(0, 500) });
    } else if (m.role === "assistant") {
      const value = textContent(m.content);
      events.push({
        ts, kind: m.error ? "error" : "assistant", model: m.model,
        text: value.slice(0, 500), inputTokens: m.usage?.input ?? 0,
        outputTokens: m.usage?.output ?? 0, cacheRead: m.usage?.cacheRead ?? 0,
      });
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === "toolCall" || b?.type === "tool_use")
          events.push({ ts, kind: "tool_use", tool: b.name ?? b.toolName ?? "tool", model: m.model });
      }
    } else if (m.role === "toolResult" && m.isError) {
      events.push({ ts, kind: "error", text: textContent(m.content).slice(0, 500) });
    }
  }
  return events;
}

export function piSessionDetail(sessionId: string, root = piRoot(), host = "local"): SessionDetail | null {
  const file = listPiFiles(root).find((f) => scanPiSession(f, host).id === sessionId);
  if (!file) return null;
  return { session: scanPiSession(file, host), timeline: piTimeline(file) };
}
