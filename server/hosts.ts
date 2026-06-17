import path from "node:path";
import os from "node:os";

// A "host" is a machine whose Claude/Codex transcripts we scan. The local
// machine is always included; remote machines are pulled into a staging dir
// via rsync (see sync.ts) and then scanned from that local copy.
export interface HostSpec {
  id: string;
  label: string;
  /** SSH target ("user@host") for remotes; null for the local machine. */
  ssh: string | null;
  /** Local path to the Claude projects dir to scan. */
  projectsDir: string;
  /** Local path to the Codex sessions dir to scan. */
  codexDir: string;
  /** Remote-side rsync source for Claude projects (default "~/.claude/projects/"). */
  remoteProjects: string;
  /** Remote-side rsync source for Codex sessions (default "~/.codex/sessions/"). */
  remoteCodex: string;
  /**
   * --rsync-path override: the command to run on the remote to invoke rsync.
   * Used for Windows hosts that have no native rsync but can reach one through
   * WSL (e.g. "wsl -d Ubuntu rsync", reading Windows files under /mnt/c).
   */
  rsyncPath: string | null;
}

/** Where remote transcripts are staged locally before scanning. */
export function remoteStageRoot(): string {
  return (
    process.env.CLAUDE_REMOTE_CACHE ??
    path.join(os.homedir(), ".claude-remotes")
  );
}

interface RemoteDef {
  id: string;
  ssh: string;
  remoteProjects?: string;
  remoteCodex?: string;
  rsyncPath?: string;
}

// Built-in remotes. etzmacminim2 is macOS (plain rsync, home-relative paths);
// etzevox2 is Windows with no native rsync, so we drive Ubuntu's WSL rsync and
// reference the Windows profile via /mnt/c.
const BUILTIN_REMOTES: RemoteDef[] = [
  { id: "etzmacminim2", ssh: "etgarcia@etzmacminim2.lan" },
  {
    id: "etzevox2",
    ssh: "etgarcia@etzevox2.lan",
    rsyncPath: "wsl -d Ubuntu rsync",
    remoteProjects: "/mnt/c/Users/etgarcia/.claude/projects/",
    remoteCodex: "/mnt/c/Users/etgarcia/.codex/sessions/",
  },
];

// Optional env override: comma-separated "id=user@host" pairs (unix defaults).
// When set, it replaces the built-in remote list.
function envRemotes(): RemoteDef[] | null {
  const spec = process.env.CLAUDE_REMOTE_HOSTS;
  if (!spec) return null;
  const out: RemoteDef[] = [];
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const id = part.slice(0, eq).trim();
    const ssh = part.slice(eq + 1).trim();
    if (id && ssh) out.push({ id, ssh });
  }
  return out;
}

let cached: HostSpec[] | null = null;

export function hosts(): HostSpec[] {
  if (cached) return cached;
  const list: HostSpec[] = [];

  list.push({
    id: "local",
    label: process.env.CLAUDE_LOCAL_LABEL ?? "local",
    ssh: null,
    projectsDir:
      process.env.CLAUDE_PROJECTS_DIR ??
      path.join(os.homedir(), ".claude", "projects"),
    codexDir:
      process.env.CODEX_SESSIONS_DIR ??
      path.join(os.homedir(), ".codex", "sessions"),
    remoteProjects: "",
    remoteCodex: "",
    rsyncPath: null,
  });

  for (const r of envRemotes() ?? BUILTIN_REMOTES) {
    const base = path.join(remoteStageRoot(), r.id);
    list.push({
      id: r.id,
      label: r.id,
      ssh: r.ssh,
      projectsDir: path.join(base, "projects"),
      codexDir: path.join(base, "codex"),
      remoteProjects: r.remoteProjects ?? ".claude/projects/",
      remoteCodex: r.remoteCodex ?? ".codex/sessions/",
      rsyncPath: r.rsyncPath ?? null,
    });
  }

  cached = list;
  return list;
}

export function hostById(idOrLabel: string): HostSpec | undefined {
  return hosts().find((h) => h.id === idOrLabel || h.label === idOrLabel);
}
