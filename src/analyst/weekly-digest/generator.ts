import { generateText } from 'ai';
import { openaiModel, samplingFor, maxTokensFor } from '../../openai.js';
import { logAiTokenUsage } from '../../ai-token-usage.js';
import { DIGEST_MODEL, DIGEST_MAX_TOKENS, DIGEST_TEMPERATURE } from '../constants.js';
import { pctChange } from './utils.js';
import type { DigestStoreMetrics, DigestAnomalySummary } from './types.js';
import type { OpportunityDraft, OpportunityEvidence, OpportunityEvidenceType } from '../opportunity/types.js';

// ── Numeric guards for LLM-supplied numbers ───────────────────

function finiteNumber(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ── Prompt builders ───────────────────────────────────────────

// Renders a WoW percentage, treating null (zero prior-week baseline) as an
// explicit "no baseline" rather than a misleading "+0.0%".
function signedPct(n: number | null): string {
  if (n === null) return 'n/a (no prior-week baseline)';
  return (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
}

function buildMetricsBlock(m: DigestStoreMetrics): string {
  const revWow = pctChange(m.totalRevenue, m.priorWeekRevenue);
  const ordWow = pctChange(m.totalOrders, m.priorWeekOrders);
  const aovWow = pctChange(m.averageOrderValue, m.priorWeekAov);
  const cur = m.currency;

  const productsTable =
    m.topProducts.length > 0
      ? m.topProducts
          .map(
            (p, i) =>
              `  ${(i + 1).toString().padStart(2)}. ${p.product.slice(0, 50).padEnd(50)} ${p.units.toString().padStart(5)} units   ${cur} ${p.revenue.toFixed(2).padStart(10)}`,
          )
          .join('\n')
      : '  (no product data available)';

  const dailyTable =
    m.dailyTrend.length > 0
      ? m.dailyTrend
          .map(
            (d) =>
              `  ${d.date}: ${d.orders.toString().padStart(4)} orders   ${cur} ${d.revenue.toFixed(2).padStart(10)}`,
          )
          .join('\n')
      : '  (no daily data available)';

  const truncationNote = m.truncated
    ? '\n⚠ DATA CAVEAT: order volume exceeded the fetch cap this week, so revenue/order/customer totals likely UNDERSTATE the true figures. Acknowledge this uncertainty and do not over-interpret WoW changes.\n'
    : '';

  return `WEEK: ${m.weekStart} → ${m.weekEnd}  (revenue WoW: ${signedPct(revWow)})
${truncationNote}
REVENUE & ORDERS
  Revenue        : ${cur} ${m.totalRevenue.toFixed(2)}  (prior ${cur} ${m.priorWeekRevenue.toFixed(2)}, ${signedPct(revWow)} WoW)
  Orders         : ${m.totalOrders}  (prior ${m.priorWeekOrders}, ${signedPct(ordWow)} WoW)
  AOV            : ${cur} ${m.averageOrderValue.toFixed(2)}  (prior ${cur} ${m.priorWeekAov.toFixed(2)}, ${signedPct(aovWow)} WoW)
  Unique Cust.   : ${m.uniqueCustomers}
  Discounts Given: ${cur} ${m.totalDiscounts.toFixed(2)}

DAILY SHAPE (within the week)
${dailyTable}

CUSTOMERS
  Newly-registered accounts: ${m.newlyRegisteredCustomers}  (prior week ${m.priorWeekNewlyRegistered}, ${signedPct(pctChange(m.newlyRegisteredCustomers, m.priorWeekNewlyRegistered))} WoW)
  NOTE: this counts accounts CREATED this week, not new-vs-repeat buyers — do not describe it as "repeat purchase rate".

REFUNDS
  Refund rate    : ${m.refundRate.toFixed(1)}%  of orders
  Amount refunded: ${cur} ${m.totalRefunded.toFixed(2)}
${buildRefundedProductsBlock(m)}

DISCOUNTS & PROMOTIONS
  Code uptake rate: ${m.discountUptakeRate.toFixed(1)}%  of orders used a code
${buildDiscountCodesBlock(m)}

CHECKOUT
  Abandonment rate: ${m.abandonmentRate.toFixed(1)}%   (abandoned cart value: ${cur} ${m.abandonedValue.toFixed(2)})

INVENTORY HEALTH (current snapshot)
  Out of stock: ${m.outOfStockCount}   Low stock: ${m.lowStockCount}
${buildLowStockBlock(m)}

TOP 10 PRODUCTS BY REVENUE
${productsTable}`;
}

function buildRefundedProductsBlock(m: DigestStoreMetrics): string {
  if (m.refundedProducts.length === 0) return '  Top refunded products: none';
  const lines = m.refundedProducts.map(
    (p) => `    • ${p.product.slice(0, 50)} — ${p.unitsRefunded} units (${p.refundOccurrences} refunds)`,
  );
  return `  Top refunded products:\n${lines.join('\n')}`;
}

function buildDiscountCodesBlock(m: DigestStoreMetrics): string {
  if (m.topDiscountCodes.length === 0) return '  Top codes: none used this week';
  const cur = m.currency;
  const lines = m.topDiscountCodes.map(
    (c) =>
      `    • ${c.code} — used ${c.timesUsed}×, ${cur} ${c.totalDiscount.toFixed(2)} discounted → ${cur} ${c.totalRevenue.toFixed(2)} revenue`,
  );
  return `  Top codes:\n${lines.join('\n')}`;
}

function buildLowStockBlock(m: DigestStoreMetrics): string {
  if (m.lowStockItems.length === 0) return '  At-risk items: none';
  const lines = m.lowStockItems.map(
    (i) => `    • [${i.status}] ${i.product.slice(0, 40)} (${i.variant.slice(0, 30)}) — ${i.available} available`,
  );
  return `  At-risk items:\n${lines.join('\n')}`;
}

function buildAnomaliesBlock(anomalies: DigestAnomalySummary[]): string {
  if (anomalies.length === 0) {
    return 'ANALYST ANOMALIES: None detected this week.';
  }
  const lines = anomalies.map(
    (a) =>
      `  • [${a.severity.toUpperCase()}] ${a.insightType} — ${a.direction.toUpperCase()}: ${a.summary}  (${a.detectedAt})`,
  );
  return `ANALYST ANOMALIES DETECTED THIS WEEK (${anomalies.length}):\n${lines.join('\n')}`;
}

function isNonEmptyObject(ctx: unknown): boolean {
  return Boolean(ctx) && typeof ctx === 'object' && Object.keys(ctx as object).length > 0;
}

function buildContextBlock(businessContext: unknown, orgIdentity: unknown): string {
  const sections: string[] = [];
  if (isNonEmptyObject(orgIdentity)) {
    try {
      sections.push(`STORE IDENTITY (brand, voice, positioning — tailor the narrative to this):\n${JSON.stringify(orgIdentity, null, 2)}`);
    } catch {
      /* ignore unserialisable identity */
    }
  }
  if (isNonEmptyObject(businessContext)) {
    try {
      sections.push(`BUSINESS CONTEXT:\n${JSON.stringify(businessContext, null, 2)}`);
    } catch {
      /* ignore unserialisable context */
    }
  }
  return sections.length > 0 ? `\n${sections.join('\n\n')}` : '';
}

// ── LLM output shape (before validation) ─────────────────────

interface RawLlmEvidence {
  type?: unknown;
  label?: unknown;
  value?: unknown;
  ref?: unknown;
  note?: unknown;
}

interface RawLlmOpportunity {
  title?: unknown;
  description?: unknown;
  category?: unknown;
  priority?: unknown;
  evidence?: unknown;
  dedupeKey?: unknown;
}

interface RawLlmOutput {
  headline?: unknown;
  narrative?: unknown;
  // healthScore is computed deterministically by the caller — the LLM only
  // explains it via healthScoreRationale.
  healthScoreRationale?: unknown;
  topWins?: unknown;
  topConcerns?: unknown;
  opportunities?: unknown;
}

// ── Validation / sanitisation ─────────────────────────────────

const VALID_CATEGORIES = new Set([
  'MARKETING',
  'COMMUNICATION',
  'PRICING',
  'PRODUCT',
  'RETENTION',
  'OPERATIONS',
  'CUSTOMER_EXPERIENCE',
  'INVENTORY',
  'ACQUISITION',
  'OTHER',
]);

const VALID_EVIDENCE_TYPES = new Set(['anomaly', 'metric', 'cohort', 'message', 'digest']);

function sanitiseEvidence(raw: unknown, digestId: string): OpportunityEvidence[] {
  if (!Array.isArray(raw)) {
    return [{ type: 'digest', label: 'Weekly digest', ref: digestId, note: 'Generated from weekly digest' }];
  }
  return (raw as RawLlmEvidence[])
    .map((e) => ({
      type: (VALID_EVIDENCE_TYPES.has(e.type as string) ? e.type : 'digest') as OpportunityEvidenceType,
      label: typeof e.label === 'string' ? e.label.slice(0, 120) : '',
      value: typeof e.value === 'string' ? e.value.slice(0, 120) : undefined,
      ref: typeof e.ref === 'string' ? e.ref.slice(0, 120) : digestId,
      note: typeof e.note === 'string' ? e.note.slice(0, 300) : undefined,
    }))
    .filter((e) => e.label.length > 0);
}

function sanitiseOpportunities(raw: unknown, digestId: string): OpportunityDraft[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawLlmOpportunity[])
    .slice(0, 5)
    .map((o) => {
      const priority = finiteNumber(o.priority);
      const title = typeof o.title === 'string' ? o.title.slice(0, 80) : 'Opportunity';
      return {
        title,
        description: typeof o.description === 'string' ? o.description.slice(0, 2000) : '',
        category: VALID_CATEGORIES.has(o.category as string) ? (o.category as string) : 'OTHER',
        priority: priority === undefined ? 50 : clamp(Math.round(priority), 0, 100),
        evidence: sanitiseEvidence(o.evidence, digestId),
        dedupeKey:
          typeof o.dedupeKey === 'string' && o.dedupeKey.length > 0
            ? o.dedupeKey.slice(0, 120)
            : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60),
      };
    })
    .filter((o) => o.description.length > 0 && o.evidence.length > 0);
}

// ── Public interface ──────────────────────────────────────────

export interface GenerateDigestResult {
  headline: string;
  narrative: string;
  healthScore: number;
  healthScoreRationale: string;
  topWins: string[];
  topConcerns: string[];
  opportunities: OpportunityDraft[];
  modelName: string;
}

export async function generateDigest(
  metrics: DigestStoreMetrics,
  anomalies: DigestAnomalySummary[],
  orgContext: {
    organisationId: string;
    businessContext?: unknown;
    orgIdentity?: unknown;
  },
  digestId: string,
  healthScore: number,
): Promise<GenerateDigestResult> {
  const metricsBlock = buildMetricsBlock(metrics);
  const anomaliesBlock = buildAnomaliesBlock(anomalies);
  const contextBlock = buildContextBlock(orgContext.businessContext, orgContext.orgIdentity);
  const healthBand =
    healthScore >= 70 ? 'healthy' : healthScore >= 50 ? 'watch' : healthScore >= 30 ? 'concerning' : 'critical';

  const prompt = `You are a senior e-commerce business analyst generating a weekly digest for a Shopify merchant. Your analysis must be specific, data-driven, and grounded in the numbers provided.
${contextBlock}

━━━ STORE DATA ━━━
${metricsBlock}

━━━ ANOMALIES ━━━
${anomaliesBlock}

━━━ STORE HEALTH SCORE ━━━
The store health score for this week is ${healthScore}/100 (${healthBand}). This number was computed deterministically from the metrics above — do NOT change it. Your job is only to explain it in healthScoreRationale, grounded in the specific numbers that drove it (revenue trend, refund rate, abandonment, anomalies, inventory).

━━━ INSTRUCTIONS ━━━
Return ONLY a valid JSON object — no markdown fences, no prose outside the JSON.

{
  "headline": "<one sentence: what defined this week, cite a key number>",
  "narrative": "<3–4 paragraphs: what happened this week, likely drivers, what it means for the business. Reference specific numbers including the daily shape, inventory, discounts, and refunds where relevant.>",
  "healthScoreRationale": "<1–2 sentences explaining why the score is ${healthScore}/100, citing the metrics that drove it>",
  "topWins": ["<win 1>", "<win 2>", "<win 3>"],
  "topConcerns": ["<concern 1>", "<concern 2>", "<concern 3>"],
  "opportunities": [
    {
      "title": "<max 80 chars, action-oriented e.g. 'Create a denim bundle to lift average order value'>",
      "description": "<2-4 sentences: problem -> evidence with numbers -> concrete suggested action, in one piece of advice>",
      "category": "<MARKETING|COMMUNICATION|PRICING|PRODUCT|RETENTION|OPERATIONS|CUSTOMER_EXPERIENCE|INVENTORY|ACQUISITION|OTHER>",
      "priority": <0–100, higher = more urgent/impactful>,
      "evidence": [{ "type": "<anomaly|metric|digest>", "label": "<short label e.g. 'Refund rate'>", "value": "<e.g. '8.2% of orders'>", "ref": "<insightType or metric name>", "note": "<why this evidence supports it>" }],
      "dedupeKey": "<short stable slug for this topic, e.g. 'restock-bestseller'>"
    }
  ]
}

Rules:
• topWins and topConcerns must each have exactly 3 strings.
• Generate 0–5 opportunities. Quality over quantity — only include one when it is clearly supported by the data and combines problem, evidence, AND a concrete action in its description. Generic, common advice with no cited number is a failure.
• If a product is OUT_OF_STOCK or LOW_STOCK and is also a top seller, prioritise a restock-focused opportunity (category INVENTORY).
• If a discount code shows heavy use with thin revenue, consider a PRICING opportunity.
• "Newly-registered accounts" counts sign-ups, not repeat buyers — never describe it as a repeat-purchase or retention rate.
• Do not fabricate data. If a metric is zero, missing, or flagged as a data caveat, acknowledge that explicitly.`;

  const startedAt = new Date();
  const result = await generateText({
    model: openaiModel(DIGEST_MODEL),
    prompt,
    ...samplingFor(DIGEST_MODEL, DIGEST_TEMPERATURE),
    maxOutputTokens: maxTokensFor(DIGEST_MODEL, DIGEST_MAX_TOKENS),
  });

  logAiTokenUsage({
    organisationId: orgContext.organisationId,
    modelName: DIGEST_MODEL,
    feature: 'analyst',
    agentName: 'weekly-digest',
    operation: 'generate-digest',
    usage: result.usage,
    finishReason: result.finishReason,
    latencyMs: Date.now() - startedAt.getTime(),
    startedAt,
    metadata: { weekStart: metrics.weekStart, weekEnd: metrics.weekEnd },
  });

  // Extract the JSON object from the response, tolerating markdown fences and
  // leading/trailing prose that the model may emit despite the instruction.
  // Strategy: find the first '{' and last '}' and parse what's between them.
  let jsonText = result.text.trim();
  const firstBrace = jsonText.indexOf('{');
  const lastBrace = jsonText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    jsonText = jsonText.slice(firstBrace, lastBrace + 1);
  }

  let raw: RawLlmOutput;
  try {
    raw = JSON.parse(jsonText) as RawLlmOutput;
  } catch {
    throw new Error(`[digest] LLM returned unparseable JSON (finishReason=${result.finishReason}): ${jsonText.slice(0, 200)}`);
  }

  const headline =
    typeof raw.headline === 'string' ? raw.headline.slice(0, 300) : 'Weekly store digest';
  const narrative = typeof raw.narrative === 'string' ? raw.narrative : '';
  // healthScore is the deterministic value passed in — the LLM only explains it.
  const healthScoreRationale =
    typeof raw.healthScoreRationale === 'string' ? raw.healthScoreRationale : '';
  const topWins = Array.isArray(raw.topWins)
    ? (raw.topWins as unknown[]).filter((w) => typeof w === 'string').slice(0, 3) as string[]
    : [];
  const topConcerns = Array.isArray(raw.topConcerns)
    ? (raw.topConcerns as unknown[]).filter((c) => typeof c === 'string').slice(0, 3) as string[]
    : [];

  return {
    headline,
    narrative,
    healthScore,
    healthScoreRationale,
    topWins,
    topConcerns,
    opportunities: sanitiseOpportunities(raw.opportunities, digestId),
    modelName: DIGEST_MODEL,
  };
}
