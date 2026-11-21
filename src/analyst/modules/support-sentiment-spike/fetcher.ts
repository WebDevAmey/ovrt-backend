import { prisma } from '../../../prisma.js';
import { BUSINESS_TIMEZONE } from '../../constants.js';

export type InsightRow = {
  type: string;       // InsightType enum value
  sentiment: string;  // InsightSentiment enum value
  date: string;       // YYYY-MM-DD, business timezone
};

// 70 days: 9 weeks for the weekly negative-sentiment EWMA series, plus a
// little extra so the day-of-week CUSUM per complaint type has a full
// 63-day window once bucketed.
const LOOKBACK_DAYS = 70;

function toBusinessDateStr(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const day = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${day}`;
}

/**
 * resolveSource for this module is the organisation itself — CustomerInsight
 * rows are written directly by the Gmail/WhatsApp support adapters with no
 * separate "integration" record to gate on (unlike Shopify). We only run
 * this module for orgs that actually have support insight data.
 */
export async function resolveSupportSource(orgId: string): Promise<string | null> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - LOOKBACK_DAYS);

  const count = await prisma.customerInsight.count({
    where: { organisationId: orgId, createdAt: { gte: since } },
  });
  return count > 0 ? orgId : null;
}

export async function fetchSupportInsights(orgId: string): Promise<InsightRow[]> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - LOOKBACK_DAYS);

  const rows = await prisma.customerInsight.findMany({
    where: { organisationId: orgId, createdAt: { gte: since } },
    select: { type: true, sentiment: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map((r) => ({
    type: r.type,
    sentiment: r.sentiment,
    date: toBusinessDateStr(r.createdAt),
  }));
}
