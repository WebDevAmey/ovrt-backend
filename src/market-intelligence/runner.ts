import { generateText, Output } from 'ai';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { openaiModel, samplingFor, reasoningOpts, maxTokensFor } from '../openai.js';
import { prisma } from '../prisma.js';
import { logAiTokenUsage } from '../ai-token-usage.js';
import type {
  OrgIdentityFields,
  BusinessContextFields,
  CompetitorProfile,
  MarketOverview,
  MarketTrends,
  TargetAudience,
  QueryContext,
  Source,
} from './types.js';

const PLAN_MODEL = process.env.WEB_SEARCH_PLAN_MODEL ?? 'gpt-4o-mini';
const SEARCH_MODEL = process.env.WEB_SEARCH_MODEL ?? 'gpt-5-search-api';
const SYNTHESIS_MODEL = process.env.MARKET_SYNTHESIS_MODEL ?? 'gpt-4o';

// Ordered fallback chain, deduped so a failing model isn't retried back-to-back
// (e.g. when SEARCH_MODEL is left at its 'gpt-5-search-api' default it would
// otherwise appear twice and burn an identical retry).
const SEARCH_MODEL_CHAIN = [
  ...new Set([
    SEARCH_MODEL,
    'gpt-5-search-api',
    'gpt-4o-search-preview',
    'gpt-5',
    'gpt-4o',
  ]),
];

const MAX_SEARCH_QUERIES = 8;

// Fraction of planned searches that must succeed before we pay for synthesis.
// Synthesising over a near-empty fact set produces a low-quality analysis the
// user would still see as SUCCEEDED, so require a quorum.
const MIN_SEARCH_SUCCESS_RATIO = 0.5;

// ─── Context helpers ──────────────────────────────────────────────────────────

function deriveScale(identity: OrgIdentityFields): string {
  const employees = identity.employeeCount ?? '';
  const year = identity.foundingYear ? parseInt(identity.foundingYear) : null;
  const age = year ? new Date().getFullYear() - year : null;

  const sizePart = employees
    ? employees.replace(/\s/g, '') === '1'
      ? 'solo founder'
      : `${employees} employees`
    : 'small';

  const agePart =
    age !== null
      ? age <= 1
        ? 'early-stage startup (< 1 year old)'
        : age <= 3
          ? 'early-stage startup'
          : age <= 7
            ? 'growth-stage'
            : 'established'
      : '';

  return [sizePart, agePart].filter(Boolean).join(', ');
}

function buildBusinessProfile(
  identity: OrgIdentityFields,
  context: BusinessContextFields,
): string {
  const lines: string[] = [
    `Brand: ${identity.displayName || identity.legalName || 'Unknown'}`,
    `Industry: ${identity.industry || 'Unknown'}`,
    `Sub-type: ${identity.businessSubType || 'Unknown'}`,
    `Business kind: ${identity.businessKind || 'Unknown'} (${identity.businessType || 'Unknown'})`,
    `Country: ${identity.country || 'Unknown'}`,
    `City: ${identity.city || 'Unknown'}`,
    `Scale: ${deriveScale(identity)}`,
    `Currency: ${identity.currency || 'INR'}`,
    identity.websiteUrl ? `Website: ${identity.websiteUrl}` : '',
    context.companyDescription ? `Description: ${context.companyDescription}` : '',
    context.primaryCustomer ? `Primary customer: ${context.primaryCustomer}` : '',
    context.customerSegments ? `Customer segments: ${context.customerSegments}` : '',
    context.businessModel ? `Business model: ${context.businessModel}` : '',
    context.competitors ? `Known competitors (if any): ${context.competitors}` : '',
    context.strategicPriorities?.filter(Boolean).length
      ? `Strategic priorities: ${context.strategicPriorities!.filter(Boolean).join('; ')}`
      : '',
  ];

  return lines.filter(Boolean).join('\n');
}

// ─── Phase 1: Query planning ──────────────────────────────────────────────────

const queryPlanSchema = z.object({
  queries: z
    .array(z.string().min(10))
    .min(4)
    .max(MAX_SEARCH_QUERIES)
    .describe('Targeted search queries for market and competitor research'),
});

async function planSearchQueries(
  profile: string,
  identity: OrgIdentityFields,
  orgId: string,
): Promise<string[]> {
  const brandName = identity.displayName || identity.legalName || 'the brand';
  const industry = identity.businessSubType || identity.industry || 'retail';
  const country = identity.country || 'India';
  const scale = deriveScale(identity);

  const startedAt = new Date();
  const result = await generateText({
    model: openaiModel(PLAN_MODEL),
    output: Output.object({ schema: queryPlanSchema }),
    system: `You are a market research strategist. Your job is to generate precise web search queries for competitive intelligence.

Key rules:
1. DISAMBIGUATION: Always include the industry/sub-type in queries to avoid surfacing unrelated brands with similar names. Never search by brand name alone — always anchor it to the industry.
2. SCALE-AWARE: Include scale qualifiers so results match comparable-sized businesses, not industry giants. Use phrases like "small brand", "startup", "D2C brand", "independent brand", or approximate revenue/employee ranges.
3. AUDIENCE-FIRST: Some queries should ask WHO this audience buys from — not just "list of competitors". E.g., "Indian women aged 25-35 denim jeans online purchase brands".
4. GEOGRAPHY-SPECIFIC: Always include the country. Include city/region when relevant for local markets.
5. RECENCY: Add "2024" or "2025" to trend and market queries.
6. VARIETY: Cover these angles — (a) direct competitors, (b) audience buying behavior, (c) market trends + size, (d) pricing landscape, (e) emerging brands.`,
    prompt: `Generate ${MAX_SEARCH_QUERIES} web search queries for market and competitor research.

Business profile:
${profile}

Important disambiguation context:
- Brand name "${brandName}" must ALWAYS appear with industry qualifier ("${industry}") to avoid confusion with unrelated brands in other industries.
- Scale: ${scale} — queries should surface similarly-sized competitors, not Fortune-500 players.
- Search for WHO the ${country} audience for "${industry}" products buys from, not just "competitors of ${brandName}".

Return queries that together answer: Who are the real competitors, what does the market look like, and what does the target audience buy?`,
    ...samplingFor(PLAN_MODEL, 0.2),
    maxOutputTokens: maxTokensFor(PLAN_MODEL, 512),
  });

  logAiTokenUsage({
    organisationId: orgId,
    modelName: PLAN_MODEL,
    feature: 'market-intelligence',
    agentName: 'market-intelligence',
    operation: 'plan-queries',
    usage: result.usage,
    finishReason: result.finishReason,
    latencyMs: Date.now() - startedAt.getTime(),
    startedAt,
  });

  // Already bounded to [4, MAX_SEARCH_QUERIES] by queryPlanSchema's min/max.
  return result.output.queries;
}

// ─── Phase 2: Web search ──────────────────────────────────────────────────────

type RawSearchResult = {
  query: string;
  facts: string;
  sources: Source[];
};

// Matches a bare domain (e.g. example.com, sub.example.co.in), no scheme/path.
const DOMAIN_RE = /[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+\.?[a-z]{2,}/gi;

/**
 * Pull domain citations out of the model's bullet text. The model is told to
 * cite as "(from: domain.com)" / "(source: domain.com)" or "[domain.com]", but
 * it routinely lists several domains in one parenthetical ("(source: a.com,
 * b.com)"). We therefore extract every domain token from each citation rather
 * than treating the whole parenthetical as a single URL.
 */
function extractSources(text: string): Source[] {
  const sources: Source[] = [];
  const seen = new Set<string>();

  const add = (raw: string): void => {
    const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
    if (!domain) return;
    const url = `https://${domain}`;
    if (seen.has(url)) return;
    seen.add(url);
    sources.push({ url, title: domain });
  };

  // (from: …) / (source: …) — may contain multiple comma/space-separated domains.
  const citationRe = /\((?:from|source):\s*([^)]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = citationRe.exec(text)) !== null) {
    const inner = m[1];
    const domains = inner.match(DOMAIN_RE);
    if (domains) for (const d of domains) add(d);
  }

  // [domain.com] bracketed single-domain citations.
  const bracketRe = /\[([a-z0-9.\-]+\.[a-z]{2,})\]/gi;
  while ((m = bracketRe.exec(text)) !== null) {
    add(m[1]);
  }

  return sources;
}

async function runSingleSearch(query: string, orgId: string): Promise<RawSearchResult> {
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  let lastError: Error | null = null;

  for (const modelId of SEARCH_MODEL_CHAIN) {
    try {
      const isSearchModel = modelId.includes('search');
      const system = isSearchModel
        ? `You are a market research assistant. Extract factual bullet points from web search results.
Return ONLY bullet-point facts. Each bullet must be one sentence with specific numbers, dates, or concrete claims.
Format: - [factual statement] (from: domain.com)
Focus on: brands, prices, revenue figures, audience demographics, market size, growth rates.
Never summarise or interpret. Raw facts only.`
        : `Search the internet and return factual bullet points answering this query.
Format: - [factual statement] (source: domain.com)
Focus on concrete figures. Do not speculate.`;

      const startedAt = new Date();
      const { text, usage, finishReason } = await generateText({
        model: openai(modelId),
        system,
        prompt: query,
        // gpt-5 / gpt-5-search-api are reasoning models that spend output tokens
        // on hidden reasoning; maxTokensFor inflates the budget so the visible
        // facts aren't truncated. samplingFor only sets temperature for models
        // that accept it (reasoning models reject it → 400).
        ...samplingFor(modelId, 0.2),
        maxOutputTokens: maxTokensFor(modelId, 1000),
      });

      logAiTokenUsage({
        organisationId: orgId,
        modelName: modelId,
        feature: 'market-intelligence',
        agentName: 'market-intelligence',
        operation: 'web-search',
        usage,
        finishReason,
        latencyMs: Date.now() - startedAt.getTime(),
        startedAt,
        metadata: { query },
      });

      const sources = extractSources(text);

      return { query, facts: text, sources };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[market-intelligence] search model "${modelId}" failed: ${lastError.message}`);
    }
  }

  throw lastError || new Error('All search models failed');
}

// ─── Phase 3: Synthesis ───────────────────────────────────────────────────────

const competitorSchema = z.object({
  name: z.string(),
  website: z.string().nullable(),
  estimatedRevenue: z.string().nullable(),
  employeeCount: z.string().nullable(),
  businessModel: z.string(),
  targetAudience: z.string(),
  priceRange: z.string().nullable(),
  keyProducts: z.array(z.string()),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  marketPositioning: z.string(),
  geography: z.string(),
  socialPresence: z.object({
    instagram: z.string().nullable(),
    facebook: z.string().nullable(),
    other: z.array(z.string()),
  }),
  sources: z.array(z.string()),
  confidenceScore: z.number().min(0).max(1),
});

const synthesisSchema = z.object({
  marketOverview: z.object({
    summary: z.string(),
    marketSize: z.string().nullable(),
    growthRate: z.string().nullable(),
    keyDynamics: z.array(z.string()),
    opportunities: z.array(z.string()),
    threats: z.array(z.string()),
    dominantPlayers: z.array(z.string()),
  }),
  competitors: z.array(competitorSchema),
  marketTrends: z.object({
    trends: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        impact: z.enum(['HIGH', 'MEDIUM', 'LOW']),
        isOpportunity: z.boolean(),
      }),
    ),
    seasonality: z.string().nullable(),
    emergingCategories: z.array(z.string()),
    channelShifts: z.array(z.string()),
  }),
  targetAudience: z.object({
    demographics: z.object({
      ageRange: z.string(),
      genderSkew: z.string(),
      incomeLevel: z.string(),
      location: z.string(),
    }),
    behaviors: z.array(z.string()),
    preferences: z.array(z.string()),
    shoppingChannels: z.array(z.string()),
    topBrandsTheyBuy: z.array(z.string()),
    priceSensitivity: z.string(),
  }),
});

type SynthesisOutput = z.infer<typeof synthesisSchema>;

async function synthesizeResults(
  rawFacts: string,
  profile: string,
  identity: OrgIdentityFields,
  orgId: string,
): Promise<SynthesisOutput> {
  const brandName = identity.displayName || identity.legalName || 'the brand';
  const industry = identity.businessSubType || identity.industry || 'retail';
  const country = identity.country || 'India';

  const startedAt = new Date();
  const result = await generateText({
    model: openaiModel(SYNTHESIS_MODEL),
    output: Output.object({ schema: synthesisSchema }),
    system: `You are a senior market intelligence analyst. Your job is to extract structured competitive intelligence from web research notes.

Critical rules:
1. DISAMBIGUATION: Only include competitors operating in the SAME industry ("${industry}") as ${brandName}. Discard any brands from unrelated sectors even if their name sounds similar.
2. SCALE-MATCHING: Prefer competitors of similar scale (${deriveScale(identity)}). Large enterprise players are OK to include in dominantPlayers but not as primary competitors unless they genuinely compete for the same customers.
3. COUNTRY-SCOPE: Focus on ${country} market unless the brand explicitly operates internationally.
4. EVIDENCE-BASED: Only include facts that appear in the research notes. If a data point is unknown, use null. Never invent figures.
5. CONFIDENCE SCORE: Set confidenceScore based on how much evidence backed that competitor (1.0 = multiple sources with concrete data, 0.3 = single mention, no details).`,
    prompt: `Analyse these web research notes about the market where "${brandName}" (${industry} brand in ${country}) operates, and extract the structured intelligence below.

Business profile of ${brandName}:
${profile}

Research notes from web searches:
${rawFacts}

Extract:
1. marketOverview — high-level market picture
2. competitors — real competitors from SAME industry only, with all details from the notes
3. marketTrends — trends, seasonality, emerging categories
4. targetAudience — who buys in this market and from whom`,
    ...samplingFor(SYNTHESIS_MODEL, 0.1),
    ...reasoningOpts(SYNTHESIS_MODEL, 'medium'),
    maxOutputTokens: maxTokensFor(SYNTHESIS_MODEL, 4000),
  });

  logAiTokenUsage({
    organisationId: orgId,
    modelName: SYNTHESIS_MODEL,
    feature: 'market-intelligence',
    agentName: 'market-intelligence',
    operation: 'synthesize',
    usage: result.usage,
    finishReason: result.finishReason,
    latencyMs: Date.now() - startedAt.getTime(),
    startedAt,
  });

  return result.output;
}

// ─── Main runner ──────────────────────────────────────────────────────────────

export async function runMarketAnalysis(analysisId: string, orgId: string): Promise<void> {
  // Mark as running
  await prisma.marketAnalysis.update({
    where: { id: analysisId },
    data: { status: 'RUNNING', startedAt: new Date() },
  });

  try {
    // Load org context
    const org = await prisma.organisation.findUnique({
      where: { id: orgId },
      select: { orgIdentity: true, businessContext: true },
    });
    if (!org) throw new Error(`Organisation ${orgId} not found`);

    const identity = (org.orgIdentity ?? {}) as OrgIdentityFields;
    const context = (org.businessContext ?? {}) as BusinessContextFields;

    const profile = buildBusinessProfile(identity, context);

    // Phase 1: Generate targeted search queries
    console.log(`[market-intelligence] planning queries for org=${orgId}`);
    const queries = await planSearchQueries(profile, identity, orgId);
    console.log(`[market-intelligence] planned ${queries.length} queries for org=${orgId}`);

    // Phase 2: Execute searches in parallel
    const searchResults = await Promise.allSettled(
      queries.map((q) => runSingleSearch(q, orgId)),
    );

    const successfulResults = searchResults
      .filter((r): r is PromiseFulfilledResult<RawSearchResult> => r.status === 'fulfilled')
      .map((r) => r.value);

    // Require a quorum of successful searches before paying for synthesis —
    // synthesising over a near-empty fact set yields a low-quality result the
    // user would still see as SUCCEEDED. Always need at least one.
    const minRequired = Math.max(1, Math.ceil(queries.length * MIN_SEARCH_SUCCESS_RATIO));
    if (successfulResults.length < minRequired) {
      throw new Error(
        `Insufficient web search coverage: ${successfulResults.length}/${queries.length} succeeded (need ${minRequired})`,
      );
    }

    // Combine facts and deduplicate sources
    const rawFacts = successfulResults.map((r) => `Query: ${r.query}\n${r.facts}`).join('\n\n---\n\n');

    const allSources = successfulResults.flatMap((r) => r.sources);
    const seenUrls = new Set<string>();
    const uniqueSources: Source[] = [];
    for (const s of allSources) {
      if (!seenUrls.has(s.url)) {
        seenUrls.add(s.url);
        uniqueSources.push(s);
      }
    }

    // Phase 3: Synthesize into structured output
    console.log(`[market-intelligence] synthesizing results for org=${orgId}`);
    const synthesis = await synthesizeResults(rawFacts, profile, identity, orgId);

    // Build query context for traceability
    const queryContext: QueryContext = {
      brandName: identity.displayName || identity.legalName || 'Unknown',
      industry: identity.industry || 'Unknown',
      subType: identity.businessSubType || 'Unknown',
      country: identity.country || 'Unknown',
      scale: deriveScale(identity),
      searchQueries: queries,
      generatedAt: new Date().toISOString(),
    };

    // Persist results
    await prisma.marketAnalysis.update({
      where: { id: analysisId },
      data: {
        status: 'SUCCEEDED',
        completedAt: new Date(),
        queryContext: queryContext as object,
        marketOverview: synthesis.marketOverview as object,
        competitors: synthesis.competitors as object,
        marketTrends: synthesis.marketTrends as object,
        targetAudience: synthesis.targetAudience as object,
        sources: uniqueSources as object,
      },
    });

    console.log(`[market-intelligence] analysis complete for org=${orgId}, id=${analysisId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[market-intelligence] analysis failed for org=${orgId}: ${message}`);

    await prisma.marketAnalysis.update({
      where: { id: analysisId },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        error: message,
      },
    });

    throw err;
  }
}
