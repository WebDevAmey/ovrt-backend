# Insight module notes

## The `AnomalyDetails` same-unit contract (read before writing a detector)

`AnomalyDetails` ([types.ts](./types.ts)) has three generic numeric fields —
`mean`, `actualValue`, `zScore` — that every detector fills in. They look free-form,
but a **downstream consumer assigns them fixed meaning** and the detector must honor it.

The generic hook formatter in
[`src/agents/shopify-analyst/index.ts`](../../agents/shopify-analyst/index.ts) renders:

- `mean`        → "baseline"
- `actualValue` → observed value
- `(actualValue - mean) / |mean|` → the **"% from baseline"** shown in the hook
- `zScore`      → the **"σ"** shown in the hook

### The rule

**`mean` and `actualValue` must be the SAME metric in the SAME unit.** The formatter
divides one by the other to produce a percentage; if they are different quantities
the percentage is nonsense.

For a true statistical module (`daily-orders-trend`), this is natural: `mean` is the
baseline average, `actualValue` is the observed value, `zScore` is the real z-score.

For a **threshold-based** module (no distribution), reuse the fields like this — the
metric you measure goes in `actualValue`, the threshold you compare against goes in
`mean`, and `zScore` carries the gap (in the metric's own unit, with a comment saying so):

```ts
// metric = days-of-cover; baseline = 14-day reorder threshold
zScore: DAYS_OF_COVER_THRESHOLD - daysOfCover, // gap below threshold, in days
mean: DAYS_OF_COVER_THRESHOLD,
actualValue: daysOfCover,
```

`sell-through-rate` and `inventory-stockout-risk` follow this pattern. Any
domain-specific numbers (velocity, revenue loss, on-hand qty) go in **extra keys**
(`AnomalyDetails` allows `[key: string]: unknown`), never in `mean`/`actualValue`.

### The anti-pattern (real bug, fixed Jun 2026)

`inventory-stockout-risk` originally set `mean: dailyVelocity` (0.9 units/day) and
`actualValue: daysOfCover` (13 days) — two different quantities in two different units.
The hook then printed `+1360%` from dividing days by units/day. It also hardcoded
`zScore: 0`, so every alert read `0.0σ`. Fixed by adopting the contract above.

> Heads up: several other threshold modules still reuse `zScore` for a domain
> quantity (e.g. `inventory-efficiency` = "gap to sell-through threshold",
> `location-inventory-imbalance` = severity). That's fine **as long as** `mean` and
> `actualValue` stay same-unit so the hook's % math holds. When you touch one of
> these, double-check the rendered hook, not just the stored fields.

## Shared statistics toolkit (`stats.ts`)

[`stats.ts`](./stats.ts) has the primitives most modules should reach for
instead of hand-rolling a threshold:

- **`seasonalCusum`** — for daily continuous metrics (orders/day, AOV/day).
  Map its result into `AnomalyDetails` as: `mean` = `weekdayMean`,
  `actualValue` = `latestValue`, `stdDev` = `weekdayStdDev`, `zScore` =
  `cusumValue` (NOT a real z-score — it's the cumulative standardized
  deviation; same-unit contract still holds since `mean`/`actualValue` are
  both the raw daily metric).
- **`ewmaProportionControl`** — for rate metrics (abandonment rate, refund
  rate, discount uptake, retention rate). Map as: `mean` = `ewma * 100`
  (percentage), `actualValue` = `latestProportion * 100`, `zScore` = relative
  deviation from baseline (percent), domain-specific control limits go in
  extra fields (`controlLimitLowerPct`, etc.) — never in `zScore`/`stdDev`.
- **`olsRegression`** — promoted from `weekly-revenue-trajectory/detector.ts`
  unchanged; reuse for any other trend-style module rather than re-deriving it.

Both `seasonalCusum` and `ewmaProportionControl` need real history (8+ weeks
of daily data, or 4+ periods for proportions) — they intentionally return
`fired: false` rather than degrading to a less reliable comparison when data
is thin. Detectors should treat that as "no detection," not an error.
