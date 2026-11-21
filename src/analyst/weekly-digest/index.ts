export { runWeeklyDigest } from './runner.js';
export { runDigestSweep } from './sweep.js';
export { computeDigestWindow } from './fetcher.js';
export type {
  WeeklyDigestContent,
  DigestStoreMetrics,
  DigestAnomalySummary,
  DigestWeekOverWeek,
  DigestTopProduct,
  DigestRefundedProduct,
  DigestDiscountCode,
  DigestLowStockItem,
  DigestDailyPoint,
} from './types.js';

// Cron schedule: Monday 06:00 IST — after all weekly analyst modules have run
export const DIGEST_CRON_SCHEDULE = '0 6 * * 1';
