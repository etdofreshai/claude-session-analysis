import path from "node:path";
import os from "node:os";

// A "host" is a machine whose AI-agent transcripts we scan. The local
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
  /** Local path to the Pi agent sessions dir to scan. */
  piDir: string;
  /** Local path to the OpenCode SQLite database to scan. */
  opencodeDb: string;
  /**
   * rsync SOURCE for Claude projects. For SSH remotes this is an SSH-side,
   * home-relative path (e.g. ".claude/projects/"); for the local host it is an
   * ABSOLUTE local path (e.g. "/Users/you/.claude/projects/"). A trailing slash
   * is REQUIRED so rsync copies the directory CONTENTS (not a nested subdir).
   * Empty string means "this host is scanned in place; do not rsync".
   */
  remoteProjects: string;
  /** rsync SOURCE for Codex sessions; same conventions as remoteProjects. */
  remoteCodex: string;
  /** rsync SOURCE for Pi sessions; same conventions as remoteProjects. */
  remotePi: string;
  /** rsync SOURCE directory containing opencode.db and its WAL files. */
  remoteOpenCode: string;
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
  remotePi?: string;
  remoteOpenCode?: string;
  rsyncPath?: string;
}

// Built-in remotes — macOS hosts pulled over plain rsync with home-relative
// paths. The machine running this dashboard is etzmacminim2 itself, so it's
// scanned directly as the local host (below) rather than pulled over SSH.
const BUILTIN_REMOTES: RemoteDef[] = [
  { id: "etzmacstudiom4max", ssh: "etgarcia@etzmacstudiom4max.lan" },
  { id: "etzmacbookprom1", ssh: "etgarcia@etzmacbookprom1.lan" },
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

  const localLabel = process.env.CLAUDE_LOCAL_LABEL ?? "etzmacminim2";
  const localStage = path.join(remoteStageRoot(), localLabel);
  // A containerized deployment has no meaningful local archive. In that mode
  // every source host is declared through CLAUDE_REMOTE_HOSTS and staged in the
  // persistent cache volume.
  if (process.env.CLAUDE_DISABLE_LOCAL !== "1") list.push({
    id: "local",
    label: localLabel,
    ssh: null,
    // Scan the durable staging archive, NOT the live dir, so a deleted live
    // session survives in the dashboard (the local rsync below is append/update
    // only — no --delete).
    projectsDir: path.join(localStage, "projects"),
    codexDir: path.join(localStage, "codex"),
    piDir: path.join(localStage, "pi"),
    opencodeDb: path.join(localStage, "opencode", "opencode.db"),
    // COPY SOURCE for the local self-archive rsync: the LIVE dirs. Absolute
    // paths, trailing slash mandatory (copies contents into the stage dir).
    // The CLAUDE_PROJECTS_DIR / CODEX_SESSIONS_DIR env overrides now select the
    // SOURCE that gets archived (was: the scan target).
    remoteProjects:
      (process.env.CLAUDE_PROJECTS_DIR ??
        path.join(os.homedir(), ".claude", "projects")) + "/",
    remoteCodex:
      (process.env.CODEX_SESSIONS_DIR ??
        path.join(os.homedir(), ".codex", "sessions")) + "/",
    remotePi:
      (process.env.PI_SESSIONS_DIR ??
        path.join(os.homedir(), ".pi", "agent", "sessions")) + "/",
    remoteOpenCode:
      (process.env.OPENCODE_DATA_DIR ??
        path.join(os.homedir(), ".local", "share", "opencode")) + "/",
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
      piDir: path.join(base, "pi"),
      opencodeDb: path.join(base, "opencode", "opencode.db"),
      remoteProjects: r.remoteProjects ?? ".claude/projects/",
      remoteCodex: r.remoteCodex ?? ".codex/sessions/",
      remotePi: r.remotePi ?? ".pi/agent/sessions/",
      remoteOpenCode: r.remoteOpenCode ?? ".local/share/opencode/",
      rsyncPath: r.rsyncPath ?? null,
    });
  }

  cached = list;
  return list;
}

export function hostById(idOrLabel: string): HostSpec | undefined {
  return hosts().find((h) => h.id === idOrLabel || h.label === idOrLabel);
}
