import { useMemo, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
  PieChart, Pie, Cell, CartesianGrid,
} from "recharts";
import type { FlatSession, RangeKey, HourRangeKey, Granularity } from "../aggregate";
import {
  byDay, byHour, costByModel, costByProject, topTools, modelColor,
  RANGES, HOUR_RANGES, windowTotals,
} from "../aggregate";
import type { PricingTable } from "../pricing";
import { fmtTokens, fmtUsd } from "../pricing";

export default function Overview({
  sessions, pricing,
}: {
  sessions: FlatSession[];
  pricing: PricingTable;
}) {
  // Time granularity for the trend chart, plus a remembered range per mode.
  const [gran, setGran] = useState<Granularity>("day");
  const [dayRange, setDayRange] = useState<RangeKey>("all");
  const [hourRange, setHourRange] = useState<HourRangeKey>("24h");

  // Recompute the window anchor when the data refreshes (not on every render).
  const now = useMemo(() => Date.now(), [sessions]);
  const activeRange =
    gran === "hour"
      ? HOUR_RANGES.find((r) => r.key === hourRange)!
      : RANGES.find((r) => r.key === dayRange)!;
  const fromMs = useMemo(
    () => (activeRange.windowMs == null ? null : now - activeRange.windowMs),
    [activeRange, now]
  );
  // Suffix appended to windowed card/chart labels (blank only for daily all-time).
  const suffix =
    gran === "day" && dayRange === "all" ? "" : ` (${activeRange.label})`;

  // The trend chart's buckets: per-hour or per-day, both stacked by model.
  const buckets = useMemo(
    () => (gran === "hour" ? byHour(sessions, pricing, fromMs) : byDay(sessions, pricing, fromMs)),
    [gran, sessions, pricing, fromMs]
  );
  const models = useMemo(() => costByModel(sessions, pricing, fromMs), [sessions, pricing, fromMs]);
  const projects = useMemo(() => costByProject(sessions, pricing, fromMs).slice(0, 12), [sessions, pricing, fromMs]);
  const tools = useMemo(() => topTools(sessions, 15, fromMs), [sessions, fromMs]);

  // Only models that actually cost something feed the donut.
  const pieModels = useMemo(() => models.filter((m) => m.cost > 0), [models]);

  // Cost/token totals + message counts scoped to the selected window.
  const totals = useMemo(() => windowTotals(sessions, pricing, fromMs), [sessions, pricing, fromMs]);
  // "Last 1h" is a live, window-independent metric — always across all sessions.
  const costLastHour = useMemo(
    () => sessions.reduce((a, s) => a + s.costLastHour, 0),
    [sessions]
  );

  const modelNames = useMemo(() => {
    const set = new Set<string>();
    for (const d of buckets) Object.keys(d.byModel).forEach((m) => set.add(m));
    return [...set];
  }, [buckets]);

  // One name->color map shared by the trend bars, the bar tooltip (via bar fill),
  // the donut, and the table — so a model is the same color everywhere. Assign
  // each model a color exactly once; modelColor uses MODEL_COLORS by name when
  // known, else a fallback by this single global index (cost-desc, then any
  // bucket-only models), avoiding the per-chart index drift that gave the same
  // fallback model different colors in different charts.
  const colorOf = useMemo(() => {
    const map: Record<string, string> = {};
    let i = 0;
    for (const m of models) if (!(m.model in map)) map[m.model] = modelColor(m.model, i++);
    for (const m of modelNames) if (!(m in map)) map[m] = modelColor(m, i++);
    return map;
  }, [models, modelNames]);

  const chartData = useMemo(
    () =>
      buckets.map((d) => ({
        label: d.label,
        ...Object.fromEntries(modelNames.map((m) => [m, +(d.byModel[m] ?? 0).toFixed(2)])),
      })),
    [buckets, modelNames]
  );
  // Thin x-axis ticks when there are many buckets (e.g. up to 168 hourly bars).
  const tickInterval = chartData.length > 24 ? Math.ceil(chartData.length / 16) : 0;

  return (
    <div className="page">
      <div className="range-bar">
        <button className={gran === "day" ? "active" : ""} onClick={() => setGran("day")}>Daily</button>
        <button className={gran === "hour" ? "active" : ""} onClick={() => setGran("hour")}>Hourly</button>
        <span className="range-sep" />
        {(gran === "hour" ? HOUR_RANGES : RANGES).map((r) => {
          const selected = gran === "hour" ? hourRange === r.key : dayRange === r.key;
          return (
            <button
              key={r.key}
              className={selected ? "active" : ""}
              onClick={() =>
                gran === "hour"
                  ? setHourRange(r.key as HourRangeKey)
                  : setDayRange(r.key as RangeKey)
              }
            >
              {r.label}
            </button>
          );
        })}
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
        <h2>Estimated cost per {gran === "hour" ? "hour" : "day"} (by model){suffix}</h2>
        <ResponsiveContainer width="100%" height={gran === "hour" ? 310 : 280}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis
              dataKey="label"
              stroke="#888"
              fontSize={11}
              interval={tickInterval}
              angle={gran === "hour" ? -35 : 0}
              textAnchor={gran === "hour" ? "end" : "middle"}
              height={gran === "hour" ? 64 : 30}
            />
            <YAxis stroke="#888" fontSize={11} tickFormatter={(v) => "$" + v} />
            <Tooltip
              content={<BucketTooltip />}
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

// Tooltip for the per-bucket cost chart (daily or hourly). recharts hands us
// every stacked series (all models) for the hovered bucket; show only the ones
// that actually cost something, sorted high→low, so the box stays short and
// relevant instead of listing ~20 models at $0.00.
function BucketTooltip({ active, payload, label }: any) {
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
