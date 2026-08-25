import { useEffect, useMemo, useState } from "react";
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

type ModelViewMode = "simple" | "broken-out";

export default function Overview({
  sessions, pricing,
}: {
  sessions: FlatSession[];
  pricing: PricingTable;
}) {
  // Time granularity for the trend chart, plus a remembered range per mode.
  const [gran, setGran] = useState<Granularity>(() =>
    localStorage.getItem("overviewGranularity") === "hour" ? "hour" : "day"
  );
  const [dayRange, setDayRange] = useState<RangeKey>(() => {
    const saved = localStorage.getItem("overviewDayRange") as RangeKey | null;
    return saved && RANGES.some((r) => r.key === saved) ? saved : "all";
  });
  const [hourRange, setHourRange] = useState<HourRangeKey>(() => {
    const saved = localStorage.getItem("overviewHourRange") as HourRangeKey | null;
    return saved && HOUR_RANGES.some((r) => r.key === saved) ? saved : "24h";
  });
  const [modelView, setModelView] = useState<ModelViewMode>(() =>
    localStorage.getItem("overviewModelView") === "simple" ? "simple" : "broken-out"
  );

  useEffect(() => { localStorage.setItem("overviewGranularity", gran); }, [gran]);
  useEffect(() => { localStorage.setItem("overviewDayRange", dayRange); }, [dayRange]);
  useEffect(() => { localStorage.setItem("overviewHourRange", hourRange); }, [hourRange]);
  useEffect(() => { localStorage.setItem("overviewModelView", modelView); }, [modelView]);

  const resetView = () => {
    localStorage.removeItem("overviewGranularity");
    localStorage.removeItem("overviewDayRange");
    localStorage.removeItem("overviewHourRange");
    localStorage.removeItem("overviewModelView");
    setGran("day");
    setDayRange("all");
    setHourRange("24h");
    setModelView("broken-out");
  };

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
  const pieSegments = useMemo(
    () =>
      pieModels.flatMap((m) => [
        { key: `${m.model}:cache`, model: m.model, kind: "Cached input" as const, cost: m.cacheCost },
        { key: `${m.model}:input`, model: m.model, kind: "Input" as const, cost: m.inputCost },
        { key: `${m.model}:output`, model: m.model, kind: "Output" as const, cost: m.outputCost },
      ]).filter((part) => part.cost > 0),
    [pieModels]
  );

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
        ...Object.fromEntries(
          modelNames.flatMap((m) => [
            [m, +(
              (d.byModel[m]?.cache ?? 0) +
              (d.byModel[m]?.input ?? 0) +
              (d.byModel[m]?.output ?? 0)
            ).toFixed(4)],
            [`${m}:cache`, +(d.byModel[m]?.cache ?? 0).toFixed(4)],
            [`${m}:input`, +(d.byModel[m]?.input ?? 0).toFixed(4)],
            [`${m}:output`, +(d.byModel[m]?.output ?? 0).toFixed(4)],
          ])
        ),
      })),
    [buckets, modelNames]
  );
  // Thin x-axis ticks when there are many buckets (e.g. up to 168 hourly bars).
  const tickInterval = chartData.length > 24 ? Math.ceil(chartData.length / 16) : 0;
  // A week is readable horizontally. Longer daily ranges need rotation so the
  // month/year labels remain legible instead of colliding or being mistaken
  // for hourly timestamps.
  const rotateDailyLabels = gran === "day" && dayRange !== "1w";
  const xAxisAngle = gran === "hour" || rotateDailyLabels ? -35 : 0;
  const xAxisHeight = xAxisAngle === 0 ? 30 : 64;

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
        <span className="range-sep" />
        <span className="range-label">Model view</span>
        <button
          type="button"
          className={modelView === "simple" ? "active" : ""}
          aria-pressed={modelView === "simple"}
          onClick={() => setModelView("simple")}
        >
          Simple
        </button>
        <button
          type="button"
          className={modelView === "broken-out" ? "active" : ""}
          aria-pressed={modelView === "broken-out"}
          onClick={() => setModelView("broken-out")}
        >
          Broken out
        </button>
        <button className="reset-view" type="button" onClick={resetView}>Reset view</button>
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
        {modelView === "broken-out" && <ShadeLegend />}
        <ResponsiveContainer width="100%" height={gran === "hour" ? 310 : 280}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis
              dataKey="label"
              stroke="#888"
              fontSize={11}
              interval={tickInterval}
              angle={xAxisAngle}
              textAnchor={xAxisAngle === 0 ? "middle" : "end"}
              height={xAxisHeight}
            />
            <YAxis stroke="#888" fontSize={11} tickFormatter={(v) => "$" + v} />
            <Tooltip
              content={<BucketTooltip />}
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
            />
            {modelView === "simple"
              ? modelNames.map((m) => (
                  <Bar key={m} dataKey={m} name={m} stackId="cost" fill={colorOf[m]} />
                ))
              : modelNames.flatMap((m) => [
                  <Bar
                    key={`${m}:cache`}
                    dataKey={`${m}:cache`}
                    name={`${m} · Cached input`}
                    stackId="cost"
                    fill={tokenShade(colorOf[m], "cache")}
                  />,
                  <Bar
                    key={`${m}:input`}
                    dataKey={`${m}:input`}
                    name={`${m} · Input`}
                    stackId="cost"
                    fill={tokenShade(colorOf[m], "input")}
                  />,
                  <Bar
                    key={`${m}:output`}
                    dataKey={`${m}:output`}
                    name={`${m} · Output`}
                    stackId="cost"
                    fill={tokenShade(colorOf[m], "output")}
                  />,
                ])}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="panel-row">
        <div className="panel half">
          <h2>Cost by model{suffix}</h2>
          {modelView === "broken-out" && <ShadeLegend />}
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              {modelView === "simple" ? (
                <Pie
                  data={pieModels}
                  dataKey="cost"
                  nameKey="model"
                  innerRadius={55}
                  outerRadius={95}
                  paddingAngle={2}
                >
                  {pieModels.map((model) => (
                    <Cell key={model.model} fill={colorOf[model.model]} />
                  ))}
                </Pie>
              ) : (
                <Pie
                  data={pieSegments}
                  dataKey="cost"
                  nameKey="key"
                  innerRadius={55}
                  outerRadius={95}
                  paddingAngle={2}
                >
                  {pieSegments.map((part) => (
                    <Cell
                      key={part.key}
                      fill={tokenShade(
                        colorOf[part.model],
                        part.kind === "Cached input" ? "cache" : part.kind.toLowerCase() as "input" | "output"
                      )}
                    />
                  ))}
                </Pie>
              )}
              <Tooltip
                contentStyle={{ background: "#1c1f26", border: "1px solid #333" }}
                formatter={(v: any, _name: any, item: any) => [
                  fmtUsd(Number(v)),
                  item.payload.kind
                    ? `${item.payload.model} · ${item.payload.kind}`
                    : item.payload.model,
                ]}
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
                    {modelView === "simple" ? (
                      <span
                        className="legend-swatch"
                        style={{ background: colorOf[m.model] }}
                        aria-hidden="true"
                      />
                    ) : (
                      <ModelShadeSwatch color={colorOf[m.model]} />
                    )}
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

function mixHex(color: string, target: "#000000" | "#ffffff", amount: number): string {
  const value = color.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return color;
  const to = target === "#ffffff" ? 255 : 0;
  const channels = [0, 2, 4].map((offset) => {
    const from = Number.parseInt(value.slice(offset, offset + 2), 16);
    return Math.round(from + (to - from) * amount).toString(16).padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

type TokenShadeKind = "cache" | "input" | "output";

function tokenShade(color: string, kind: TokenShadeKind): string {
  if (kind === "cache") return mixHex(color, "#000000", 0.38);
  if (kind === "output") return mixHex(color, "#ffffff", 0.34);
  return color;
}

function ModelShadeSwatch({ color }: { color: string }) {
  return (
    <span className="model-shade-swatch" aria-hidden="true">
      <span style={{ background: tokenShade(color, "cache") }} />
      <span style={{ background: tokenShade(color, "input") }} />
      <span style={{ background: tokenShade(color, "output") }} />
    </span>
  );
}

function ShadeLegend() {
  return (
    <div className="shade-legend" aria-label="Token cost shade legend">
      <span><span className="shade-key shade-key-cache" />Cached input</span>
      <span><span className="shade-key shade-key-input" />Input</span>
      <span><span className="shade-key shade-key-output" />Output</span>
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
