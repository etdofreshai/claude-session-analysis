// Shared between the Vite middleware (server/) and the React app (src/).

export interface ModelUsage {
  /** API calls attributed to this model (deduped by message id) */
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearch: number;
}

/**
 * Token usage bucketed by UTC hour ("2026-06-10T16") and model.
 * Only the trailing 48h of a transcript is kept — enough for rolling
 * "recent cost" windows without bloating the payload. Untouched files
 * can't have recent activity, so mtime caching stays correct.
 */
export type HourlyUsage = Record<string, Record<string, ModelUsage>>;

export interface SubagentStats {
  id: string;
  file: string;
  sizeBytes: number;
  firstTs: string | null;
  lastTs: string | null;
  assistantMsgs: number;
  userMsgs: number;
  models: Record<string, ModelUsage>;
  toolCalls: Record<string, number>;
  agentName: string | null;
  hourlyUsage: HourlyUsage;
}

export interface SessionCounts {
  records: number;
  userPrompts: number;
  toolResults: number;
  assistantMsgs: number;
  toolUses: number;
  attachments: number;
  system: number;
  apiErrors: number;
  sidechain: number;
}

export type SessionSource = "claude" | "codex";

export interface SessionStats {
  id: string;
  project: string;
  file: string;
  source: SessionSource;
  sizeBytes: number;
  title: string | null;
  lastPrompt: string | null;
  agentName: string | null;
  firstTs: string | null;
  lastTs: string | null;
  /** Wall-clock span in ms between first and last record */
  durationMs: number;
  version: string | null;
  gitBranch: string | null;
  cwd: string | null;
  entrypoint: string | null;
  permissionModes: string[];
  effortModes: string[];
  counts: SessionCounts;
  models: Record<string, ModelUsage>;
  toolCalls: Record<string, number>;
  subagents: SubagentStats[];
  recordTypes: Record<string, number>;
  hourlyUsage: HourlyUsage;
}

export interface ProjectStats {
  /** Raw directory name, e.g. C--Users-etgarcia-workspace */
  name: string;
  /** Best-effort real path derived from cwd fields in transcripts */
  displayPath: string | null;
  sessions: SessionStats[];
}

export interface StatsResponse {
  generatedAt: string;
  scanMs: number;
  root: string;
  projects: ProjectStats[];
}

// ---- Session detail (drill-down) ----

export interface TimelineEvent {
  ts: string | null;
  kind: "user" | "assistant" | "tool_use" | "tool_result" | "error" | "system";
  model?: string;
  text?: string;
  tool?: string;
  outputTokens?: number;
  inputTokens?: number;
  cacheRead?: number;
  agent?: string; // set for subagent events
}

export interface SessionDetail {
  session: SessionStats;
  timeline: TimelineEvent[];
}
