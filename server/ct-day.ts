// Central-Time calendar-day bucketing for the per-day usage rollups.
// The timezone MUST match DISPLAY_TZ in src/pricing.ts so the day keys the
// server emits line up with the calendar days the UI renders.
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "2026-06-10" — the Central-Time calendar day an ISO timestamp falls on. */
export function ctDay(ts: string): string {
  return fmt.format(new Date(ts));
}
