# Frontend handoff — Support agent action layer (what changed)

This describes backend/API/behavior changes from the support-agent "playbooks + actions"
work. It states **what changed**, not what to build — UI decisions are yours.

## TL;DR
- The support agent can now take real actions on Shopify: **cancel an order, edit an
  unfulfilled order's shipping address, and create a reorder (checkout) link**.
- These are **off by default** and gated by per-action merchant toggles. There is a **new
  API** to read/write those toggles (`/support/config/action-permissions`). No UI exists for
  it yet — that's the one place the UI genuinely needs a new surface.
- Everything else is backward-compatible: no new conversation statuses, no enum changes,
  existing rules/persona/signature/mode settings still work exactly as before.

---

## 1. New API: action permissions config

The org's write-action policy lives on `SupportAgentConfig` and is read/written here.

**Auth:** header `x-service-token` (same service token used by `POST /support/conversations/:id/approve`), purpose `gmail` or `support`. Scoped to the token's org.

### `GET /support/config/action-permissions`
Always returns a fully-populated, normalized policy (safe defaults even if never configured):

```json
{
  "actionPermissions": {
    "cancelOrder":   { "enabled": false, "onlyIfUnfulfilled": true, "maxHoursAfterOrder": null },
    "editAddress":   { "enabled": false, "onlyIfUnfulfilled": true },
    "reorder":       { "enabled": true },
    "initiateReturn":{ "enabled": false },
    "refund":        { "enabled": false, "maxAmount": null },
    "requireCustomerConfirmation": true
  },
  "returnWindowDays": null
}
```

### `PUT /support/config/action-permissions`
Body (all fields optional; partial is fine — the server normalizes against defaults before saving):

```json
{
  "actionPermissions": { "cancelOrder": { "enabled": true, "maxHoursAfterOrder": 24 } },
  "returnWindowDays": 30
}
```
Response: `{ "ok": true, "actionPermissions": { …full policy… }, "returnWindowDays": 30 }`.

**Field meanings:**
- `enabled` — whether the agent may perform that action at all.
- `cancelOrder.onlyIfUnfulfilled` / `editAddress.onlyIfUnfulfilled` — restrict to orders that
  haven't shipped (recommended on).
- `cancelOrder.maxHoursAfterOrder` — number of hours after order placement to still allow
  auto-cancel; `null` = no time limit.
- `refund.maxAmount` — guardrail cap (number) or `null`.
- `requireCustomerConfirmation` — when on, irreversible actions (cancel, address change) make
  the agent ask the customer to confirm in-thread before executing.
- `returnWindowDays` — the store's return window, used by the agent when judging return
  eligibility. `null` = defer to the store's written policy.

**Important caveat for the UI:** `initiateReturn` and `refund` exist in the schema but are
**not yet wired** — enabling them currently has **no effect** (the agent still escalates
returns/refunds to a human). Only `cancelOrder`, `editAddress`, and `reorder` actually do
something today. Treat the first two as "coming soon" rather than live toggles.

---

## 2. New data model: `SupportActionLog`

An audit + idempotency row is written every time the agent executes or fails an action.
Shape:

```
SupportActionLog {
  id, organisationId, conversationId,
  orderRef    // Shopify order GID/name, or null
  actionType  // "cancelOrder" | "editAddress" | "reorder" | "initiateReturn" | "refund"
  status      // "executed" | "failed"
  detail      // JSON (e.g. { invoiceUrl } for reorder, { error } for failures)
  createdAt
}
```

There is **no read API for this yet** — it's currently write-only from the backend. If you
want to surface an "actions taken" audit trail per conversation, a list endpoint would need
to be added backend-side first.

---

## 3. Behavioral changes that affect existing screens

These don't require API changes but shift what existing UI *means*:

- **The agent escalates (`NEEDS_HUMAN`) much less often.** It now has a built-in playbook for
  every customer intent, so it can answer order-status, tracking, returns eligibility,
  policy, pricing/discount, damaged-item, etc. without a merchant rule. Expect the
  `NEEDS_HUMAN` queue to shrink. `NEEDS_HUMAN` additionally fires when a write action was
  attempted and **failed** (a teammate should take over).
- **Replies can now contain action results.** A reply may say "I've cancelled order #1234" or
  include a **reorder checkout link**. For a confirmation step, a reply may instead recap the
  action and ask the customer to confirm ("reply YES to cancel"), with the actual action
  happening on the customer's next message.
- **DRAFT vs AUTO_SEND timing nuance.** Actions execute when the agent drafts the reply (tool
  call), i.e. **before** a human approves in DRAFT mode. So in DRAFT mode a human approves the
  *message text*, but the cancel/reorder may already have run. If the product intent is that
  humans gate the *action* too (not just the wording), that's a backend behavior decision to
  revisit — flagging so the approval UI's meaning is understood, not assumed.
- **Conversation statuses are unchanged** (`OPEN`, `AWAITING_APPROVAL`, `READY_TO_SEND`,
  `ANSWERED`, `NEEDS_HUMAN`, `CLOSED`) and the `intent` enum is unchanged. The new fine-grained
  topic taxonomy lives only in the backend and is not persisted to a column you'd query.

---

## 4. What did NOT change (so you can rule it out)
- No changes to the existing support agent config fields you already render (`mode`, `persona`,
  `signature`, `systemInstructions`, `fallbackBehavior`, `escalateOnLowConfidence`,
  `escalateOnComplex`, rules). They all still apply; rules are now optional overrides on top of
  the built-in playbooks.
- No changes to the inbox/conversation/message read endpoints or shapes.
- No new conversation/message statuses or Prisma enums.

---

## 5. Net: minimum vs. nice-to-have
- **Minimum (to use the new capability):** a settings surface that reads/writes
  `/support/config/action-permissions` — at least `cancelOrder.enabled`,
  `editAddress.enabled`, `reorder.enabled`, `requireCustomerConfirmation`, and
  `returnWindowDays`. Without it, the new actions stay at their (mostly-off) defaults.
- **Nice-to-have:** an "actions taken" audit view (needs a new backend list endpoint for
  `SupportActionLog` first), and copy explaining that returns/refund toggles are not yet live.
