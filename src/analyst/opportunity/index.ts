export { runOpportunityCurationSweep } from './sweep.js';
export { curateOpportunities } from './curator.js';
export { writeOpportunities } from './writer.js';
export type {
  OpportunityDraft,
  OpportunityEvidence,
  OpportunityEvidenceType,
  CurationInput,
  CurationAnomalyInput,
  CurationDigestSummary,
} from './types.js';

// Cron schedule: daily — the 4-day-per-org cadence is enforced inside the
// sweep via a marker AnalystJob, not by this interval. Running the sweep
// daily just means a newly-eligible org never waits more than a day past
// its 4-day mark.
export const OPPORTUNITY_CURATION_CRON_SCHEDULE = '0 7 * * *';
