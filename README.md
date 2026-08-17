# AI Session Analysis

A local Vite + React dashboard that analyzes sessions from Claude Code, Codex,
Pi, and OpenCode: models used, estimated cost, message counts, tool usage,
subagent activity, and per-session drill-downs.

The default local stores are:

- Claude Code: `~/.claude/projects/**/*.jsonl`
- Codex: `~/.codex/sessions/**/*.jsonl`
- Pi: `~/.pi/agent/sessions/**/*.jsonl`
- OpenCode: `~/.local/share/opencode/opencode.db`

## How it works

The Vite dev server includes a middleware plugin (`server/api.ts`) that scans
these stores **server-side** (the data can be hundreds of MB — transcripts and
databases never ship raw to the browser). Parsed per-session stats are cached by
file/database modification state, so the first scan is the slow one and
refreshes are cheap.

- `GET /api/stats` — aggregated stats for every session in every project
- `GET /api/session?project=&id=` — full drill-down with an event timeline

Claude subagent transcripts and OpenCode child sessions are parsed and
attributed to their parent session.

Token usage is deduplicated by API message id (streamed messages repeat the
usage block across multiple JSONL records).

## Cost estimates

Claude Code transcripts record token usage but **not** billed cost. The app
computes estimates from an editable pricing table (Pricing tab, persisted to
localStorage). Claude defaults follow the official pricing docs (June 2026):
Fable/Mythos 5 at $10/$50 per MTok, Opus 4.5–4.8 at $5/$25, deprecated Opus
4.0/4.1 at $15/$75, Sonnet at $3/$15, Haiku 4.5 at $1/$5. GLM/GPT/Gemini rows
are approximations. Cache-write pricing distinguishes 5m vs 1h ephemeral
entries. Caveat: fast mode (premium Opus pricing) is not detected, and
subscription plans (Pro/Max) don't bill per token — treat costs as
API-equivalent value, not an invoice.

## Run

```sh
npm install
npm run dev    # http://localhost:5180
```

Override nonstandard local stores with `CLAUDE_PROJECTS_DIR`,
`CODEX_SESSIONS_DIR`, `PI_SESSIONS_DIR`, or `OPENCODE_DATA_DIR`.

Configured remote hosts are synced into `~/.claude-remotes` too. OpenCode sync
copies only `opencode.db` and its WAL companions, deliberately excluding its
large snapshot and tool-output directories.

## Dokploy/container deployment

The included Dockerfile runs the same Vite API/UI server on port 5180. Set
`CLAUDE_REMOTE_HOSTS` to the three SSH source hosts and mount the declared
`/data` volume so the append-only staging archive and dedicated SSH key survive
redeploys. `CLAUDE_DISABLE_LOCAL=1` (the image default) prevents a phantom
container-local host from appearing in the dashboard. `/healthz` is a
non-scanning liveness endpoint.

Set `DASHBOARD_PASSWORD` and a high-entropy `DASHBOARD_SESSION_SECRET` when the
service is routed through a public hostname. Unauthenticated browser requests
receive an unlock screen; successful entry creates a Secure, HttpOnly,
SameSite session cookie. The health endpoint remains unauthenticated, while all
UI assets and session APIs require the session. `DASHBOARD_BASIC_AUTH` remains
as a deployment-compatibility fallback only when `DASHBOARD_PASSWORD` is unset.

For a migration, `ARCHIVE_BOOTSTRAP_SOURCE` can point to the existing Mini
archive (with a trailing slash). The entrypoint rsyncs it once into the volume,
writes `/data/.archive-bootstrapped` only after success, and then switches to
normal incremental per-host pulls. Remove the bootstrap key environment value
after the persistent volume has been verified.

## Notes

- "Prompts" counts real user inputs; tool results echoed back as user messages
  are counted separately.
- `<synthetic>` model entries (client-generated messages) cost $0.
- Sessions running under proxies (GLM, Codex) show those models — pricing is
  approximate there; adjust in the Pricing tab to match your plan.
