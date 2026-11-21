/**
 * Revenue-loss rule resolution
 * ============================
 * The refund calculator needs to know, for a given refund (which happened in a
 * specific currency, at a specific time), which configured cost rule applies.
 *
 * Rules are versioned (effectiveFrom/effectiveTo) and optionally scoped to a
 * currency. A rule with `currency = null` is the catch-all default. For a refund
 * in currency X at time T we pick:
 *   1. the active currency-specific rule (currency = X, window contains T), else
 *   2. the active default rule (currency = null, window contains T), else
 *   3. a zero-cost fallback (everything 0) so the calculator still runs and the
 *      response can flag that no rule was configured.
 *
 * "Active" means effectiveFrom <= T AND (effectiveTo is null OR effectiveTo >= T).
 * If multiple rules overlap, the one with the latest effectiveFrom wins (most
 * recently configured), making rule edits behave intuitively.
 */

import { prisma } from '../prisma.js';

// The resolved, plain-number cost rule the calculator consumes. Mirrors the
// RevenueLossRule model minus the bookkeeping columns.
export type ResolvedLossRule = {
  ruleId: string | null; // null => synthesized zero-cost fallback
  currency: string | null;
  gatewayFeeRate: number;
  gatewayFixedFee: number;
  gatewayFeeTaxRate: number;
  gatewayFeeRefunded: boolean;
  outboundShippingBorneByStore: boolean;
  returnShippingCost: number;
  restockLabourPerItem: number;
  handlingFeePerRefund: number;
  writeOffRate: number;
};

export const ZERO_RULE: Omit<ResolvedLossRule, 'currency'> = {
  ruleId: null,
  gatewayFeeRate: 0,
  gatewayFixedFee: 0,
  gatewayFeeTaxRate: 0,
  gatewayFeeRefunded: false,
  // Default to "store eats outbound shipping" so a missing rule is conservative
  // (counts more as loss) rather than silently hiding cost.
  outboundShippingBorneByStore: true,
  returnShippingCost: 0,
  restockLabourPerItem: 0,
  handlingFeePerRefund: 0,
  writeOffRate: 0,
};

// What `prisma.revenueLossRule.findMany` returns for the fields we care about.
type RuleRow = {
  id: string;
  currency: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  gatewayFeeRate: number;
  gatewayFixedFee: number;
  gatewayFeeTaxRate: number;
  gatewayFeeRefunded: boolean;
  outboundShippingBorneByStore: boolean;
  returnShippingCost: number;
  restockLabourPerItem: number;
  handlingFeePerRefund: number;
  writeOffRate: number;
};

/**
 * Loads every rule for an integration once, then hands back a resolver closure
 * so the calculator can match each refund without an extra DB round-trip per
 * refund. Returns `{ resolve, hasAnyRule }`.
 */
export async function loadRuleResolver(integrationId: string): Promise<{
  resolve: (currency: string, at: Date) => ResolvedLossRule;
  hasAnyRule: boolean;
}> {
  const rules = (await prisma.revenueLossRule.findMany({
    where: { integrationId },
    orderBy: { effectiveFrom: 'desc' }, // latest-configured first => first match wins
    select: {
      id: true,
      currency: true,
      effectiveFrom: true,
      effectiveTo: true,
      gatewayFeeRate: true,
      gatewayFixedFee: true,
      gatewayFeeTaxRate: true,
      gatewayFeeRefunded: true,
      outboundShippingBorneByStore: true,
      returnShippingCost: true,
      restockLabourPerItem: true,
      handlingFeePerRefund: true,
      writeOffRate: true,
    },
  })) as RuleRow[];

  const isActive = (r: RuleRow, at: Date) =>
    r.effectiveFrom.getTime() <= at.getTime() &&
    (r.effectiveTo === null || r.effectiveTo.getTime() >= at.getTime());

  const toResolved = (r: RuleRow): ResolvedLossRule => ({
    ruleId: r.id,
    currency: r.currency,
    gatewayFeeRate: r.gatewayFeeRate,
    gatewayFixedFee: r.gatewayFixedFee,
    gatewayFeeTaxRate: r.gatewayFeeTaxRate,
    gatewayFeeRefunded: r.gatewayFeeRefunded,
    outboundShippingBorneByStore: r.outboundShippingBorneByStore,
    returnShippingCost: r.returnShippingCost,
    restockLabourPerItem: r.restockLabourPerItem,
    handlingFeePerRefund: r.handlingFeePerRefund,
    writeOffRate: r.writeOffRate,
  });

  const resolve = (currency: string, at: Date): ResolvedLossRule => {
    // 1. currency-specific active rule (rules are pre-sorted latest-first).
    const specific = rules.find((r) => r.currency === currency && isActive(r, at));
    if (specific) return toResolved(specific);
    // 2. default (currency = null) active rule.
    const fallbackDefault = rules.find((r) => r.currency === null && isActive(r, at));
    if (fallbackDefault) return toResolved(fallbackDefault);
    // 3. zero-cost fallback so the calculation still produces a (zero) number.
    return { ...ZERO_RULE, currency };
  };

  return { resolve, hasAnyRule: rules.length > 0 };
}
