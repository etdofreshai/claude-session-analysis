import { useMemo } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
  PieChart, Pie, Cell, Legend, CartesianGrid,
} from "recharts";
import type { FlatSession } from "../aggregate";
import { byDay, costByModel, costByProject, topTools, modelColor } from "../aggregate";
import type { PricingTable } from "../pricing";
import { fmtTokens, fmtUsd } from "../pricing";

export default function Overview({
  sessions, pricing,
}: {
  sessions: FlatSession[];
  pricing: PricingTable;
}) {
  const days = useMemo(() => byDay(sessions, pricing), [sessions, pricing]);
  const models = useMemo(() => costByModel(sessions, pricing), [sessions, pricing]);
  const projects = useMemo(() => costByProject(sessions).slice(0, 12), [sessions]);
  const tools = useMemo(() => topTools(sessions), [sessions]);

  const totals = useMemo(() => {
    let cost = 0, costLastHour = 0, allTok = 0, prompts = 0, asst = 0, subagents = 0, errors = 0, toolUses = 0;
    for (const s of sessions) {
      cost += s.cost + s.subagentCost;
      costLastHour += s.costLastHour;
      allTok += s.totalTokensAll;
      prompts += s.counts.userPrompts;
      asst += s.counts.assistantMsgs;
      subagents += s.subagents.length;
      errors += s.counts.apiErrors;
      toolUses += s.counts.toolUses;
    }
    return { cost, costLastHour, allTok, prompts, asst, subagents, errors, toolUses };
  }, [sessions]);

  const modelNames = useMemo(() => {
    const set = new Set<string>();
    for (const d of days) Object.keys(d.byModel).forEach((m) => set.add(m));
    return [...set];
  }, [days]);

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
      <div className="cards">
        <Card label="Est. total cost" value={fmtUsd(totals.cost)} />
        <Card label="Est. cost (last 1h)" value={fmtUsd(totals.costLastHour)} />
        <Card label="Total tokens (incl. cache)" value={fmtTokens(totals.allTok)} />
        <Card label="User prompts" value={totals.prompts.toLocaleString()} />
        <Card label="Assistant messages" value={totals.asst.toLocaleString()} />
        <Card label="Tool calls" value={totals.toolUses.toLocaleString()} />
        <Card label="Subagent runs" value={totals.subagents.toLocaleString()} />
        <Card label="API errors" value={totals.errors.toLocaleString()} />
      </div>

      <div className="panel">
        <h2>Estimated cost per day (by model)</h2>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={dayChartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#333" />
            <XAxis dataKey="day" stroke="#888" fontSize={11} />
            <YAxis stroke="#888" fontSize={11} tickFormatter={(v) => "$" + v} />
            <Tooltip
              contentStyle={{ background: "#1c1f26", border: "1px solid #333" }}
              formatter={(v: any, name: any) => [fmtUsd(Number(v)), name]}
            />
            {modelNames.map((m, i) => (
              <Bar key={m} dataKey={m} stackId="cost" fill={modelColor(m, i)} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="panel-row">
        <div className="panel half">
          <h2>Cost by model</h2>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie
                data={models.filter((m) => m.cost > 0)}
                dataKey="cost"
                nameKey="model"
                innerRadius={55}
                outerRadius={95}
                paddingAngle={2}
              >
                {models.filter((m) => m.cost > 0).map((m, i) => (
                  <Cell key={m.model} fill={modelColor(m.model, i)} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: "#1c1f26", border: "1px solid #333" }}
                formatter={(v: any) => fmtUsd(Number(v))}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
          <table className="mini">
            <thead>
              <tr><th>Model</th><th>API calls</th><th>Tokens</th><th>Est. cost</th></tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.model}>
                  <td>{m.model}</td>
                  <td>{m.calls.toLocaleString()}</td>
                  <td>{fmtTokens(m.tokens)}</td>
                  <td>{fmtUsd(m.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel half">
          <h2>Cost by project (top 12)</h2>
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
        <h2>Most used tools</h2>
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

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="card-value">{value}</div>
      <div className="card-label">{label}</div>
    </div>
  );
}
