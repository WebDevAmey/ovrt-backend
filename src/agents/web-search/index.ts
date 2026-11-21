/**
 * Web Search Agent
 * ================
 * Provides real-time internet search for competitor intelligence, market trends,
 * current pricing, and recent external events using OpenAI's search-enabled models.
 *
 * Follows OpenAI's official web search documentation:
 * https://platform.openai.com/docs/guides/web-search
 *
 * Supports two paths:
 * 1. Search models (gpt-5-search-api, gpt-4o-search-preview) - built-in web search
 * 2. Reasoning models (gpt-5, gpt-4o) - can perform searches via instructions
 *
 * Key features:
 * - Multi-model fallback strategy for API reliability
 * - Automatic source citation extraction
 * - Graceful degradation if web search unavailable
 * - Detailed error logging for debugging
 *
 * Examples:
 *   - "What is Notion's current pricing?"
 *   - "What are the latest trends in B2B SaaS churn?"
 *   - "How does [competitor] compare to us?"
 */

import { generateText, Output } from 'ai';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { openaiModel, samplingFor, reasoningOpts, maxTokensFor } from '../../openai.js';
import {
  writeAgentStatus,
  type Evidence,
  type EvidenceTask,
  type AiUsageContext,
  type AgentRunnerContext,
  type AgentDefinition,
} from '../types.js';
import { createAgentSpan, createGenerationSpan, endGenerationSpan, endSpan, type LangfuseContext } from '../../langfuse-tracing.js';
import { logAiTokenUsage } from '../../ai-token-usage.js';
import { queryPlanSystemPrompt, webSearchSystemPrompt } from './prompts.js';
import type { UIMessageStreamWriter } from 'ai';
import type { Persona } from '../../personas.js';

// Primary model: gpt-5-search-api (built-in web search)
// Fallbacks if unavailable: gpt-4o-search-preview, then gpt-5/gpt-4o with search instructions
const WEB_SEARCH_MODEL = process.env.WEB_SEARCH_MODEL || 'gpt-5-search-api';
const MAX_QUERIES = Number(process.env.WEB_SEARCH_MAX_QUERIES || '5');

// Model fallback chain for reliability
const SEARCH_MODEL_CHAIN = [
  WEB_SEARCH_MODEL,
  'gpt-5-search-api',
  'gpt-4o-search-preview',
  'gpt-5',
  'gpt-4o',
];

type WebsiteAnnotation = {
  url: string;
  title: string;
};

const queryPlanSchema = z.object({
  queries: z
    .array(z.string().min(5).describe('A specific, focused search query'))
    .min(1)
    .max(5)
    .describe('1-5 focused search queries to answer the question'),
});

interface SearchResult {
  query: string;
  facts: string;
  websites: WebsiteAnnotation[];
  tokenUsage: { input: number; output: number };
}

async function planSearchQueries(
  question: string,
  usageCtx: AiUsageContext,
): Promise<string[]> {
  const planModelId = process.env.WEB_SEARCH_PLAN_MODEL ?? 'gpt-4o-mini';
  const startedAt = new Date();
  const planResult = await generateText({
    model: openaiModel(planModelId),
    output: Output.object({ schema: queryPlanSchema }),
    system: queryPlanSystemPrompt(),
    prompt: `Question: "${question}"\n\nReturn focused search queries that together answer this question.`,
    ...samplingFor(planModelId, 0),
    ...reasoningOpts(planModelId, 'minimal'),
    maxOutputTokens: maxTokensFor(planModelId, 256),
  });

  logAiTokenUsage({
    ...usageCtx,
    modelName: planModelId,
    feature: 'web-search',
    agentName: 'web-search',
    operation: 'plan-queries',
    usage: planResult.usage,
    finishReason: planResult.finishReason,
    latencyMs: Date.now() - startedAt.getTime(),
    startedAt,
  });

  return planResult.output.queries;
}

async function executeWebSearch(query: string, usageCtx: AiUsageContext): Promise<SearchResult> {
  const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  let lastError: Error | null = null;

  // Try models in fallback order for reliability
  for (const modelId of SEARCH_MODEL_CHAIN) {
    try {
      const model = openai(modelId);

      const isSearchModel = modelId.includes('search');
      const searchStartedAt = new Date();
      const { text, usage, finishReason } = await generateText({
        model,
        system: webSearchSystemPrompt(isSearchModel),
        prompt: query,
        maxOutputTokens: 800,
      });

      logAiTokenUsage({
        ...usageCtx,
        modelName: modelId,
        feature: 'web-search',
        agentName: 'web-search',
        operation: 'search',
        usage,
        finishReason,
        latencyMs: Date.now() - searchStartedAt.getTime(),
        startedAt: searchStartedAt,
        metadata: { query },
      });

      // Extract websites from citation patterns in the facts text
      const websites: WebsiteAnnotation[] = [];
      const seenUrls = new Set<string>();

      const patterns = [
        /\((?:from|source):\s*([^\)]+)\)/gi, // (from: domain.com) or (source: domain.com)
        /\[([a-zA-Z0-9\.\-]+\.[a-zA-Z]{2,})\]/g, // [domain.com]
      ];

      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text)) !== null) {
          let domain = match[1].trim();
          // Clean up domain
          domain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');

          let url = domain;
          if (!domain.startsWith('http')) {
            url = `https://${domain}`;
          }

          if (!seenUrls.has(url)) {
            seenUrls.add(url);
            websites.push({ url, title: domain });
          }
        }
      }

      return {
        query,
        facts: text,
        websites,
        tokenUsage: {
          input: usage?.inputTokens ?? 0,
          output: usage?.outputTokens ?? 0,
        },
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[web-search] model "${modelId}" failed: ${lastError.message}. Trying next model...`,
      );
      // Continue to next model in chain
    }
  }

  // All models exhausted
  throw lastError || new Error('All web search models failed');
}

export async function runWebSearchAgent(
  task: EvidenceTask,
  ctx: AgentRunnerContext,
): Promise<Evidence> {
  const { writer, persona, usageCtx, signal, parentTrace } = ctx;

  // Create Langfuse agent and generation spans
  const agentSpan = createAgentSpan(parentTrace || null, 'web-search', task.question, { persona });
  const generationSpan = createGenerationSpan(parentTrace || null, 'web-search-generateText', 'web-search-api', {
    input: task.question,
  });

  writeAgentStatus(writer, { phase: 'web-search-planning', question: task.question });

  try {
    // Phase 1: Plan sub-queries
    const queries = await planSearchQueries(task.question, usageCtx);
    const cappedQueries = queries.slice(0, MAX_QUERIES);

    writeAgentStatus(writer, {
      phase: 'web-search-running',
      question: task.question,
      queryCount: cappedQueries.length,
      modelChain: SEARCH_MODEL_CHAIN,
    });

    // Phase 2: Execute searches in parallel
    const searchResults = await Promise.all(
      cappedQueries.map(q => {
        if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
        return executeWebSearch(q, usageCtx);
      }),
    );

    // Phase 3: Collect and deduplicate facts + websites
    const facts = searchResults.map(r => r.facts).filter(f => f.length > 0).join('\n\n');

    const allWebsites = searchResults.flatMap(r => r.websites);
    const seenUrls = new Set<string>();
    const uniqueWebsites: WebsiteAnnotation[] = [];

    for (const w of allWebsites) {
      if (!seenUrls.has(w.url)) {
        seenUrls.add(w.url);
        uniqueWebsites.push(w);
      }
    }

    // Sum token usage across all searches
    const totalTokenUsage = searchResults.reduce(
      (acc, r) => ({
        input: acc.input + r.tokenUsage.input,
        output: acc.output + r.tokenUsage.output,
      }),
      { input: 0, output: 0 },
    );

    writeAgentStatus(writer, {
      phase: 'web-search-done',
      question: task.question,
      websiteCount: uniqueWebsites.length,
      totalTokensUsed: totalTokenUsage.input + totalTokenUsage.output,
    });

    // End Langfuse spans
    endGenerationSpan(generationSpan, (facts || '(No facts retrieved)').substring(0, 500), {
      inputTokens: totalTokenUsage.input,
      outputTokens: totalTokenUsage.output,
    }, 'success');

    endSpan(agentSpan, { websiteCount: uniqueWebsites.length });

    return {
      question: task.question,
      source: { type: 'web_search', websites: uniqueWebsites },
      records: [],
      summary: facts || '(No facts retrieved from web search)',
      tokenUsage: totalTokenUsage,
    };
  } catch (err) {
    if (signal?.aborted) throw err;

    const msg = err instanceof Error ? err.message : String(err);
    const errorDetails = {
      question: task.question,
      modelChain: SEARCH_MODEL_CHAIN,
      error: msg,
      timestamp: new Date().toISOString(),
    };

    console.error('[web-search] agent error:', JSON.stringify(errorDetails, null, 2));

    // Return informative error message with troubleshooting suggestions
    let errorMsg = `Web search unavailable: ${msg}`;
    if (msg.includes('401') || msg.includes('401')) {
      errorMsg =
        'API authentication failed. Check OPENAI_API_KEY is set correctly. ' +
        'Ensure the key has access to web search models.';
    } else if (msg.includes('429')) {
      errorMsg = 'Rate limited. Web search quota exceeded. Try again shortly.';
    } else if (msg.includes('model') || msg.includes('not found')) {
      errorMsg =
        'No web search models available. Configured models: ' +
        SEARCH_MODEL_CHAIN.join(', ') +
        '. Verify your API key has access to these models.';
    }

    // End spans on error
    endSpan(agentSpan, undefined, new Error(errorMsg));
    return {
      question: task.question,
      source: { type: 'unavailable' },
      records: [],
      summary: errorMsg,
    };
  }
}

export const webSearchAgentDef: AgentDefinition = {
  type: 'web_search',
  manifestLine: '[web_search] — real-time internet search for competitor pricing/products, current market trends, industry news, and recent external events. Use sparingly.',
  requiresDbSource: false,
  routingRule: 'WEB_SEARCH: agentType="web_search" — ONLY for real-time external data (competitor pricing, market news from past 12 months). NOT for org metrics or general frameworks. sourceId=null.',
  run: runWebSearchAgent,
};
