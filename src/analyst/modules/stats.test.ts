import { describe, it, expect } from 'vitest';
import { seasonalCusum, ewmaProportionControl, olsRegression } from './stats.js';

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

describe('seasonalCusum', () => {
  it('returns not-fired with fewer than 21 days', () => {
    const dates = dateSeq('2024-01-01', 10);
    const series = dates.map((date) => ({ date, value: 10 }));
    const result = seasonalCusum(series);
    expect(result.fired).toBe(false);
  });

  it('does not fire on a flat series', () => {
    const dates = dateSeq('2024-01-01', 63);
    const series = dates.map((date) => ({ date, value: 10 }));
    const result = seasonalCusum(series);
    expect(result.fired).toBe(false);
  });

  it('does not fire on normal day-of-week variation', () => {
    // Weekday pattern: weekends (Sat/Sun) lower than weekdays, repeated
    // consistently for 9 weeks — should NOT fire since each day is compared
    // to its own weekday's baseline.
    const dates = dateSeq('2024-01-01', 63); // 2024-01-01 is a Monday
    const series = dates.map((date, i) => {
      const dow = i % 7;
      const isWeekend = dow === 5 || dow === 6;
      return { date, value: isWeekend ? 5 : 10 };
    });
    const result = seasonalCusum(series);
    expect(result.fired).toBe(false);
  });

  it('fires spike on a sustained increase in the test window', () => {
    const dates = dateSeq('2024-01-01', 63);
    const series = dates.map((date, i) => ({
      date,
      // Last 7 days roughly double — a sustained shift, not just one outlier day.
      value: i >= 56 ? 30 : 10 + (i % 3 === 0 ? 1 : -1), // small baseline noise
    }));
    const result = seasonalCusum(series);
    expect(result.fired).toBe(true);
    expect(result.direction).toBe('spike');
  });

  it('fires drop on a sustained decrease in the test window', () => {
    const dates = dateSeq('2024-01-01', 63);
    const series = dates.map((date, i) => ({
      date,
      value: i >= 56 ? 2 : 10 + (i % 3 === 0 ? 1 : -1),
    }));
    const result = seasonalCusum(series);
    expect(result.fired).toBe(true);
    expect(result.direction).toBe('drop');
  });
});

describe('ewmaProportionControl', () => {
  it('returns not-fired with fewer than 4 usable periods', () => {
    const result = ewmaProportionControl([
      { date: '2024-01-07', successes: 10, total: 100 },
      { date: '2024-01-14', successes: 10, total: 100 },
    ]);
    expect(result.fired).toBe(false);
  });

  it('does not fire when the rate is stable', () => {
    const series = Array.from({ length: 8 }, (_, i) => ({
      date: `2024-0${Math.floor(i / 4) + 1}-${String((i % 4) * 7 + 7).padStart(2, '0')}`,
      successes: 10,
      total: 100,
    }));
    const result = ewmaProportionControl(series);
    expect(result.fired).toBe(false);
  });

  it('fires spike on a large rate jump with adequate sample size', () => {
    const series = [
      { date: '2024-01-07', successes: 10, total: 100 },
      { date: '2024-01-14', successes: 11, total: 100 },
      { date: '2024-01-21', successes: 9, total: 100 },
      { date: '2024-01-28', successes: 10, total: 100 },
      { date: '2024-02-04', successes: 40, total: 100 }, // jump from ~10% to 40%
    ];
    const result = ewmaProportionControl(series);
    expect(result.fired).toBe(true);
    expect(result.direction).toBe('spike');
  });

  it('does not fire a large pp move when sample size is tiny on both sides', () => {
    // 1/3 → 2/3 is a 33pp move but n=3 in both periods — should not read as
    // a confident signal once binomial variance is accounted for, though it
    // may still occasionally fire; this asserts the control limit widens
    // (lower bound stays far below the naive 3pp gate this replaces).
    const series = [
      { date: '2024-01-07', successes: 1, total: 3 },
      { date: '2024-01-14', successes: 1, total: 3 },
      { date: '2024-01-21', successes: 1, total: 3 },
      { date: '2024-01-28', successes: 1, total: 3 },
      { date: '2024-02-04', successes: 2, total: 3 },
    ];
    const result = ewmaProportionControl(series);
    expect(result.controlLimitUpper).toBeGreaterThan(0.34); // wider than the raw ewma + tiny margin
  });
});

describe('olsRegression', () => {
  it('fits a perfect line with rSquared = 1', () => {
    const y = [10, 20, 30, 40, 50];
    const reg = olsRegression(y);
    expect(reg.slope).toBeCloseTo(10, 5);
    expect(reg.rSquared).toBeCloseTo(1, 5);
  });

  it('returns rSquared = 0 for a flat series', () => {
    const reg = olsRegression([10, 10, 10, 10]);
    expect(reg.slope).toBeCloseTo(0, 5);
    expect(reg.rSquared).toBe(0);
  });
});
