# Analyst System Review — 12 Detection Functions

All functions live under `src/analyst/modules/*/detector.ts`.  
They are pure deterministic functions: `(FactRow[]) => DetectionResult`.  
Default thresholds are in `src/analyst/constants.ts`.

---

## 1. `detectDailyOrdersOutlier` — Daily Orders Trend

**Schedule:** Daily, 02:00 UTC | **File:** `daily-orders-trend/detector.ts`

**What it checks:**  
14-day daily order count time series. Uses the first 13 days as baseline and checks whether the 14th (yesterday) is a statistical outlier.

**Math:**

```
mean  = Σ(baseline[0..12]) / 13
var   = Σ((val - mean)²) / (13 - 1)     // sample variance
stdDev = √variance

if stdDev > 0:
    z = (actualValue - mean) / stdDev
    fired = |z| > 2.0                    // ANALYST_ZSCORE_THRESHOLD
else:
    relativeDev = |actual - mean| / max(mean, 1)
    fired = relativeDev > 0.20           // ANALYST_FLAT_BASELINE_THRESHOLD

direction = actual >= mean ? 'spike' : 'drop'
```

**Gates:** Requires ≥ 14 rows.  
**Edge cases:** Flat baseline (stdDev = 0) falls back to relative deviation. Insufficient data silently skips.

---

## 2. `detectAovErosion` — AOV Erosion

**Schedule:** Daily, 03:00 UTC | **File:** `aov-erosion/detector.ts`

**What it checks:**  
Week-over-week Average Order Value drop. Customers buying same frequency but spending less per visit.

**Math:**

```
dropPct = ((prevAOV - currAOV) / prevAOV) × 100
fired = dropPct ≥ 10
```

**Gates:** Requires ≥ 2 rows; both windows ≥ 10 orders; prevAOV > 0.  
**Direction:** Always `'drop'`.

---

## 3. `detectRepeatPurchaseRateDrop` — Repeat Purchase Rate Drop

**Schedule:** Weekly (Mon 02:00 UTC) | **File:** `repeat-purchase-rate/detector.ts`

**What it checks:**  
Month-over-month repeat purchase rate (30-day retention window). Leading indicator — retention decay shows up here ~60 days before it hits revenue.

**Math:**

```
drop = prev.repeatPurchaseRate - curr.repeatPurchaseRate
fired = drop ≥ 4            // 4 percentage points
```

**Gates:** Requires ≥ 2 rows; both windows ≥ 30 total customers.  
**Direction:** Always `'drop'`.

---

## 4. `detectRefundRateSpike` — Refund Rate Spike

**Schedule:** Weekly (Wed 02:00 UTC) | **File:** `refund-rate-spike/detector.ts`

**What it checks:**  
Two triggers: (1) overall refund rate spike, (2) product-level refund surge.

**Math:**

```
Trigger 1 (rate_spike):
    delta = curr.refundRate - prev.refundRate
    fired = delta ≥ 2  AND  both windows ≥ 20 orders

Trigger 2 (product_surge):
    tripled  = prevRefunds > 0  AND  currRefunds ≥ prevRefunds × 3
    newHotspot = prevRefunds == 0  AND  currRefunds ≥ 4
    fired = (tripled OR newHotspot)  AND  currRefunds ≥ 3
```

**Direction:** Always `'spike'`.

---

## 5. `detectDiscountDependencyCreep` — Discount Dependency Creep

**Schedule:** Weekly (Fri 02:00 UTC) | **File:** `discount-dependency/detector.ts`

**What it checks:**  
Week-over-week creep in discount uptake rate (% of orders using a coupon). Customers learn to wait for codes; margin erodes silently.

**Math:**

```
delta = curr.discountUptakeRate - prev.discountUptakeRate
fired = delta ≥ 5  AND  curr.discountUptakeRate ≥ 15
```

**Gates:** Requires ≥ 2 rows; both windows ≥ 15 orders.  
**Direction:** Always `'spike'`.

---

## 6. `detectProductRevenueShift` — Product Revenue Shift

**Schedule:** Weekly (Tue 02:00 UTC) | **File:** `product-revenue-shift/detector.ts`

**What it checks:**  
Silent shifts in product mix — a product's revenue share changing significantly week-over-week. Catches products quietly losing ground or new ones exploding, even when total revenue looks stable.

**Math:**

```
absShareChange = |shareChangePp|
absRevenueChange = |revenueChangePct|  (or Infinity for new entrants)

for each product:
    if absShareChange ≥ 8  AND  absRevenueChange ≥ 20:
        score = absShareChange × 3 + absRevenueChange
        keep highest-scored product

direction = revenueChange > 0 ? 'spike' : 'drop'
```

**Gates:** Requires ≥ 1 product row.  
**Note:** New entrants (null `revenueChangePct`) bypass the revenue gate and score on share-change only.

---

## 7. `detectCheckoutAbandonmentSpike` — Checkout Abandonment Spike

**Schedule:** Daily, 06:00 UTC | **File:** `checkout-abandonment-spike/detector.ts`

**What it checks:**  
Sudden WoW jump in checkout abandonment rate. Industry baseline ~70%; only fires on jumps, not the baseline. A sudden jump usually means something broke (payment gateway, mobile regression, surprise shipping cost).

**Math:**

```
jump = curr.abandonmentRate - prev.abandonmentRate
fired = jump ≥ 8                     // JUMP_THRESHOLD
    AND  curr.abandonmentRate ≥ 50   // MIN_CURRENT_RATE
    AND  both windows ≥ 30 checkouts // MIN_CHECKOUTS

// Estimated lost revenue:
expectedAbandoned = (prev.abandoned / prev.total) × curr.total
additionalAbandoned = curr.abandoned - expectedAbandoned
avgCartValue = curr.abandonedValue / curr.abandonedCheckouts
estimatedLostRevenue = max(0, additionalAbandoned × avgCartValue)
```

**Direction:** Always `'spike'`.

---

## 8. `detectWeeklyRevenueTrajectory` — Weekly Revenue Trajectory

**Schedule:** Weekly (Mon 04:00 UTC) | **File:** `weekly-revenue-trajectory/detector.ts`

**What it checks:**  
Long-horizon revenue trend using linear regression on 12+ complete ISO weeks. Catches what daily z-score misses: a smooth 2%/week decline compounds to ~25% over a quarter.

**Math:**

```
linearRegression(y[0..n-1]):
    meanX = (n-1)/2
    meanY = Σ(y) / n
    slope = Σ((i - meanX)(y_i - meanY)) / Σ((i - meanX)²)
    intercept = meanY - slope × meanX
    rSquared = 1 - Σ(y_i - (intercept + slope·i))² / Σ(y_i - meanY)²
    relativeSlope = slope / meanY

gates:
    meanY ≥ 500                     // MIN_AVG_WEEKLY_REVENUE
    |relativeSlope| ≥ 0.02          // 2%/week
    rSquared ≥ 0.4

totalImpliedChangePct = relativeSlope × (n-1) × 100
```

**Gates:** Requires ≥ 12 weeks. All three gates must pass.  
**Direction:** `slope > 0 ? 'spike' : 'drop'`.

---

## 9. `detectFulfillmentDelay` — Fulfillment Delay Spike

**Schedule:** Daily, 05:00 UTC | **File:** `fulfillment-delay-spike/detector.ts`

**What it checks:**  
Snapshot-based: looks at currently-unfulfilled orders and fires on SLA breach (≥14 days) or systemic backlog (≥5 aged orders AND ≥10% of recent volume).

**Math:**

```
Trigger 1 (critical_aged_order):
    fired = maxAgedDays ≥ 14          // CRITICAL_AGE_DAYS

Trigger 2 (backlog):
    fired = agedCount ≥ 5             // WARNING_MIN_COUNT
        AND  agedRatio ≥ 0.10         // WARNING_MIN_RATIO
```

**Direction:** Always `'spike'`.

---

## 10. `detectStockoutRisk` — Inventory Stockout Risk

**Schedule:** Daily, 04:00 UTC | **File:** `inventory-stockout-risk/detector.ts`

**What it checks:**  
Joins 30-day sales velocity with current on-hand inventory to find top sellers that are out of stock OR will run out before typical reorder lead time (14 days).

**Math:**

```
eligible = filter products where dailyVelocity ≥ 0.5

Trigger 1 (out_of_stock):
    fired = availableNow ≤ 0
    estimatedDailyRevenueLoss = (revenue30d / unitsSold30d) × dailyVelocity

Trigger 2 (low_cover):
    daysOfCover = availableNow / dailyVelocity
    fired = daysOfCover < 14         // DAYS_OF_COVER_THRESHOLD
    picks worst (lowest daysOfCover)
```

**Direction:** Always `'drop'`.

---

## 11. `detectNewCustomerAcquisitionDrop` — New Customer Acquisition Drop

**Schedule:** Weekly (Thu 03:00 UTC) | **File:** `new-customer-acquisition-drop/detector.ts`

**What it checks:**  
Top-of-funnel signal: new customer acquisition drop WoW (30-day windows). Leading indicator — precedes revenue decline by weeks because retention masks the gap temporarily.

**Math:**

```
gates:
    prev.newCustomers ≥ 30                     // MIN_PREV_NEW
    curr.newCustomers < prev × 0.70            // DROP_RATIO
    prev - curr ≥ 10                           // MIN_ABSOLUTE_DROP

dropPct = ((prev - curr) / prev) × 100
```

**Direction:** Always `'drop'`.

---

## 12. `detectLocationImbalance` — Location Inventory Imbalance

**Schedule:** Daily, 07:00 UTC | **File:** `location-inventory-imbalance/detector.ts`

**What it checks:**  
"Stockout at one of several locations" — a top seller at 2+ locations has total stock overall, but at least one location is empty. This is an inter-location transfer opportunity (faster than a supplier reorder).

**Math:**

```
for each product:
    eligible if dailyVelocity ≥ 0.5
        AND  locationsConfigured ≥ 2
        AND  locationsEmpty ≥ 1
        AND  locationsStocked ≥ 1

    emptyShare = locationsEmpty / locationsConfigured
    severity = dailyVelocity × emptyShare

    pick highest-severity product

daysOfCoverIfAbsorbed = totalAvailable / dailyVelocity
```

**Direction:** Always `'drop'`.

---

## Summary: What We Check

| # | Module | Domain | Method | Sensitivity |
|---|--------|--------|--------|-------------|
| 1 | Daily Orders Trend | Revenue/Volume | Z-score (13d baseline, 14th obs) | \|z\| > 2.0 (~4.6% FPR) |
| 2 | AOV Erosion | Revenue/Margins | WoW % drop | ≥ 10% drop, ≥ 10 orders |
| 3 | Repeat Purchase Rate | Retention/Loyalty | MoM pp drop | ≥ 4pp, ≥ 30 customers |
| 4 | Refund Rate Spike | Product Quality | Rate ∆ + product tripling | ≥ 2pp AND/OR ≥ 3x refunds |
| 5 | Discount Dependency | Margin/Pricing | WoW uptake ∆ | ≥ 5pp AND ≥ 15% rate |
| 6 | Product Revenue Shift | Product Mix | Share ∆ × revenue ∆ | ≥ 8pp AND ≥ 20% |
| 7 | Checkout Abandonment | Conversion/Funnel | WoW jump pp | ≥ 8pp jump, rate ≥ 50% |
| 8 | Weekly Revenue Trajectory | Revenue/Strategy | Linear regression trend | \|slope/mean\| ≥ 2%, R² ≥ 0.4 |
| 9 | Fulfillment Delay | Operations/Fulfillment | SLA breach + backlog | ≥ 14d single OR ≥ 5 aged + ≥ 10% |
| 10 | Inventory Stockout Risk | Inventory/Supply | OOS + days-of-cover | Stock = 0 OR cover < 14d, vel ≥ 0.5 |
| 11 | New Customer Acquisition | Marketing/Funnel | WoW % + absolute drop | < 70% of prev AND ≥ 10 fewer |
| 12 | Location Imbalance | Inventory/Distribution | Multi-location OOS | ≥ 1 empty + ≥ 1 stocked, vel ≥ 0.5 |

The system covers **5 domains**: Revenue (1,2,6,8), Retention (3), Marketing/Funnel (4,5,7,11), Fulfillment (9), Inventory (10,12).  
All detectors are **deterministic threshold-based** — no ML, no adaptive thresholds. Design choice favors **interpretability and testability** over statistical sophistication.
