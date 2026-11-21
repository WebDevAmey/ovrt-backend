/**
 * Product formatting helpers (pure)
 * =================================
 * Currency/availability formatting for the Gmail agent's product lookups. Kept
 * dependency-free (no DB, no SDK) so it's unit-testable and so importing it
 * can't trigger prisma/client init.
 *
 * Why this exists: the raw Shopify result carries a bare numeric price plus a
 * separate ISO currency code. Handed that, the model tends to render "$50"
 * regardless of the code — which is how an Indian store's ₹1,599 product came
 * back to a customer as "$50–$80". Pre-formatting the money in the shop's own
 * currency here gives the model a correct string to quote verbatim.
 */

export type Availability = 'in_stock' | 'out_of_stock' | 'unknown';

/**
 * Map a raw inventory quantity to a customer-safe availability state. A null/
 * non-numeric quantity means inventory isn't tracked for that item — that's
 * "unknown", NOT out-of-stock (the item may well be purchasable). Treat a
 * positive quantity as in stock; zero or negative (oversold) as out of stock.
 */
export function availabilityFromQty(qty: number | null | undefined): Availability {
  if (typeof qty !== 'number') return 'unknown';
  return qty > 0 ? 'in_stock' : 'out_of_stock';
}

/**
 * Format a money amount in the SHOP'S currency, ready to drop into a reply.
 * Falls back to "<CODE> <amount>" if the currency code isn't one Intl knows,
 * and returns null for a missing/non-numeric amount (so callers/the model must
 * treat the price as unknown rather than inventing one).
 */
export function formatMoney(
  amount: number | null | undefined,
  currency: string | null | undefined,
): string | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const code = (currency || '').trim().toUpperCase();
  if (code) {
    try {
      return new Intl.NumberFormat('en', { style: 'currency', currency: code }).format(amount);
    } catch {
      // Unknown/non-ISO currency code — fall through to a plain code + amount.
    }
  }
  return code ? `${code} ${amount}` : String(amount);
}

/** A human-readable price string for a product's min–max range, in shop currency. */
export function priceRangeDisplay(
  minPrice: number | null | undefined,
  maxPrice: number | null | undefined,
  currency: string | null | undefined,
): string | null {
  const min = formatMoney(minPrice, currency);
  if (min === null) return null;
  const max = formatMoney(maxPrice, currency);
  return max !== null && max !== min ? `${min} – ${max}` : min;
}
