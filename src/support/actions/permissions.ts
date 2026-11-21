/**
 * Action permissions (pure)
 * =========================
 * The merchant decides, per irreversible action, whether the support agent may
 * perform it. The toggles + guardrails live as JSON on SupportAgentConfig
 * (`actionPermissions`); this module parses that opaque blob into a typed,
 * fully-populated `ActionPolicy` with SAFE DEFAULTS so a missing/partial/garbage
 * config never grants an action it shouldn't.
 *
 * Defaults are deny-by-default for everything that mutates Shopify, EXCEPT
 * `reorder` (which only ever creates a new draft/checkout link — it touches
 * nothing the customer already owns). Irreversible actions also default to
 * asking the customer to confirm in-thread before the agent executes them.
 *
 * Pure: no DB, no LLM, no Shopify — just defaults + a defensive merge. The
 * executors (executors.ts) consult the parsed policy before any mutation.
 */

export type ActionType = 'cancelOrder' | 'editAddress' | 'reorder' | 'initiateReturn' | 'refund';

/**
 * Outcome of a write-action attempt. The EXECUTOR (executors.ts) is the single
 * source of truth — never the model's self-report — so a hallucinated "I
 * cancelled it" can't stand in for a real mutation.
 *   executed      — the Shopify mutation succeeded.
 *   proposed      — confirmation required; the agent must recap + ask, not act.
 *   not_permitted — the merchant has this action disabled.
 *   ineligible    — the action cannot apply (order not found/owned, already shipped…).
 *   failed        — the mutation was attempted and errored (genuine failure ⇒ escalate).
 */
export type ActionStatus = 'executed' | 'proposed' | 'not_permitted' | 'ineligible' | 'failed';

export type ActionOutcome = {
  type: ActionType;
  status: ActionStatus;
  /** Shopify order GID or name the action targeted, when applicable. */
  orderRef: string | null;
  /** A short note the agent uses to phrase its reply / the customer's next step. */
  summary: string;
  /** Extra data worth keeping in the audit log (e.g. a reorder invoice URL). */
  detail?: Record<string, unknown>;
};

export type ActionPolicy = {
  cancelOrder: { enabled: boolean; onlyIfUnfulfilled: boolean; maxHoursAfterOrder: number | null };
  editAddress: { enabled: boolean; onlyIfUnfulfilled: boolean };
  reorder: { enabled: boolean };
  initiateReturn: { enabled: boolean };
  refund: { enabled: boolean; maxAmount: number | null };
  /** Ask the customer for an explicit in-thread "yes" before an irreversible action. */
  requireCustomerConfirmation: boolean;
};

export const ALL_ACTION_TYPES: readonly ActionType[] = [
  'cancelOrder',
  'editAddress',
  'reorder',
  'initiateReturn',
  'refund',
];

export const DEFAULT_ACTION_POLICY: ActionPolicy = {
  cancelOrder: { enabled: false, onlyIfUnfulfilled: true, maxHoursAfterOrder: null },
  editAddress: { enabled: false, onlyIfUnfulfilled: true },
  reorder: { enabled: true },
  initiateReturn: { enabled: false },
  refund: { enabled: false, maxAmount: null },
  requireCustomerConfirmation: true,
};

/** Read a boolean field defensively: only an actual boolean overrides the default. */
function bool(raw: Record<string, unknown> | undefined, key: string, fallback: boolean): boolean {
  const v = raw?.[key];
  return typeof v === 'boolean' ? v : fallback;
}

/** Read a finite-number-or-null field defensively. */
function numOrNull(raw: Record<string, unknown> | undefined, key: string, fallback: number | null): number | null {
  const v = raw?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * Parse the opaque `actionPermissions` JSON into a fully-populated ActionPolicy.
 * Any missing or wrong-typed field falls back to the safe default — the merchant
 * can only ever *widen* from a deny-by-default baseline, never break the shape.
 */
export function parseActionPolicy(raw: unknown): ActionPolicy {
  const root = asRecord(raw);
  if (!root) return structuredClone(DEFAULT_ACTION_POLICY);

  const cancel = asRecord(root.cancelOrder);
  const edit = asRecord(root.editAddress);
  const reorder = asRecord(root.reorder);
  const ret = asRecord(root.initiateReturn);
  const refund = asRecord(root.refund);
  const d = DEFAULT_ACTION_POLICY;

  return {
    cancelOrder: {
      enabled: bool(cancel, 'enabled', d.cancelOrder.enabled),
      onlyIfUnfulfilled: bool(cancel, 'onlyIfUnfulfilled', d.cancelOrder.onlyIfUnfulfilled),
      maxHoursAfterOrder: numOrNull(cancel, 'maxHoursAfterOrder', d.cancelOrder.maxHoursAfterOrder),
    },
    editAddress: {
      enabled: bool(edit, 'enabled', d.editAddress.enabled),
      onlyIfUnfulfilled: bool(edit, 'onlyIfUnfulfilled', d.editAddress.onlyIfUnfulfilled),
    },
    reorder: { enabled: bool(reorder, 'enabled', d.reorder.enabled) },
    initiateReturn: { enabled: bool(ret, 'enabled', d.initiateReturn.enabled) },
    refund: {
      enabled: bool(refund, 'enabled', d.refund.enabled),
      maxAmount: numOrNull(refund, 'maxAmount', d.refund.maxAmount),
    },
    requireCustomerConfirmation: bool(root, 'requireCustomerConfirmation', d.requireCustomerConfirmation),
  };
}

export function isActionEnabled(policy: ActionPolicy, action: ActionType): boolean {
  return policy[action].enabled;
}

export function enabledActions(policy: ActionPolicy): ActionType[] {
  return ALL_ACTION_TYPES.filter((a) => policy[a].enabled);
}
