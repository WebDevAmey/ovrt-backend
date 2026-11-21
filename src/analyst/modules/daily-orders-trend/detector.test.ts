import { describe, it, expect } from 'vitest';
import { detectDailyOrdersOutlier } from './detector.js';
import type { DailyOrderRow } from './detector.js';

function dateSeq(startIso: string, count: number): string[] {
  const start = new Date(`${startIso}T00:00:00Z`);
  const dates: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

function makeRows(counts: number[], currency = 'USD'): DailyOrderRow[] {
  const dates = dateSeq('2024-01-01', counts.length);
  return counts.map((orderCount, i) => ({
    period: dates[i]!,
    orderCount,
    sales: orderCount * 50,
    currency,
  }));
}

describe('detectDailyOrdersOutlier', () => {
  it('returns not detected when fewer than 63 rows', () => {
    const rows = makeRows(new Array(14).fill(10));
    expect(detectDailyOrdersOutlier(rows)).toEqual({ detected: false });
  });

  it('returns not detected for a flat 63-day series', () => {
    const rows = makeRows(new Array(63).fill(10));
    expect(detectDailyOrdersOutlier(rows)).toEqual({ detected: false });
  });

  it('detects a sustained spike in the most recent week', () => {
    const counts = Array.from({ length: 63 }, (_, i) =>
      i >= 56 ? 30 : 10 + (i % 3 === 0 ? 1 : -1),
    );
    const rows = makeRows(counts);
    const result = detectDailyOrdersOutlier(rows);
    expect(result.detected).toBe(true);
    if (result.detected) {
      expect(result.anomaly.direction).toBe('spike');
    }
  });

  it('detects a sustained drop in the most recent week', () => {
    const counts = Array.from({ length: 63 }, (_, i) =>
      i >= 56 ? 2 : 10 + (i % 3 === 0 ? 1 : -1),
    );
    const rows = makeRows(counts);
    const result = detectDailyOrdersOutlier(rows);
    expect(result.detected).toBe(true);
    if (result.detected) {
      expect(result.anomaly.direction).toBe('drop');
    }
  });

  it('does not fire for mild day-to-day noise', () => {
    const counts = Array.from({ length: 63 }, (_, i) => 10 + (i % 4) - 1);
    const rows = makeRows(counts);
    expect(detectDailyOrdersOutlier(rows).detected).toBe(false);
  });

  it('uses the date of the most recent row', () => {
    const counts = Array.from({ length: 63 }, (_, i) => (i >= 56 ? 40 : 10));
    const rows = makeRows(counts);
    const result = detectDailyOrdersOutlier(rows);
    expect(result.detected).toBe(true);
    if (result.detected) {
      expect(result.anomaly.date).toBe(rows[rows.length - 1]!.period);
    }
  });
});
