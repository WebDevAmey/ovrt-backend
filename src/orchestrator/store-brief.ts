import type { WeeklyDigestContent } from '../analyst/weekly-digest/types.js';

/**
 * Store Brief rendering (pure, DB-free)
 * =====================================
 * Turns already-fetched analyst data — the latest weekly digest (what's
 * normal), open opportunities (what's currently flagged), and recent
 * customer-support signals (voice of customer) — into the prompt blocks the
 * chat lifecycle injects at planning, synthesis, and the Shopify agent.
 *
 * Kept free of any DB import so it stays deterministic and unit-testable. The
 * DB fetch lives in store-intelligence.ts.
 */

export const CUSTOMER_INSIGHT_WINDOW_DAYS = 30;
export const MAX_HOOKS = 5;
const MAX_CUSTOMER_EXAMPLES = 3;

export type StoreIntelligence = {
  /** Rich block for synthesis + the Shopify agent. Empty string when no data. */
  storeBriefBlock: string;
  /** Terse block for the planner: active signals so follow-ups route with awareness. Empty when none. */
  storeSignalsBlock: string;
  /** True when at least one source produced data. */
  hasData: boolean;
};

/** Minimal opportunity shape the assembler needs (subset of Opportunity). */
export type StoreOpportunityInput = { title: string; description: string; category: string };
/** Minimal customer-insight shape the assembler needs (subset of CustomerInsight). */
export type StoreCustomerInsightInput = { type: string; sentiment: string; summary: string };

export const EMPTY_STORE_INTELLIGENCE: StoreIntelligence = {
  storeBriefBlock: '',
  storeSignalsBlock: '',
  hasData: false,
};

// Map the CustomerInsight enum to operator-friendly labels.
const INSIGHT_TYPE_LABELS: Record<string, string> = {
  PRODUCT_QUALITY: 'product-quality',
  WRONG_OR_DAMAGED_ITEM: 'wrong/damaged item',
  FAQ_GAP: 'FAQ gap',
  FEATURE_REQUEST: 'feature request',
  STOCK_REQUEST: 'stock request',
  SHIPPING_PAIN: 'shipping',
  PRAISE: 'praise',
  OTHER: 'other',
};

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  return `${n.toFixed(1)}%`;
}

// Signed week-over-week delta, e.g. "+12.5% WoW" / "-5.2% WoW". null → "n/a".
function fmtDelta(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return 'n/a';
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% WoW`;
}

function fmtMoney(currency: string, n: number | null | undefined, decimals = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return 'n/a';
  return `${currency} ${n.toLocaleString('en-US', { maximumFractionDigits: decimals, minimumFractionDigits: decimals })}`.trim();
}

/**
 * Render the weekly digest into the "what's normal" core of the brief.
 * Returns the brief lines plus the digest's flagged concerns for the caller to merge.
 */
function renderDigestSection(content: WeeklyDigestContent): { lines: string[]; concerns: string[] } {
  const m = content.metrics;
  const currency = m?.currency ?? '';
  const wow = content.weekOverWeek ?? ({} as WeeklyDigestContent['weekOverWeek']);

  const lines: string[] = [];
  lines.push(
    `STORE PULSE (week of ${content.weekStart}, health ${content.healthScore}/100): ` +
      `revenue ${fmtMoney(currency, m?.totalRevenue)} (${fmtDelta(wow.revenueChangePct)}), ` +
      `orders ${m?.totalOrders ?? 'n/a'} (${fmtDelta(wow.ordersChangePct)}), ` +
      `AOV ${fmtMoney(currency, m?.averageOrderValue, 2)} (${fmtDelta(wow.aovChangePct)}).`,
  );

  // Normal daily-order range from the within-week daily shape.
  const dailyOrders = (m?.dailyTrend ?? []).map((d) => d.orders).filter((n) => Number.isFinite(n));
  if (dailyOrders.length > 0) {
    const min = Math.min(...dailyOrders);
    const max = Math.max(...dailyOrders);
    lines.push(`Typical daily orders: ${min}–${max}/day last week.`);
  }

  // What's normal — the store's own recent baselines, so the model can judge new numbers.
  const norms: string[] = [];
  if (m?.refundRate !== undefined) norms.push(`refund rate ${fmtPct(m.refundRate)}`);
  if (m?.abandonmentRate !== undefined) norms.push(`checkout abandonment ${fmtPct(m.abandonmentRate)}`);
  if (m?.discountUptakeRate !== undefined) norms.push(`discount uptake ${fmtPct(m.discountUptakeRate)}`);
  if (norms.length > 0) {
    lines.push(`WHAT'S NORMAL for this store (last week): ${norms.join(' · ')}.`);
  }

  if (content.headline) lines.push(`Last week in a line: ${content.headline}`);

  const concerns = (content.topConcerns ?? []).filter((c) => c && c.trim().length > 0);
  return { lines, concerns };
}

/**
 * Pure assembler — turns already-fetched analyst data into prompt blocks.
 * No DB access, so it is deterministic and unit-testable.
 */
export function assembleStoreIntelligence(
  digestContent: WeeklyDigestContent | null,
  opportunities: StoreOpportunityInput[],
  customerInsights: StoreCustomerInsightInput[],
): StoreIntelligence {
  const briefSections: string[] = [];
  const flagged: string[] = [];
  const signalTypes = new Set<string>();
  let digestWeek: string | null = null;
  let digestHealth: number | null = null;

  // ── What's normal (weekly digest) ────────────────────────────────────────
  if (digestContent) {
    digestWeek = digestContent.weekStart ?? null;
    digestHealth = typeof digestContent.healthScore === 'number' ? digestContent.healthScore : null;
    const { lines, concerns } = renderDigestSection(digestContent);
    briefSections.push(lines.join('\n'));
    flagged.push(...concerns);
    for (const a of digestContent.anomalies ?? []) {
      if (a.insightType) signalTypes.add(a.insightType);
    }
  }

  // ── What's currently flagged (open opportunities) ────────────────────────
  for (const o of opportunities) {
    if (o.title) flagged.push(o.title.trim());
    if (o.category) signalTypes.add(o.category);
  }
  if (flagged.length > 0) {
    const unique = [...new Set(flagged)];
    briefSections.push(
      'CURRENTLY FLAGGED (proactively raise any of these if relevant to the question):\n' +
        unique.map((f) => `- ${f}`).join('\n'),
    );
  }

  // ── Voice of customer (recent support signals) ───────────────────────────
  if (customerInsights.length > 0) {
    const counts = new Map<string, number>();
    for (const ci of customerInsights) {
      const label = INSIGHT_TYPE_LABELS[ci.type] ?? ci.type.toLowerCase();
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const countLine = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, n]) => `${n} ${label}`)
      .join(', ');

    // A couple of analyst-written example summaries — negative sentiment first.
    const examples = [...customerInsights]
      .sort((a, b) => (a.sentiment === 'NEGATIVE' ? -1 : 0) - (b.sentiment === 'NEGATIVE' ? -1 : 0))
      .slice(0, MAX_CUSTOMER_EXAMPLES)
      .map((ci) => ci.summary?.trim())
      .filter((s): s is string => !!s && s.length > 0);

    const lines = [
      `CUSTOMER VOICE (last ${CUSTOMER_INSIGHT_WINDOW_DAYS}d, ${customerInsights.length} signals): ${countLine}.`,
    ];
    if (examples.length > 0) lines.push(...examples.map((e) => `- ${e}`));
    briefSections.push(lines.join('\n'));
  }

  if (briefSections.length === 0) return EMPTY_STORE_INTELLIGENCE;

  const storeBriefBlock =
    "STORE BRIEF — your live knowledge of THIS specific store. Use it to judge whether a number is good or bad for them, and to proactively surface what's already flagged. Treat these as known facts, not evidence to re-verify:\n\n" +
    briefSections.join('\n\n');

  // Terse planner signal: what's going on, so follow-ups route with awareness.
  const signalParts: string[] = [];
  if (digestWeek) {
    signalParts.push(
      `A recent weekly digest exists (week of ${digestWeek}${digestHealth !== null ? `, health ${digestHealth}/100` : ''}).`,
    );
  }
  if (signalTypes.size > 0) {
    signalParts.push(`Active store signals: ${[...signalTypes].join(', ')}.`);
  }
  const storeSignalsBlock = signalParts.length > 0 ? `\n\nSTORE SIGNALS: ${signalParts.join(' ')}` : '';

  return { storeBriefBlock, storeSignalsBlock, hasData: true };
}
