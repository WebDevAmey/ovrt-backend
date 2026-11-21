/**
 * Order-number query helper (pure)
 * ================================
 * Builds the Shopify `name:` filter clause for an order the customer referenced.
 * Kept dependency-free (no DB/SDK) so it's unit-testable.
 *
 * Customers write order numbers inconsistently ("1234", "#1234", "# 1234") and
 * many stores don't use a bare "#<number>" at all — they configure a prefix or
 * suffix ("EXP1234", "SD-1234"). So we normalize the leading "#"/whitespace and
 * then match BOTH the value as written and its "#"-prefixed form, rather than
 * assuming the "#<number>" shape (which caused false "order not found" misses).
 */

/**
 * Turn a raw, customer-typed order number into a Shopify query clause, e.g.
 * `(name:#1234 OR name:1234)`. Returns null if there's nothing usable after
 * normalization (caller should then just filter by email).
 */
export function buildOrderNameClause(orderNumber: string | null | undefined): string | null {
  if (!orderNumber) return null;
  // Strip any leading "#"/whitespace, so "#1234", "# 1234" and "1234" all reduce
  // to the same bare value (the # is optional for the customer).
  const raw = orderNumber.trim().replace(/^[#\s]+/, '').trim();
  if (!raw) return null;
  // Match both the "#"-prefixed form (the usual stored name) and the raw form
  // (covers shop-configured prefixes/suffixes like "EXP1234" or "SD-1234").
  const names = [`#${raw}`, raw];
  return `(${names.map((n) => `name:${n}`).join(' OR ')})`;
}
