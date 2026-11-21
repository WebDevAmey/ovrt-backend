/**
 * Week-over-week percent change.
 *
 * Returns `null` when the prior value is 0 — there is no defined percentage
 * change from a zero baseline (a first sales week or recovery from an outage
 * would otherwise read as a misleading "+0%"). Callers render `null` as
 * "n/a (no prior-week baseline)" rather than asserting a flat week.
 */
export function pctChange(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return Math.round(((current - prior) / prior) * 1000) / 10; // one decimal place
}
