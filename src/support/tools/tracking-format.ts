/**
 * Tracking / discount formatting helpers (pure)
 * =============================================
 * Shape Shopify's nested fulfillment + discount shapes into the flat,
 * customer-safe summaries the support read tools hand to the model. Kept
 * dependency-free (no DB, no SDK) so they're unit-testable in isolation.
 */

export type RawTrackingInfo = { number?: string | null; url?: string | null; company?: string | null };

export type RawFulfillment = {
  displayStatus?: string | null;
  estimatedDeliveryAt?: string | null;
  trackingInfo?: RawTrackingInfo[] | null;
};

export type Shipment = {
  /** Fulfillment displayStatus: IN_TRANSIT, OUT_FOR_DELIVERY, DELIVERED, … */
  status: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  estimatedDelivery: string | null;
};

/**
 * Flatten an order's fulfillments into one shipment summary each, using the
 * first tracking entry of each fulfillment (a fulfillment usually has a single
 * package). Missing tracking ⇒ null fields but the status is preserved.
 */
export function summarizeShipments(fulfillments: RawFulfillment[] | null | undefined): Shipment[] {
  if (!fulfillments || fulfillments.length === 0) return [];
  return fulfillments.map((f) => {
    const t = f.trackingInfo && f.trackingInfo.length > 0 ? f.trackingInfo[0] : null;
    return {
      status: f.displayStatus ?? null,
      carrier: t?.company ?? null,
      trackingNumber: t?.number ?? null,
      trackingUrl: t?.url ?? null,
      estimatedDelivery: f.estimatedDeliveryAt ?? null,
    };
  });
}

export type RawDiscount = {
  title?: string | null;
  status?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
} | null;

export type DiscountSummary = {
  found: boolean;
  title: string | null;
  status: string | null;
  active: boolean;
  startsAt: string | null;
  endsAt: string | null;
};

/**
 * Describe a discount code's usability. `active` is true only when Shopify
 * reports the code's status as ACTIVE — EXPIRED/SCHEDULED/etc. are not currently
 * usable, which is exactly what a "my code isn't working" customer needs to hear.
 */
export function describeDiscount(node: RawDiscount): DiscountSummary {
  if (!node) {
    return { found: false, title: null, status: null, active: false, startsAt: null, endsAt: null };
  }
  const status = node.status ?? null;
  return {
    found: true,
    title: node.title ?? null,
    status,
    active: typeof status === 'string' && status.toUpperCase() === 'ACTIVE',
    startsAt: node.startsAt ?? null,
    endsAt: node.endsAt ?? null,
  };
}
