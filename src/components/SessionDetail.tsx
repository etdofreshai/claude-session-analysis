import { useEffect, useState } from "react";
import type { SessionDetail, TimelineEvent } from "../types";
import { fetchSessionDetail } from "../api";
import type { PricingTable } from "../pricing";
import { fmtDuration, fmtTimeCT, fmtTokens, fmtUsd, modelsCost, totalTokens, usageCost } from "../pricing";

// ---------- lightweight markdown renderer ----------

function escHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMd(text: string): string {
  let t = escHtml(text);
  t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  t = t.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/^#{4} (.+)$/gm, "<h4>$1</h4>");
  t = t.replace(/^#{3} (.+)$/gm, "<h3>$1</h3>");
  t = t.replace(/^#{2} (.+)$/gm, "<h2>$1</h2>");
  t = t.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  return t
    .split(/\n{2,}/)
    .map((p) => {
      p = p.trim();
      if (!p) return "";
      if (/^<h[1-4]/.test(p)) return p;
      return `<p>${p.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

function renderMarkdown(raw: string): string {
  const parts: string[] = [];
  let last = 0;
  const codeRe = /```(\w*)\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(raw)) !== null) {
    if (m.index > last) parts.push(inlineMd(raw.slice(last, m.index)));
    parts.push(`<pre class="md-pre"><code>${escHtml(m[2])}</code></pre>`);
    last = m.index + m[0].length;
  }
  if (last < raw.length) parts.push(inlineMd(raw.slice(last)));
  return parts.join("");
}

// ---------- message sub-modal ----------

function MessageModal({ event, onClose }: { event: TimelineEvent; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const label =
    event.kind === "tool_use"
      ? `→ ${event.tool}`
      : event.kind === "assistant" && event.model
      ? `${event.kind} (${event.model.replace("claude-", "")})`
      : event.kind;

  return (
    <div className="modal-backdrop msg-modal-backdrop" onClick={onClose}>
      <div className="modal msg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <span className={`event-label ${event.kind}`}>{label}</span>
            {event.agent && <span className="sub"> [{event.agent}]</span>}
            <span className="sub"> {fmtTimeCT(event.ts)}</span>
          </h2>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="modal-body msg-modal-body">
          {event.text ? (
            <div
              className="md-content"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(event.text) }}
            />
          ) : (
            <span className="muted">(no text content)</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- main session detail ----------

export default function SessionDetailView({
  project, id, source, pricing, onClose,
}: {
  project: string;
  id: string;
  source?: string;
  pricing: PricingTable;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<TimelineEvent | null>(null);

  useEffect(() => {
    setDetail(null);
    fetchSessionDetail(project, id, source).then(setDetail).catch((e) => setError(String(e)));
  }, [project, id, source]);

  // Lock body scroll while this modal is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  return (
    <>
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <div className="modal-header">
            <h2>
              {detail?.session.title ?? id.slice(0, 8)}
              <span className="sub">{project}</span>
            </h2>
            <button onClick={onClose}>✕</button>
          </div>

          {error && <div className="error-banner">{error}</div>}
          {!detail && !error && <div className="loading">Loading session…</div>}

          {detail && (
            <div className="modal-body">
              <div className="cards">
                <MiniCard label="Est. cost" value={fmtUsd(
                  modelsCost(detail.session.models, pricing) +
                  detail.session.subagents.reduce((a, s) => a + modelsCost(s.models, pricing), 0)
                )} />
                <MiniCard label="Duration" value={fmtDuration(detail.session.durationMs)} />
                <MiniCard label="Prompts" value={String(detail.session.counts.userPrompts)} />
                <MiniCard label="Assistant msgs" value={String(detail.session.counts.assistantMsgs)} />
                <MiniCard label="Tool calls" value={String(detail.session.counts.toolUses)} />
                <MiniCard label="Subagents" value={String(detail.session.subagents.length)} />
                <MiniCard label="API errors" value={String(detail.session.counts.apiErrors)} />
              </div>

              <h3>
                Model usage
                {detail.session.effortModes.length > 0 && (
                  <span className="sub">
                    effort: {detail.session.effortModes.join(", ")}
                  </span>
                )}
              </h3>
              <table className="mini">
                <thead>
                  <tr>
                    <th>Model</th><th>Calls</th><th>Input</th><th>Output</th>
                    <th>Cache read</th><th>Cache write</th><th>Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(detail.session.models).map(([m, u]) => (
                    <tr key={m}>
                      <td>{m}</td>
                      <td>{u.calls}</td>
                      <td>{fmtTokens(u.input)}</td>
                      <td>{fmtTokens(u.output)}</td>
                      <td>{fmtTokens(u.cacheRead)}</td>
                      <td>{fmtTokens(u.cacheWrite5m + u.cacheWrite1h)}</td>
                      <td>{fmtUsd(usageCost(m, u, pricing))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {detail.session.subagents.length > 0 && (
                <>
                  <h3>Subagents ({detail.session.subagents.length})</h3>
                  <table className="mini">
                    <thead>
                      <tr>
                        <th>Agent</th><th>Msgs</th><th>Models</th><th>Tokens</th><th>Est. cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.session.subagents.map((s) => (
                        <tr key={s.id}>
                          <td>{s.agentName ?? s.id.slice(0, 12)}</td>
                          <td>{s.assistantMsgs}</td>
                          <td>{Object.keys(s.models).map((m) => m.replace("claude-", "")).join(", ")}</td>
                          <td>{fmtTokens(Object.values(s.models).reduce((a, u) => a + totalTokens(u), 0))}</td>
                          <td>{fmtUsd(modelsCost(s.models, pricing))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              <h3>
                Timeline ({detail.timeline.length} events)
                <label className="autorefresh">
                  <input
                    type="checkbox"
                    checked={showTools}
                    onChange={(e) => setShowTools(e.target.checked)}
                  />
                  show tool calls
                </label>
              </h3>
              <div className="timeline">
                {detail.timeline
                  .filter((e) => showTools || e.kind !== "tool_use")
                  .map((e, i) => (
                    <div
                      key={i}
                      className={"event " + e.kind}
                      onClick={() => setSelectedEvent(e)}
                      title="Click to view full message"
                    >
                      <span className="ts">{fmtTimeCT(e.ts)}</span>
                      <span className="kind">
                        {e.agent ? `[${e.agent}] ` : ""}
                        {e.kind === "tool_use" ? `→ ${e.tool}` : e.kind}
                        {e.kind === "assistant" && e.model ? ` (${e.model.replace("claude-", "")})` : ""}
                      </span>
                      <span className="text">{e.text}</span>
                      {e.kind === "assistant" && (e.outputTokens ?? 0) > 0 && (
                        <span className="muted"> +{fmtTokens(e.outputTokens!)} out</span>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {selectedEvent && (
        <MessageModal event={selectedEvent} onClose={() => setSelectedEvent(null)} />
      )}
    </>
  );
}

function MiniCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card small">
      <div className="card-value">{value}</div>
      <div className="card-label">{label}</div>
    </div>
  );
}
