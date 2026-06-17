# Migrating the claude-session-analysis Dashboard to a Fresh Host

This runbook moves the dashboard to any machine that already has **node + npm**,
serves it on `0.0.0.0` (LAN-reachable), and pulls all session data from the
source machines over **SSH/rsync**. There is **no frp tunnel** — it's reached
directly on the new host's LAN address.

Every nontrivial claim below is cited to `file:line` in this repo.

---

## 0. Pre-migration gate — commit & push the data pipeline FIRST

The multi-host SSH/rsync pipeline must be in git before you clone it elsewhere.
If `server/hosts.ts` / `server/sync.ts` are still untracked, a `git clone`
delivers the **old single-host build with no rsync** — it loads, returns `200`,
and looks fine while having **zero remote data and no sync panel**.

On the **source machine**:

```sh
cd /path/to/claude-session-analysis
git add server/hosts.ts server/sync.ts server/scanner.ts server/api.ts server/codex-scanner.ts \
        src/App.tsx src/api.ts src/components/Overview.tsx src/components/SessionDetail.tsx \
        src/components/SessionsTable.tsx src/styles.css src/types.ts
git commit -m "Add multi-host SSH/rsync data pipeline"
git push origin main

# Prove the pipeline is now in origin/main — BOTH must succeed:
git ls-files server/hosts.ts server/sync.ts            # must list BOTH files
git cat-file -e origin/main:server/sync.ts && echo "sync.ts in origin/main"
```

If you cannot commit/push, `git clone` (Step 3 Option A) is unusable — use
Option B (copy the working tree) instead.

---

## 1. What you're migrating (and what you're NOT)

A **Vite 6 + React 18 dashboard** whose backend is a Vite dev-server middleware
plugin (`server/api.ts` → `sessionApiPlugin`, registered in `vite.config.ts:6`).
It is **not** a standalone server and has **no production build path** — it must
run as `npm run dev`. Data is pulled from the source machines by
**rsync-over-SSH** (`server/sync.ts`).

**NOT migrating:** any frp/frpc/frps tunnel — intentionally dropped. The
dashboard is reached directly on the new host's LAN address (port `5180`),
bound to `0.0.0.0`.

---

## 2. Prerequisites on the new host

Node + npm are assumed present. Verify versions and install the
missing-but-required tools (**rsync**, an **ssh client**, **git**):

```sh
node --version      # Vite 6 needs v18.18+ / v20+ / v22+
npm --version       # 7+ for lockfileVersion 3

# rsync MUST exist — server shells out to bare `rsync` (server/sync.ts:39).
command -v rsync || echo "rsync MISSING"
command -v ssh   || echo "ssh MISSING"
command -v git   || echo "git MISSING"

# Debian/Ubuntu:
sudo apt-get update && sudo apt-get install -y rsync openssh-client git
# macOS: rsync + ssh ship by default; git via `xcode-select --install`
```

> No Node/npm version is pinned anywhere (no `engines`/`volta`/`.nvmrc` —
> `package.json`). Any modern Node works.

**Before proceeding, identify the box that holds today's real `~/.claude`.**
Migration promotes that "local" box to an SSH *remote* (Step 5), which only
works if it's actually SSH-reachable. If it's a container, it may have no sshd /
be NAT'd / be ephemeral. Confirm now:

```sh
ssh <user>@<old-local-host> 'ls ~/.claude/projects | head'   # must list real project dirs
```

If it has no sshd or isn't reachable, the remote-pull model can't reach it —
enable sshd on it, or stage its `~/.claude` onto a reachable host.

---

## 3. Get the code onto the new host & install deps

`node_modules/` and `dist/` are gitignored (`.gitignore`), so install after fetching.

```sh
# Option A — git clone (ONLY after Step 0 commit+push succeeded; else it's the OLD build)
git clone <repo-url> ~/claude-session-analysis
cd ~/claude-session-analysis

# Option B — copy the working tree (use if Step 0 was NOT done).
# If rsync is missing on the source host, use a tar-over-ssh pipe instead:
ssh <user>@<source-host> \
  'tar -C /path/to/repos \
       --exclude claude-session-analysis/node_modules \
       --exclude claude-session-analysis/dist \
       --exclude claude-session-analysis/.git \
       -czf - claude-session-analysis' \
  | tar -C ~ -xzf -
cd ~/claude-session-analysis

# Install reproducibly from the committed lockfile (lockfileVersion 3):
npm ci
# Fallback only if npm ci errors on lock drift:  npm install
```

> Do **NOT** copy any workspace-level `.env` — it may hold live secrets this app
> doesn't read. Copying it is a credential leak. This app reads no `.env`.

---

## 4. SSH access to the source machines

rsync runs with `-o BatchMode=yes` (`server/sync.ts:15`) → **key-based,
non-interactive SSH is mandatory**; any password prompt fails the pull silently
(shows as a per-host error in the UI). `StrictHostKeyChecking=accept-new`
(`server/sync.ts:17`) auto-adds *unknown* keys but **rejects a changed** one.

The source machines (see `server/hosts.ts`):

| id | SSH target | OS | rsync mechanism |
|---|---|---|---|
| `etzmacminim2` | `etgarcia@etzmacminim2.lan` (192.168.1.2) | macOS | native rsync, home-relative |
| `etzevox2` | `etgarcia@etzevox2.lan` (192.168.1.140) | Windows/WSL | `--rsync-path 'wsl -d Ubuntu rsync'`, `/mnt/c` paths |
| *(old "local" box)* | reachable `user@host` from Step 2 | Linux | native rsync, home-relative |

```sh
# 4a. key
ls ~/.ssh/id_ed25519.pub 2>/dev/null || ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519

# 4b. authorize on each source
ssh-copy-id etgarcia@etzmacminim2.lan
ssh-copy-id etgarcia@etzevox2.lan
ssh-copy-id <user>@<old-local-host>
# manual fallback if ssh-copy-id is unavailable:
cat ~/.ssh/id_ed25519.pub | ssh etgarcia@etzevox2.lan \
  'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'

# 4c. confirm non-interactive reach + name resolution
ssh -o BatchMode=yes etgarcia@etzmacminim2.lan true && echo "mac OK"
ssh -o BatchMode=yes etgarcia@etzevox2.lan   true && echo "win OK"
ssh -o BatchMode=yes <user>@<old-local-host> true && echo "oldlocal OK"
```

**4d. Prove rsync works before touching the app** (mirrors `server/sync.ts:30-42`):

```sh
# macOS source
rsync -az --timeout=25 \
  -e 'ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new' \
  etgarcia@etzmacminim2.lan:.claude/projects/ /tmp/test-mac/ && echo "MAC OK"

# old-local Linux box
rsync -az --timeout=25 \
  -e 'ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new' \
  <user>@<old-local-host>:.claude/projects/ /tmp/test-oldlocal/ && echo "OLDLOCAL OK"

# Windows/WSL source (drives rsync through WSL, reads /mnt/c)
rsync -az --timeout=25 \
  -e 'ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new' \
  --rsync-path 'wsl -d Ubuntu rsync' \
  etgarcia@etzevox2.lan:/mnt/c/Users/etgarcia/.claude/projects/ /tmp/test-win/ && echo "WIN OK"
```

If Windows fails, confirm WSL Ubuntu has rsync (`wsl -d Ubuntu rsync --version`
on that box) — Windows has no native rsync; that's the whole point of
`--rsync-path`. The first Windows pull traverses thousands of files over WSL and
can take ~20s — normal. If `.lan` names don't resolve, use IPs. If a key was
rebuilt and rejected: `ssh-keygen -R etzevox2.lan`.

---

## 5. Edit the host registry — `server/hosts.ts` (most important data change)

On the current machine the real transcripts live on the `local` host
(`server/hosts.ts`, `ssh: null`). On a fresh box that data is now *remote* —
promote it or it disappears.

**Before** (`BUILTIN_REMOTES`):
```ts
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
```

**After** (add the old-local box; Linux defaults apply, no path overrides needed):
```ts
const BUILTIN_REMOTES: RemoteDef[] = [
  { id: "etcontainer", ssh: "<user>@<old-local-host>" },   // <- was the "local" box
  { id: "etzmacminim2", ssh: "etgarcia@etzmacminim2.lan" },
  {
    id: "etzevox2",
    ssh: "etgarcia@etzevox2.lan",
    rsyncPath: "wsl -d Ubuntu rsync",
    remoteProjects: "/mnt/c/Users/etgarcia/.claude/projects/",
    remoteCodex: "/mnt/c/Users/etgarcia/.codex/sessions/",
  },
];
```

- The new host's own `local` entry stays `ssh: null` and points at the new box's
  empty `~/.claude` — fine; `scanClaudeHost` tolerates a missing/empty root
  (`server/scanner.ts`).
- **Keep `etzevox2` hardcoded here.** The `CLAUDE_REMOTE_HOSTS` env override only
  parses `id=user@host` and assumes unix `~/.claude` defaults (`server/hosts.ts`)
  — it cannot express `rsyncPath` or `/mnt/c` paths.
- Different `.lan` resolution → use IPs; different Windows user/distro → edit
  `/mnt/c/Users/<user>/...` and `wsl -d <Distro> rsync`.

---

## 6. Other machine-specific edits

| What | Where | Current | Change to |
|---|---|---|---|
| **Host bind** | `vite.config.ts` server block (no `host` key) | localhost-only | add `host: true` |
| Served port | `vite.config.ts` | `5180` | keep unless conflict (frontend uses relative `/api`, `src/api.ts` — no other edit) |
| Remote SSH targets / WSL paths | `server/hosts.ts` | mac/win entries | per Step 5 |
| Old-local box | `server/hosts.ts` | `local`, `ssh:null` | promote (Step 5) |
| Staging cache root | `server/hosts.ts` | `~/.claude-remotes` | leave default (auto-created `server/sync.ts`); ensure HOME writable, hundreds of MB free |
| Sync TTL | `server/sync.ts` | `90000` ms | leave default |
| Display timezone | `src/pricing.ts` | `America/Chicago` | cosmetic |

The one required edit (`vite.config.ts` server block):
```ts
  server: {
    port: 5180,
    host: true,        // bind 0.0.0.0, LAN-reachable
  },
```
(Or skip the edit and pass `--host 0.0.0.0` at runtime.) There are **no IPs,
tokens, secrets, CORS, or absolute URLs** in the repo to change — the frontend
is relative-path only.

---

## 7. Run it, bound to 0.0.0.0

`npm run dev` is the **only** mode that serves `/api/stats` and `/api/session` —
the API is a `configureServer` plugin (`server/api.ts`), so it exists only under
the dev server. **Do not** use `build` + `preview` (no `configurePreviewServer`
hook → backend 404s).

```sh
cd ~/claude-session-analysis
npm run dev                      # if you added host:true
npm run dev -- --host 0.0.0.0    # if you didn't edit the config
```

Vite prints the bind URLs — the **Network:** line `http://192.168.1.X:5180/`
MUST appear. Cross-check:
```sh
ss -ltnp | grep 5180     # expect 0.0.0.0:5180 (or *:5180), NOT 127.0.0.1:5180
# macOS: lsof -iTCP:5180 -sTCP:LISTEN -n
```
Reachable at **`http://<new-host-LAN-ip>:5180/`**. No frp.

---

## 8. Verify — a gate that fails closed

1. Open `http://<new-host-LAN-ip>:5180/` from another LAN device — the UI loads.
2. **Find the per-host sync-status panel.** If there's **no sync panel at
   all — STOP.** You're on the pre-pipeline build (the Step 0 blocker). A loading
   UI + `200` from `/api/stats` is **not** success.
3. The panel must list exactly `etzmacminim2`, `etzevox2`, and the promoted
   old-local box, each **ok: true** (failures show rsync stderr inline,
   `server/sync.ts`).
4. The first `/api/stats` fires the background sync immediately (`server/sync.ts`;
   TTL only gates *subsequent* syncs) — so wait **~pull time (~20s for Windows),
   not TTL+pull**, then refresh and require **at least one remote with session
   counts > 0** and that sessions/cost render. All-empty after a successful
   pull = not done.
5. Click into a session to spot-check the drill-down (`/api/session`).

> The new box's own `local` host legitimately contributes little/nothing — but
> *only* when the sync panel is present and a remote shows real data. Empty + no
> sync panel = the blocker.

---

## 9. Keep it running

```sh
# tmux (recommended headless)
tmux new -s dashboard
cd ~/claude-session-analysis && npm run dev   # detach: Ctrl-b d ; reattach: tmux attach -t dashboard

# or nohup
nohup npm run dev > ~/dashboard.log 2>&1 &
```
For survival across reboots, a **systemd user service** (Linux) / **launchd
agent** (macOS) running `npm run dev` in the repo dir is the right tool — set up
only if you want that.

---

## 10. Troubleshooting (top failure modes)

| Symptom | Cause | Fix |
|---|---|---|
| UI loads, 200, but **no sync panel / no remote data** | Running the pre-pipeline build (Step 0 skipped before clone) | Commit+push pipeline, confirm `git cat-file -e origin/main:server/sync.ts`, re-deploy |
| Sync panel present but **all remotes empty** | `hosts.ts` still treats old box as `local` | Promote it to `BUILTIN_REMOTES` (Step 5) |
| Old-local box **unreachable over SSH** | container w/o sshd / NAT'd | enable sshd or stage its `~/.claude` elsewhere (Step 2) |
| Remote error: `rsync: command not found` | rsync missing **on the remote** (esp. WSL Ubuntu) | install it; `wsl -d Ubuntu rsync --version` |
| `Permission denied` / would prompt | key not authorized; `BatchMode` forbids prompts | re-run `ssh-copy-id`; test `ssh -o BatchMode=yes user@host true` |
| `Host key verification failed` | source key changed | `ssh-keygen -R <host>`, ssh once to re-seed |
| `.lan` unreachable | mDNS not resolving | use IPs in `server/hosts.ts` |
| Every fetch 404s | running `vite preview` / static dist | use `npm run dev` only |
| Not reachable from other devices | bound localhost-only | add `host: true` / `--host 0.0.0.0`; `ss -ltnp \| grep 5180` shows `0.0.0.0` |
| Connection refused though `ss` shows `0.0.0.0:5180` | host firewall | `sudo ufw allow 5180/tcp` (Ubuntu) / macOS firewall allow node |
| `EADDRINUSE` | port 5180 busy | free it or change the port in `vite.config.ts` |
| Remote data **vanished** after an outage | `rsync --delete` (`server/sync.ts`) mirrors an empty/unreachable remote | transient; repopulates next pull |
| `npm ci` fails on lock drift | lock out of sync | fix lock on source & re-push, or `npm install` |
