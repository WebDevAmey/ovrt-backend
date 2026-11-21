import { describe, it, expect } from 'vitest';
import { summarizeShipments, describeDiscount } from './tracking-format.js';

describe('summarizeShipments', () => {
  it('returns an empty array for no fulfillments', () => {
    expect(summarizeShipments(null)).toEqual([]);
    expect(summarizeShipments(undefined)).toEqual([]);
    expect(summarizeShipments([])).toEqual([]);
  });

  it('maps a fulfillment with tracking to a shipment', () => {
    const out = summarizeShipments([
      {
        displayStatus: 'IN_TRANSIT',
        estimatedDeliveryAt: '2026-06-30T00:00:00Z',
        trackingInfo: [{ number: 'TRK123', url: 'https://track/abc', company: 'DHL' }],
      },
    ]);
    expect(out).toEqual([
      {
        status: 'IN_TRANSIT',
        carrier: 'DHL',
        trackingNumber: 'TRK123',
        trackingUrl: 'https://track/abc',
        estimatedDelivery: '2026-06-30T00:00:00Z',
      },
    ]);
  });

  it('keeps the status when there is no tracking info', () => {
    const out = summarizeShipments([{ displayStatus: 'FULFILLED', trackingInfo: [] }]);
    expect(out[0]).toMatchObject({ status: 'FULFILLED', trackingNumber: null, trackingUrl: null, carrier: null });
  });

  it('summarises multiple shipments, using the first tracking entry of each', () => {
    const out = summarizeShipments([
      { displayStatus: 'DELIVERED', trackingInfo: [{ number: 'A', url: null, company: 'UPS' }] },
      { displayStatus: 'IN_TRANSIT', trackingInfo: [{ number: 'B', url: 'u', company: 'FedEx' }] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].trackingNumber).toBe('A');
    expect(out[1].trackingNumber).toBe('B');
  });
});

describe('describeDiscount', () => {
  it('reports a missing code as not found', () => {
    const d = describeDiscount(null);
    expect(d.found).toBe(false);
  });

  it('reports an active code as usable', () => {
    const d = describeDiscount({ title: 'SUMMER10', status: 'ACTIVE', startsAt: null, endsAt: null });
    expect(d.found).toBe(true);
    expect(d.active).toBe(true);
    expect(d.title).toBe('SUMMER10');
  });

  it('reports an expired/scheduled code as not currently usable', () => {
    expect(describeDiscount({ title: 'OLD', status: 'EXPIRED', startsAt: null, endsAt: null }).active).toBe(false);
    expect(describeDiscount({ title: 'SOON', status: 'SCHEDULED', startsAt: null, endsAt: null }).active).toBe(false);
  });
});
