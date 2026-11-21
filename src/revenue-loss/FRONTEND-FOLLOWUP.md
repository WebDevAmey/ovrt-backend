# Revenue-loss: frontend follow-up

The backend now computes refund loss from a **versioned `RevenueLossRule`** model
instead of three flat floats on `ShopifyIntegration`. The old columns
(`labourRestockCost`, `processingFeeRate`, `returnShippingCost`) are kept but
**deprecated** — nothing in the backend reads them anymore. The frontend still
needs work to (a) let merchants configure the new rules and (b) consume the
richer response. None of this blocks the backend; the refund endpoint runs with
zero rules (returns `usingFallbackRules: true`).

## 1. Mirror the schema (causal-frontend)

Add the `RevenueLossRule` model + `revenueLossRules` relation to
`causal-frontend/prisma/schema.prisma` (copy verbatim from
`causal-backend/prisma/schema.prisma`). Run `prisma generate` in the frontend.
The user applies the actual migration (shared Neon DB — do not migrate/push).

## 2. Server action (`causal-frontend/lib/actions/shopify.ts`)

`updateShopifyChargeRules` currently writes the three deprecated floats. Replace
with CRUD over `RevenueLossRule`:

- `listRevenueLossRules(integrationId)` — return all rules for the integration.
- `upsertRevenueLossRule(integrationId, rule)` — create/update a rule. Validate:
  rates are fractions in `[0, 1]` (`gatewayFeeRate`, `gatewayFeeTaxRate`,
  `writeOffRate`); costs `>= 0`; `effectiveTo` (if set) `>= effectiveFrom`.
- `endRevenueLossRule(ruleId)` — set `effectiveTo = now()` rather than deleting,
  so historical loss numbers stay reproducible.
- Keep the `requireAdmin()` + org-ownership check pattern already in the file.

Remove the deprecated-float write once the UI no longer uses it.

## 3. Config UI (`integrations/_components/shopify-list.tsx`)

`EditChargesSheet` currently has 3 inputs. New fields to expose (all per rule;
allow one default rule with `currency = null` plus optional per-currency rules):

| Field | Input | Notes |
|---|---|---|
| `currency` | select / text | blank = default for all currencies |
| `effectiveFrom` / `effectiveTo` | date | for versioning |
| `gatewayFeeRate` | number, fraction | e.g. 0.02 = 2% — **fallback only**, real fee read from Shopify |
| `gatewayFixedFee` | number | flat per-txn fee |
| `gatewayFeeTaxRate` | number, fraction | e.g. 0.18 GST on the fee |
| `gatewayFeeRefunded` | toggle | usually OFF (gateways keep the fee) |
| `outboundShippingBorneByStore` | toggle | usually ON |
| `returnShippingCost` | number | return-label cost |
| `restockLabourPerItem` | number | per restocked unit |
| `handlingFeePerRefund` | number | flat per refund |
| `writeOffRate` | number, fraction | unsellable-on-return share |

## 4. Consume the richer response

The `/revenue-loss/refund` response shape changed:

- `summary` / `byCurrency` now carry a **`LossBreakdown`** (`gatewayFee`,
  `outboundShipping`, `returnShipping`, `restockLabour`, `handling`, `writeOff`,
  `total`) instead of `totalReturnCost`/`totalProcessingFees`/etc.
- `details[].breakdown` is the per-refund breakdown; `gatewayFeeMeasured` says
  whether the fee was real (Shopify) or estimated (config); `ruleId` is which
  rule applied (`null` = fallback).
- New top-level flags: `resultsTruncated` (page cap hit) and `usingFallbackRules`
  (no rule configured — prompt the merchant). Show a banner when either is true.
- `hotspots` now use `totalLoss` / `refundOccurrences` / `variantId` (was
  `totalReturnCost` / `refundCount` / title-keyed).

The `/revenue-loss/checkout` response gained `lossType:
'potential-uncaptured-revenue'` — label abandoned-cart value as *potential*
revenue, never sum it with realized refund loss.
