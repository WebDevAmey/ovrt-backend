export type SweepJobData = {
  type: 'sweep';
  insightType: string;
  orgId?: string;
  bypassRateLimit?: boolean;
};

export type RunJobData = {
  type: 'run';
  orgId: string;
  insightType: string;
  sourceId: string;
};

export type DigestSweepJobData = {
  type: 'digest-sweep';
  orgId?: string;
};

export type DigestJobData = {
  type: 'digest';
  orgId: string;
  sourceId: string;
  weekStart: string; // YYYY-MM-DD Monday of the covered week
  weekEnd: string;   // YYYY-MM-DD Sunday of the covered week
};

export type CurationSweepJobData = {
  type: 'curation-sweep';
  orgId?: string;
  bypassRateLimit?: boolean;
};

export type AnalystJobData = SweepJobData | RunJobData | DigestSweepJobData | DigestJobData | CurationSweepJobData;
