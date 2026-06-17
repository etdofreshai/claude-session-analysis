import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import type { HostSyncStatus } from "../src/types";
import { hosts, type HostSpec } from "./hosts";

const execFileP = promisify(execFile);

// A scan triggers a fresh rsync only if the last one finished more than
// TTL_MS ago; rapid refreshes within that window read the already-staged
// copy instead of paying SSH latency again.
const TTL_MS = Number(process.env.CLAUDE_SYNC_TTL_MS ?? 90_000);

const SSH_OPTS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=8",
  "-o", "StrictHostKeyChecking=accept-new",
];

const status = new Map<string, HostSyncStatus>();
let lastSyncStart = 0;
let inFlight: Promise<void> | null = null;

async function rsyncPull(
  h: HostSpec,
  src: string,
  dest: string
): Promise<void> {
  fs.mkdirSync(dest, { recursive: true });
  const args = [
    "-az",
    "--delete",
    "--timeout=25",
    "-e", `ssh ${SSH_OPTS.join(" ")}`,
  ];
  // Windows hosts have no native rsync — run it through WSL on the remote.
  if (h.rsyncPath) args.push("--rsync-path", h.rsyncPath);
  args.push(`${h.ssh}:${src}`, dest.endsWith("/") ? dest : dest + "/");
  await execFileP("rsync", args, {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function syncHost(h: HostSpec): Promise<void> {
  if (!h.ssh) return;
  const t0 = Date.now();
  let ok = true;
  let error: string | null = null;
  try {
    // projects is required; codex is best-effort (the dir may not exist).
    await rsyncPull(h, h.remoteProjects, h.projectsDir);
    try {
      await rsyncPull(h, h.remoteCodex, h.codexDir);
    } catch {
      /* no codex on this host — ignore */
    }
  } catch (e: any) {
    ok = false;
    error = String(e?.stderr || e?.message || e).trim().slice(0, 500);
  }
  status.set(h.id, {
    id: h.id,
    label: h.label,
    ssh: h.ssh,
    ok,
    error,
    lastSyncMs: Date.now(),
    durationMs: Date.now() - t0,
  });
}

async function doSync(): Promise<void> {
  const remotes = hosts().filter((h) => h.ssh);
  await Promise.all(remotes.map((h) => syncHost(h)));
}

/**
 * Trigger a background refresh of the remote staging dirs if the cache is stale,
 * and return the per-host status immediately. The scan that calls this reads
 * whatever is currently staged — it never blocks on SSH/rsync (a full etzevox2
 * pull traverses thousands of files over WSL and can take ~20s). At most one
 * sync runs per TTL window; the fresh data lands on a subsequent scan.
 */
export function ensureSynced(): HostSyncStatus[] {
  const now = Date.now();
  if (!inFlight && (lastSyncStart === 0 || now - lastSyncStart >= TTL_MS)) {
    lastSyncStart = now;
    inFlight = doSync().finally(() => {
      inFlight = null;
    });
  }
  return statusList();
}

export function statusList(): HostSyncStatus[] {
  return hosts()
    .filter((h) => h.ssh)
    .map(
      (h) =>
        status.get(h.id) ?? {
          id: h.id,
          label: h.label,
          ssh: h.ssh,
          ok: false,
          error: "not yet synced",
          lastSyncMs: null,
          durationMs: null,
        }
    );
}
