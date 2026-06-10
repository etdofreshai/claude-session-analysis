import { useState } from "react";
import type { ModelPricing, PricingTable } from "../pricing";
import { DEFAULT_PRICING, resetPricing, savePricing } from "../pricing";

const FIELDS: { key: keyof ModelPricing; label: string }[] = [
  { key: "input", label: "Input" },
  { key: "output", label: "Output" },
  { key: "cacheRead", label: "Cache read" },
  { key: "cacheWrite5m", label: "Cache write 5m" },
  { key: "cacheWrite1h", label: "Cache write 1h" },
];

export default function PricingSettings({
  pricing, onChange,
}: {
  pricing: PricingTable;
  onChange: (p: PricingTable) => void;
}) {
  const [newPrefix, setNewPrefix] = useState("");

  const update = (prefix: string, field: keyof ModelPricing, value: number) => {
    const next = {
      ...pricing,
      [prefix]: { ...pricing[prefix], [field]: value },
    };
    savePricing(next);
    onChange(next);
  };

  const addRow = () => {
    if (!newPrefix.trim()) return;
    const next = { ...pricing, [newPrefix.trim()]: { ...DEFAULT_PRICING["*"] } };
    savePricing(next);
    onChange(next);
    setNewPrefix("");
  };

  const removeRow = (prefix: string) => {
    const next = { ...pricing };
    delete next[prefix];
    savePricing(next);
    onChange(next);
  };

  const reset = () => {
    resetPricing();
    onChange({ ...DEFAULT_PRICING });
  };

  return (
    <div className="page">
      <div className="panel">
        <h2>Pricing (USD per million tokens)</h2>
        <p className="muted">
          Model names match by longest prefix; <code>*</code> is the fallback.
          Costs everywhere in the app are estimates computed from token usage in
          the transcripts — Claude Code does not record actual billing. Values
          persist in this browser's localStorage.
        </p>
        <table className="mini pricing-table">
          <thead>
            <tr>
              <th>Model prefix</th>
              {FIELDS.map((f) => <th key={f.key}>{f.label}</th>)}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(pricing).map(([prefix, p]) => (
              <tr key={prefix}>
                <td><code>{prefix}</code></td>
                {FIELDS.map((f) => (
                  <td key={f.key}>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={p[f.key]}
                      onChange={(e) => update(prefix, f.key, Number(e.target.value))}
                    />
                  </td>
                ))}
                <td>
                  {prefix !== "*" && (
                    <button className="link" onClick={() => removeRow(prefix)}>remove</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="filters">
          <input
            placeholder="new model prefix, e.g. claude-haiku-4-5"
            value={newPrefix}
            onChange={(e) => setNewPrefix(e.target.value)}
          />
          <button onClick={addRow}>Add</button>
          <button onClick={reset}>Reset to defaults</button>
        </div>
      </div>
    </div>
  );
}
