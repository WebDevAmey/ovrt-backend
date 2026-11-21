// ─────────────────────────────────────────────────────────────
// Opportunity — shared TypeScript types
//
// Both producers (anomaly curation engine + weekly digest) emit the same
// lean OpportunityDraft shape so the rest of the pipeline (writer, API,
// orchestrator, store-brief) never needs to know which producer made it.
// New signal sources (reviews, basket composition, cohorts, …) plug in by
// adding to CurationInput and producing more OpportunityDraft[] — the
// Opportunity model and downstream consumers do not change.
// ─────────────────────────────────────────────────────────────

export type OpportunityEvidenceType = 'anomaly' | 'metric' | 'cohort' | 'message' | 'digest';

export interface OpportunityEvidence {
  type: OpportunityEvidenceType;
  label: string;   // "Single-item orders"
  value?: string;  // "190 of 198 (96%)"
  ref?: string;     // anomalyId / insightType / metric name
  note?: string;
}

// ── Draft returned by an LLM producer before DB write ─────────

export interface OpportunityDraft {
  title: string;        // max ~80 chars
  description: string;  // prose: problem -> evidence -> suggested action
  category: string;      // OpportunityCategory enum string value
  priority: number;      // 0-100, higher = surface first
  evidence: OpportunityEvidence[];
  dedupeKey: string;      // topic/insightType slug for cross-run + cross-producer dedup
  sourceAnomalyId?: string; // primary anomaly cited, when this draft is anomaly-backed
}

// ── Curation engine input contract ─────────────────────────────

export interface CurationAnomalyInput {
  id: string;
  insightType: string;
  anomalyDetails: Record<string, unknown>;
  promptContext: string | null;
  detectedAt: string; // YYYY-MM-DD
}

export interface CurationDigestSummary {
  headline: string;
  narrative: string;
  healthScore: number;
  topWins: string[];
  topConcerns: string[];
  weekStart: string;
  weekEnd: string;
}

/**
 * Everything the curation LLM call needs to ground its suggestions in real
 * store context. Future signal sources (e.g. a pixel-analytics module)
 * extend this with an additional optional field — curator.ts grows a new
 * prompt section for it, nothing upstream/downstream changes.
 */
export interface CurationInput {
  organisationId: string;
  anomalies: CurationAnomalyInput[];
  latestDigest: CurationDigestSummary | null;
  businessContext?: unknown;
  orgIdentity?: unknown;
  // dedupeKeys of opportunities already OPEN/VIEWED/EXPLORING for this org —
  // the model is told not to re-suggest these.
  existingDedupeKeys: string[];
}
