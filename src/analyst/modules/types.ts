// Types and interface for pluggable insight modules

export type FactRow = Record<string, unknown>;

export type AnomalyDirection = 'spike' | 'drop' | 'anomaly';

export type AnomalyDetails = {
  zScore: number;
  mean: number;
  stdDev: number;
  actualValue: number;
  date: string;
  direction: AnomalyDirection;
  [key: string]: unknown; // modules can add domain-specific fields
};

export type DetectionResult =
  | { detected: true; anomaly: AnomalyDetails }
  | { detected: false };

/**
 * InsightModule is the contract every insight type implements.
 * The runner, trigger, and hooks handlers only know this interface.
 * This design allows adding new insight types (AOV, reviews, etc.)
 * without changing the core pipeline.
 */
export interface InsightModule {
  readonly insightType: string;
  readonly sourceType: string;
  readonly schedule: string;    // cron expression
  readonly rateLimitMs: number; // minimum ms between runs (safety net for manual triggers)

  /**
   * Checks if this insight can run for the given org.
   * Returns the integration sourceId if data source is connected and active,
   * or null to skip this module entirely.
   */
  resolveSource(orgId: string): Promise<string | null>;

  /**
   * Fetches the raw fact data needed for detection.
   * Shape and content is module-specific.
   */
  fetchData(sourceId: string): Promise<FactRow[]>;

  /**
   * Pure deterministic outlier detection. No I/O, no LLM.
   * Returns { detected: true, anomaly } or { detected: false }.
   */
  detectAnomaly(rows: FactRow[]): DetectionResult;

  /**
   * Builds the text context persisted on the anomaly (InsightAnomaly.promptContext)
   * and later fed to the opportunity curation engine. Module is responsible for
   * formatting its data clearly (tables, summaries, etc.).
   */
  buildPromptContext(rows: FactRow[], anomaly: AnomalyDetails): string;
}
