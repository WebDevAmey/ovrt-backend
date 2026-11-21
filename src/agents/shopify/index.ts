/**
 * Shopify Agent
 * =============
 * Invoked by the router when the planner decides a question needs live Shopify store data.
 *
 * Flow:
 *   1. Resolve the target ShopifyIntegration row (sourceId on the task, or
 *      the org's first active store).
 *   2. Decrypt the OAuth access token and build a connection object (URL,
 *      version, identity hints).
 *   3. Build a system prompt with shop identity, the tool inventory and
 *      Shopify search-query syntax cheatsheet, persona lens, and anti-
 *      hallucination rules.
 *   4. Run generateText with twelve tools:
 *        - getOrdersSummary, getOrdersTimeSeries, getTopProductsBySales (sales KPIs)
 *        - getCustomerRetentionStats (loyalty / LTV)
 *        - getInventoryLevels, getFulfillmentSummary (operations)
 *        - getDiscountPerformance, getRefundAnalysis (health metrics)
 *        - listOrders, listProducts, listCustomers (record retrieval)
 *        - getShopOverview (context)
 *      Up to MAX_TOOL_STEPS rounds.
 *   5. Return an Evidence object with source.type='shopify'.
 *
 * Read-only by contract: every helper only ever sends `query` operations,
 * and the GraphQL transport rejects any string containing "mutation".
 *
 * NOTE on caching: the previous ShopifyQL-shaped question-hash cache (DIA
 * pattern) was removed in this iteration. The new tool surface is function-
 * call shaped (typed args), not query-string shaped, so the cache key needs
 * a different format — deferred to a follow-up pass.
 */

import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import type { UIMessageStreamWriter } from 'ai';
import { openaiModel, isReasoningModel, maxTokensFor } from '../../openai.js';
import { prisma } from '../../prisma.js';
import type { Persona } from '../../personas.js';
import {
  readTokens,
  writeAgentStatus,
  type Evidence,
  type EvidenceTask,
  type AiUsageContext,
  type AgentRunnerContext,
  type AgentDefinition,
} from '../types.js';
import { createAgentSpan, createGenerationSpan, endGenerationSpan, endSpan, type LangfuseContext } from '../../langfuse-tracing.js';
import { logAiTokenUsage } from '../../ai-token-usage.js';
import { resolveShopifyConnection, type ShopifyConnectInfo } from './credentials.js';
import { shopifyGraphQL, ShopifyGraphQLError } from './graphql.js';
import { shopifySystemPrompt } from './prompts.js';
import {
  getShopOverview,
  getOrdersSummary,
  getOrdersTimeSeries,
  getTopProductsBySales,
  getInventoryLevels,
  getCustomerRetentionStats,
  getDiscountPerformance,
  getFulfillmentSummary,
  getRefundAnalysis,
  listOrders,
  listProducts,
  listCustomers,
} from './functions.js';

const MAX_TOOL_STEPS = Number(process.env.SHOPIFY_MAX_STEPS ?? '6');

// ── Integration loader ───────────────────────────────────────────────────────

type IntegrationLite = {
  id: string;
  name: string;
  shopDomain: string;
};

async function loadIntegration(
  integrationId: string | null | undefined,
  orgId: string,
): Promise<IntegrationLite | null> {
  if (integrationId) {
    const row = await prisma.shopifyIntegration.findFirst({
      where: { id: integrationId, organisationId: orgId },
      select: { id: true, name: true, shopDomain: true },
    });
    if (row) return row;
  }
  return prisma.shopifyIntegration.findFirst({
    where: { organisationId: orgId, status: 'ACTIVE' },
    select: { id: true, name: true, shopDomain: true },
    orderBy: { createdAt: 'asc' },
  });
}


// ── Tool input schemas ───────────────────────────────────────────────────────

const overviewSchema = z.object({
  rationale: z.string().describe('One sentence: why you need the store snapshot.'),
});

const ordersSummarySchema = z.object({
  since: z.string().describe('Start of window, YYYY-MM-DD (inclusive).'),
  until: z.string().nullable().optional().describe('End of window, YYYY-MM-DD. Defaults to today.'),
  financialStatus: z
    .string()
    .nullable()
    .optional()
    .describe('Optional Shopify financial_status filter, e.g. "paid", "refunded", "pending".'),
  rationale: z.string().describe('One sentence: what this aggregate tells us.'),
});

const ordersTimeSeriesSchema = z.object({
  since: z.string(),
  until: z.string().nullable().optional(),
  granularity: z.enum(['day', 'week', 'month']),
  rationale: z.string(),
});

const topProductsSchema = z.object({
  since: z.string(),
  until: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(50).nullable().optional().describe('Default 10, max 50.'),
  rationale: z.string(),
});

const listOrdersSchema = z.object({
  query: z.string().nullable().optional().describe('Shopify order search syntax.'),
  limit: z.number().int().min(1).max(100).nullable().optional(),
  rationale: z.string(),
});

const listProductsSchema = z.object({
  query: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(100).nullable().optional(),
  rationale: z.string(),
});

const listCustomersSchema = z.object({
  query: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(100).nullable().optional(),
  rationale: z.string(),
});

const inventoryLevelsSchema = z.object({
  lowStockThreshold: z
    .number()
    .int()
    .min(0)
    .nullable()
    .optional()
    .describe('Flag variants with available qty below this as LOW_STOCK. Default 10.'),
  rationale: z.string(),
});

const customerRetentionSchema = z.object({
  since: z
    .string()
    .nullable()
    .optional()
    .describe('Filter to customers created on or after this date (YYYY-MM-DD). Omit for all-time.'),
  until: z.string().nullable().optional(),
  rationale: z.string(),
});

const discountPerformanceSchema = z.object({
  since: z.string().describe('Start of window, YYYY-MM-DD.'),
  until: z.string().nullable().optional(),
  rationale: z.string(),
});

const fulfillmentSummarySchema = z.object({
  since: z
    .string()
    .nullable()
    .optional()
    .describe('Only include orders created on or after this date. Default: 30 days ago.'),
  rationale: z.string(),
});

const refundAnalysisSchema = z.object({
  since: z.string().describe('Start of window, YYYY-MM-DD.'),
  until: z.string().nullable().optional(),
  rationale: z.string(),
});

const rawQuerySchema = z.object({
  query: z
    .string()
    .describe('A read-only GraphQL query string. Mutations are blocked at the transport.'),
  variables: z
    .record(z.string(), z.unknown())
    .nullable()
    .optional()
    .describe('Query variables as a JSON object. Use for $first, $after, $q pagination args.'),
  rationale: z.string().describe('One sentence: what data this query retrieves.'),
});

// ── Main agent ───────────────────────────────────────────────────────────────

export async function runShopifyAgent(
  task: EvidenceTask,
  ctx: AgentRunnerContext,
): Promise<Evidence> {
  const { orgId, orgSummary, providerModelId, writer, persona, usageCtx, signal, parentTrace, storeBrief } = ctx;
  const shopifyModelId = process.env.SHOPIFY_MODEL ?? providerModelId;

  // Create Langfuse agent span
  const agentSpan = createAgentSpan(parentTrace || null, 'shopify', task.question, { persona });

  // Create Langfuse generation span for LLM call (nested under agent span)
  const generationSpan = createGenerationSpan(parentTrace || null, 'shopify-generateText', shopifyModelId, {
    input: task.question,
  });

  const emit = (phase: string, data?: Record<string, unknown>) =>
    writeAgentStatus(writer, { phase, ...data });

  const integration = await loadIntegration(task.sourceId, orgId);
  if (!integration) {
    return {
      question: task.question,
      source: { type: 'unavailable' },
      records: [],
      summary: 'No active Shopify integration found for this organisation.',
    };
  }

  let conn: ShopifyConnectInfo;
  try {
    conn = await resolveShopifyConnection(integration.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Shopify] credential resolution failed', { integrationId: integration.id, err: msg });
    return {
      question: task.question,
      source: {
        type: 'shopify',
        id: integration.id,
        name: integration.name,
        shopDomain: integration.shopDomain,
      },
      records: [],
      summary: `Cannot connect to Shopify store "${integration.name}": ${msg}`,
    };
  }

  emit('shopify-store-loaded', {
    name: integration.name,
    shopDomain: integration.shopDomain,
    currency: conn.currency,
    plan: conn.planName,
  });

  type Collected = {
    label: string;
    rows: Array<Record<string, unknown>>;
    rowCount: number;
  };
  const collectedRecords: Collected[] = [];
  let callIndex = 0;

  // Reusable wrapper for tool execution — keeps every tool's emit/collect/error
  // path identical. Returns the result for the LLM or an { error } object.
  function runTool<TInput, TResult extends { rowCount: number; columns: string[]; rows: Array<Record<string, unknown>>; truncated?: boolean }>(
    name: string,
    label: (input: TInput) => string,
    impl: (input: TInput) => Promise<TResult>,
  ) {
    return async (input: TInput & { rationale: string }) => {
      const idx = ++callIndex;
      emit('shopify-query-running', { tool: name, rationale: input.rationale, callIndex: idx });
      try {
        const result = await impl(input);
        collectedRecords.push({
          label: label(input),
          rows: result.rows,
          rowCount: result.rowCount,
        });
        emit('shopify-query-done', {
          tool: name,
          rowCount: result.rowCount,
          columns: result.columns,
          truncated: result.truncated ?? false,
          callIndex: idx,
        });
        return {
          rowCount: result.rowCount,
          columns: result.columns,
          rows: result.rows.slice(0, 50),
          truncated: result.truncated ?? false,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Shopify] ${name} failed`, { err: msg });
        emit('shopify-query-error', { tool: name, error: msg, callIndex: idx });
        return { error: msg };
      }
    };
  }

  const reasoning = isReasoningModel(shopifyModelId);

  const shopifyStartedAt = new Date();
  const shopifyResult = await generateText({
    model: openaiModel(shopifyModelId),
    system: shopifySystemPrompt(conn, orgSummary, persona, storeBrief),
    prompt: `Answer this Shopify business question using live store data:\n"${task.question}"\n\nPlan your tool calls carefully. For any metric, also retrieve the prior-period equivalent so period-over-period comparison is possible. Run independent calls in parallel. After collecting results, write a clear, business-focused evidence summary with exact numbers and trend context.`,
    tools: {
      getShopOverview: tool({
        description: 'One-row store snapshot: name, currency, plan, total products/orders/customers.',
        inputSchema: overviewSchema,
        execute: runTool(
          'getShopOverview',
          () => 'Shop overview',
          () => getShopOverview(conn),
        ),
      }),
      getOrdersSummary: tool({
        description: 'Aggregate orders for a window: orderCount, totalSales, discounts, AOV, uniqueCustomers. For revenue/count questions; call twice for trends.',
        inputSchema: ordersSummarySchema,
        execute: runTool(
          'getOrdersSummary',
          (input) =>
            `Orders summary ${input.since} → ${input.until ?? 'today'}${input.financialStatus ? ` (${input.financialStatus})` : ''}`,
          (input) =>
            getOrdersSummary(conn, {
              since: input.since,
              until: input.until ?? null,
              financialStatus: input.financialStatus ?? null,
            }),
        ),
      }),
      getOrdersTimeSeries: tool({
        description: 'Orders bucketed by day/week/month. For trend or "X over time" questions. Keep bucket count under ~30.',
        inputSchema: ordersTimeSeriesSchema,
        execute: runTool(
          'getOrdersTimeSeries',
          (input) =>
            `Orders ${input.granularity}-series ${input.since} → ${input.until ?? 'today'}`,
          (input) =>
            getOrdersTimeSeries(conn, {
              since: input.since,
              until: input.until ?? null,
              granularity: input.granularity,
            }),
        ),
      }),
      getTopProductsBySales: tool({
        description: 'Top-N products by revenue with units sold. For "top products" / "best sellers" questions. Default 10, max 50.',
        inputSchema: topProductsSchema,
        execute: runTool(
          'getTopProductsBySales',
          (input) =>
            `Top ${input.limit ?? 10} products ${input.since} → ${input.until ?? 'today'}`,
          (input) =>
            getTopProductsBySales(conn, {
              since: input.since,
              until: input.until ?? null,
              limit: input.limit ?? undefined,
            }),
        ),
      }),
      listOrders: tool({
        description:
          'Real order objects (max 100). Use ONLY when the user wants to see specific orders. ' +
          'For aggregates use getOrdersSummary.',
        inputSchema: listOrdersSchema,
        execute: runTool(
          'listOrders',
          (input) => `Orders matching "${input.query ?? 'all'}"`,
          (input) =>
            listOrders(conn, {
              query: input.query ?? undefined,
              limit: input.limit ?? undefined,
            }),
        ),
      }),
      listProducts: tool({
        description:
          'Real product objects with variants/inventory (max 100). Use ONLY for specific product lookups.',
        inputSchema: listProductsSchema,
        execute: runTool(
          'listProducts',
          (input) => `Products matching "${input.query ?? 'all'}"`,
          (input) =>
            listProducts(conn, {
              query: input.query ?? undefined,
              limit: input.limit ?? undefined,
            }),
        ),
      }),
      listCustomers: tool({
        description:
          'Real customer objects with order summary (max 100). Use ONLY for specific customer lookups.',
        inputSchema: listCustomersSchema,
        execute: runTool(
          'listCustomers',
          (input) => `Customers matching "${input.query ?? 'all'}"`,
          (input) =>
            listCustomers(conn, {
              query: input.query ?? undefined,
              limit: input.limit ?? undefined,
            }),
        ),
      }),
      getInventoryLevels: tool({
        description: 'Variants across locations with qty and OUT_OF_STOCK/LOW_STOCK/OK status. For inventory health/stock alerts. Default threshold: 10 units.',
        inputSchema: inventoryLevelsSchema,
        execute: runTool(
          'getInventoryLevels',
          (input) => `Inventory levels (threshold: ${input.lowStockThreshold ?? 10})`,
          (input) => getInventoryLevels(conn, { lowStockThreshold: input.lowStockThreshold ?? undefined }),
        ),
      }),
      getCustomerRetentionStats: tool({
        description: 'New vs returning split, repeat purchase rate (%), avg LTV, avg orders/customer. For loyalty/retention questions.',
        inputSchema: customerRetentionSchema,
        execute: runTool(
          'getCustomerRetentionStats',
          (input) => `Customer retention ${input.since ?? 'all time'} → ${input.until ?? 'now'}`,
          (input) =>
            getCustomerRetentionStats(conn, {
              since: input.since ?? null,
              until: input.until ?? null,
            }),
        ),
      }),
      getDiscountPerformance: tool({
        description: 'Discount uptake rate, total given, per-code breakdown (timesUsed, revenue, avgDiscount). For coupon/discount effectiveness questions.',
        inputSchema: discountPerformanceSchema,
        execute: runTool(
          'getDiscountPerformance',
          (input) => `Discount performance ${input.since} → ${input.until ?? 'today'}`,
          (input) =>
            getDiscountPerformance(conn, {
              since: input.since,
              until: input.until ?? null,
            }),
        ),
      }),
      getFulfillmentSummary: tool({
        description: 'Unfulfilled orders oldest-first with item list, days waiting, destination. For fulfillment backlog/aging questions.',
        inputSchema: fulfillmentSummarySchema,
        execute: runTool(
          'getFulfillmentSummary',
          (input) => `Unfulfilled orders since ${input.since ?? '30 days ago'}`,
          (input) => getFulfillmentSummary(conn, { since: input.since ?? null }),
        ),
      }),
      getRefundAnalysis: tool({
        description: 'Refund rate (% of orders), total refunded, % of revenue, top refunded products. For return/refund analysis.',
        inputSchema: refundAnalysisSchema,
        execute: runTool(
          'getRefundAnalysis',
          (input) => `Refund analysis ${input.since} → ${input.until ?? 'today'}`,
          (input) =>
            getRefundAnalysis(conn, {
              since: input.since,
              until: input.until ?? null,
            }),
        ),
      }),
      shopifyRawQuery: tool({
        description: 'Custom read-only Admin GraphQL query. For variant-level breakdowns or filters not covered by other tools. Paginate with `after` cursor.',
        inputSchema: rawQuerySchema,
        execute: async (input) => {
          const idx = ++callIndex;
          emit('shopify-query-running', {
            tool: 'shopifyRawQuery',
            rationale: input.rationale,
            callIndex: idx,
          });
          try {
            const result = await shopifyGraphQL<Record<string, unknown>>(
              conn,
              input.query,
              (input.variables as Record<string, unknown>) ?? {},
            );
            collectedRecords.push({
              label: input.rationale,
              rows: [{ data: JSON.stringify(result) }],
              rowCount: 1,
            });
            emit('shopify-query-done', { tool: 'shopifyRawQuery', rowCount: 1, callIndex: idx });
            return { data: result };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn('[Shopify] shopifyRawQuery failed', { err: msg });
            emit('shopify-query-error', { tool: 'shopifyRawQuery', error: msg, callIndex: idx });
            return { error: msg };
          }
        },
      }),
    },
    stopWhen: stepCountIs(task.maxSteps ?? MAX_TOOL_STEPS),
    maxOutputTokens: maxTokensFor(shopifyModelId, 2048),
    ...(reasoning ? {} : { temperature: 0.1 }),
    ...(reasoning
      ? { providerOptions: { openai: { reasoningEffort: 'low' as const } } }
      : {}),
    abortSignal: signal,
  });

  const { text, usage, finishReason } = shopifyResult;

  logAiTokenUsage({
    ...usageCtx,
    modelName: shopifyModelId,
    feature: 'shopify',
    agentName: 'shopify',
    operation: 'answer',
    usage,
    finishReason: shopifyResult.finishReason,
    latencyMs: Date.now() - shopifyStartedAt.getTime(),
    startedAt: shopifyStartedAt,
    toolCallCount: callIndex,
    metadata: { persona, question: task.question, integrationId: integration.id },
  });

  // Hard guard: if no tool call returned data, suppress LLM text so the
  // synthesiser cannot consume hallucinated numbers as live evidence.
  if (collectedRecords.length === 0) {
    console.warn('[Shopify] all tool calls failed — suppressing LLM summary', {
      integrationId: integration.id,
      question: task.question,
    });
    return {
      question: task.question,
      source: { type: 'unavailable' },
      records: [],
      summary:
        `Live data unavailable: all Shopify calls against "${integration.name}" failed. ` +
        `Do not estimate or fabricate a value — tell the user the data could not be retrieved.`,
    };
  }

  const records = collectedRecords.map((r) => ({
    label: r.label,
    rowCount: r.rowCount,
    rows: r.rows,
  }));

  const t = readTokens(usage);
  const latencyMs = Date.now() - shopifyStartedAt.getTime();

  // End Langfuse generation span with token usage
  endGenerationSpan(generationSpan, text.substring(0, 500), {
    inputTokens: t.input,
    outputTokens: t.output,
  }, finishReason);

  // End agent span
  endSpan(agentSpan, { summary: text.substring(0, 200) });

  return {
    question: task.question,
    source: {
      type: 'shopify',
      id: integration.id,
      name: integration.name,
      shopDomain: integration.shopDomain,
    },
    records,
    summary: text,
    tokenUsage: { input: t.input, output: t.output },
  };
}

export const shopifyAgentDef: AgentDefinition = {
  type: 'shopify',
  manifestLine: '[shopify] — queries a live Shopify store (sales, orders, products, customers, inventory) via ShopifyQL + Admin GraphQL:',
  requiresDbSource: true,
  routingRule: 'SHOPIFY: agentType="shopify" — any question about the org\'s Shopify store: sales, revenue, orders, products, customers, inventory, top SKUs, AOV, retention, refunds. Set sourceId to the shopify sourceId.',
  run: runShopifyAgent,
};

export { ShopifyGraphQLError };
