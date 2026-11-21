// ─────────────────────────────────────────────────────────────
// Weekly Digest — TypeScript types
//
// WeeklyDigestContent is the shape stored in WeeklyDigest.summary. The
// digest's recommendations are now lean OpportunityDraft objects (shared
// with the anomaly curation engine) — see ../opportunity/types.ts.
// ─────────────────────────────────────────────────────────────

// ── Digest content (WeeklyDigest.summary) ────────────────────

export interface DigestTopProduct {
  product: string;
  units: number;
  revenue: number;
}

export interface DigestRefundedProduct {
  product: string;
  unitsRefunded: number;
  refundOccurrences: number;
}

export interface DigestDiscountCode {
  code: string;
  timesUsed: number;
  totalDiscount: number;
  totalRevenue: number;
}

export interface DigestLowStockItem {
  product: string;
  variant: string;
  available: number;
  status: 'OUT_OF_STOCK' | 'LOW_STOCK';
}

export interface DigestDailyPoint {
  date: string; // YYYY-MM-DD
  orders: number;
  revenue: number;
}

export interface DigestStoreMetrics {
  weekStart: string; // YYYY-MM-DD
  weekEnd: string;   // YYYY-MM-DD
  currency: string;
  // Current week
  totalRevenue: number;
  totalOrders: number;
  averageOrderValue: number;
  uniqueCustomers: number;
  totalDiscounts: number;
  // Customers — counts are by account-registration date within the week, so
  // these describe newly-registered accounts, NOT new-vs-repeat buyers.
  newlyRegisteredCustomers: number;
  // Returns / refunds
  refundRate: number;
  totalRefunded: number;
  refundedProducts: DigestRefundedProduct[];
  // Discounts / promotions
  discountUptakeRate: number; // % of orders that used a code
  topDiscountCodes: DigestDiscountCode[];
  // Checkout
  abandonmentRate: number;
  abandonedValue: number;
  // Inventory health
  outOfStockCount: number;
  lowStockCount: number;
  lowStockItems: DigestLowStockItem[];
  // Top sellers
  topProducts: DigestTopProduct[];
  // Within-week daily shape (Mon → Sun)
  dailyTrend: DigestDailyPoint[];
  // Prior week — kept for context in the summary JSON
  priorWeekRevenue: number;
  priorWeekOrders: number;
  priorWeekAov: number;
  priorWeekNewlyRegistered: number;
  // True when any underlying Shopify fetch hit its pagination cap, meaning the
  // current-week totals may understate. Surfaced to the LLM as a caveat.
  truncated: boolean;
}

export interface DigestAnomalySummary {
  insightType: string;
  direction: 'spike' | 'drop' | 'anomaly';
  summary: string;
  anomalyId: string;
  severity: 'low' | 'medium' | 'high';
  detectedAt: string; // YYYY-MM-DD
}

export interface DigestWeekOverWeek {
  // null when the prior-week baseline is 0 (no defined percentage change)
  revenueChangePct: number | null;
  ordersChangePct: number | null;
  aovChangePct: number | null;
  newlyRegisteredChangePct: number | null;
}

export interface WeeklyDigestContent {
  weekStart: string;
  weekEnd: string;
  headline: string;
  narrative: string;
  healthScore: number; // 0–100 — deterministic base, computed from metrics
  healthScoreRationale: string;
  weekOverWeek: DigestWeekOverWeek;
  topWins: string[];     // 3 items
  topConcerns: string[]; // 3 items
  anomalyCount: number;
  anomalies: DigestAnomalySummary[];
  metrics: DigestStoreMetrics;
}

