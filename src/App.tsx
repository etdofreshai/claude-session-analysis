import { useEffect, useMemo, useState } from "react";
import type { StatsResponse } from "./types";
import { fetchStats } from "./api";
import { loadPricing, type PricingTable } from "./pricing";
import { flatten } from "./aggregate";
import Overview from "./components/Overview";
import SessionsTable from "./components/SessionsTable";
import SessionDetailView from "./components/SessionDetail";
import PricingSettings from "./components/PricingSettings";

type Tab = "overview" | "sessions" | "pricing";

const TABS: Tab[] = ["overview", "sessions", "pricing"];

function tabFromHash(): Tab {
  const h = window.location.hash.replace(/^#\/?/, "") as Tab;
  return TABS.includes(h) ? h : "overview";
}

export default function App() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [pricing, setPricing] = useState<PricingTable>(() => loadPricing());
  const [selected, setSelected] = useState<{ project: string; id: string; source: string; host: string } | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      setStats(await fetchStats());
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  // Keep the tab in sync with the URL hash (so refresh / back-forward work).
  useEffect(() => {
    if (tabFromHash() !== tab) window.location.hash = `#/${tab}`;
  }, [tab]);

  useEffect(() => {
    const onHashChange = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [autoRefresh]);

  const sessions = useMemo(
    () => (stats ? flatten(stats, pricing) : []),
    [stats, pricing]
  );

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          AI Session Analysis
          {stats && (
            <span className="sub">
              {sessions.length} sessions · {stats.projects.length} projects ·
              {stats.hosts.length} hosts · scanned in {stats.scanMs}ms
            </span>
          )}
        </h1>
        {stats && stats.sync.length > 0 && (
          <div className="sync-status">
            {stats.sync.map((s) => (
              <span
                key={s.id}
                className={"sync-host " + (s.ok ? "ok" : "err")}
                title={
                  (s.id === "local" ? "this machine — local archive\n" : "") +
                  (s.error ? `error: ${s.error}\n` : "") +
                  (s.lastSyncMs
                    ? `last sync: ${new Date(s.lastSyncMs).toLocaleTimeString()} (${s.durationMs}ms)`
                    : "never synced")
                }
              >
                {s.ok ? "●" : "○"} {s.label}
              </span>
            ))}
          </div>
        )}
        <nav>
          <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Overview</button>
          <button className={tab === "sessions" ? "active" : ""} onClick={() => setTab("sessions")}>Sessions</button>
          <button className={tab === "pricing" ? "active" : ""} onClick={() => setTab("pricing")}>Pricing</button>
          <button onClick={refresh} disabled={loading}>{loading ? "Scanning…" : "Refresh"}</button>
          <label className="autorefresh">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
            />
            auto 30s
          </label>
        </nav>
      </header>

      {error && <div className="error-banner">Failed to load: {error}</div>}

      {!stats && !error && <div className="loading">Scanning session files…</div>}

      {stats && tab === "overview" && (
        <Overview sessions={sessions} pricing={pricing} />
      )}
      {stats && tab === "sessions" && (
        <SessionsTable
          sessions={sessions}
          pricing={pricing}
          onSelect={(s) => setSelected({ project: s.project, id: s.id, source: s.source, host: s.host })}
        />
      )}
      {tab === "pricing" && (
        <PricingSettings pricing={pricing} onChange={setPricing} />
      )}

      {selected && (
        <SessionDetailView
          project={selected.project}
          id={selected.id}
          source={selected.source}
          host={selected.host}
          pricing={pricing}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
