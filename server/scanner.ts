import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  ModelUsage,
  ProjectStats,
  SessionDetail,
  SessionStats,
  StatsResponse,
  SubagentStats,
  TimelineEvent,
} from "../src/types";

export function projectsRoot(): string {
  return (
    process.env.CLAUDE_PROJECTS_DIR ??
    path.join(os.homedir(), ".claude", "projects")
  );
}

// ---------- low-level parsing ----------

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

interface ParsedTranscript {
  firstTs: string | null;
  lastTs: string | null;
  title: string | null;
  lastPrompt: string | null;
  agentName: string | null;
  version: string | null;
  gitBranch: string | null;
  cwd: string | null;
  entrypoint: string | null;
  permissionModes: string[];
  records: number;
  userPrompts: number;
  toolResults: number;
  assistantMsgs: number;
  toolUses: number;
  attachments: number;
  system: number;
  apiErrors: number;
  sidechain: number;
  models: Record<string, ModelUsage>;
  toolCalls: Record<string, number>;
  recordTypes: Record<string, number>;
}

function parseTranscript(filePath: string): ParsedTranscript {
  const out: ParsedTranscript = {
    firstTs: null,
    lastTs: null,
    title: null,
    lastPrompt: null,
    agentName: null,
    version: null,
    gitBranch: null,
    cwd: null,
    entrypoint: null,
    permissionModes: [],
    records: 0,
    userPrompts: 0,
    toolResults: 0,
    assistantMsgs: 0,
    toolUses: 0,
    attachments: 0,
    system: 0,
    apiErrors: 0,
    sidechain: 0,
    models: {},
    toolCalls: {},
    recordTypes: {},
  };

  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return out;
  }

  // The same API message can appear in multiple records (streamed in chunks),
  // each repeating the usage block — count usage once per message id.
  const seenMsgIds = new Set<string>();

  // Track both title kinds separately so the latest of each wins;
  // a custom title always beats an AI-generated one.
  let customTitle: string | null = null;
  let aiTitle: string | null = null;

  for (const line of text.split("\n")) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    out.records++;
    const t = o.type ?? "unknown";
    out.recordTypes[t] = (out.recordTypes[t] || 0) + 1;

    if (o.timestamp) {
      if (!out.firstTs || o.timestamp < out.firstTs) out.firstTs = o.timestamp;
      if (!out.lastTs || o.timestamp > out.lastTs) out.lastTs = o.timestamp;
    }
    if (o.version) out.version = o.version;
    if (o.gitBranch) out.gitBranch = o.gitBranch;
    if (o.cwd) out.cwd = o.cwd;
    if (o.entrypoint) out.entrypoint = o.entrypoint;
    if (o.isSidechain) out.sidechain++;
    if (o.isApiErrorMessage) out.apiErrors++;

    switch (t) {
      case "custom-title":
        if (o.customTitle) customTitle = o.customTitle;
        break;
      case "ai-title":
        if (o.aiTitle ?? o.title) aiTitle = o.aiTitle ?? o.title;
        break;
      case "last-prompt":
        if (o.lastPrompt) out.lastPrompt = o.lastPrompt;
        break;
      case "agent-name":
        if (o.agentName) out.agentName = o.agentName;
        break;
      case "permission-mode":
        if (o.permissionMode && !out.permissionModes.includes(o.permissionMode))
          out.permissionModes.push(o.permissionMode);
        break;
      case "attachment":
        out.attachments++;
        break;
      case "system":
        out.system++;
        break;
      case "user": {
        const c = o.message?.content;
        const isToolResult =
          Array.isArray(c) && c.some((b: any) => b?.type === "tool_result");
        if (isToolResult) out.toolResults++;
        else if (!o.isMeta) out.userPrompts++;
        break;
      }
      case "assistant": {
        const m = o.message;
        if (!m) break;
        out.assistantMsgs++;
        if (Array.isArray(m.content)) {
          for (const b of m.content) {
            if (b?.type === "tool_use" && b.name) {
              out.toolUses++;
              out.toolCalls[b.name] = (out.toolCalls[b.name] || 0) + 1;
            }
          }
        }
        const model = m.model ?? "unknown";
        const u = m.usage;
        if (u && m.id && !seenMsgIds.has(m.id)) {
          seenMsgIds.add(m.id);
          const mu = (out.models[model] ??= emptyUsage());
          mu.calls++;
          mu.input += u.input_tokens || 0;
          mu.output += u.output_tokens || 0;
          mu.cacheRead += u.cache_read_input_tokens || 0;
          const cc = u.cache_creation;
          if (cc && (cc.ephemeral_5m_input_tokens || cc.ephemeral_1h_input_tokens)) {
            mu.cacheWrite5m += cc.ephemeral_5m_input_tokens || 0;
            mu.cacheWrite1h += cc.ephemeral_1h_input_tokens || 0;
          } else {
            mu.cacheWrite5m += u.cache_creation_input_tokens || 0;
          }
          mu.webSearch += u.server_tool_use?.web_search_requests || 0;
        }
        break;
      }
    }
  }
  out.title = customTitle ?? aiTitle;
  return out;
}

// ---------- session-level scanning with cache ----------

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

function scanSubagents(projDir: string, sessionId: string): SubagentStats[] {
  const dir = path.join(projDir, sessionId, "subagents");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return files.map((f) => {
    const fp = path.join(dir, f);
    return cached(fp, (): SubagentStats => {
      const p = parseTranscript(fp);
      return {
        id: f.replace(/^agent-/, "").replace(/\.jsonl$/, ""),
        file: fp,
        sizeBytes: safeSize(fp),
        firstTs: p.firstTs,
        lastTs: p.lastTs,
        assistantMsgs: p.assistantMsgs,
        userMsgs: p.userPrompts + p.toolResults,
        models: p.models,
        toolCalls: p.toolCalls,
        agentName: p.agentName,
      };
    });
  });
}

function safeSize(fp: string): number {
  try {
    return fs.statSync(fp).size;
  } catch {
    return 0;
  }
}

function scanSession(
  projName: string,
  projDir: string,
  file: string
): SessionStats {
  const fp = path.join(projDir, file);
  const id = file.replace(/\.jsonl$/, "");
  const base = cached(fp, () => {
    const p = parseTranscript(fp);
    const stats: Omit<SessionStats, "subagents"> = {
      id,
      project: projName,
      file: fp,
      sizeBytes: safeSize(fp),
      title: p.title,
      lastPrompt: p.lastPrompt,
      agentName: p.agentName,
      firstTs: p.firstTs,
      lastTs: p.lastTs,
      durationMs:
        p.firstTs && p.lastTs
          ? Date.parse(p.lastTs) - Date.parse(p.firstTs)
          : 0,
      version: p.version,
      gitBranch: p.gitBranch,
      cwd: p.cwd,
      entrypoint: p.entrypoint,
      permissionModes: p.permissionModes,
      counts: {
        records: p.records,
        userPrompts: p.userPrompts,
        toolResults: p.toolResults,
        assistantMsgs: p.assistantMsgs,
        toolUses: p.toolUses,
        attachments: p.attachments,
        system: p.system,
        apiErrors: p.apiErrors,
        sidechain: p.sidechain,
      },
      models: p.models,
      toolCalls: p.toolCalls,
      recordTypes: p.recordTypes,
    };
    return stats;
  });
  // Subagent files have their own mtime-based cache entries, so re-resolve
  // them on every scan rather than freezing them inside the session entry.
  return { ...base, subagents: scanSubagents(projDir, id) };
}

export function scanAll(): StatsResponse {
  const t0 = Date.now();
  const root = projectsRoot();
  const projects: ProjectStats[] = [];
  let projDirs: string[] = [];
  try {
    projDirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // root missing — return empty response
  }
  for (const name of projDirs) {
    const projDir = path.join(root, name);
    let files: string[];
    try {
      files = fs
        .readdirSync(projDir)
        .filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    const sessions = files.map((f) => scanSession(name, projDir, f));
    const cwds = sessions.map((s) => s.cwd).filter(Boolean) as string[];
    const displayPath = cwds.length
      ? mostCommon(cwds)
      : null;
    projects.push({ name, displayPath, sessions });
  }
  return {
    generatedAt: new Date().toISOString(),
    scanMs: Date.now() - t0,
    root,
    projects,
  };
}

function mostCommon(arr: string[]): string {
  const c = new Map<string, number>();
  let best = arr[0],
    bestN = 0;
  for (const a of arr) {
    const n = (c.get(a) || 0) + 1;
    c.set(a, n);
    if (n > bestN) {
      best = a;
      bestN = n;
    }
  }
  return best;
}

// ---------- detail (drill-down) ----------

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b?.type === "text" || b?.type === "thinking")
      .map((b: any) => b.text ?? b.thinking ?? "")
      .join(" ");
  }
  return "";
}

function timelineFromFile(filePath: string, agent?: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return events;
  }
  const seenMsgIds = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = o.timestamp ?? null;
    if (o.isApiErrorMessage) {
      events.push({ ts, kind: "error", text: String(o.error ?? "API error").slice(0, 300), agent });
      continue;
    }
    if (o.type === "user") {
      const c = o.message?.content;
      const isToolResult =
        Array.isArray(c) && c.some((b: any) => b?.type === "tool_result");
      if (isToolResult) continue; // too noisy for the timeline
      if (o.isMeta) continue;
      const txt = extractText(c).trim();
      if (txt) events.push({ ts, kind: "user", text: txt.slice(0, 500), agent });
    } else if (o.type === "assistant" && o.message) {
      const m = o.message;
      const isNewMsg = m.id && !seenMsgIds.has(m.id);
      if (m.id) seenMsgIds.add(m.id);
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b?.type === "tool_use" && b.name) {
            events.push({ ts, kind: "tool_use", tool: b.name, model: m.model, agent });
          }
        }
      }
      const txt = extractText(m.content).trim();
      if (txt || isNewMsg) {
        events.push({
          ts,
          kind: "assistant",
          model: m.model,
          text: txt.slice(0, 500),
          outputTokens: isNewMsg ? m.usage?.output_tokens ?? 0 : 0,
          inputTokens: isNewMsg ? m.usage?.input_tokens ?? 0 : 0,
          cacheRead: isNewMsg ? m.usage?.cache_read_input_tokens ?? 0 : 0,
          agent,
        });
      }
    }
  }
  return events;
}

export function sessionDetail(
  projName: string,
  sessionId: string
): SessionDetail | null {
  const root = projectsRoot();
  const projDir = path.join(root, projName);
  const fp = path.join(projDir, sessionId + ".jsonl");
  if (!fs.existsSync(fp)) return null;
  const session = scanSession(projName, projDir, sessionId + ".jsonl");
  const timeline = timelineFromFile(fp);
  for (const sub of session.subagents) {
    timeline.push(
      ...timelineFromFile(sub.file, sub.agentName ?? sub.id.slice(0, 8))
    );
  }
  timeline.sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  return { session, timeline };
}
