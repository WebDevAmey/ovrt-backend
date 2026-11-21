// Shared statistical primitives for insight modules.
// Pure functions, no I/O — every module's detector.ts should prefer these
// over hand-rolled thresholds. See NOTES.md for the AnomalyDetails field
// mapping convention each primitive's result must be translated into.

export type DailyPoint = { date: string; value: number };

export type CusumResult = {
  fired: boolean;
  direction: 'spike' | 'drop' | 'anomaly';
  cusumValue: number;
  weekdayMean: number;
  weekdayStdDev: number;
  latestValue: number;
};

function dayOfWeek(dateStr: string): number {
  // dateStr is YYYY-MM-DD; parse as UTC midnight so day-of-week is stable
  // regardless of server timezone.
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/**
 * Day-of-week-adjusted CUSUM (cumulative sum control chart).
 *
 * Unlike a single-point z-score, CUSUM accumulates standardized deviations
 * over time, so it catches BOTH a single large shock AND a slow multi-day
 * drift that never individually crosses a z-score threshold but compounds.
 *
 * `series` must be in ascending date order. The most recent 7 days are
 * treated as the "test window"; everything before that is the baseline used
 * to compute each weekday's mean/stdDev (so a real anomaly in the test
 * window doesn't contaminate its own baseline). Requires at least 21 days
 * (3 full weeks) total; 56+ days (8 weeks) recommended for stable weekday
 * baselines.
 */
export function seasonalCusum(
  series: DailyPoint[],
  opts: { slackSigmas?: number; decisionSigmas?: number } = {},
): CusumResult {
  const slackSigmas = opts.slackSigmas ?? 0.5;
  const decisionSigmas = opts.decisionSigmas ?? 5;

  if (series.length < 21) {
    return {
      fired: false,
      direction: 'anomaly',
      cusumValue: 0,
      weekdayMean: 0,
      weekdayStdDev: 0,
      latestValue: series[series.length - 1]?.value ?? 0,
    };
  }

  const testWindowSize = Math.min(7, Math.floor(series.length / 3));
  const baseline = series.slice(0, series.length - testWindowSize);

  const byWeekday = new Map<number, number[]>();
  for (const point of baseline) {
    const dow = dayOfWeek(point.date);
    const bucket = byWeekday.get(dow) ?? [];
    bucket.push(point.value);
    byWeekday.set(dow, bucket);
  }

  const weekdayStats = new Map<number, { mean: number; stdDev: number }>();
  for (const [dow, values] of byWeekday) {
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance =
      values.length > 1
        ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1)
        : 0;
    // Flat/near-flat weekday baseline: fall back to a 10% noise floor so
    // standardization doesn't divide by ~0 and blow up the CUSUM.
    const stdDev = variance > 0 ? Math.sqrt(variance) : Math.max(mean * 0.1, 1);
    weekdayStats.set(dow, { mean, stdDev });
  }

  // Run CUSUM sequentially over the FULL series (baseline + test window).
  // Baseline residuals average ~0 by construction, so they don't drift the
  // sum; a real persistent shift in the test window accumulates.
  let sPlus = 0;
  let sMinus = 0;
  const k = slackSigmas;
  for (const point of series) {
    const dow = dayOfWeek(point.date);
    const stats = weekdayStats.get(dow);
    if (!stats) continue; // weekday never seen in baseline — skip, can't standardize
    const residual = (point.value - stats.mean) / stats.stdDev;
    sPlus = Math.max(0, sPlus + residual - k);
    sMinus = Math.min(0, sMinus + residual + k);
  }

  const latest = series[series.length - 1]!;
  const latestStats = weekdayStats.get(dayOfWeek(latest.date)) ?? { mean: 0, stdDev: 0 };

  const fired = sPlus > decisionSigmas || Math.abs(sMinus) > decisionSigmas;
  const cusumValue = sPlus >= Math.abs(sMinus) ? sPlus : sMinus;
  const direction: 'spike' | 'drop' | 'anomaly' = !fired
    ? 'anomaly'
    : sPlus > decisionSigmas
      ? 'spike'
      : 'drop';

  return {
    fired,
    direction,
    cusumValue: Math.round(cusumValue * 100) / 100,
    weekdayMean: Math.round(latestStats.mean * 100) / 100,
    weekdayStdDev: Math.round(latestStats.stdDev * 100) / 100,
    latestValue: latest.value,
  };
}

export type PeriodPoint = { date: string; successes: number; total: number };

export type EwmaProportionResult = {
  fired: boolean;
  direction: 'spike' | 'drop' | 'anomaly';
  ewma: number;
  controlLimitLower: number;
  controlLimitUpper: number;
  latestProportion: number;
};

/**
 * EWMA control chart on a proportion (rate) metric.
 *
 * Replaces fixed percentage-point thresholds ("rate rose by 4pp") with a
 * control limit that's naturally narrower when sample sizes are large and
 * wider when they're small, using each period's own binomial variance
 * (`p*(1-p)/n`). This is what makes a 4pp move on n=30 read very differently
 * from the same 4pp move on n=300.
 *
 * `series` must be in ascending date order, at least 4 periods. The EWMA and
 * its variance are built from all periods except the last; the last period's
 * raw proportion is then tested against that control limit (a fresh
 * observation is never used to set its own bound).
 */
export function ewmaProportionControl(
  series: PeriodPoint[],
  opts: { lambda?: number } = {},
): EwmaProportionResult {
  const lambda = opts.lambda ?? 0.3;

  const usable = series.filter((p) => p.total > 0);
  if (usable.length < 4) {
    const last = series[series.length - 1];
    return {
      fired: false,
      direction: 'anomaly',
      ewma: 0,
      controlLimitLower: 0,
      controlLimitUpper: 0,
      latestProportion: last && last.total > 0 ? last.successes / last.total : 0,
    };
  }

  const history = usable.slice(0, usable.length - 1);
  const latest = usable[usable.length - 1]!;

  const first = history[0]!;
  let ewma = first.successes / first.total;
  let ewmaVar = (ewma * (1 - ewma)) / first.total;

  for (let i = 1; i < history.length; i++) {
    const period = history[i]!;
    const p = period.successes / period.total;
    const varianceP = (p * (1 - p)) / period.total;
    ewma = lambda * p + (1 - lambda) * ewma;
    ewmaVar = lambda ** 2 * varianceP + (1 - lambda) ** 2 * ewmaVar;
  }

  const latestProportion = latest.successes / latest.total;
  const latestVarianceP = (latestProportion * (1 - latestProportion)) / latest.total;
  const controlStdDev = Math.sqrt(ewmaVar + latestVarianceP);

  const controlLimitLower = Math.max(0, ewma - 3 * controlStdDev);
  const controlLimitUpper = Math.min(1, ewma + 3 * controlStdDev);

  const fired = latestProportion < controlLimitLower || latestProportion > controlLimitUpper;
  const direction: 'spike' | 'drop' | 'anomaly' = !fired
    ? 'anomaly'
    : latestProportion > controlLimitUpper
      ? 'spike'
      : 'drop';

  return {
    fired,
    direction,
    ewma: Math.round(ewma * 10000) / 10000,
    controlLimitLower: Math.round(controlLimitLower * 10000) / 10000,
    controlLimitUpper: Math.round(controlLimitUpper * 10000) / 10000,
    latestProportion: Math.round(latestProportion * 10000) / 10000,
  };
}

export type Regression = {
  slope: number;
  intercept: number;
  rSquared: number;
  meanY: number;
  relativeSlope: number;
};

/**
 * Ordinary least squares for evenly-spaced x = 0..n-1.
 * Promoted from weekly-revenue-trajectory/detector.ts (unchanged) so other
 * trend-style modules can reuse it without depending on that module.
 */
export function olsRegression(y: number[]): Regression {
  const n = y.length;
  const meanX = (n - 1) / 2;
  const sumY = y.reduce((a, b) => a + b, 0);
  const meanY = sumY / n;

  let numerator = 0;
  let denominator = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    const dy = y[i]! - meanY;
    numerator += dx * dy;
    denominator += dx * dx;
  }

  const slope = denominator > 0 ? numerator / denominator : 0;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * i;
    const yi = y[i]!;
    ssRes += (yi - predicted) ** 2;
    ssTot += (yi - meanY) ** 2;
  }

  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return {
    slope,
    intercept,
    rSquared,
    meanY,
    relativeSlope: meanY > 0 ? slope / meanY : 0,
  };
}
