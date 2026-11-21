/**
 * Shopify high-level functions (barrel export)
 * ============================================
 * Re-exports all public functions from modularized metrics.
 * This maintains backward compatibility with existing imports.
 */

// Aggregate metrics
export { getOrdersSummary, getOrdersTimeSeries, getCheckoutAbandonment, type OrdersSummaryInput, type OrdersTimeSeriesInput, type Granularity, type CheckoutAbandonmentInput } from './metrics/orders.js';
export { getTopProductsBySales, type TopProductsInput } from './metrics/products.js';
export { getInventoryLevels, type InventoryLevelsInput } from './metrics/inventory.js';
export { getCustomerRetentionStats, type CustomerRetentionInput } from './metrics/customers.js';
export { getFulfillmentSummary, type FulfillmentSummaryInput } from './metrics/fulfillment.js';
export { getRefundAnalysis, type RefundAnalysisInput } from './metrics/refunds.js';
export { getDiscountPerformance, type DiscountPerformanceInput } from './metrics/discounts.js';

// Record listings
export { getShopOverview, listOrders, listProducts, listCustomers, type ListOrdersInput, type ListProductsInput, type ListCustomersInput } from './metrics/records.js';

// Shared types
export type { RecordResult } from './types.js';
