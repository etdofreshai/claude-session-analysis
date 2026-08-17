import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { sessionIdentity, windowCost, type FlatSession } from "../aggregate";
import type { PricingTable } from "../pricing";
import { fmtDateTimeCT, fmtDuration, fmtTokens, fmtUsd } from "../pricing";

type SortKey = "date" | "cost" | "costWin" | "tokens" | "prompts" | "duration" | "subagents";
type ColKey =
  | "date" | "src" | "host" | "project" | "title" | "models"
  | "prompts" | "tokens" | "subagents" | "duration" | "costWin" | "cost";

// Columns in table (DOM) order; drives the "Columns" picker and measurement.
const COLUMNS: { key: ColKey; label: string }[] = [
  { key: "date", label: "Last activity" },
  { key: "src", label: "Src" },
  { key: "host", label: "Host" },
  { key: "project", label: "Project" },
  { key: "title", label: "Title / last prompt" },
  { key: "models", label: "Models" },
  { key: "prompts", label: "Prompts" },
  { key: "tokens", label: "Tokens" },
  { key: "subagents", label: "Subagents" },
  { key: "duration", label: "Duration" },
  { key: "costWin", label: "Cost (window)" },
  { key: "cost", label: "Total cost" },
];

// Auto-fit drop order: hide these (in this order) until the table fits its
// container. Columns absent here (Project, Tokens, both costs) are never
// auto-hidden — only the picker can hide them.
const DROP_PRIORITY: ColKey[] = [
  "models", "subagents", "title", "duration", "prompts", "host", "src", "date",
];

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

  const [hidden, setHidden] = useState<Set<ColKey>>(() => new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const autoFitDone = useRef(false);

  const visible = (key: ColKey) => !hidden.has(key);
  const toggleColumn = (key: ColKey) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  // Auto-fit once per page load, after real rows exist. In an auto-layout table
  // every cell in a column shares the header's width, so each <th>'s offsetWidth
  // IS the column width — measure all headers once, then subtract widths along
  // the drop-priority list until the overflow is gone, and hide in one update.
  useLayoutEffect(() => {
    if (autoFitDone.current || sessions.length === 0) return;
    autoFitDone.current = true;
    const table = tableRef.current;
    const scroll = scrollRef.current;
    if (!table || !scroll) return;
    let overflow = table.scrollWidth - scroll.clientWidth;
    if (overflow <= 0) return;
    const widths = new Map<string, number>();
    table.querySelectorAll<HTMLTableCellElement>("thead th[data-col]").forEach(
      (th) => widths.set(th.dataset.col!, th.offsetWidth)
    );
    const toHide = new Set<ColKey>();
    for (const key of DROP_PRIORITY) {
      if (overflow <= 0) break;
      overflow -= widths.get(key) ?? 0;
      toHide.add(key);
    }
    setHidden(toHide);
  }, [sessions.length]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node))
        setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pickerOpen]);

  // Cost over the selected trailing window, per session (incl. subagents).
  const winCost = useMemo(() => {
    const now = Date.now();
    const map = new Map<string, number>();
    for (const s of sessions) {
      let c = windowCost(s.hourlyUsage, pricing, windowMs, now);
      for (const sub of s.subagents)
        c += windowCost(sub.hourlyUsage, pricing, windowMs, now);
      map.set(sessionIdentity(s), c);
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
        case "costWin": return winCost.get(sessionIdentity(s)) ?? 0;
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
      data-col={k}
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
          <option value="pi">Pi</option>
          <option value="opencode">OpenCode</option>
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
        <div className="columns-picker" ref={pickerRef}>
          <button type="button" onClick={() => setPickerOpen((o) => !o)}>
            Columns
          </button>
          {pickerOpen && (
            <div className="columns-panel">
              {COLUMNS.map((c) => (
                <label key={c.key}>
                  <input
                    type="checkbox"
                    checked={visible(c.key)}
                    onChange={() => toggleColumn(c.key)}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="table-scroll" ref={scrollRef}>
      <table className="sessions" ref={tableRef}>
        <thead>
          <tr>
            {visible("date") && th("Last activity", "date")}
            {visible("src") && <th data-col="src">Src</th>}
            {visible("host") && <th data-col="host">Host</th>}
            {visible("project") && <th data-col="project">Project</th>}
            {visible("title") && <th data-col="title">Title / last prompt</th>}
            {visible("models") && <th data-col="models">Models</th>}
            {visible("prompts") && th("Prompts", "prompts")}
            {visible("tokens") && th("Tokens", "tokens")}
            {visible("subagents") && th("Subagents", "subagents")}
            {visible("duration") && th("Duration", "duration")}
            {visible("costWin") && th(`Cost (${windowLabel})`, "costWin")}
            {visible("cost") && th("Total cost", "cost")}
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={sessionIdentity(s)} onClick={() => onSelect(s)}>
              {visible("date") && (
                <td className="nowrap">{fmtDateTimeCT(s.lastTs ?? s.firstTs)}</td>
              )}
              {visible("src") && (
                <td className="nowrap">
                  <span className={`chip chip-src chip-${s.source}`}>{s.source}</span>
                </td>
              )}
              {visible("host") && (
                <td className="nowrap">
                  <span className="chip chip-host">{s.host}</span>
                </td>
              )}
              {visible("project") && (
                <td className="project-cell" title={s.projectDisplay}>{s.projectDisplay}</td>
              )}
              {visible("title") && (
                <td className="title-cell" title={s.lastPrompt ?? ""}>
                  {s.title ?? s.lastPrompt ?? s.agentName ?? s.id.slice(0, 8)}
                </td>
              )}
              {visible("models") && (
                <td className="nowrap">
                  {Object.keys(s.models).map((m) => (
                    <span key={m} className="chip">{m.replace("claude-", "")}</span>
                  ))}
                  {s.effortModes.filter((e) => e !== "normal").map((e) => (
                    <span key={e} className="chip chip-effort">{e}</span>
                  ))}
                </td>
              )}
              {visible("prompts") && <td className="num">{s.counts.userPrompts}</td>}
              {visible("tokens") && <td className="num">{fmtTokens(s.totalTokensAll)}</td>}
              {visible("subagents") && <td className="num">{s.subagents.length || ""}</td>}
              {visible("duration") && <td className="num">{fmtDuration(s.durationMs)}</td>}
              {visible("costWin") && (
                <td className="num cost">
                  {(() => {
                    const c = winCost.get(sessionIdentity(s)) ?? 0;
                    return c > 0.0005 ? fmtUsd(c) : "";
                  })()}
                </td>
              )}
              {visible("cost") && (
                <td className="num cost">
                  {fmtUsd(s.cost + s.subagentCost)}
                  {s.subagentCost > 0.005 && (
                    <span className="muted"> ({fmtUsd(s.subagentCost)} sub)</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
