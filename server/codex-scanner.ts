import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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

// Codex stores rollout transcripts under ~/.codex/sessions/YYYY/MM/DD/
// as rollout-*.jsonl. Records are { timestamp, type, payload } where type is
// one of: session_meta | turn_context | event_msg | response_item.
export function codexRoot(): string {
  return (
    process.env.CODEX_SESSIONS_DIR ??
    path.join(os.homedir(), ".codex", "sessions")
  );
}

function emptyUsage(): ModelUsage {
  return {
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    webSearch: 0,
  };
}

interface ParsedCodex {
  firstTs: string | null;
  lastTs: string | null;
  title: string | null;
  lastPrompt: string | null;
  cwd: string | null;
  version: string | null;
  source: string | null; // codex "source" (vscode/cli) or originator
  effortModes: string[];
  records: number;
  userPrompts: number;
  toolResults: number;
  assistantMsgs: number;
  toolUses: number;
  apiErrors: number;
  models: Record<string, ModelUsage>;
  toolCalls: Record<string, number>;
  recordTypes: Record<string, number>;
  hourlyUsage: HourlyUsage;
  dailyUsage: DailyUsage;
}

const TOOL_CALL_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "tool_search_call",
  "web_search_call",
]);
const TOOL_OUTPUT_TYPES = new Set([
  "function_call_output",
  "custom_tool_call_output",
  "tool_search_output",
]);

/**
 * Walk a JSONL transcript without loading its full contents into V8's heap.
 * Some Codex rollouts are hundreds of MB; readFileSync(..., "utf8") exceeds
 * V8's string limit for those files and silently turned them into empty
 * dashboard sessions.
 */
function forEachJsonRecord(filePath: string, visit: (record: any) => void): boolean {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return false;
  }

  const buffer = Buffer.allocUnsafe(256 * 1024);
  // Hold undecoded byte chunks until a newline, then decode exactly one whole
  // JSON record. This avoids repeated string concatenation for large embedded
  // prompt records that cross many read buffers.
  let pending: Buffer[] = [];
  const consume = (line: string) => {
    if (!line) return;
    try {
      visit(JSON.parse(line));
    } catch {
      // A partially-written or malformed JSONL line must not discard the
      // surrounding valid transcript records.
    }
  };

  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      let start = 0;
      let newline: number;
      while ((newline = buffer.indexOf(0x0a, start)) >= 0 && newline < bytes) {
        const line = buffer.subarray(start, newline);
        if (pending.length) {
          pending.push(Buffer.from(line));
          consume(Buffer.concat(pending).toString("utf8"));
          pending = [];
        } else {
          consume(line.toString("utf8"));
        }
        start = newline + 1;
      }
      if (start < bytes) pending.push(Buffer.from(buffer.subarray(start, bytes)));
    }
    if (pending.length) consume(Buffer.concat(pending).toString("utf8"));
    return true;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function parseCodexTranscript(filePath: string): ParsedCodex {
  const out: ParsedCodex = {
    firstTs: null,
    lastTs: null,
    title: null,
    lastPrompt: null,
    cwd: null,
    version: null,
    source: null,
    effortModes: [],
    records: 0,
    userPrompts: 0,
    toolResults: 0,
    assistantMsgs: 0,
    toolUses: 0,
    apiErrors: 0,
    models: {},
    toolCalls: {},
    recordTypes: {},
    hourlyUsage: {},
    dailyUsage: {},
  };

  // Model/effort are set per turn via turn_context; token usage is attributed
  // to whichever model was most recently in effect. Some older rollouts emit
  // token_count before their first turn_context. When the transcript declares
  // exactly one model, it is safe to use that model for those leading records.
  // Multi-model and declaration-free files stay explicitly "unknown".
  const declaredModels = new Set<string>();
  const leadingTokenUsage: Array<{ usage: any; ts?: string }> = [];
  let curModel = "unknown";
  const addTokenUsage = (model: string, u: any, ts?: string) => {
    const targets = [(out.models[model] ??= emptyUsage())];
    if (ts) {
      const hour = String(ts).slice(0, 13);
      const hb = (out.hourlyUsage[hour] ??= {});
      targets.push((hb[model] ??= emptyUsage()));
      const day = ctDay(ts); // "2026-06-10" in Central Time
      const db = (out.dailyUsage[day] ??= {});
      targets.push((db[model] ??= emptyUsage()));
    }
    const cached = u.cached_input_tokens || 0;
    const input = (u.input_tokens || 0) - cached;
    for (const mu of targets) {
      mu.calls++;
      mu.input += input > 0 ? input : 0;
      mu.output += u.output_tokens || 0;
      mu.cacheRead += cached;
    }
  };

  forEachJsonRecord(filePath, (o) => {
    out.records++;
    const ts: string | undefined = o.timestamp;
    if (ts) {
      if (!out.firstTs || ts < out.firstTs) out.firstTs = ts;
      if (!out.lastTs || ts > out.lastTs) out.lastTs = ts;
    }

    const p = o.payload ?? {};
    const kind = o.type;

    if (kind === "session_meta") {
      out.cwd = p.cwd ?? out.cwd;
      out.version = p.cli_version ?? out.version;
      out.source = sourceLabel(p.source) ?? sourceLabel(p.originator) ?? out.source;
      return;
    }

    if (kind === "turn_context") {
      if (typeof p.model === "string") {
        declaredModels.add(p.model);
        curModel = p.model;
      }
      const effort =
        p.collaboration_mode?.settings?.reasoning_effort ??
        p.reasoning_effort;
      if (effort && !out.effortModes.includes(effort))
        out.effortModes.push(effort);
      return;
    }

    if (kind === "event_msg") {
      const pt = p.type;
      out.recordTypes[pt] = (out.recordTypes[pt] || 0) + 1;
      switch (pt) {
        case "user_message": {
          out.userPrompts++;
          const msg = (p.message ?? "").trim();
          if (msg) {
            if (!out.title) out.title = msg.slice(0, 200);
            out.lastPrompt = msg.slice(0, 500);
          }
          break;
        }
        case "agent_message":
          out.assistantMsgs++;
          break;
        case "turn_aborted":
          out.apiErrors++;
          break;
        case "token_count": {
          const u = p.info?.last_token_usage;
          if (u) {
            if (curModel === "unknown") leadingTokenUsage.push({ usage: u, ts });
            else addTokenUsage(curModel, u, ts);
          }
          break;
        }
      }
      return;
    }

    if (kind === "response_item") {
      const pt = p.type;
      out.recordTypes[pt] = (out.recordTypes[pt] || 0) + 1;
      if (TOOL_CALL_TYPES.has(pt)) {
        out.toolUses++;
        const name =
          p.name ??
          (pt === "web_search_call"
            ? "web_search"
            : pt === "tool_search_call"
            ? "tool_search"
            : pt);
        out.toolCalls[name] = (out.toolCalls[name] || 0) + 1;
      } else if (TOOL_OUTPUT_TYPES.has(pt)) {
        out.toolResults++;
      }
      return;
    }
  });

  const leadingModel = declaredModels.size === 1 ? [...declaredModels][0] : "unknown";
  for (const { usage, ts } of leadingTokenUsage)
    addTokenUsage(leadingModel, usage, ts);

  // Keep only the trailing 48h of hourly buckets (relative to last activity).
  if (out.lastTs) {
    const cutoff = Date.parse(out.lastTs) - 48 * 3600_000;
    for (const hour of Object.keys(out.hourlyUsage)) {
      if (Date.parse(hour + ":00:00Z") < cutoff) delete out.hourlyUsage[hour];
    }
  }
  return out;
}

// ---------- caching (mtime + size) ----------

interface CacheEntry {
  mtimeMs: number;
  size: number;
  value: any;
}
const cache = new Map<string, CacheEntry>();

function cached<T>(filePath: string, compute: () => T): T {
  let st: fs.Stats;
  try {
    st = fs.statSync(filePath);
  } catch {
    return compute();
  }
  const hit = cache.get(filePath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size)
    return hit.value as T;
  const value = compute();
  cache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

function safeSize(fp: string): number {
  try {
    return fs.statSync(fp).size;
  } catch {
    return 0;
  }
}

// Walk YYYY/MM/DD and return every rollout-*.jsonl path.
function listRolloutFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (
        e.isFile() &&
        e.name.startsWith("rollout-") &&
        e.name.endsWith(".jsonl")
      )
        files.push(full);
    }
  };
  walk(root, 0);
  return files;
}

// Session id is the trailing UUID of the rollout filename.
function idFromFile(file: string): string {
  const base = path.basename(file).replace(/\.jsonl$/, "");
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? m[1] : base.replace(/^rollout-/, "");
}

// Codex "source" is a plain string ("vscode", "cli") in older CLIs; newer
// CLIs emit an object for subagent-spawned threads, e.g.
// {"subagent":{"thread_spawn":{"agent_nickname":"Sagan","agent_role":"explorer",…}}}.
// Reduce either shape to a display string so objects never reach the UI.
function sourceLabel(src: unknown): string | null {
  if (typeof src === "string") return src;
  if (src && typeof src === "object") {
    const spawn = (src as any).subagent?.thread_spawn;
    const name = spawn?.agent_nickname ?? spawn?.agent_role;
    if (name) return `subagent:${name}`;
    return Object.keys(src)[0] ?? null;
  }
  return null;
}

function projectNameFromCwd(cwd: string | null, id: string): string {
  if (!cwd) return "codex:unknown";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

function scanCodexSession(file: string, host: string): SessionStats {
  return cached(file, () => {
    const p = parseCodexTranscript(file);
    const id = idFromFile(file);
    const stats: SessionStats = {
      id,
      host,
      project: projectNameFromCwd(p.cwd, id),
      file,
      source: "codex",
      sizeBytes: safeSize(file),
      title: p.title,
      lastPrompt: p.lastPrompt,
      agentName: p.source,
      firstTs: p.firstTs,
      lastTs: p.lastTs,
      durationMs:
        p.firstTs && p.lastTs
          ? Date.parse(p.lastTs) - Date.parse(p.firstTs)
          : 0,
      version: p.version,
      gitBranch: null,
      cwd: p.cwd,
      entrypoint: p.source,
      permissionModes: [],
      effortModes: p.effortModes,
      counts: {
        records: p.records,
        userPrompts: p.userPrompts,
        toolResults: p.toolResults,
        assistantMsgs: p.assistantMsgs,
        toolUses: p.toolUses,
        attachments: 0,
        system: 0,
        apiErrors: p.apiErrors,
        sidechain: 0,
      },
      models: p.models,
      toolCalls: p.toolCalls,
      subagents: [],
      recordTypes: p.recordTypes,
      hourlyUsage: p.hourlyUsage,
      dailyUsage: p.dailyUsage,
    };
    return stats;
  });
}

// Group codex sessions into ProjectStats by their cwd (so they sit alongside
// Claude projects in the same UI).
export function scanCodexAll(root = codexRoot(), host = "local"): ProjectStats[] {
  const files = listRolloutFiles(root);
  const byProject = new Map<string, SessionStats[]>();
  for (const f of files) {
    const s = scanCodexSession(f, host);
    const arr = byProject.get(s.project) ?? [];
    arr.push(s);
    byProject.set(s.project, arr);
  }
  const projects: ProjectStats[] = [];
  for (const [name, sessions] of byProject) {
    const cwds = sessions.map((s) => s.cwd).filter(Boolean) as string[];
    projects.push({
      name: `codex:${name}`,
      host,
      displayPath: cwds[0] ?? null,
      sessions,
    });
  }
  return projects;
}

// ---------- detail (drill-down) ----------

function codexTimeline(filePath: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return events;
  }
  let curModel: string | undefined;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = o.timestamp ?? null;
    const p = o.payload ?? {};
    if (o.type === "turn_context" && p.model) {
      curModel = p.model;
      continue;
    }
    if (o.type === "event_msg") {
      const pt = p.type;
      if (pt === "user_message") {
        const txt = String(p.message ?? "").trim();
        if (txt) events.push({ ts, kind: "user", text: txt.slice(0, 500) });
      } else if (pt === "agent_message") {
        const txt = String(p.message ?? "").trim();
        if (txt)
          events.push({
            ts,
            kind: "assistant",
            model: curModel,
            text: txt.slice(0, 500),
          });
      } else if (pt === "turn_aborted") {
        events.push({ ts, kind: "error", text: "turn aborted" });
      }
    } else if (o.type === "response_item") {
      const pt = p.type;
      if (TOOL_CALL_TYPES.has(pt)) {
        const name =
          p.name ?? (pt === "web_search_call" ? "web_search" : pt);
        events.push({ ts, kind: "tool_use", tool: name, model: curModel });
      } else if (pt === "reasoning") {
        const txt = Array.isArray(p.summary)
          ? p.summary.map((s: any) => s?.text ?? "").join(" ").trim()
          : "";
        if (txt)
          events.push({ ts, kind: "assistant", model: curModel, text: txt.slice(0, 500) });
      }
    }
  }
  return events;
}

export function codexSessionDetail(
  sessionId: string,
  root = codexRoot(),
  host = "local"
): SessionDetail | null {
  const files = listRolloutFiles(root);
  const file = files.find((f) => idFromFile(f) === sessionId);
  if (!file) return null;
  const session = scanCodexSession(file, host);
  const timeline = codexTimeline(file);
  timeline.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  return { session, timeline };
}
