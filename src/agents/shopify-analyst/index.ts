/**
 * Shopify Analyst Agent
 * =====================
 * Called by the orchestrator when a conversation is linked to an anomaly.
 * Instead of the generic planning phase, this module produces a pre-defined
 * set of targeted EvidenceTask objects based on the anomaly type, and
 * provides an anomaly-specific synthesis prompt.
 *
 * Anomaly types handled:
 *   REFUND_RATE_SPIKE          — refund rate increased above baseline
 *   DAILY_ORDERS_TREND         — daily order count spike or drop
 *   AOV_EROSION                — average order value declining
 *   REPEAT_PURCHASE_RATE_DROP  — repeat purchase rate falling
 *   DISCOUNT_DEPENDENCY_CREEP  — increasing share of discounted orders
 *   PRODUCT_REVENUE_SHIFT      — top-product revenue mix changed
 */

import type { EvidenceTask } from '../types.js';
import type { Persona } from '../../personas.js';
import { getPersonaPrompt } from '../../personas.js';

// ── Anomaly context ───────────────────────────────────────────────────────────

export type AnomalyContext = {
  anomalyId: string;
  insightType: string;
  direction: 'spike' | 'drop';
  date: string;        // ISO date of detected anomaly
  actualValue: number;
  mean: number;
  stdDev: number;
  zScore: number;
  shopifySourceId: string | null; // ShopifyIntegration.id
};

// ── Date helper ───────────────────────────────────────────────────────────────

function offsetDate(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

// ── Investigation tasks per anomaly type ──────────────────────────────────────

/**
 * Returns targeted Shopify investigation tasks for the given anomaly.
 * These replace the LLM planning phase. Tasks are kept to 1-2 per anomaly
 * type with maxSteps capped — the Shopify agent runs parallel tool calls
 * within a single session so multiple tasks only add overhead.
 */
export function getAnomalyTasks(ctx: AnomalyContext): EvidenceTask[] {
  const date = ctx.date.slice(0, 10);
  const since30 = offsetDate(date, -30);
  const since60 = offsetDate(date, -60);
  const sid = ctx.shopifySourceId;

  switch (ctx.insightType) {
    case 'REFUND_RATE_SPIKE':
      return [
        {
          agentType: 'shopify',
          sourceId: sid,
          maxSteps: 5,
          question: `Run in parallel: (1) refund analysis ${since30}→${date} and ${since60}→${since30}, (2) inventory levels, (3) fulfillment backlog since ${since30}. Return: refund rate % for both periods, top 5 refunded products by unit count, stock status for those products, count of orders unfulfilled 4+ days.`,
        },
      ];

    case 'DAILY_ORDERS_TREND':
      if (ctx.direction === 'drop') {
        return [
          {
            agentType: 'shopify',
            sourceId: sid,
            maxSteps: 5,
            question: `Run in parallel: (1) daily order time series ${since30}→${date}, (2) top 25 products by revenue ${since30}→${date} and ${since60}→${since30}, (3) inventory levels. Return: which day the drop started, steepness, top products in current vs prior period, any products that disappeared from top rankings, out-of-stock items that were previously top sellers.`,
          },
          {
            agentType: 'shopify',
            sourceId: sid,
            maxSteps: 4,
            question: `Get discount performance ${since30}→${date} vs ${since60}→${since30}. Return: uptake rate % for both periods, total discount spend, which high-value codes expired or had significant drop in usage around the order drop date.`,
          },
        ];
      } else {
        return [
          {
            agentType: 'shopify',
            sourceId: sid,
            maxSteps: 5,
            question: `Run in parallel: (1) daily order time series ${since30}→${date}, (2) top 25 products by revenue ${since30}→${date} vs ${since60}→${since30}, (3) inventory levels for top-gaining products. Return: which day spike started, which products drove it, revenue delta, and days of stock remaining at current run rate for top spike products.`,
          },
        ];
      }

    case 'AOV_EROSION':
      return [
        {
          agentType: 'shopify',
          sourceId: sid,
          maxSteps: 5,
          question: `Run in parallel: (1) orders summary ${since30}→${date} and ${since60}→${since30}, (2) top 25 products ${since30}→${date} vs ${since60}→${since30}, (3) discount performance ${since30}→${date}. Return: exact AOV for both periods and % change, which products shifted in rank (cheaper items up, premium items down), discount uptake % for both periods.`,
        },
        {
          agentType: 'shopify',
          sourceId: sid,
          maxSteps: 3,
          question: `Get customer retention stats ${since30}→${date} vs ${since60}→${since30}. Return: new vs returning customer order % for both periods, repeat purchase rate, and avg orders per returning customer. Focus on whether rising new-customer share correlates with the AOV drop.`,
        },
      ];

    case 'REPEAT_PURCHASE_RATE_DROP':
      return [
        {
          agentType: 'shopify',
          sourceId: sid,
          maxSteps: 5,
          question: `Run in parallel: (1) customer retention stats for recent period vs ${since60}→${since30}, (2) refund analysis ${since60}→${date}, (3) fulfillment summary since ${since60}. Return: repeat purchase rate % for both periods, whether returning customers appear in refunds, avg fulfillment time, any orders older than 7 days unfulfilled.`,
        },
      ];

    case 'DISCOUNT_DEPENDENCY_CREEP':
      return [
        {
          agentType: 'shopify',
          sourceId: sid,
          maxSteps: 5,
          question: `Run in parallel: (1) discount performance ${since60}→${date}, (2) orders summary ${since30}→${date} vs ${since60}→${since30}, (3) customer retention stats ${since60}→${date}. Return: % of orders using a code each period, total discount spend, top 3 codes by usage, AOV with vs without discount, and whether code users are new or returning customers.`,
        },
      ];

    case 'PRODUCT_REVENUE_SHIFT':
      return [
        {
          agentType: 'shopify',
          sourceId: sid,
          maxSteps: 4,
          question: `Get top 25 products ${since30}→${date} and ${since60}→${since30} in parallel. Return: products that entered top rankings, products that dropped out, revenue delta for the biggest movers in both directions, exact units and revenue for each.`,
        },
        {
          agentType: 'shopify',
          sourceId: sid,
          maxSteps: 4,
          question: `Run in parallel: (1) inventory levels for all products (flag under 20 units), (2) refund analysis ${since60}→${date}. Return: stock remaining for the products that gained the most rank, and whether products that lost rank also have elevated refund rates.`,
        },
      ];

    default:
      return [
        {
          agentType: 'shopify',
          sourceId: sid,
          maxSteps: 5,
          question: `Get store performance overview ${since30}→${date} vs ${since60}→${since30}: orders summary, top 10 products, customer retention, discount usage. Return what changed most significantly around ${date}.`,
        },
      ];
  }
}

// ── Anomaly-specific synthesis prompt ─────────────────────────────────────────

export function buildAnomalySynthesisSystem(
  ctx: AnomalyContext,
  persona: Persona,
  orgContextBlock: string,
  memoryBlock: string,
): string {
  const personaSystem = getPersonaPrompt(persona);
  // Percent deviation of the observed value from its baseline mean. Named
  // pctDelta (not pctChange) to avoid confusion with the week-over-week
  // pctChange util in weekly-digest, which has different null-baseline semantics.
  const pctDelta =
    ctx.mean > 0
      ? Math.round(((ctx.actualValue - ctx.mean) / Math.abs(ctx.mean)) * 100)
      : 0;
  const absChange = pctDelta >= 0 ? `+${pctDelta}%` : `${pctDelta}%`;
  const severity = Math.abs(ctx.zScore).toFixed(1);

  const typeDescriptions: Record<string, string> = {
    REFUND_RATE_SPIKE: 'a spike in refund rate',
    DAILY_ORDERS_TREND_spike: 'an unexpected spike in daily orders',
    DAILY_ORDERS_TREND_drop: 'a drop in daily orders',
    AOV_EROSION: 'a decline in average order value (AOV)',
    REPEAT_PURCHASE_RATE_DROP: 'a drop in repeat purchase rate',
    DISCOUNT_DEPENDENCY_CREEP: 'growing discount dependency',
    PRODUCT_REVENUE_SHIFT: 'a shift in product revenue mix',
    WEEKLY_REVENUE_TRAJECTORY: 'a sustained multi-week revenue trend',
    INVENTORY_STOCKOUT_RISK: 'a bestseller out of stock or about to run out',
    INVENTORY_TURN_RATE_DROP: 'slow-moving inventory tying up capital',
    SELL_THROUGH_RATE_DROP: 'overstocked inventory with low sell-through',
    LOCATION_INVENTORY_IMBALANCE: 'a stockout at one location while others hold stock',
    NEW_CUSTOMER_ACQUISITION_DROP: 'a drop in new-customer acquisition',
    CHECKOUT_ABANDONMENT_SPIKE: 'a spike in checkout abandonment',
    FULFILLMENT_DELAY_SPIKE: 'a fulfillment backlog / aged unfulfilled orders',
  };

  const typeGuidance: Record<string, string> = {
    REFUND_RATE_SPIKE: `Key questions from data: Which SKU dominates refunds (single-SKU = batch defect; spread = fulfillment/listing)? Is fulfillment backlog >4 days (customers preemptively refunding)? Actions: pull the specific batch, personal message to affected buyers (not a blanket coupon), fix backlog before any marketing.`,

    DAILY_ORDERS_TREND_drop: `Key questions from data: Did a top SKU go out of stock when orders dropped (supply problem, not demand)? Did a high-value discount code expire (sharp before/after = promo lapse)? Actions: name the specific product or code — "restock X" / "reactivate Y", not "review inventory". Back-in-stock email recovers drops fast.`,

    DAILY_ORDERS_TREND_spike: `Key questions from data: Which products drove it (name with exact revenue)? Days of stock at current run rate (most urgent number)? New vs returning customers? Actions: if stock is at risk, calculate reorder now. If new customers, start post-purchase sequence today — waiting kills momentum.`,

    AOV_EROSION: `Key questions from data: Product mix shift (cheaper items rising) or discount abuse (more code usage)? New-customer share rising (new buyers order less — different fix)? Actions: name the mechanism with exact numbers. If discount creep: cap the specific codes. Bundle 2-3 co-purchased products to lift AOV without a price change.`,

    REPEAT_PURCHASE_RATE_DROP: `Key questions from data: Did drop coincide with fulfillment slowdown or refund spike? Are returning customers in the refund data (experience failure, not acquisition problem)? Actions: if fulfillment delays correlate, personal outreach to affected customers. Fix the product/experience before any retention campaign.`,

    DISCOUNT_DEPENDENCY_CREEP: `Key questions from data: Returning or new customers driving code usage (returning = trained to discount-hunt, structural)? Which 3 codes account for most spend? Exact discount dollars from evidence. Actions: expire/restrict top codes for loyalists, replace with early access or free shipping. Audit coupon aggregator sites for leaked codes.`,

    PRODUCT_REVENUE_SHIFT: `Key questions from data: Name the winner and loser with exact revenue deltas. Days of stock for winner at current run rate (a gaining product with <7 days will self-reverse). Does the loser have elevated refunds (quality issue, not just demand shift)? Actions: reorder the winner today if stock is constrained. Don't market the loser until refund issue is resolved.`,

    WEEKLY_REVENUE_TRAJECTORY: `This is a slow trend over 12 weeks, NOT a one-week event — do not frame it as "this week". Key questions from data: Is the slope driven by order count or AOV (volume vs value problem)? Does the decline track a specific product/category falling out of the mix, or is it broad-based? How strong is the fit (R²) — a tight fit means the trend is real and will continue absent intervention. Actions: quantify the run-rate destination (extrapolate the slope to next quarter) so the merchant feels the stakes, then attack the dominant driver — re-acquisition if order count is sliding, bundling/upsell if AOV is.`,

    INVENTORY_STOCKOUT_RISK: `Time-sensitive — every day OOS is direct lost revenue. Key questions from data: Is the product fully out (lost sales now) or within reorder lead time (days of cover vs the 14-day window)? What's the daily velocity and implied daily revenue loss? Actions: name the exact product and the reorder quantity to cover lead time + buffer; if already OOS, set up a back-in-stock notification to recapture demand and check for a substitutable variant to redirect buyers to today.`,

    INVENTORY_TURN_RATE_DROP: `Capital efficiency problem, not a demand emergency — frame it as cash tied up, not lost sales. Key questions from data: How many annualized turns vs the 4-turn floor, and how many days of stock on hand? Is velocity low enough that the on-hand quantity is simply an over-order? Actions: recommend a markdown/bundle to move the stale units and an explicit reduction to the next reorder quantity; quantify the capital freed so the trade-off against a discount is clear.`,

    SELL_THROUGH_RATE_DROP: `Overstock signal (the inverse of stockout) — too much supply against demand. Key questions from data: Sell-through % vs the 50% floor, units still on hand, and days-to-sell-out at current velocity. Is this a seasonal item past its window? Actions: a targeted promotion or bundle to lift sell-through before the capital ages further; flag the over-order so the next purchase is sized to actual velocity.`,

    LOCATION_INVENTORY_IMBALANCE: `Fixable with an inter-location transfer — faster and cheaper than a supplier reorder, so lead with that. Key questions from data: Which location(s) are empty, which holds the stock, and how much cover the stocked locations provide if they absorb the empty location's demand? Actions: recommend the specific transfer (from the top-stock location to the empty one) with a rough quantity; if the empty location serves a distinct region, note the local demand it's currently failing to capture.`,

    NEW_CUSTOMER_ACQUISITION_DROP: `Top-of-funnel signal — orders look fine today but the pipeline is shrinking. Key questions from data: Magnitude of the WoW drop (% and absolute), and did conversion rate fall too (traffic-quality issue) or only signups (traffic-volume issue)? Common drivers: paused/cut ad spend, expired campaign, SEO slip, competitor promo. Actions: check what changed in acquisition channels around the drop date; name the most likely lever (reactivate the paused campaign, restore spend) rather than a generic "review marketing".`,

    CHECKOUT_ABANDONMENT_SPIKE: `A sudden jump usually means something broke, not a demand shift — investigate mechanics first. Key questions from data: Size of the pp jump and the abandoned-cart value/count at stake. Did it coincide with a deploy, a shipping-rate change, or a payment-gateway issue? Actions: walk the checkout on mobile and desktop to reproduce, check for a surprise cost on the final step, and verify the payment provider; if a specific step is implicated, fix it before any abandoned-cart email — recovering carts won't help if checkout is still broken.`,

    FULFILLMENT_DELAY_SPIKE: `Customer-experience risk that compounds into refunds and bad reviews if left. Key questions from data: Is there a single order well past SLA (14+ days) or a systemic backlog (count and share of recent orders aged 3+ days)? Is the backlog concentrated in one product (supply gap) or broad (ops capacity)? Actions: clear the oldest orders first with proactive customer outreach, identify whether the bottleneck is stock or labor, and watch for preemptive refunds from waiting customers.`,
  };

  const guidanceKey =
    ctx.insightType === 'DAILY_ORDERS_TREND'
      ? `DAILY_ORDERS_TREND_${ctx.direction}`
      : ctx.insightType;

  const typeDescription =
    typeDescriptions[guidanceKey] ?? typeDescriptions[ctx.insightType] ?? 'an anomaly in store data';
  const guidance = typeGuidance[guidanceKey] ?? '';

  const orgCtxSection = orgContextBlock ? `\n\nOrganisation context:\n${orgContextBlock}` : '';

  return `${personaSystem}${orgCtxSection}

Anomaly: **${typeDescription}** on ${ctx.date} (${absChange} from baseline, ${severity}σ).
${guidance}

FORMAT — use only numbers from the evidence, no fabrication:

ONE sentence opener — the specific product/number that explains what happened.

**What the data shows:**
Compact markdown table(s) with period-over-period comparisons. Columns relevant to this anomaly type (e.g. Product | Prior Rev | Current Rev | Δ | Units | Refunds | Stock). Every cell from evidence only.

**Your 3 priorities this week:**
Bold title (4–6 words) + 2–3 sentences each. Exact product names, %, counts. What to do + why + expected outcome.

**Your move today:**
One action doable in 30 min. If a customer message — write the copy. If an admin check — give the exact Shopify filter path.

Tone: trusted advisor, short sentences, no hedging, no "consider".${memoryBlock}

Evidence (compact rows):`;
}

// ── Status label per anomaly ──────────────────────────────────────────────────

export function getAnomalyOpener(insightType: string, direction: 'spike' | 'drop'): string {
  const map: Record<string, string> = {
    REFUND_RATE_SPIKE:
      "My refund rate just spiked — help me figure out what's driving it and what to do this week.",
    DAILY_ORDERS_TREND_drop:
      "My daily orders dropped sharply — help me understand what's happening and what steps to take.",
    DAILY_ORDERS_TREND_spike:
      "I'm seeing an unexpected order spike — help me understand what's driving it and how to capitalize.",
    AOV_EROSION:
      "My average order value is declining — what's causing this and what can I do about it this week?",
    REPEAT_PURCHASE_RATE_DROP:
      "My repeat purchase rate dropped — help me figure out why returning customers aren't coming back and what to do.",
    DISCOUNT_DEPENDENCY_CREEP:
      "I'm relying too heavily on discounts — help me build a plan to reduce this dependency.",
    PRODUCT_REVENUE_SHIFT:
      "My product revenue mix shifted — help me understand what changed and what actions to take.",
  };

  const key = `${insightType}_${direction}`;
  return map[key] ?? map[insightType] ?? "My analyst flagged an anomaly — help me understand what's happening and what to do.";
}
