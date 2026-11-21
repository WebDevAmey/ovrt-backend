import { resolveShopifySource, getShopifyConn, daysAgoStr } from '../shopify-shared.js';
import { getCustomerRetentionStats } from '../../../agents/shopify/functions.js';

export { resolveShopifySource };

export type NewCustomerRow = {
  period: 'current' | 'previous';
  windowStart: string;
  windowEnd: string;
  newCustomers: number;          // customers whose account was created in the window AND have exactly 1 lifetime order
  totalCustomers: number;        // all customers whose account was created in the window
  conversionRate: number;        // newCustomers / totalCustomers (% of signups that bought)
  newCustomerAvgSpend: number;
  currency: string;
};

/**
 * Pulls new-customer signal for two 30-day windows.
 *
 * `newCustomers` here uses Shopify's customer-account-creation filter combined
 * with lifetime `orders_count == 1`. Bias note: customers who registered before
 * the window but made their first purchase inside it are not counted. The bias
 * is roughly constant across consecutive windows, so the WoW comparison stays
 * meaningful even though the absolute count understates true acquisitions.
 */
export async function fetchNewCustomerAcquisition(integrationId: string): Promise<NewCustomerRow[]> {
  const conn = await getShopifyConn(integrationId);

  const [curr, prev] = await Promise.all([
    getCustomerRetentionStats(conn, { since: daysAgoStr(30), until: daysAgoStr(1) }),
    getCustomerRetentionStats(conn, { since: daysAgoStr(60), until: daysAgoStr(31) }),
  ]);

  const toRow = (
    period: 'current' | 'previous',
    since: string,
    until: string,
    r: typeof curr,
  ): NewCustomerRow => {
    const s = r.rows[0] as Record<string, unknown>;
    const newCustomers = Number(s?.newCustomers ?? 0);
    const totalCustomers = Number(s?.totalCustomers ?? 0);
    return {
      period,
      windowStart: since,
      windowEnd: until,
      newCustomers,
      totalCustomers,
      conversionRate:
        totalCustomers > 0
          ? Math.round((newCustomers / totalCustomers) * 10000) / 100
          : 0,
      newCustomerAvgSpend: Number(s?.newCustomerAvgSpend ?? 0),
      currency: String(s?.currency ?? ''),
    };
  };

  return [
    toRow('current', daysAgoStr(30), daysAgoStr(1), curr),
    toRow('previous', daysAgoStr(60), daysAgoStr(31), prev),
  ];
}
