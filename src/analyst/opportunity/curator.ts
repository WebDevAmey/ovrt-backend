import { generateText } from 'ai';
import { openaiModel, samplingFor, maxTokensFor } from '../../openai.js';
import { logAiTokenUsage } from '../../ai-token-usage.js';
import {
  OPPORTUNITY_CURATION_MODEL,
  OPPORTUNITY_CURATION_MAX_TOKENS,
  OPPORTUNITY_CURATION_TEMPERATURE,
  OPPORTUNITY_CURATION_MAX_DRAFTS,
} from '../constants.js';
import type {
  CurationInput,
  OpportunityDraft,
  OpportunityEvidence,
  OpportunityEvidenceType,
} from './types.js';

const VALID_CATEGORIES = new Set([
  'MARKETING',
  'COMMUNICATION',
  'PRICING',
  'PRODUCT',
  'RETENTION',
  'OPERATIONS',
  'CUSTOMER_EXPERIENCE',
  'INVENTORY',
  'ACQUISITION',
  'OTHER',
]);

const VALID_EVIDENCE_TYPES = new Set(['anomaly', 'metric', 'cohort', 'message', 'digest']);

function finiteNumber(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function isNonEmptyObject(ctx: unknown): boolean {
  return Boolean(ctx) && typeof ctx === 'object' && Object.keys(ctx as object).length > 0;
}

// ── Prompt builders ────────────────────────────────────────────

function buildAnomaliesBlock(anomalies: CurationInput['anomalies']): string {
  if (anomalies.length === 0) {
    return 'No new anomalies detected since the last curation run.';
  }
  return anomalies
    .map((a) => {
      const ctx = a.promptContext?.trim();
      const header = `[${a.id}] ${a.insightType} — detected ${a.detectedAt}`;
      return ctx ? `${header}\n${ctx}` : `${header}\n${JSON.stringify(a.anomalyDetails)}`;
    })
    .join('\n\n');
}

function buildDigestBlock(digest: CurationInput['latestDigest']): string {
  if (!digest) return 'No weekly digest available yet for this store.';
  return `Week ${digest.weekStart} → ${digest.weekEnd} (health ${digest.healthScore}/100)
Headline: ${digest.headline}
Narrative: ${digest.narrative}
Top wins: ${digest.topWins.join(' | ') || 'none'}
Top concerns: ${digest.topConcerns.join(' | ') || 'none'}`;
}

function buildContextBlock(businessContext: unknown, orgIdentity: unknown): string {
  const sections: string[] = [];
  if (isNonEmptyObject(orgIdentity)) {
    try {
      sections.push(`STORE IDENTITY:\n${JSON.stringify(orgIdentity, null, 2)}`);
    } catch {
      /* ignore unserialisable identity */
    }
  }
  if (isNonEmptyObject(businessContext)) {
    try {
      sections.push(`BUSINESS CONTEXT:\n${JSON.stringify(businessContext, null, 2)}`);
    } catch {
      /* ignore unserialisable context */
    }
  }
  return sections.length > 0 ? `\n${sections.join('\n\n')}` : '';
}

function buildExistingBlock(existingDedupeKeys: string[]): string {
  if (existingDedupeKeys.length === 0) return 'None.';
  return existingDedupeKeys.map((k) => `  • ${k}`).join('\n');
}

// ── LLM output shape (before validation) ───────────────────────

interface RawLlmEvidence {
  type?: unknown;
  label?: unknown;
  value?: unknown;
  ref?: unknown;
  note?: unknown;
}

interface RawLlmDraft {
  title?: unknown;
  description?: unknown;
  category?: unknown;
  priority?: unknown;
  evidence?: unknown;
  dedupeKey?: unknown;
  sourceAnomalyId?: unknown;
}

interface RawLlmOutput {
  opportunities?: unknown;
}

function sanitiseEvidence(raw: unknown): OpportunityEvidence[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawLlmEvidence[])
    .map((e) => ({
      type: (VALID_EVIDENCE_TYPES.has(e.type as string) ? e.type : 'anomaly') as OpportunityEvidenceType,
      label: typeof e.label === 'string' ? e.label.slice(0, 120) : '',
      value: typeof e.value === 'string' ? e.value.slice(0, 120) : undefined,
      ref: typeof e.ref === 'string' ? e.ref.slice(0, 120) : undefined,
      note: typeof e.note === 'string' ? e.note.slice(0, 300) : undefined,
    }))
    .filter((e) => e.label.length > 0);
}

function sanitiseDrafts(raw: unknown, validAnomalyIds: Set<string>): OpportunityDraft[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawLlmDraft[])
    .slice(0, OPPORTUNITY_CURATION_MAX_DRAFTS)
    .map((d) => {
      const priority = finiteNumber(d.priority);
      const evidence = sanitiseEvidence(d.evidence);
      const sourceAnomalyId =
        typeof d.sourceAnomalyId === 'string' && validAnomalyIds.has(d.sourceAnomalyId)
          ? d.sourceAnomalyId
          : undefined;
      const title = typeof d.title === 'string' ? d.title.slice(0, 80) : '';
      return {
        title,
        description: typeof d.description === 'string' ? d.description.slice(0, 2000) : '',
        category: VALID_CATEGORIES.has(d.category as string) ? (d.category as string) : 'OTHER',
        priority: priority === undefined ? 50 : clamp(Math.round(priority), 0, 100),
        evidence,
        dedupeKey:
          typeof d.dedupeKey === 'string' && d.dedupeKey.length > 0
            ? d.dedupeKey.slice(0, 120)
            : title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60),
        sourceAnomalyId,
      };
    })
    .filter((d) => d.title.length > 0 && d.description.length > 0 && d.evidence.length > 0);
}

// ── Public interface ────────────────────────────────────────────

export async function curateOpportunities(input: CurationInput): Promise<OpportunityDraft[]> {
  const anomaliesBlock = buildAnomaliesBlock(input.anomalies);
  const digestBlock = buildDigestBlock(input.latestDigest);
  const contextBlock = buildContextBlock(input.businessContext, input.orgIdentity);
  const existingBlock = buildExistingBlock(input.existingDedupeKeys);

  const prompt = `You are a senior e-commerce growth consultant for a Shopify merchant. Your only job is to find the highest-leverage, evidence-backed opportunities for this specific store and turn each into ONE concrete, actionable suggestion. You are NOT writing alerts — every opportunity must combine the problem, the evidence, AND the suggested action in a single piece of advice.
${contextBlock}

━━━ RECENT ANOMALIES SINCE LAST CURATION ━━━
${anomaliesBlock}

━━━ LATEST WEEKLY DIGEST ━━━
${digestBlock}

━━━ ALREADY-OPEN OPPORTUNITIES (do not duplicate these) ━━━
${existingBlock}

━━━ QUALITY BAR (read carefully) ━━━
• Quality over quantity. Return 0 opportunities if nothing here is genuinely worth a merchant's attention — do not pad the list.
• Generic, common advice ("improve your marketing", "send more emails") is a FAILURE. Every opportunity must cite specific numbers from the data above (an anomaly value, a metric, a count) as evidence.
• Each opportunity's description must read as: what's happening (with the number) -> why it matters -> the specific action to take. Example style: "190 of your last 198 orders (96%) were single-item — bundling complementary products at checkout could lift AOV. Consider pairing your top-selling denim with a related accessory at a small discount."
• Do not restate an anomaly as a bare alert ("Orders dropped 20%") without a concrete next step attached.
• Prefer opportunities anomaly-backed by evidence over speculation. If you reference an anomaly, set sourceAnomalyId to its bracketed id exactly as given above (e.g. the id inside [..]).
• At most ${OPPORTUNITY_CURATION_MAX_DRAFTS} opportunities.

Return ONLY a valid JSON object — no markdown fences, no prose outside the JSON.

{
  "opportunities": [
    {
      "title": "<max 80 chars, action-oriented e.g. 'Create a denim bundle to lift average order value'>",
      "description": "<2-4 sentences: problem -> evidence with numbers -> concrete suggested action>",
      "category": "<MARKETING|COMMUNICATION|PRICING|PRODUCT|RETENTION|OPERATIONS|CUSTOMER_EXPERIENCE|INVENTORY|ACQUISITION|OTHER>",
      "priority": <0-100, higher = more urgent/impactful>,
      "evidence": [{ "type": "<anomaly|metric|cohort|message|digest>", "label": "<short label e.g. 'Single-item orders'>", "value": "<e.g. '190 of 198 (96%)'>", "ref": "<anomaly id or metric name>", "note": "<optional>" }],
      "dedupeKey": "<short stable slug for this topic, e.g. 'aov-bundle-denim'>",
      "sourceAnomalyId": "<bracketed anomaly id from above, omit if not anomaly-backed>"
    }
  ]
}`;

  const startedAt = new Date();
  const result = await generateText({
    model: openaiModel(OPPORTUNITY_CURATION_MODEL),
    prompt,
    ...samplingFor(OPPORTUNITY_CURATION_MODEL, OPPORTUNITY_CURATION_TEMPERATURE),
    maxOutputTokens: maxTokensFor(OPPORTUNITY_CURATION_MODEL, OPPORTUNITY_CURATION_MAX_TOKENS),
  });

  logAiTokenUsage({
    organisationId: input.organisationId,
    modelName: OPPORTUNITY_CURATION_MODEL,
    feature: 'analyst',
    agentName: 'opportunity-curator',
    operation: 'curate-opportunities',
    usage: result.usage,
    finishReason: result.finishReason,
    latencyMs: Date.now() - startedAt.getTime(),
    startedAt,
    metadata: { anomalyCount: input.anomalies.length },
  });

  let jsonText = result.text.trim();
  const firstBrace = jsonText.indexOf('{');
  const lastBrace = jsonText.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    jsonText = jsonText.slice(firstBrace, lastBrace + 1);
  }

  let raw: RawLlmOutput;
  try {
    raw = JSON.parse(jsonText) as RawLlmOutput;
  } catch {
    console.error(
      `[opportunity-curator] unparseable JSON (finishReason=${result.finishReason}): ${jsonText.slice(0, 200)}`,
    );
    return [];
  }

  const validAnomalyIds = new Set(input.anomalies.map((a) => a.id));
  return sanitiseDrafts(raw.opportunities, validAnomalyIds);
}
