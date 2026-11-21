/**
 * Playbook registry (pure)
 * ========================
 * The built-in "structured workflow" that makes the agent robust WITHOUT any
 * merchant rules. One `Playbook` per support topic (topics.ts) gives the agent,
 * for that intent: what data to look up, how to decide, and when to escalate —
 * written as a guidance block in the same voice as the system blocks in
 * prompt.ts. `selectPlaybooks` composes the guidance for the detected topic(s)
 * and appends action-specific guidance that reflects what the agent is actually
 * allowed and wired to do (the `performable` set = merchant-enabled ∩ wired).
 *
 * Pure: no DB, no LLM, no Shopify — just strings + a deterministic compose, so
 * it is fully unit-testable and the merchant config can only ever *widen* it.
 *
 * Merchant `directives`/`systemInstructions` still layer ON TOP of this in
 * prompt.ts as the highest-priority override — playbooks are the floor, not a ceiling.
 */

import type { SupportTopic } from './topics.js';
import { SUPPORT_TOPICS } from './topics.js';
import type { ActionType } from '../actions/permissions.js';

export type Playbook = {
  id: SupportTopic;
  title: string;
  /** Always-on guidance: what to fetch, how to answer, when to escalate. */
  guidance: string;
  /** Write actions this topic may involve (gated separately by `performable`). */
  actions: ActionType[];
};

/**
 * Per-action guidance, phrased once. `performable` is shown when the agent is
 * both permitted (merchant toggle) AND wired with the tool; `notPerformable`
 * otherwise. Kept global (not per-playbook) so a shared action reads identically
 * wherever it appears and is emitted only once per reply.
 */
const ACTION_GUIDANCE: Record<ActionType, { performable: string; notPerformable: string }> = {
  cancelOrder: {
    performable:
      'CANCELLING: You can cancel this order yourself with the cancelOrder tool. First look the order up, ' +
      'recap exactly which order will be cancelled, and ask the customer to confirm; only after they clearly ' +
      'say yes, call cancelOrder with confirmed: true. Never cancel an order that is already fulfilled/shipped — ' +
      'offer the return process instead.',
    notPerformable:
      'CANCELLING: You are not permitted to cancel orders automatically — do not promise a cancellation. If the ' +
      'order can still be cancelled, escalate so a teammate can action it quickly; if it has already shipped, ' +
      'explain that and offer the return process instead.',
  },
  editAddress: {
    performable:
      'ADDRESS CHANGE: You can update an unfulfilled order\'s shipping address with the editAddress tool. ' +
      'Read back the full new address and confirm it with the customer before calling editAddress with ' +
      'confirmed: true. If the order has already shipped, do not change it — explain and escalate if needed.',
    notPerformable:
      'ADDRESS CHANGE: You are not permitted to edit orders automatically. Collect the corrected address and ' +
      'escalate so a teammate can update it before the order ships — do not promise the change yourself.',
  },
  reorder: {
    performable:
      'REORDER: You can generate a reorder link with the reorder tool (it creates a fresh checkout for the same ' +
      'items — it never charges the customer). Confirm which items they want to reorder, then share the link.',
    notPerformable:
      'REORDER: You cannot generate a reorder link right now. Point the customer to the product(s) on the store ' +
      'so they can buy again, and offer to help find them.',
  },
  initiateReturn: {
    performable:
      'RETURNS: When the order is eligible you can start a return with the initiateReturn tool. Confirm which ' +
      'item(s) and the reason with the customer first, then call initiateReturn with confirmed: true and share ' +
      'the next steps it returns.',
    notPerformable:
      'RETURNS: You are not permitted to start returns automatically. Check eligibility, explain the return ' +
      'policy and steps clearly, and escalate to a teammate to process it if the customer wants to proceed.',
  },
  refund: {
    performable:
      'REFUNDS: With the customer\'s agreement, and only within policy, you may issue a refund using the refund ' +
      'tool. Confirm the order and amount first, then call refund with confirmed: true. Anything unusual or ' +
      'outside policy — escalate instead of refunding.',
    notPerformable:
      'REFUNDS: You are not permitted to issue refunds. Acknowledge the request empathetically and escalate it ' +
      'to a teammate — never promise or imply a refund amount yourself.',
  },
};

const PLAYBOOKS: Record<SupportTopic, Playbook> = {
  ORDER_STATUS: {
    id: 'ORDER_STATUS',
    title: 'Order status / tracking (WISMO)',
    actions: [],
    guidance:
      'The customer is asking where their order is. Use lookupOrder (and getOrderTracking for the tracking ' +
      'number, carrier, link, and any delivery estimate) before replying. Give the current fulfilment status ' +
      'plainly, share the tracking link if there is one, and set a realistic expectation. If no order is found ' +
      'under their email, ask them to confirm the email used at checkout (clarify) — never say it does not exist.',
  },
  ORDER_DELAYED: {
    id: 'ORDER_DELAYED',
    title: 'Late / not-received order',
    actions: [],
    guidance:
      'The customer says their order is late or never arrived. Look the order up and check tracking first. If it ' +
      'is in transit, empathise, share the latest tracking status and a realistic ETA. If tracking shows ' +
      'delivered but they did not receive it, or it appears genuinely lost/stuck, treat it as sensitive: ' +
      'apologise and escalate so a teammate can arrange a reship or refund — do not promise either yourself.',
  },
  CANCEL_ORDER: {
    id: 'CANCEL_ORDER',
    title: 'Cancel an order',
    actions: ['cancelOrder'],
    guidance:
      'The customer wants to cancel an order. Look it up and check its fulfilment status: only unfulfilled ' +
      'orders can be cancelled. Be warm and quick about it.',
  },
  EDIT_ORDER: {
    id: 'EDIT_ORDER',
    title: 'Edit an order (address / items)',
    actions: ['editAddress'],
    guidance:
      'The customer wants to change something on an existing order — most often the shipping address. Look the ' +
      'order up and confirm it is still unfulfilled. Address changes can be handled per the guidance below; ' +
      'changing items/sizes or quantities is not automated — for those, escalate or suggest cancelling and ' +
      'reordering if the order is still unfulfilled.',
  },
  RETURN_EXCHANGE: {
    id: 'RETURN_EXCHANGE',
    title: 'Return or exchange',
    actions: ['initiateReturn', 'refund'],
    guidance:
      'The customer wants to return or exchange an item. Look the order up, use getOrderTracking to see when it ' +
      'was delivered, and getStorePolicies for the return window and rules — then judge whether it is still ' +
      'eligible and explain the steps clearly. For an exchange, also confirm the replacement variant is available.',
  },
  REFUND: {
    id: 'REFUND',
    title: 'Refund request / status',
    actions: ['refund'],
    guidance:
      'Separate a refund STATUS question ("where is my refund?") from a refund REQUEST. For status, look the ' +
      'order up and report what the order/refund record shows. For a request, check the order and the refund ' +
      'policy first, then follow the refund guidance below.',
  },
  DAMAGED_WRONG_MISSING: {
    id: 'DAMAGED_WRONG_MISSING',
    title: 'Damaged / wrong / missing item',
    actions: ['refund', 'initiateReturn'],
    guidance:
      'The customer received something damaged, wrong, or missing. Lead with a genuine apology. Look the order ' +
      'up to confirm what was in it. Ask for a photo if that helps resolve it. Offer the best resolution the ' +
      'store policy and your permissions allow (replacement or refund); if it is outside what you can do, ' +
      'escalate. Always capture this as an insight.',
  },
  REORDER: {
    id: 'REORDER',
    title: 'Reorder / buy again',
    actions: ['reorder'],
    guidance:
      'The customer wants to buy the same thing again. Use lookupOrder to see their past order (or lookupProduct ' +
      'for a named item), confirm what they want, then follow the reorder guidance below.',
  },
  PRODUCT_INFO: {
    id: 'PRODUCT_INFO',
    title: 'Product details',
    actions: [],
    guidance:
      'The customer is asking about a product (size, material, fit, specs, options). Use lookupProduct to ground ' +
      'your answer in the real catalogue. Answer about the specific variant/option they named. If the catalogue ' +
      'does not carry the detail, say you will confirm rather than guessing — never invent specs. Send the customer the link of the product.',
  },
  PRODUCT_AVAILABILITY: {
    id: 'PRODUCT_AVAILABILITY',
    title: 'Stock / availability',
    actions: [],
    guidance:
      'The customer wants to know if something is in stock or will be restocked. Use lookupProduct and report ' +
      'availability per variant. "unknown" means the store does not track that item — say it is available to ' +
      'order, not out of stock. If genuinely out of stock, offer to note their interest (capture a STOCK_REQUEST ' +
      'insight); do not promise a restock date you do not have.',
  },
  PRICING_DISCOUNT: {
    id: 'PRICING_DISCOUNT',
    title: 'Pricing / discounts',
    actions: [],
    guidance:
      'The customer is asking about price, a discount, or a code that is not working. Use lookupProduct for the ' +
      'price (quote the pre-formatted store-currency string exactly) and checkDiscountCode to verify a code\'s ' +
      'validity/conditions. If a code is invalid or expired, explain why kindly; do not invent a discount.',
  },
  SHIPPING_INFO: {
    id: 'SHIPPING_INFO',
    title: 'Shipping / delivery info',
    actions: [],
    guidance:
      'The customer is asking about shipping cost, options, destinations, or delivery times (pre-purchase). Use ' +
      'getStorePolicies for the shipping policy and the merchant instructions. If the specifics are not ' +
      'available, say you will confirm rather than guessing a rate or timeframe.',
  },
  STORE_POLICY: {
    id: 'STORE_POLICY',
    title: 'Store policy (returns / shipping / warranty)',
    actions: [],
    guidance:
      'The customer is asking about a store policy. Use getStorePolicies and the merchant general instructions ' +
      'as the source of truth. Summarise the relevant policy plainly. If it is not documented, say you will ' +
      'confirm the details rather than guessing.',
  },
  ACCOUNT_ISSUE: {
    id: 'ACCOUNT_ISSUE',
    title: 'Account / checkout / payment issue',
    actions: [],
    guidance:
      'The customer cannot log in, check out, or pay. Offer the common fixes (try another card/browser, check ' +
      'the email used, clear the cart). You cannot see their payment provider details, so if it persists, ' +
      'escalate so a teammate can investigate. Do not ask for full card numbers or passwords.',
  },
  FEEDBACK_COMPLAINT_PRAISE: {
    id: 'FEEDBACK_COMPLAINT_PRAISE',
    title: 'Feedback / complaint / praise',
    actions: [],
    guidance:
      'The customer is giving feedback, a suggestion, a complaint, or praise not tied to a specific order action. ' +
      'Respond warmly and sincerely, thank them, and capture the signal as an insight. Escalate only if it ' +
      'carries a sensitive edge (legal/safety threat, threat to go public over a serious issue).',
  },
  WHOLESALE_B2B: {
    id: 'WHOLESALE_B2B',
    title: 'Wholesale / B2B inquiry',
    actions: [],
    guidance:
      'The customer is asking about wholesale, bulk, or reseller/trade terms. This usually needs a human or a ' +
      'specific process the store defines. Acknowledge the interest, share anything the merchant instructions ' +
      'cover, and escalate so the right person can follow up.',
  },
  OTHER: {
    id: 'OTHER',
    title: 'General / uncategorised',
    actions: [],
    guidance:
      'A general question that does not fit a specific workflow. Use the lookup tools if it touches an order or a ' +
      'product, answer helpfully and honestly from real data, ask a clarifying question if you are missing a ' +
      'detail, and escalate only if it is genuinely sensitive or beyond what you can do.',
  },
};

export function getPlaybook(topic: SupportTopic): Playbook {
  return PLAYBOOKS[topic];
}

export function allPlaybooks(): Playbook[] {
  return SUPPORT_TOPICS.map((t) => PLAYBOOKS[t]);
}

/**
 * Compose the guidance for the detected topic(s) plus the action guidance for
 * each write action those playbooks involve. `performable` is the set of actions
 * the agent can actually take right now (merchant-enabled ∩ wired) — anything
 * not in it gets the "you can't, so explain/escalate" branch. Each action's
 * guidance is emitted at most once even if two topics share it.
 */
export function selectPlaybooks(topics: SupportTopic[], performable: ReadonlySet<ActionType>): string {
  const selected = topics.length ? topics : (['OTHER'] as SupportTopic[]);
  const uniqueTopics = [...new Set(selected)].slice(0, 2);

  const blocks: string[] = [];
  const actionLines: string[] = [];
  const seenActions = new Set<ActionType>();

  for (const t of uniqueTopics) {
    const pb = getPlaybook(t);
    blocks.push(`[${pb.title}] ${pb.guidance}`);
    for (const a of pb.actions) {
      if (seenActions.has(a)) continue;
      seenActions.add(a);
      const g = ACTION_GUIDANCE[a];
      actionLines.push(performable.has(a) ? g.performable : g.notPerformable);
    }
  }

  return [...blocks, ...actionLines].join('\n\n');
}
