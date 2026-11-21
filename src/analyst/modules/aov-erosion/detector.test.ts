import { describe, it, expect } from 'vitest';
import { detectAovErosion } from './detector.js';
import type { AovRow } from './fetcher.js';

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

function makeRows(aovs: number[], currency = 'USD'): AovRow[] {
  const dates = dateSeq('2024-01-01', aovs.length);
  return aovs.map((averageOrderValue, i) => ({
    period: dates[i]!,
    orderCount: 20,
    sales: averageOrderValue * 20,
    averageOrderValue,
    currency,
  }));
}

describe('detectAovErosion', () => {
  it('returns not detected with fewer than 21 days of paid orders', () => {
    const rows = makeRows(new Array(10).fill(100));
    expect(detectAovErosion(rows)).toEqual({ detected: false });
  });

  it('returns not detected for a flat AOV series', () => {
    const rows = makeRows(new Array(63).fill(100));
    expect(detectAovErosion(rows)).toEqual({ detected: false });
  });

  it('detects a sustained AOV drop in the most recent week', () => {
    const aovs = Array.from({ length: 63 }, (_, i) => (i >= 56 ? 70 : 100 + (i % 3 === 0 ? 1 : -1)));
    const rows = makeRows(aovs);
    const result = detectAovErosion(rows);
    expect(result.detected).toBe(true);
    if (result.detected) {
      expect(result.anomaly.direction).toBe('drop');
      expect(result.anomaly.dropPct as number).toBeGreaterThan(0);
    }
  });

  it('does not fire on a sustained AOV increase', () => {
    const aovs = Array.from({ length: 63 }, (_, i) => (i >= 56 ? 150 : 100));
    const rows = makeRows(aovs);
    expect(detectAovErosion(rows).detected).toBe(false);
  });

  it('excludes zero-order days before standardizing', () => {
    const aovs = Array.from({ length: 63 }, (_, i) => (i >= 56 ? 70 : 100 + (i % 3 === 0 ? 1 : -1)));
    const rows = makeRows(aovs);
    // Zero out a few scattered baseline days — orderCount 0 should be filtered, not treated as $0 AOV.
    rows[5]!.orderCount = 0;
    rows[5]!.averageOrderValue = 0;
    rows[20]!.orderCount = 0;
    rows[20]!.averageOrderValue = 0;
    const result = detectAovErosion(rows);
    expect(result.detected).toBe(true);
  });
});
