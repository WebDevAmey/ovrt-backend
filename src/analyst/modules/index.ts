import { dailyOrdersTrendModule } from './daily-orders-trend/index.js';
import { aovErosionModule } from './aov-erosion/index.js';
import { repeatPurchaseRateModule } from './repeat-purchase-rate/index.js';
import { refundRateSpikeModule } from './refund-rate-spike/index.js';
import { discountDependencyModule } from './discount-dependency/index.js';
import { productRevenueShiftModule } from './product-revenue-shift/index.js';
import { inventoryStockoutRiskModule } from './inventory-stockout-risk/index.js';
import { fulfillmentDelayModule } from './fulfillment-delay-spike/index.js';
import { weeklyRevenueTrajectoryModule } from './weekly-revenue-trajectory/index.js';
import { checkoutAbandonmentSpikeModule } from './checkout-abandonment-spike/index.js';
import { newCustomerAcquisitionDropModule } from './new-customer-acquisition-drop/index.js';
import { locationInventoryImbalanceModule } from './location-inventory-imbalance/index.js';
import { inventoryEfficiencyModule } from './inventory-efficiency/index.js';
import { supportSentimentSpikeModule } from './support-sentiment-spike/index.js';
import { abandonedCheckoutProductAnomalyModule } from './abandoned-checkout-product-anomaly/index.js';
import { discountCodeAnomalyModule } from './discount-code-anomaly/index.js';
import { geographicDemandShiftModule } from './geographic-demand-shift/index.js';
import type { InsightModule } from './types.js';

/**
 * Registry of all analyst modules.
 * To add a new insight: create a module directory, implement InsightModule,
 * add it here. Zero changes needed anywhere else.
 *
 * Current schedule spread (all times IST / Asia-Kolkata — see BUSINESS_TIMEZONE
 * in ../constants.ts, applied via the cron scheduler's timezone option):
 *
 * Daily (each one hour apart to spread Shopify/support API load):
 *   02:00 — DAILY_ORDERS_TREND                 (day-of-week-adjusted CUSUM, 63-day series)
 *   03:00 — AOV_EROSION                        (day-of-week-adjusted CUSUM on daily AOV, paid orders only)
 *   04:00 — INVENTORY_STOCKOUT_RISK            (velocity × on-hand; daysOfCover < 14)
 *   05:00 — FULFILLMENT_DELAY_SPIKE            (aged unfulfilled snapshot + single-day-blip guard)
 *   06:00 — CHECKOUT_ABANDONMENT_SPIKE         (EWMA control chart, 8 weekly snapshots)
 *   07:00 — LOCATION_INVENTORY_IMBALANCE       (top-seller empty at one location; defers to stockout risk below 7 days cover)
 *   08:00 — INVENTORY_EFFICIENCY_DROP          (merged sell-through + turn-rate; Warning/Critical tiers)
 *   10:00 — SUPPORT_SENTIMENT_SPIKE            (complaint-type CUSUM + negative-sentiment EWMA)
 *   11:00 — ABANDONED_CHECKOUT_PRODUCT_ANOMALY (per-SKU abandonment-rate EWMA, 6 weekly snapshots)
 *
 * Weekly:
 *   Mon 02:00 — REPEAT_PURCHASE_RATE_DROP      (EWMA control chart, 8 weekly snapshots)
 *   Mon 04:00 — WEEKLY_REVENUE_TRAJECTORY      (12-week linear regression)
 *   Tue 02:00 — PRODUCT_REVENUE_SHIFT          (product mix shift; revenue-weighted scoring)
 *   Tue 04:00 — GEOGRAPHIC_DEMAND_SHIFT        (per-region order-share EWMA + fraud-cluster check)
 *   Wed 02:00 — REFUND_RATE_SPIKE              (EWMA control chart + Poisson-style per-product surge)
 *   Thu 03:00 — NEW_CUSTOMER_ACQUISITION_DROP  (30d acquisition WoW)
 *   Fri 02:00 — DISCOUNT_DEPENDENCY_CREEP      (EWMA control chart, 8 weekly snapshots)
 *   Sat 02:00 — DISCOUNT_CODE_ANOMALY          (per-code redemption CUSUM + margin-outlier z-test)
 */
export const INSIGHT_MODULES: InsightModule[] = [
  dailyOrdersTrendModule,
  aovErosionModule,
  inventoryStockoutRiskModule,
  fulfillmentDelayModule,
  checkoutAbandonmentSpikeModule,
  locationInventoryImbalanceModule,
  inventoryEfficiencyModule,
  supportSentimentSpikeModule,
  abandonedCheckoutProductAnomalyModule,
  repeatPurchaseRateModule,
  weeklyRevenueTrajectoryModule,
  geographicDemandShiftModule,
  productRevenueShiftModule,
  refundRateSpikeModule,
  newCustomerAcquisitionDropModule,
  discountDependencyModule,
  discountCodeAnomalyModule,
];

const MODULE_MAP = new Map(INSIGHT_MODULES.map((m) => [m.insightType, m]));

export function getModuleByType(insightType: string): InsightModule | undefined {
  return MODULE_MAP.get(insightType);
}
