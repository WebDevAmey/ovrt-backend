// Analyst module configuration constants
// Update these values to tune the always-on analyst behavior

// The business operates on Indian Standard Time. All cron schedules and
// calendar-boundary math ("today", "last N days", week windows) are anchored
// to this zone so merchants see runs and date ranges aligned to their clock.
export const BUSINESS_TIMEZONE = 'Asia/Kolkata';

export const ANALYST_ZSCORE_THRESHOLD = 2.0; // Statistical outlier threshold (sigma)
export const ANALYST_FLAT_BASELINE_THRESHOLD = 0.2; // 20% deviation when stdDev=0 (edge case)
export const ANALYST_RATE_LIMIT_MS = 23 * 60 * 60 * 1000; // 23 hours between jobs per insightType

// Weekly Digest generation
export const DIGEST_MODEL = 'gpt-4o';
// Headroom for a 3–4 paragraph narrative plus up to 5 fully-structured
// recommendations; a tight cap risks a truncated JSON that fails to parse.
export const DIGEST_MAX_TOKENS = 4000;
export const DIGEST_TEMPERATURE = 0.3;

// Jobs RUNNING or QUEUED past this age are treated as orphans from a crashed worker
// and reaped to FAILED on startup. Real jobs complete in well under a minute.
export const ANALYST_STALE_JOB_MS = 60 * 60 * 1000; // 1 hour

// Opportunity curation engine (anomaly -> opportunity)
export const OPPORTUNITY_CURATION_INSIGHT_TYPE = 'OPPORTUNITY_CURATION'; // marker AnalystJob.insightType for cadence tracking
export const OPPORTUNITY_CURATION_INTERVAL_MS = 4 * 24 * 60 * 60 * 1000; // run at most every 4 days per org
export const OPPORTUNITY_CURATION_MODEL = DIGEST_MODEL;
export const OPPORTUNITY_CURATION_MAX_TOKENS = 3000;
export const OPPORTUNITY_CURATION_TEMPERATURE = 0.3;
export const OPPORTUNITY_CURATION_MAX_DRAFTS = 5; // cap on opportunities emitted per curation run
