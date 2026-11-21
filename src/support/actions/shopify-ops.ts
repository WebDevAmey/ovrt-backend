/**
 * Real ActionOps — Shopify-backed implementation of the executor I/O seam
 * =======================================================================
 * Wires the pure executors (executors.ts) to the live store: an email-scoped
 * order finder (read transport) plus the three write wrappers (mutation
 * transport). Kept separate from executors.ts so the decision logic stays
 * unit-testable with fakes and this thin adapter holds all the Shopify shapes.
 */

import { queryOrdersForAction } from '../../agents/shopify/support-queries.js';
import { orderCancel, orderUpdateShippingAddress, draftOrderCreate } from '../../agents/shopify/mutations.js';
import { buildOrderNameClause } from '../tools/order-query.js';
import type { ShopifyConnectInfo } from '../../agents/shopify/credentials.js';
import type { ActionOps, ActionOrder } from './executors.js';

/** Build a Shopify-backed ActionOps for one store connection. */
export function buildShopifyActionOps(conn: ShopifyConnectInfo): ActionOps {
  return {
    async findOrder({ orderNumber, customerEmail }): Promise<ActionOrder | null> {
      const email = customerEmail.trim().toLowerCase();
      if (!email) return null;
      const parts = [`email:${email}`];
      const nameClause = buildOrderNameClause(orderNumber);
      if (nameClause) parts.push(nameClause);

      const data = await queryOrdersForAction(conn, 5, parts.join(' '));
      const node = data.orders.edges
        .map((e) => e.node)
        // Defence in depth: only ever act on an order whose customer email matches.
        .find((n) => String(n.customer?.email ?? '').trim().toLowerCase() === email);
      if (!node) return null;

      return {
        id: node.id,
        name: node.name,
        email: node.customer?.email ?? null,
        fulfillmentStatus: node.displayFulfillmentStatus,
        createdAt: node.createdAt,
        lineItems: node.lineItems.edges.map((e) => ({
          variantId: e.node.variant?.id ?? null,
          quantity: e.node.quantity,
        })),
      };
    },

    async cancelOrder({ orderId, reason, notifyCustomer }) {
      await orderCancel(conn, { orderId, reason, notifyCustomer });
    },

    async updateShippingAddress({ orderId, address }) {
      await orderUpdateShippingAddress(conn, { orderId, address });
    },

    async createReorder({ lineItems, email }) {
      return draftOrderCreate(conn, { lineItems, email });
    },
  };
}
