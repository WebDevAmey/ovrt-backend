import { shopifyGraphQL } from '../agents/shopify/graphql.js';
import { type ShopifyConnectInfo } from '../agents/shopify/credentials.js';
import { type ResolvedLossRule } from './rules.js';

// ---------------------------------------------------------------------------
//  Philosophy
// ---------------------------------------------------------------------------
//
// This module computes the money a refund costs that CANNOT be recovered, even
// though the product itself may go back into inventory. Components:
//
//   1. Gateway fee kept       — Stripe/Razorpay keep their fee (+ tax on it) on a
//                               refund. Read the REAL fee from Shopify's recorded
//                               transactions; fall back to the configured rate
//                               only when Shopify has no fee data.
//   2. Outbound shipping      — what you paid to ship the order out is gone once
//                               it's refunded (if the store bears it).
//   3. Return shipping label   — what you pay to get the item back (only when an
//                               item is actually returned/restocked).
//   4. Restock labour          — warehouse handling per physically-restocked unit.
//   5. Handling overhead       — flat admin cost per refund.
//   6. Write-off               — fraction of restocked value that comes back
//                               unsellable and must be scrapped (inventory loss).
//
// Anything Shopify measured directly (real fees, refunded amount, outbound
// shipping paid, restock flags) is preferred over a configured estimate.

// ---------------------------------------------------------------------------
//  GraphQL Query
// ---------------------------------------------------------------------------

export const REFUND_LOSS_QUERY = `
  query GetRefundsInRange($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        currencyCode
        totalShippingPriceSet {
          presentmentMoney { amount currencyCode }
        }
        transactions {
          kind
          status
          fees {
            amount { amount currencyCode }
          }
        }
        refunds {
          id
          createdAt
          totalRefundedSet {
            presentmentMoney { amount currencyCode }
          }
          orderAdjustments(first: 20) {
            nodes {
              amountSet { presentmentMoney { amount } }
            }
          }
          refundLineItems(first: 50) {
            nodes {
              quantity
              restockType
              restocked
              subtotalSet { presentmentMoney { amount } }
              lineItem {
                title
                variant {
                  id
                  price
                }
              }
            }
          }
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
//  Caps
// ---------------------------------------------------------------------------

const MAX_PAGES = 40;
const MAX_DETAILS = 500;

// ---------------------------------------------------------------------------
//  Shopify response types (only fields the query selects)
// ---------------------------------------------------------------------------

type Money = { amount: string; currencyCode?: string };
type MoneyBag = { presentmentMoney: Money };

type TransactionNode = {
  kind: string;
  status: string;
  fees: { amount: Money }[];
};

type RefundLineItemNode = {
  quantity: number;
  restockType: string | null;
  restocked: boolean;
  subtotalSet: MoneyBag | null;
  lineItem: {
    title: string;
    variant: {
      id: string | null;
      price: string | null;
    } | null;
  } | null;
};

type RefundNode = {
  id: string;
  createdAt: string;
  totalRefundedSet: MoneyBag | null;
  orderAdjustments: { nodes: { amountSet: MoneyBag | null }[] };
  refundLineItems: { nodes: RefundLineItemNode[] };
};

type OrderNode = {
  id: string;
  name: string;
  currencyCode: string;
  totalShippingPriceSet: MoneyBag | null;
  transactions: TransactionNode[];
  refunds: RefundNode[];
};

type RefundLossQueryResult = {
  orders: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: OrderNode[];
  };
};

// ---------------------------------------------------------------------------
//  Public types
// ---------------------------------------------------------------------------

export type RefundFilter = {
  startDate: string;
  endDate: string;
};

// Each loss component, tracked separately so the UI can break down WHY a refund
// cost money and the totals are auditable (sum of components === total).
export type LossBreakdown = {
  gatewayFee: number; // gateway fee + tax on it, kept on refund
  outboundShipping: number; // outbound shipping the store ate
  returnShipping: number; // return-label cost
  restockLabour: number; // warehouse handling on restocked units
  handling: number; // flat per-refund overhead
  writeOff: number; // unsellable-on-return inventory loss
  total: number; // sum of the above
};

export type CurrencyTotals = LossBreakdown & {
  currencyCode: string;
  refundCount: number;
  refundedAmount: number; // total money refunded to customers (context, not loss)
};

export type RefundHotspot = {
  productTitle: string;
  variantId: string | null;
  totalLoss: number;
  refundedQuantity: number;
  refundOccurrences: number; // # of distinct refunds touching this product
};

export type RefundDetail = {
  refundId: string;
  orderId: string;
  orderName: string;
  createdAt: string;
  currencyCode: string;
  refundedAmount: number;
  breakdown: LossBreakdown;
  // Which gateway-fee inputs were measured from Shopify vs estimated from config.
  gatewayFeeMeasured: boolean;
  ruleId: string | null;
  items: {
    title: string;
    variantId: string | null;
    quantity: number;
    unitPrice: number;
    restocked: boolean;
  }[];
};

export type RefundLossResult = {
  summary: LossBreakdown & {
    totalRefunds: number;
    totalRefundedAmount: number;
  };
  byCurrency: CurrencyTotals[];
  hotspots: RefundHotspot[];
  details: RefundDetail[];
  detailsTruncated: boolean;
  // True when the page cap was hit and some refunds in the window were dropped.
  resultsTruncated: boolean;
  // True when no RevenueLossRule was configured, so cost estimates fell back to
  // zero and only measured values (gateway fee, outbound shipping) contributed.
  usingFallbackRules: boolean;
};

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

const num = (s: string | null | undefined): number => {
  const v = parseFloat(s ?? '');
  return Number.isFinite(v) ? v : 0;
};

const emptyBreakdown = (): LossBreakdown => ({
  gatewayFee: 0,
  outboundShipping: 0,
  returnShipping: 0,
  restockLabour: 0,
  handling: 0,
  writeOff: 0,
  total: 0,
});

const addBreakdown = (target: LossBreakdown, src: LossBreakdown) => {
  target.gatewayFee += src.gatewayFee;
  target.outboundShipping += src.outboundShipping;
  target.returnShipping += src.returnShipping;
  target.restockLabour += src.restockLabour;
  target.handling += src.handling;
  target.writeOff += src.writeOff;
  target.total += src.total;
};

const round2 = (v: number) => Math.round(v * 100) / 100;

const roundBreakdown = (b: LossBreakdown): LossBreakdown => ({
  gatewayFee: round2(b.gatewayFee),
  outboundShipping: round2(b.outboundShipping),
  returnShipping: round2(b.returnShipping),
  restockLabour: round2(b.restockLabour),
  handling: round2(b.handling),
  writeOff: round2(b.writeOff),
  total: round2(b.total),
});

/**
 * The real gateway fee Shopify recorded for an order, summed across its SALE /
 * CAPTURE transactions (refund transactions don't carry the original fee).
 * Returns null when Shopify has no fee data (manual/COD/test orders) so the
 * caller can fall back to the configured rate.
 */
function measuredGatewayFee(order: OrderNode): number | null {
  let total = 0;
  let sawFee = false;
  for (const tx of order.transactions ?? []) {
    if (tx.status !== 'SUCCESS') continue;
    if (tx.kind !== 'SALE' && tx.kind !== 'CAPTURE') continue;
    for (const fee of tx.fees ?? []) {
      const amt = num(fee.amount?.amount);
      if (amt > 0) {
        total += amt;
        sawFee = true;
      }
    }
  }
  return sawFee ? total : null;
}

// ---------------------------------------------------------------------------
//  Calculation
// ---------------------------------------------------------------------------

export async function calculateRefundRevenueLoss(
  conn: ShopifyConnectInfo,
  resolveRule: (currency: string, at: Date) => ResolvedLossRule,
  filter: RefundFilter,
): Promise<RefundLossResult> {
  const filterStart = new Date(filter.startDate);
  const filterEnd = new Date(filter.endDate);
  const queryStr = `updated_at:>=${filter.startDate} AND updated_at:<=${filter.endDate}`;

  let hasNextPage = true;
  let cursor: string | null = null;
  const allOrders: OrderNode[] = [];
  let pages = 0;

  while (hasNextPage && pages < MAX_PAGES) {
    const response: RefundLossQueryResult = await shopifyGraphQL(conn, REFUND_LOSS_QUERY, {
      first: 250,
      after: cursor,
      query: queryStr,
    });
    const data = response.orders;
    allOrders.push(...data.nodes);
    hasNextPage = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
    pages++;
  }
  // If we exhausted the page budget but Shopify still has more, results for the
  // window are incomplete — surface that rather than silently undercounting.
  const resultsTruncated = hasNextPage && pages >= MAX_PAGES;

  const currencyMap = new Map<string, CurrencyTotals>();
  const getCurrencyTotals = (code: string): CurrencyTotals => {
    let entry = currencyMap.get(code);
    if (!entry) {
      entry = {
        ...emptyBreakdown(),
        currencyCode: code,
        refundCount: 0,
        refundedAmount: 0,
      };
      currencyMap.set(code, entry);
    }
    return entry;
  };

  // Hotspots keyed by variantId (falls back to title for older/odd line items)
  // so two different variants with the same title don't merge.
  const hotspotMap = new Map<string, RefundHotspot>();
  const details: RefundDetail[] = [];

  const globalBreakdown = emptyBreakdown();
  let globalRefundCount = 0;
  let globalRefundedAmount = 0;
  let usedAnyFallback = false;

  for (const order of allOrders) {
    const currencyCode = order.currencyCode ?? 'UNKNOWN';
    const orderMeasuredFee = measuredGatewayFee(order);
    const outboundShippingPaid = num(order.totalShippingPriceSet?.presentmentMoney?.amount);

    // An order can have multiple refunds (partial refunds over time). The
    // measured order-level gateway fee belongs to the ORIGINAL capture, so we
    // attribute it to the FIRST in-window refund only, to avoid charging it once
    // per partial refund. Same for outbound shipping.
    let orderFeeClaimed = false;
    let orderShippingClaimed = false;

    // Refunds in chronological order so "first in window" is deterministic.
    const refundsSorted = [...order.refunds].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );

    for (const refund of refundsSorted) {
      const refundCreatedAt = new Date(refund.createdAt);
      if (refundCreatedAt < filterStart || refundCreatedAt > filterEnd) continue;

      const rule = resolveRule(currencyCode, refundCreatedAt);
      if (rule.ruleId === null) usedAnyFallback = true;

      const refundedAmount = num(refund.totalRefundedSet?.presentmentMoney?.amount);
      const breakdown = emptyBreakdown();
      let gatewayFeeMeasured = false;

      // --- 1. Gateway fee (measured first, config fallback) -----------------
      // Only counts as loss if the gateway does NOT refund its fee.
      if (!rule.gatewayFeeRefunded) {
        if (orderMeasuredFee !== null && !orderFeeClaimed) {
          // Real fee on the original capture, attributed once per order.
          breakdown.gatewayFee = orderMeasuredFee;
          gatewayFeeMeasured = true;
          orderFeeClaimed = true;
        } else if (orderMeasuredFee === null) {
          // No measured fee available — estimate from the refunded amount.
          const estimatedFee =
            refundedAmount * rule.gatewayFeeRate + rule.gatewayFixedFee;
          breakdown.gatewayFee = estimatedFee * (1 + rule.gatewayFeeTaxRate);
        }
        // else: measured fee already claimed by an earlier refund on this order.
      }

      // --- 2. Outbound shipping the store ate (once per order) --------------
      if (rule.outboundShippingBorneByStore && !orderShippingClaimed && outboundShippingPaid > 0) {
        breakdown.outboundShipping = outboundShippingPaid;
        orderShippingClaimed = true;
      }

      // --- Per-line-item: return shipping, labour, write-off ----------------
      const itemDetails: RefundDetail['items'] = [];
      let anyRestocked = false;

      for (const lineNode of refund.refundLineItems.nodes) {
        const unitPrice = num(lineNode.lineItem?.variant?.price);
        const quantity = lineNode.quantity ?? 0;
        const title = lineNode.lineItem?.title ?? 'Unknown Product';
        const variantId = lineNode.lineItem?.variant?.id ?? null;
        // Physically came back to inventory? Shopify tells us via `restocked`
        // and restockType (NO_RESTOCK / CANCEL / RETURN / LEGACY_RESTOCK).
        const restocked =
          lineNode.restocked === true && lineNode.restockType !== 'NO_RESTOCK';
        if (restocked) anyRestocked = true;

        // Labour: only on units that actually re-entered inventory.
        if (restocked) {
          breakdown.restockLabour += quantity * rule.restockLabourPerItem;

          // Write-off: a fraction of restocked value comes back unsellable.
          // Prefer Shopify's refunded subtotal for the line; fall back to
          // unitPrice * qty when the subtotal isn't present.
          const lineValue =
            num(lineNode.subtotalSet?.presentmentMoney?.amount) || unitPrice * quantity;
          breakdown.writeOff += lineValue * rule.writeOffRate;
        }

        itemDetails.push({ title, variantId, quantity, unitPrice, restocked });

        // --- Hotspot aggregation (per variant, occurrence counted once) -----
        const key = variantId ?? `title:${title}`;
        const existing = hotspotMap.get(key);
        if (existing) {
          existing.refundedQuantity += quantity;
          // Per-item loss share added below once breakdown.total is known.
        } else {
          hotspotMap.set(key, {
            productTitle: title,
            variantId,
            totalLoss: 0,
            refundedQuantity: quantity,
            refundOccurrences: 0,
          });
        }
      }

      // --- 3. Return shipping: only if something was actually returned ------
      if (anyRestocked) {
        breakdown.returnShipping = rule.returnShippingCost;
      }

      // --- 4. Flat handling overhead per refund -----------------------------
      breakdown.handling = rule.handlingFeePerRefund;

      breakdown.total =
        breakdown.gatewayFee +
        breakdown.outboundShipping +
        breakdown.returnShipping +
        breakdown.restockLabour +
        breakdown.handling +
        breakdown.writeOff;

      // Distribute this refund's total loss across its hotspot products by
      // refunded-quantity share, and count the occurrence once per product.
      const totalQty = itemDetails.reduce((s, it) => s + it.quantity, 0);
      const seenInThisRefund = new Set<string>();
      for (const it of itemDetails) {
        const key = it.variantId ?? `title:${it.title}`;
        const h = hotspotMap.get(key);
        if (!h) continue;
        if (totalQty > 0) {
          h.totalLoss += breakdown.total * (it.quantity / totalQty);
        }
        if (!seenInThisRefund.has(key)) {
          h.refundOccurrences += 1;
          seenInThisRefund.add(key);
        }
      }

      // Roll up.
      const totals = getCurrencyTotals(currencyCode);
      addBreakdown(totals, breakdown);
      totals.refundCount++;
      totals.refundedAmount += refundedAmount;

      addBreakdown(globalBreakdown, breakdown);
      globalRefundCount++;
      globalRefundedAmount += refundedAmount;

      details.push({
        refundId: refund.id,
        orderId: order.id,
        orderName: order.name,
        createdAt: refund.createdAt,
        currencyCode,
        refundedAmount: round2(refundedAmount),
        breakdown: roundBreakdown(breakdown),
        gatewayFeeMeasured,
        ruleId: rule.ruleId,
        items: itemDetails,
      });
    }
  }

  const hotspots = Array.from(hotspotMap.values())
    .map((h) => ({ ...h, totalLoss: round2(h.totalLoss) }))
    .sort((a, b) => b.totalLoss - a.totalLoss);

  const detailsTruncated = details.length > MAX_DETAILS;
  const sortedDetails = [...details].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const byCurrency = Array.from(currencyMap.values())
    .map((c) => ({ ...roundBreakdown(c), currencyCode: c.currencyCode, refundCount: c.refundCount, refundedAmount: round2(c.refundedAmount) }))
    .sort((a, b) => b.total - a.total);

  return {
    summary: {
      ...roundBreakdown(globalBreakdown),
      totalRefunds: globalRefundCount,
      totalRefundedAmount: round2(globalRefundedAmount),
    },
    byCurrency,
    hotspots,
    details: detailsTruncated ? sortedDetails.slice(0, MAX_DETAILS) : sortedDetails,
    detailsTruncated,
    resultsTruncated,
    usingFallbackRules: usedAnyFallback,
  };
}
