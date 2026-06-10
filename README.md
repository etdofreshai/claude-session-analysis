# Claude Session Analysis

A local Vite + React dashboard that analyzes your Claude Code session transcripts
(`~/.claude/projects/**/*.jsonl`): models used, estimated cost, message counts,
tool usage, subagent activity, and per-session drill-downs.

## How it works

The Vite dev server includes a middleware plugin (`server/api.ts`) that scans the
projects directory **server-side** (the data is hundreds of MB — it never ships
raw to the browser). Parsed per-session stats are cached by file mtime, so the
first scan is the slow one and refreshes are cheap.

- `GET /api/stats` — aggregated stats for every session in every project
- `GET /api/session?project=&id=` — full drill-down with an event timeline

Subagent transcripts (`<project>/<session-id>/subagents/agent-*.jsonl`) are
parsed and attributed to their parent session.

Token usage is deduplicated by API message id (streamed messages repeat the
usage block across multiple JSONL records).

## Cost estimates

Claude Code transcripts record token usage but **not** billed cost. The app
computes estimates from an editable pricing table (Pricing tab, persisted to
localStorage). Defaults cover Opus/Sonnet/Haiku 4.x, Fable 5 (assumed
Opus-tier), GLM, and GPT prefixes. Cache-write pricing distinguishes 5m vs 1h
ephemeral entries.

## Run

```sh
npm install
npm run dev    # http://localhost:5180
```

Set `CLAUDE_PROJECTS_DIR` to point somewhere other than `~/.claude/projects`.

## Notes

- "Prompts" counts real user inputs; tool results echoed back as user messages
  are counted separately.
- `<synthetic>` model entries (client-generated messages) cost $0.
- Sessions running under proxies (GLM, Codex) show those models — pricing is
  approximate there; adjust in the Pricing tab to match your plan.
