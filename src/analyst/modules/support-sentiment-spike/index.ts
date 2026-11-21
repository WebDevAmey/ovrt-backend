import type { InsightModule, FactRow, AnomalyDetails } from '../types.js';
import { resolveSupportSource, fetchSupportInsights, type InsightRow } from './fetcher.js';
import { detectSupportSentimentSpike } from './detector.js';

/**
 * Support Sentiment Spike insight module.
 *
 * Watches CustomerInsight rows (extracted by the Gmail/WhatsApp support
 * agent from real customer messages) for two signals: a burst in a specific
 * complaint type (day-of-week-adjusted CUSUM), or a rise in overall
 * negative-sentiment share (EWMA control chart on 8 weekly snapshots).
 *
 * This is a leading indicator — support chatter about a bad batch or
 * packaging issue typically surfaces here before it shows up in
 * REFUND_RATE_SPIKE, since refunds take longer to process than a complaint
 * email.
 */
export const supportSentimentSpikeModule: InsightModule = {
  insightType: 'SUPPORT_SENTIMENT_SPIKE',
  sourceType: 'support',
  schedule: '0 10 * * *',             // 10am daily
  rateLimitMs: 23 * 60 * 60 * 1000,

  resolveSource: resolveSupportSource,
  fetchData: fetchSupportInsights,
  detectAnomaly: detectSupportSentimentSpike,

  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string {
    const typed = rows as InsightRow[];
    const trigger = anomaly.trigger as string;

    const recentCutoff = typed.length > 0 ? typed[typed.length - 1]!.date : anomaly.date;
    const byTypeCount = new Map<string, number>();
    for (const r of typed) {
      byTypeCount.set(r.type, (byTypeCount.get(r.type) ?? 0) + 1);
    }
    const typeTable = Array.from(byTypeCount.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type.padEnd(22)} | ${String(count).padStart(5)}`)
      .join('\n');

    if (trigger === 'complaint_burst') {
      return `Support Sentiment Analysis — Complaint Burst

Complaint type volume (last ${typed.length > 0 ? 'window' : 'period'} through ${recentCutoff}):

type                   | count
------------------------|------
${typeTable}

Detected Burst (day-of-week-adjusted CUSUM):
- Complaint type: "${anomaly.complaintType as string}"
- Yesterday's count: ${anomaly.actualValue}
- This weekday's baseline: ${anomaly.mean}
- Cumulative deviation (CUSUM): ${anomaly.zScore}

A sudden burst in one complaint type often precedes a refund-rate spike — this is the support-channel signal of a quality or fulfillment issue before it shows up in returns data.`;
    }

    return `Support Sentiment Analysis — Negative Sentiment Rise

Complaint type volume (through ${recentCutoff}):

type                   | count
------------------------|------
${typeTable}

Detected Anomaly (EWMA control chart on negative-sentiment share):
- Latest negative-sentiment share: ${anomaly.actualValue.toFixed(1)}%
- Baseline (EWMA): ${anomaly.mean.toFixed(1)}%
- ${anomaly.currentNegative as number} of ${anomaly.currentTotal as number} support insights this week were negative

Overall customer sentiment in support conversations has shifted negative beyond the normal baseline.`;
  },
};
