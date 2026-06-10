import { useMemo, useState } from "react";
import type { FlatSession } from "../aggregate";
import { fmtDateTimeCT, fmtDuration, fmtTokens, fmtUsd } from "../pricing";

type SortKey = "date" | "cost" | "cost1h" | "tokens" | "prompts" | "duration" | "subagents";

export default function SessionsTable({
  sessions, onSelect,
}: {
  sessions: FlatSession[];
  onSelect: (s: FlatSession) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [desc, setDesc] = useState(true);
  const [filter, setFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");

  const projects = useMemo(
    () => [...new Set(sessions.map((s) => s.projectDisplay))].sort(),
    [sessions]
  );

  const rows = useMemo(() => {
    let r = sessions;
    if (projectFilter) r = r.filter((s) => s.projectDisplay === projectFilter);
    if (filter) {
      const f = filter.toLowerCase();
      r = r.filter(
        (s) =>
          (s.title ?? "").toLowerCase().includes(f) ||
          (s.lastPrompt ?? "").toLowerCase().includes(f) ||
          s.id.includes(f) ||
          Object.keys(s.models).some((m) => m.toLowerCase().includes(f))
      );
    }
    const key = (s: FlatSession): number => {
      switch (sortKey) {
        case "date": return Date.parse(s.lastTs ?? s.firstTs ?? "") || 0;
        case "cost": return s.cost + s.subagentCost;
        case "cost1h": return s.costLastHour;
        case "tokens": return s.totalTokensAll;
        case "prompts": return s.counts.userPrompts;
        case "duration": return s.durationMs;
        case "subagents": return s.subagents.length;
      }
    };
    return [...r].sort((a, b) => (desc ? key(b) - key(a) : key(a) - key(b)));
  }, [sessions, sortKey, desc, filter, projectFilter]);

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
        <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <span className="muted">{rows.length} sessions</span>
      </div>
      <table className="sessions">
        <thead>
          <tr>
            {th("Last activity", "date")}
            <th>Project</th>
            <th>Title / last prompt</th>
            <th>Models</th>
            {th("Prompts", "prompts")}
            {th("Tokens", "tokens")}
            {th("Subagents", "subagents")}
            {th("Duration", "duration")}
            {th("Cost (1h)", "cost1h")}
            {th("Total cost", "cost")}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.project + s.id} onClick={() => onSelect(s)}>
              <td className="nowrap">{fmtDateTimeCT(s.lastTs ?? s.firstTs)}</td>
              <td className="nowrap">{s.projectDisplay}</td>
              <td className="title-cell" title={s.lastPrompt ?? ""}>
                {s.title ?? s.lastPrompt ?? s.agentName ?? s.id.slice(0, 8)}
              </td>
              <td className="nowrap">
                {Object.keys(s.models).map((m) => (
                  <span key={m} className="chip">{m.replace("claude-", "")}</span>
                ))}
              </td>
              <td className="num">{s.counts.userPrompts}</td>
              <td className="num">{fmtTokens(s.totalTokensAll)}</td>
              <td className="num">{s.subagents.length || ""}</td>
              <td className="num">{fmtDuration(s.durationMs)}</td>
              <td className="num cost">{s.costLastHour > 0.0005 ? fmtUsd(s.costLastHour) : ""}</td>
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
