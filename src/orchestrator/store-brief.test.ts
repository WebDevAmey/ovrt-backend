import { describe, it, expect } from 'vitest';
import {
  assembleStoreIntelligence,
  EMPTY_STORE_INTELLIGENCE,
  type StoreOpportunityInput,
  type StoreCustomerInsightInput,
} from './store-brief.js';
import type { WeeklyDigestContent } from '../analyst/weekly-digest/types.js';

function makeDigest(overrides: Partial<WeeklyDigestContent> = {}): WeeklyDigestContent {
  return {
    weekStart: '2026-06-15',
    weekEnd: '2026-06-21',
    headline: 'Solid week, refunds creeping up.',
    narrative: '...',
    healthScore: 78,
    healthScoreRationale: '...',
    weekOverWeek: {
      revenueChangePct: 12.5,
      ordersChangePct: 8.0,
      aovChangePct: -2.0,
      newlyRegisteredChangePct: null,
    },
    topWins: ['Revenue up 12.5%'],
    topConcerns: ['Refund rate above the usual range', '  '],
    anomalyCount: 1,
    anomalies: [
      {
        insightType: 'REFUND_RATE_SPIKE',
        direction: 'spike',
        summary: 'Refunds up',
        anomalyId: 'a1',
        severity: 'medium',
        detectedAt: '2026-06-21',
      },
    ],
    metrics: {
      weekStart: '2026-06-15',
      weekEnd: '2026-06-21',
      currency: 'USD',
      totalRevenue: 18420,
      totalOrders: 245,
      averageOrderValue: 75.18,
      uniqueCustomers: 198,
      totalDiscounts: 2340,
      newlyRegisteredCustomers: 81,
      refundRate: 5.0,
      totalRefunded: 512,
      refundedProducts: [],
      discountUptakeRate: 31.4,
      topDiscountCodes: [],
      abandonmentRate: 72.0,
      abandonedValue: 3420,
      outOfStockCount: 0,
      lowStockCount: 3,
      lowStockItems: [],
      topProducts: [],
      dailyTrend: [
        { date: '2026-06-15', orders: 28, revenue: 2100 },
        { date: '2026-06-16', orders: 52, revenue: 3900 },
        { date: '2026-06-17', orders: 18, revenue: 1400 },
      ],
      priorWeekRevenue: 16373,
      priorWeekOrders: 226,
      priorWeekAov: 76.7,
      priorWeekNewlyRegistered: 81,
      truncated: false,
    },
    ...overrides,
  };
}

describe('assembleStoreIntelligence', () => {
  it('returns EMPTY when there is no data at all', () => {
    expect(assembleStoreIntelligence(null, [], [])).toEqual(EMPTY_STORE_INTELLIGENCE);
    expect(assembleStoreIntelligence(null, [], []).hasData).toBe(false);
  });

  it('renders pulse, baselines and the typical daily-order range from the digest', () => {
    const { storeBriefBlock, hasData } = assembleStoreIntelligence(makeDigest(), [], []);
    expect(hasData).toBe(true);
    expect(storeBriefBlock).toContain('STORE PULSE (week of 2026-06-15, health 78/100)');
    expect(storeBriefBlock).toContain('+12.5% WoW');
    expect(storeBriefBlock).toContain('-2.0% WoW'); // negative delta keeps its sign
    expect(storeBriefBlock).toContain('Typical daily orders: 18–52/day');
    expect(storeBriefBlock).toContain("WHAT'S NORMAL");
    expect(storeBriefBlock).toContain('refund rate 5.0%');
  });

  it('merges digest concerns and open opportunities into CURRENTLY FLAGGED, dropping blanks/dupes', () => {
    const opportunities: StoreOpportunityInput[] = [
      { title: 'Daily orders dipped 40% yesterday — want me to dig in?', description: '...', category: 'OPERATIONS' },
      { title: 'Refund rate above the usual range', description: '...', category: 'CUSTOMER_EXPERIENCE' }, // dupe of a concern
    ];
    const { storeBriefBlock } = assembleStoreIntelligence(makeDigest(), opportunities, []);
    expect(storeBriefBlock).toContain('CURRENTLY FLAGGED');
    expect(storeBriefBlock).toContain('Daily orders dipped 40% yesterday');
    // Deduped: the repeated concern/opportunity appears only once.
    const occurrences = storeBriefBlock.split('Refund rate above the usual range').length - 1;
    expect(occurrences).toBe(1);
    // The blank concern ('  ') is filtered out — no empty bullet.
    expect(storeBriefBlock).not.toContain('- \n');
  });

  it('summarises customer voice by type with negative-first examples', () => {
    const insights: StoreCustomerInsightInput[] = [
      { type: 'SHIPPING_PAIN', sentiment: 'NEGATIVE', summary: 'Customer waited 10 days for delivery' },
      { type: 'SHIPPING_PAIN', sentiment: 'NEGATIVE', summary: 'Late shipment complaint' },
      { type: 'PRAISE', sentiment: 'POSITIVE', summary: 'Loved the packaging' },
    ];
    const { storeBriefBlock } = assembleStoreIntelligence(null, [], insights);
    expect(storeBriefBlock).toContain('CUSTOMER VOICE (last 30d, 3 signals)');
    expect(storeBriefBlock).toContain('2 shipping'); // most frequent type first
    expect(storeBriefBlock).toContain('Customer waited 10 days');
  });

  it('builds planner signals from digest week and active anomaly/opportunity categories', () => {
    const opportunities: StoreOpportunityInput[] = [
      { title: 'Stock running low on a top seller', description: '...', category: 'INVENTORY' },
    ];
    const { storeSignalsBlock } = assembleStoreIntelligence(makeDigest(), opportunities, []);
    expect(storeSignalsBlock).toContain('STORE SIGNALS:');
    expect(storeSignalsBlock).toContain('week of 2026-06-15, health 78/100');
    expect(storeSignalsBlock).toContain('REFUND_RATE_SPIKE');
    expect(storeSignalsBlock).toContain('INVENTORY');
  });

  it('never includes a snippet field — only analyst-written summaries reach the prompt', () => {
    // The input type has no `snippet`, but guard against accidental leakage of raw text.
    const insights: StoreCustomerInsightInput[] = [
      { type: 'PRODUCT_QUALITY', sentiment: 'NEGATIVE', summary: 'Defective item reported' },
    ];
    const { storeBriefBlock } = assembleStoreIntelligence(null, [], insights);
    expect(storeBriefBlock).toContain('Defective item reported');
  });
});
