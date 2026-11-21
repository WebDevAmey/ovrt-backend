# Opportunity migration — frontend contract

`InsightHook` (per-anomaly chat alert) and `Recommendation` (weekly-digest "play") have been
merged into a single concept: **Opportunity**. Both old tables are dropped. This doc describes
the new shape and API for the frontend rebuild.

## Why

Hooks described a problem only; recommendations had a problem + a rich, mostly-unused
execution workflow (approval/ROI/parameters — confirmed zero usage). Opportunities are lean:
problem + evidence + a concrete suggested action, in one prose field. They come from two
producers — a curated anomaly-review engine (every ~4 days) and the weekly digest (weekly,
unchanged cadence/email) — but the frontend talks to one model and one set of endpoints
regardless of which produced it.

## The `Opportunity` object

```ts
type Opportunity = {
  id: string;
  title: string;
  description: string;        // prose: problem → evidence → suggested action
  category: OpportunityCategory;
  priority: number;            // 0–100, higher = surface first
  status: OpportunityStatus;
  source: OpportunitySource;
  evidence: OpportunityEvidence[];
  sourceAnomalyId: string | null; // present only for ANOMALY_CURATION opportunities tied to one anomaly
  createdAt: string;            // ISO timestamp
};

type OpportunityEvidence = {
  type: 'anomaly' | 'metric' | 'cohort' | 'message' | 'digest';
  label: string;    // e.g. "Single-item orders"
  value?: string;   // e.g. "190 of 198 (96%)"
  ref?: string;     // anomalyId / insightType / metric name
  note?: string;
};

type OpportunityStatus = 'OPEN' | 'VIEWED' | 'EXPLORING' | 'DISMISSED' | 'DONE';
type OpportunitySource = 'ANOMALY_CURATION' | 'WEEKLY_DIGEST';
type OpportunityCategory =
  | 'MARKETING' | 'COMMUNICATION' | 'PRICING' | 'PRODUCT' | 'RETENTION'
  | 'OPERATIONS' | 'CUSTOMER_EXPERIENCE' | 'INVENTORY' | 'ACQUISITION' | 'OTHER';
```

**Lifecycle:** `OPEN → VIEWED → EXPLORING → DISMISSED | DONE`. There is no approval/execution
workflow — an opportunity is either acted on (by the merchant, outside the app) and marked
`DONE`, or `DISMISSED`.

## Endpoints

All under the existing `/analyst` service-token-authed router.

- `GET /analyst/opportunities` — list `OPEN`/`VIEWED`/`EXPLORING` opportunities for the org,
  ordered by priority desc then createdAt desc. Returns `{ opportunities: Opportunity[] }`.
- `POST /analyst/opportunities/:id/view` — marks `VIEWED` (no-op, still 200, if already past
  `OPEN`). Returns `{ opportunity }`.
- `POST /analyst/opportunities/:id/explore` — body `{ conversationId: string }`. Marks
  `EXPLORING`, links the conversation. Returns `{ opportunity, anomaly }` where `anomaly` is
  `null` unless the opportunity is anomaly-backed (`sourceAnomalyId` set), in which case it's
  `{ id, anomalyDetails, detectedAt, job: { insightType, sourceId, sourceType, factData } }` —
  the same shape the old `hooks/:id/engage` returned, for any chat-injection logic that depended
  on it.
- `POST /analyst/opportunities/:id/dismiss` — marks `DISMISSED`. Returns `{ opportunity }`.
- `POST /analyst/opportunities/:id/done` — marks `DONE`. Returns `{ opportunity }`.
- `POST /analyst/opportunities/curate` — manual trigger for the anomaly curation engine
  (bypasses the 4-day rate gate), for an admin/debug "regenerate now" action. Returns
  `{ triggered: true, orgId }`; opportunities land asynchronously.

### Removed

- `GET /analyst/hooks`
- `POST /analyst/hooks/:id/engage`

### Changed

- `GET /analyst/digest/:id` now returns `{ digest, opportunities }` instead of
  `{ digest, recommendations }`. `opportunities` is every `Opportunity` with
  `source: 'WEEKLY_DIGEST'` and `sourceRef` equal to the digest id, ordered by priority desc.
  Each item: `{ id, title, description, category, priority, status, evidence, generatedByModel, createdAt }`.
- `GET /analyst/digest` (list) and `POST /analyst/digest/trigger` are unchanged.

## Conversation flow ("explore this opportunity")

Replaces the old "explore this anomaly" flow:

1. Create (or reuse) a conversation, with `intent.opportunityId = <id>` instead of the old
   `intent.anomalyId`.
2. Call `POST /analyst/opportunities/:id/explore` with that `conversationId`.
3. Send the first chat message as usual. The orchestrator reads `intent.opportunityId`, loads
   the opportunity, and:
   - If anomaly-backed (`sourceAnomalyId` set), runs the same hardcoded investigation flow the
     old anomaly chat used (per-insightType tasks, anomaly-aware synthesis tone).
   - If digest/aggregate-sourced (no `sourceAnomalyId`), the opportunity's title/description/
     evidence are injected into the planner so it investigates around the opportunity instead
     of a cold question. Both paths are explorable identically from the frontend's perspective
     — same `intent.opportunityId` field, same explore call.

## Email changes

- Per-anomaly alert emails are gone. A new batch email goes out when the curation engine
  produces new `ANOMALY_CURATION` opportunities (one email per run, listing all new
  opportunities for that org).
- The weekly digest email is unchanged in cadence/structure, except the "recommended next step"
  section is now labeled "Top Opportunity" and shows the highest-priority opportunity from that
  digest.

## Open follow-up (not yet built)

Additional analysis signal sources (reviews, basket composition, lapsed-buyer cohorts, a future
pixel-analytics module) will plug into the same curation engine and produce the same
`Opportunity` shape — no frontend changes expected when those land.
