import { useMemo, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
  PieChart, Pie, Cell, CartesianGrid,
} from "recharts";
import type { FlatSession, RangeKey } from "../aggregate";
import {
  byDay, costByModel, costByProject, topTools, modelColor,
  RANGES, rangeFromDay, windowTotals,
} from "../aggregate";
import type { PricingTable } from "../pricing";
import { fmtTokens, fmtUsd } from "../pricing";

export default function Overview({
  sessions, pricing,
}: {
  sessions: FlatSession[];
  pricing: PricingTable;
}) {
  const [range, setRange] = useState<RangeKey>("all");
  // Recompute the window anchor when the data refreshes (not on every render).
  const now = useMemo(() => Date.now(), [sessions]);
  const rangeDef = RANGES.find((r) => r.key === range)!;
  const fromDay = useMemo(() => rangeFromDay(rangeDef.days, now), [rangeDef, now]);
  // Suffix appended to windowed card/chart labels (blank for all-time).
  const suffix = range === "all" ? "" : ` (${rangeDef.label})`;

  const days = useMemo(() => byDay(sessions, pricing, fromDay), [sessions, pricing, fromDay]);
  const models = useMemo(() => costByModel(sessions, pricing, fromDay), [sessions, pricing, fromDay]);
  const projects = useMemo(() => costByProject(sessions, pricing, fromDay).slice(0, 12), [sessions, pricing, fromDay]);
  const tools = useMemo(() => topTools(sessions, 15, fromDay), [sessions, fromDay]);

  // Only models that actually cost something feed the donut.
  const pieModels = useMemo(() => models.filter((m) => m.cost > 0), [models]);

  // Cost/token totals + message counts scoped to the selected window.
  const totals = useMemo(() => windowTotals(sessions, pricing, fromDay), [sessions, pricing, fromDay]);
  // "Last 1h" is a live, window-independent metric — always across all sessions.
  const costLastHour = useMemo(
    () => sessions.reduce((a, s) => a + s.costLastHour, 0),
    [sessions]
  );

  const modelNames = useMemo(() => {
    const set = new Set<string>();
    for (const d of days) Object.keys(d.byModel).forEach((m) => set.add(m));
    return [...set];
  }, [days]);

  // One name->color map shared by the day bars, the day tooltip (via bar fill),
  // the donut, and the table — so a model is the same color everywhere. Assign
  // each model a color exactly once; modelColor uses MODEL_COLORS by name when
  // known, else a fallback by this single global index (cost-desc, then any
  // day-only models), avoiding the per-chart index drift that gave the same
  // fallback model different colors in different charts.
  const colorOf = useMemo(() => {
    const map: Record<string, string> = {};
    let i = 0;
    for (const m of models) if (!(m.model in map)) map[m.model] = modelColor(m.model, i++);
    for (const m of modelNames) if (!(m in map)) map[m] = modelColor(m, i++);
    return map;
  }, [models, modelNames]);

  const dayChartData = useMemo(
    () =>
      days.map((d) => ({
        day: d.day.slice(5),
        ...Object.fromEntries(modelNames.map((m) => [m, +(d.byModel[m] ?? 0).toFixed(2)])),
      })),
    [days, modelNames]
  );

  return (
    <div className="page">
      <div className="range-bar">
        <span className="range-label">Range</span>
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={range === r.key ? "active" : ""}
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>

      <div className="cards">
        <Card label={`Est. total cost${suffix}`} value={fmtUsd(totals.cost)} />
        <Card label="Est. cost (last 1h)" value={fmtUsd(costLastHour)} />
        <Card label={`Total tokens (incl. cache)${suffix}`} value={fmtTokens(totals.allTok)} />
        <Card label={`User prompts${suffix}`} value={totals.prompts.toLocaleString()} />
        <Card label={`Assistant messages${suffix}`} value={totals.asst.toLocaleString()} />
        <Card label={`Tool calls${suffix}`} value={totals.toolUses.toLocaleString()} />
        <Card label={`Subagent runs${suffix}`} value={totals.subagents.toLocaleString()} />
        <Card label={`API errors${suffix}`} value={totals.errors.toLocaleString()} />
      </div>

      <div className="panel">
        <h2>Estimated cost per day (by model){suffix}</h2>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={dayChartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis dataKey="day" stroke="#888" fontSize={11} />
            <YAxis stroke="#888" fontSize={11} tickFormatter={(v) => "$" + v} />
            <Tooltip
              content={<DayTooltip />}
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
            />
            {modelNames.map((m) => (
              <Bar key={m} dataKey={m} stackId="cost" fill={colorOf[m]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="panel-row">
        <div className="panel half">
          <h2>Cost by model{suffix}</h2>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie
                data={pieModels}
                dataKey="cost"
                nameKey="model"
                innerRadius={55}
                outerRadius={95}
                paddingAngle={2}
              >
                {pieModels.map((m) => (
                  <Cell key={m.model} fill={colorOf[m.model]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: "#1c1f26", border: "1px solid #333" }}
                formatter={(v: any) => fmtUsd(Number(v))}
              />
            </PieChart>
          </ResponsiveContainer>
          <table className="mini">
            <thead>
              <tr><th>Model</th><th>API calls</th><th>Tokens</th><th>Est. cost</th></tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.model}>
                  <td>
                    <span
                      className="legend-swatch"
                      style={{ background: colorOf[m.model] }}
                    />
                    {m.model}
                  </td>
                  <td>{m.calls.toLocaleString()}</td>
                  <td>{fmtTokens(m.tokens)}</td>
                  <td>{fmtUsd(m.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel half">
          <h2>Cost by project (top 12){suffix}</h2>
          <ResponsiveContainer width="100%" height={Math.max(260, projects.length * 30)}>
            <BarChart data={projects} layout="vertical" margin={{ left: 30 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#333" />
              <XAxis type="number" stroke="#888" fontSize={11} tickFormatter={(v) => "$" + v} />
              <YAxis type="category" dataKey="project" stroke="#888" fontSize={11} width={170} />
              <Tooltip
                contentStyle={{ background: "#1c1f26", border: "1px solid #333" }}
                formatter={(v: any) => fmtUsd(Number(v))}
              />
              <Bar dataKey="cost" fill="#e8714a" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="panel">
        <h2>Most used tools{suffix}</h2>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={tools}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis dataKey="tool" stroke="#888" fontSize={11} angle={-30} textAnchor="end" height={70} />
            <YAxis stroke="#888" fontSize={11} />
            <Tooltip contentStyle={{ background: "#1c1f26", border: "1px solid #333" }} />
            <Bar dataKey="count" fill="#4aa3e8" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// Tooltip for the per-day cost chart. recharts hands us every stacked series
// (all models) for the hovered day; show only the ones that actually cost
// something that day, sorted high→low, so the box stays short and relevant
// instead of listing ~20 models at $0.00.
function DayTooltip({ active, payload, label }: any) {
  if (!active || !Array.isArray(payload)) return null;
  const rows = payload
    .filter((p: any) => (p?.value ?? 0) > 0)
    .sort((a: any, b: any) => b.value - a.value);
  if (rows.length === 0) return null;
  const total = rows.reduce((s: number, p: any) => s + p.value, 0);
  return (
    <div className="chart-tooltip">
      <div className="tt-head">{label}</div>
      {rows.map((p: any) => (
        <div className="tt-row" key={p.name}>
          <span className="tt-name">
            <span className="legend-swatch" style={{ background: p.color || p.fill }} />
            {p.name}
          </span>
          <span className="tt-val">{fmtUsd(p.value)}</span>
        </div>
      ))}
      {rows.length > 1 && (
        <div className="tt-row tt-total">
          <span className="tt-name">total</span>
          <span className="tt-val">{fmtUsd(total)}</span>
        </div>
      )}
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="card-value">{value}</div>
      <div className="card-label">{label}</div>
    </div>
  );
}
