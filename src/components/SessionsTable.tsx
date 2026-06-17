import { useMemo, useState } from "react";
import { windowCost, type FlatSession } from "../aggregate";
import type { PricingTable } from "../pricing";
import { fmtDateTimeCT, fmtDuration, fmtTokens, fmtUsd } from "../pricing";

type SortKey = "date" | "cost" | "costWin" | "tokens" | "prompts" | "duration" | "subagents";

const WINDOW_OPTIONS: { label: string; ms: number }[] = [
  { label: "30min", ms: 30 * 60_000 },
  { label: "1hr", ms: 60 * 60_000 },
  { label: "1.5hr", ms: 90 * 60_000 },
  { label: "2hr", ms: 120 * 60_000 },
  { label: "3hr", ms: 180 * 60_000 },
  { label: "4hr", ms: 240 * 60_000 },
  { label: "5hr", ms: 300 * 60_000 },
  { label: "6hr", ms: 360 * 60_000 },
  { label: "12hr", ms: 720 * 60_000 },
  { label: "24hr", ms: 1440 * 60_000 },
];

export default function SessionsTable({
  sessions, pricing, onSelect,
}: {
  sessions: FlatSession[];
  pricing: PricingTable;
  onSelect: (s: FlatSession) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [desc, setDesc] = useState(true);
  const [filter, setFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [hostFilter, setHostFilter] = useState("");
  const [windowMs, setWindowMs] = useState<number>(() => {
    const saved = Number(localStorage.getItem("costWindowMs"));
    return WINDOW_OPTIONS.some((o) => o.ms === saved) ? saved : 60 * 60_000;
  });
  const windowLabel =
    WINDOW_OPTIONS.find((o) => o.ms === windowMs)?.label ?? "1hr";

  // Cost over the selected trailing window, per session (incl. subagents).
  const winCost = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, number>();
    for (const s of sessions) {
      let c = windowCost(s.hourlyUsage, pricing, windowMs, now);
      for (const sub of s.subagents)
        c += windowCost(sub.hourlyUsage, pricing, windowMs, now);
      map.set(s.project + s.id, c);
    }
    return map;
  }, [sessions, pricing, windowMs]);

  const projects = useMemo(
    () => [...new Set(sessions.map((s) => s.projectDisplay))].sort(),
    [sessions]
  );

  const hostsList = useMemo(
    () => [...new Set(sessions.map((s) => s.host))].sort(),
    [sessions]
  );

  const rows = useMemo(() => {
    let r = sessions;
    if (sourceFilter) r = r.filter((s) => s.source === sourceFilter);
    if (hostFilter) r = r.filter((s) => s.host === hostFilter);
    if (projectFilter) r = r.filter((s) => s.projectDisplay === projectFilter);
    if (filter) {
      const f = filter.toLowerCase();
      r = r.filter(
        (s) =>
          (s.title ?? "").toLowerCase().includes(f) ||
          (s.lastPrompt ?? "").toLowerCase().includes(f) ||
          s.id.includes(f) ||
          Object.keys(s.models).some((m) => m.toLowerCase().includes(f)) ||
          s.effortModes.some((e) => e.toLowerCase().includes(f))
      );
    }
    const key = (s: FlatSession): number => {
      switch (sortKey) {
        case "date": return Date.parse(s.lastTs ?? s.firstTs ?? "") || 0;
        case "cost": return s.cost + s.subagentCost;
        case "costWin": return winCost.get(s.project + s.id) ?? 0;
        case "tokens": return s.totalTokensAll;
        case "prompts": return s.counts.userPrompts;
        case "duration": return s.durationMs;
        case "subagents": return s.subagents.length;
      }
    };
    return [...r].sort((a, b) => (desc ? key(b) - key(a) : key(a) - key(b)));
  }, [sessions, sortKey, desc, filter, projectFilter, sourceFilter, hostFilter, winCost]);

  const th = (label: string, k: SortKey) => (
    <th
      className="sortable"
      onClick={() => {
        if (sortKey === k) setDesc(!desc);
        else { setSortKey(k); setDesc(true); }
      }}
    >
      {label} {sortKey === k ? (desc ? "▼" : "▲") : ""}
    </th>
  );

  return (
    <div className="page">
      <div className="filters">
        <input
          placeholder="Filter by title, prompt, model, id…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
          <option value="">All sources</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
        {hostsList.length > 1 && (
          <select value={hostFilter} onChange={(e) => setHostFilter(e.target.value)}>
            <option value="">All hosts</option>
            {hostsList.map((h) => (
              <option key={h} value={h}>{h}</option>
            ))}
          </select>
        )}
        <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <label className="muted cost-window">
          Cost window:{" "}
          <select
            value={windowMs}
            onChange={(e) => {
              const ms = Number(e.target.value);
              setWindowMs(ms);
              localStorage.setItem("costWindowMs", String(ms));
            }}
          >
            {WINDOW_OPTIONS.map((o) => (
              <option key={o.ms} value={o.ms}>{o.label}</option>
            ))}
          </select>
        </label>
        <span className="muted">{rows.length} sessions</span>
      </div>
      <table className="sessions">
        <thead>
          <tr>
            {th("Last activity", "date")}
            <th>Src</th>
            <th>Host</th>
            <th>Project</th>
            <th>Title / last prompt</th>
            <th>Models</th>
            {th("Prompts", "prompts")}
            {th("Tokens", "tokens")}
            {th("Subagents", "subagents")}
            {th("Duration", "duration")}
            {th(`Cost (${windowLabel})`, "costWin")}
            {th("Total cost", "cost")}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.project + s.id} onClick={() => onSelect(s)}>
              <td className="nowrap">{fmtDateTimeCT(s.lastTs ?? s.firstTs)}</td>
              <td className="nowrap">
                <span className={`chip chip-src chip-${s.source}`}>{s.source}</span>
              </td>
              <td className="nowrap">
                <span className="chip chip-host">{s.host}</span>
              </td>
              <td className="nowrap">{s.projectDisplay}</td>
              <td className="title-cell" title={s.lastPrompt ?? ""}>
                {s.title ?? s.lastPrompt ?? s.agentName ?? s.id.slice(0, 8)}
              </td>
              <td className="nowrap">
                {Object.keys(s.models).map((m) => (
                  <span key={m} className="chip">{m.replace("claude-", "")}</span>
                ))}
                {s.effortModes.filter((e) => e !== "normal").map((e) => (
                  <span key={e} className="chip chip-effort">{e}</span>
                ))}
              </td>
              <td className="num">{s.counts.userPrompts}</td>
              <td className="num">{fmtTokens(s.totalTokensAll)}</td>
              <td className="num">{s.subagents.length || ""}</td>
              <td className="num">{fmtDuration(s.durationMs)}</td>
              <td className="num cost">
                {(() => {
                  const c = winCost.get(s.project + s.id) ?? 0;
                  return c > 0.0005 ? fmtUsd(c) : "";
                })()}
              </td>
              <td className="num cost">
                {fmtUsd(s.cost + s.subagentCost)}
                {s.subagentCost > 0.005 && (
                  <span className="muted"> ({fmtUsd(s.subagentCost)} sub)</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
