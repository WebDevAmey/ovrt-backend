import { resolveShopifySource, getShopifyConn, daysAgoStr } from '../shopify-shared.js';
import { buildOrderQuery } from '../../../agents/shopify/helpers.js';
import { fetchOrderPages } from '../../../agents/shopify/helpers.js';

export { resolveShopifySource };

export type RegionWeekSnapshot = {
  region: string; // shipping country
  windowEnd: string;
  orderCount: number;
  totalOrdersInWindow: number;
  disabledCustomerOrders: number; // orders from customers with state === 'DISABLED'
};

// 8 non-overlapping 7-day windows. ewmaProportionControl needs real history
// per region to size its control limit by how many orders actually shipped
// there each week.
const SNAPSHOT_COUNT = 8;
const WINDOW_DAYS = 7;

export async function fetchRegionOrderShare(integrationId: string): Promise<RegionWeekSnapshot[]> {
  const conn = await getShopifyConn(integrationId);

  const offsets = Array.from({ length: SNAPSHOT_COUNT }, (_, i) => i * WINDOW_DAYS);
  const windows = await Promise.all(
    offsets.map(async (offset) => {
      const windowStart = daysAgoStr(WINDOW_DAYS + offset);
      const windowEnd = daysAgoStr(1 + offset);
      const queryString = buildOrderQuery({ since: windowStart, until: windowEnd });
      const { orders } = await fetchOrderPages(conn, queryString, {
        includeLineItems: false,
        includeShippingAddress: true,
      });

      const byRegion = new Map<string, { orderCount: number; disabledCustomerOrders: number }>();
      for (const o of orders) {
        const region = o.shippingAddress?.country || 'Unknown';
        const entry = byRegion.get(region) ?? { orderCount: 0, disabledCustomerOrders: 0 };
        entry.orderCount += 1;
        if (o.customer?.state === 'DISABLED') entry.disabledCustomerOrders += 1;
        byRegion.set(region, entry);
      }

      const totalOrdersInWindow = orders.length;
      return Array.from(byRegion.entries()).map(([region, v]) => ({
        region,
        windowEnd,
        orderCount: v.orderCount,
        totalOrdersInWindow,
        disabledCustomerOrders: v.disabledCustomerOrders,
      }));
    }),
  );

  return windows.flat();
}
