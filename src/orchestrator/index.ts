import { createUIMessageStream, type UIMessage } from 'ai';
import { prisma } from '../prisma.js';
import { DEFAULT_PERSONA, resolveProviderModelId, type Persona } from '../personas.js';
import type { AgentRunnerContext, Evidence, EvidenceTask } from '../agents/router.js';
import { getAnomalyTasks, type AnomalyContext } from '../agents/shopify-analyst/index.js';
import { logAiTokenUsage } from '../ai-token-usage.js';
import { transformOpenAIError, isOpenAIError } from '../openai-errors.js';
import { createChatTrace, createPhaseSpan, endSpan, spanToContext, type LangfuseContext } from '../langfuse-tracing.js';
import type { TokenBreakdownEntry } from '../agents/types.js';

import {
  type FinishInfo,
  type OrchestratorResult,
  type ResourceUsed,
  writeStatus,
} from './types.js';
import {
  loadChatContext,
  buildResourceManifest,
  buildGovernancePrompt,
  filterRestrictedEvidence,
} from './context.js';
import { loadStoreIntelligence } from './store-intelligence.js';
import { runPlanner } from './planner.js';
import { runTasks, runTasksSequentially, runObservation, MAX_EVIDENCE_ROUNDS } from './evidence.js';
import { runSynthesis } from './synthesis.js';
import { extractAndSaveMemory } from './memory.js';

export type { OrchestratorResult, ResourceUsed } from './types.js';

function extractUserText(messages: UIMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  return last.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

// Renders an aggregate (non-anomaly-backed) opportunity into a context block
// for the planner, so it can plan investigation tasks around the opportunity
// instead of only the user's literal question.
function buildOpportunityContextBlock(opportunity: {
  title: string;
  description: string;
  category: string;
  evidence: unknown;
}): string {
  const evidenceList = Array.isArray(opportunity.evidence)
    ? (opportunity.evidence as Array<Record<string, unknown>>)
    : [];
  const evidenceLines = evidenceList
    .map((e) => {
      const label = typeof e.label === 'string' ? e.label : '';
      const value = typeof e.value === 'string' ? e.value : '';
      return label ? `- ${label}${value ? `: ${value}` : ''}` : null;
    })
    .filter((l): l is string => !!l);

  return (
    `\n\nOPPORTUNITY BEING EXPLORED: "${opportunity.title}" (${opportunity.category})\n${opportunity.description}` +
    (evidenceLines.length > 0 ? `\nEvidence:\n${evidenceLines.join('\n')}` : '')
  );
}

export function runOrchestrator(
  messages: UIMessage[],
  userId: string,
  conversationId: string,
  orgId: string,
  persona: Persona = DEFAULT_PERSONA,
  signal?: AbortSignal,
  messageId?: string,
): OrchestratorResult {
  const providerModelId = resolveProviderModelId(persona);

  let resolveFinish!: (v: FinishInfo) => void;
  const finishPromise = new Promise<FinishInfo>((res) => {
    resolveFinish = res;
  });

  let finalized = false;
  let totalInput = 0;
  let totalOutput = 0;
  const tokenBreakdown: TokenBreakdownEntry[] = [];
  let agentCount = 0;

  const finalize = (info: FinishInfo): void => {
    if (finalized) return;
    finalized = true;
    resolveFinish(info);
  };

  const finalizeWithPartial = (finishReason: string): void => {
    finalize({
      text: '',
      inputTokens: totalInput,
      outputTokens: totalOutput,
      finishReason,
      persona,
      providerModelId,
      tokenBreakdown,
      agentCount,
      messageId: messageId ?? '',
      resourcesUsed: [],
    });
  };

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        const userText = extractUserText(messages);
        if (!userText) {
          finalizeWithPartial('error');
          throw new Error('No user question');
        }

        // Create root Langfuse trace for this chat request
        const rootContext = createChatTrace(userId, orgId, conversationId, messageId || '', persona, userText);

        const [user, conv, chatCtx, resourceManifest, storeIntel] = await Promise.all([
          prisma.user.findUnique({
            where: { id: userId },
            select: { memory: true, allowedAccess: true, restrictedAccess: true },
          }),
          prisma.conversation.findUnique({
            where: { id: conversationId },
            select: { memory: true, intent: true },
          }),
          loadChatContext(orgId),
          buildResourceManifest(orgId),
          loadStoreIntelligence(orgId),
        ]);

        const convIntent = (conv?.intent ?? {}) as Record<string, unknown>;
        const linkedOpportunityId = convIntent.opportunityId as string | undefined;
        let anomalyCtx: AnomalyContext | null = null;
        let opportunityContextBlock = '';
        let hasLinkedOpportunity = false;

        if (linkedOpportunityId) {
          const opportunity = await prisma.opportunity.findUnique({
            where: { id: linkedOpportunityId },
            select: { id: true, title: true, description: true, category: true, evidence: true, sourceAnomalyId: true },
          });

          if (opportunity) {
            hasLinkedOpportunity = true;

            if (opportunity.sourceAnomalyId) {
              const anomalyRow = await prisma.insightAnomaly.findUnique({
                where: { id: opportunity.sourceAnomalyId },
                select: {
                  id: true,
                  anomalyDetails: true,
                  job: {
                    select: { insightType: true, sourceId: true, sourceType: true },
                  },
                },
              });

              if (anomalyRow) {
                const details = anomalyRow.anomalyDetails as {
                  zScore: number;
                  mean: number;
                  stdDev: number;
                  actualValue: number;
                  date: string;
                  direction: 'spike' | 'drop';
                };
                anomalyCtx = {
                  anomalyId: anomalyRow.id,
                  insightType: anomalyRow.job.insightType,
                  direction: details.direction,
                  date: details.date,
                  actualValue: details.actualValue,
                  mean: details.mean,
                  stdDev: details.stdDev,
                  zScore: details.zScore,
                  shopifySourceId: anomalyRow.job.sourceType === 'shopify' ? anomalyRow.job.sourceId : null,
                };
              }
            }

            if (!anomalyCtx) {
              opportunityContextBlock = buildOpportunityContextBlock(opportunity);
            }
          }
        }

        const userMemoryEntries = user?.memory ?? [];
        const conversationMemoryEntries = conv?.memory ?? [];
        const { allowedAccess = [], restrictedAccess = [] } = user ?? {};
        const { orgContextBlock, orgSummaryBlock } = chatCtx;

        const userMemoryBlock =
          userMemoryEntries.length > 0
            ? `\n\nUser preferences/context:\n${userMemoryEntries.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
            : '';
        const conversationMemoryBlock =
          conversationMemoryEntries.length > 0
            ? `\n\nThis conversation context:\n${conversationMemoryEntries.map((m, i) => `${i + 1}. ${m}`).join('\n')}`
            : '';
        const memoryBlock = userMemoryBlock + conversationMemoryBlock;
        const governanceBlock = buildGovernancePrompt(allowedAccess, restrictedAccess);

        const userTurns = messages.filter((m) => m.role === 'user').length;
        const isOpportunityFirstTurn = hasLinkedOpportunity && userTurns === 1;
        const isAnomalyBackedFirstTurn = isOpportunityFirstTurn && anomalyCtx !== null;

        let initialTasks: EvidenceTask[];
        let planConfidence: 'high' | 'low' = 'low';

        if (isAnomalyBackedFirstTurn) {
          initialTasks = getAnomalyTasks(anomalyCtx!);
          writeStatus(writer, {
            phase: 'planned',
            subQuestions: initialTasks.map((t) => t.question),
            anomalyMode: true,
          });
        } else {
          const plannerSpan = createPhaseSpan(rootContext, 'planner', { input: userText });
          try {
            const planRes = await runPlanner(
              userText,
              orgSummaryBlock,
              resourceManifest,
              storeIntel.storeSignalsBlock,
              persona,
              providerModelId,
              anomalyCtx,
              opportunityContextBlock,
              governanceBlock,
              userTurns > 1,
              signal,
              writer,
              orgId,
              userId,
              conversationId,
              messageId,
              plannerSpan,
              rootContext,
            );
            initialTasks = planRes.initialTasks;
            planConfidence = planRes.planConfidence;
            totalInput += planRes.inputTokens;
            totalOutput += planRes.outputTokens;
            tokenBreakdown.push({ phase: 'planning', inputTokens: planRes.inputTokens, outputTokens: planRes.outputTokens });
            endSpan(plannerSpan, { taskCount: initialTasks.length, confidence: planConfidence });
          } catch (err) {
            endSpan(plannerSpan, undefined, err as Error);
            throw err;
          }
        }

        let evidences: Evidence[] = [];
        const onTaskEvidence = (evidence: Evidence, task: EvidenceTask): void => {
          agentCount++;
          if (evidence.tokenUsage) {
            tokenBreakdown.push({
              phase: 'evidence',
              agentType: task.agentType,
              question: task.question,
              inputTokens: evidence.tokenUsage.input,
              outputTokens: evidence.tokenUsage.output,
            });
          }
        };

        if (initialTasks.length > 0) {
          writeStatus(writer, { phase: 'investigating' });
          if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

          // Create investigation span to group all agents
          const investigationSpan = createPhaseSpan(rootContext, `investigation-round-${1}`, { input: 'Running agents' });
          const investigationContext = spanToContext(rootContext?.traceId || '', investigationSpan);

          const agentCtx: AgentRunnerContext = {
            orgId,
            orgSummary: orgSummaryBlock,
            providerModelId,
            writer,
            persona,
            usageCtx: { organisationId: orgId, userId, conversationId, messageId },
            signal,
            parentTrace: investigationContext,
            storeBrief: storeIntel.storeBriefBlock,
          };

          const round1 = isAnomalyBackedFirstTurn
            ? await runTasksSequentially(initialTasks, agentCtx, onTaskEvidence)
            : await runTasks(initialTasks, agentCtx, onTaskEvidence);
          evidences = round1;

          const hasFailure = evidences.some((e) => e.source.type === 'unavailable');
          const skipObservation = planConfidence === 'high' || (initialTasks.length <= 1 && !hasFailure);

          for (let round = 2; !isAnomalyBackedFirstTurn && !skipObservation && round <= MAX_EVIDENCE_ROUNDS; round++) {
            if (signal?.aborted) break;

            const obsRes = await runObservation(
              userText,
              evidences,
              orgSummaryBlock,
              resourceManifest,
              persona,
              providerModelId,
              round,
              signal,
              writer,
              orgId,
              userId,
              conversationId,
              messageId,
              rootContext,
            );

            totalInput += obsRes.inputTokens;
            totalOutput += obsRes.outputTokens;
            tokenBreakdown.push({ phase: 'observation', inputTokens: obsRes.inputTokens, outputTokens: obsRes.outputTokens });

            if (obsRes.isComplete || obsRes.additionalTasks.length === 0 || signal?.aborted) break;

            const followUpEvidences = await runTasks(obsRes.additionalTasks, agentCtx, onTaskEvidence);
            evidences = [...evidences, ...followUpEvidences];
          }
        }

        evidences = filterRestrictedEvidence(evidences, restrictedAccess);

        const resourcesUsed: ResourceUsed[] = [];
        const seenResources = new Set<string>();
        for (const e of evidences) {
         if (e.source.type === 'shopify') {
            const key = `shopify:${e.source.id}`;
            if (!seenResources.has(key)) {
              seenResources.add(key);
              resourcesUsed.push({
                type: 'shopify',
                id: e.source.id,
                name: e.source.name,
                shopDomain: e.source.shopDomain,
              });
            }
          } else if (e.source.type === 'research') {
            if (!seenResources.has('research')) {
              seenResources.add('research');
              resourcesUsed.push({ type: 'research' });
            }
          } else if (e.source.type === 'playbook') {
            if (e.source.name) {
              const key = `playbook:${e.source.name}`;
              if (!seenResources.has(key)) {
                seenResources.add(key);
                resourcesUsed.push({ type: 'playbook', name: e.source.name });
              }
            }
          } else if (e.source.type === 'web_search') {
            const existing = resourcesUsed.find(
              (r) => r.type === 'web_search',
            ) as { type: 'web_search'; websites: Array<{ url: string; title: string }> } | undefined;
            if (!existing) {
              seenResources.add('web_search');
              resourcesUsed.push({ type: 'web_search', websites: [...e.source.websites] });
            } else {
              const seenUrls = new Set(existing.websites.map((w) => w.url));
              for (const w of e.source.websites) {
                if (!seenUrls.has(w.url)) {
                  existing.websites.push(w);
                  seenUrls.add(w.url);
                }
              }
            }
          }
        }
        if (resourcesUsed.length > 0) {
          writeStatus(writer, { phase: 'resources-used', resources: resourcesUsed });
        }

        if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');

        // For an aggregate (non-anomaly-backed) opportunity, fold its context
        // into orgContextBlock so synthesis can ground the answer in it even
        // though it takes the generic (non-anomaly) synthesis branch.
        const orgContextBlockForSynthesis =
          isOpportunityFirstTurn && !anomalyCtx ? orgContextBlock + opportunityContextBlock : orgContextBlock;

        const result = await runSynthesis(
          messages,
          evidences,
          persona,
          providerModelId,
          orgContextBlockForSynthesis,
          storeIntel.storeBriefBlock,
          memoryBlock,
          governanceBlock,
          isAnomalyBackedFirstTurn,
          anomalyCtx,
          initialTasks.length,
          signal,
          () => writeStatus(writer, { phase: 'synthesising' }),
          (res) => {
            tokenBreakdown.push({ phase: 'synthesis', inputTokens: res.inputTokens, outputTokens: res.outputTokens });
            logAiTokenUsage({
              organisationId: orgId,
              userId,
              conversationId,
              messageId,
              modelName: providerModelId,
              feature: 'orchestrator',
              operation: 'synthesis',
              usage: res.usage,
              finishReason: res.finishReason,
              latencyMs: res.latencyMs,
              startedAt: new Date(Date.now() - res.latencyMs),
              metadata: { persona, evidenceCount: evidences.length },
            });
            finalize({
              text: res.text,
              inputTokens: totalInput + res.inputTokens,
              outputTokens: totalOutput + res.outputTokens,
              finishReason: res.finishReason,
              persona,
              providerModelId,
              tokenBreakdown,
              agentCount,
              messageId: messageId ?? '',
              resourcesUsed,
            });

            extractAndSaveMemory(
              res.text.slice(0, 400),
              userText,
              userMemoryEntries,
              conversationMemoryEntries,
              userId,
              conversationId,
              orgId,
              messageId,
            ).catch((err) => console.error('[orchestrator] memory update failed', err));
          },
          (error) => {
            const friendly = isOpenAIError(error) ? transformOpenAIError(error) : null;
            if (friendly) {
              console.error('[orchestrator] streamText error:', friendly.type, friendly.message);
            } else {
              console.error('[orchestrator] streamText error', error);
            }
            finalizeWithPartial('error');
          },
          userId,
          conversationId,
          orgId,
          rootContext
        );

        writer.merge(
          result.toUIMessageStream({
            messageMetadata: ({ part }) => {
              if (part.type === 'finish') {
                const synthIn = part.totalUsage?.inputTokens ?? 0;
                const synthOut = part.totalUsage?.outputTokens ?? 0;
                return {
                  messageId,
                  usage: {
                    inputTokens: totalInput + synthIn,
                    outputTokens: totalOutput + synthOut,
                  },
                };
              }
              return undefined;
            },
          }),
        );
      } catch (err) {
        const isAbort = signal?.aborted || (err instanceof DOMException && err.name === 'AbortError');
        if (isAbort) {
          console.error('[orchestrator] error: aborted by client');
          finalizeWithPartial('abort');
        } else {
          const friendly = isOpenAIError(err) ? transformOpenAIError(err) : null;
          if (friendly) {
            console.error('[orchestrator] error:', friendly.type, friendly.message);
            finalizeWithPartial('error');
            throw new Error(friendly.message);
          } else {
            console.error('[orchestrator] error', err);
            finalizeWithPartial('error');
            throw err;
          }
        }
      }
    },
    onError: (err) => {
      const isAbort = signal?.aborted;
      if (isAbort) {
        console.error('[orchestrator] stream error: aborted by client');
        finalizeWithPartial('abort');
        return 'Request cancelled';
      } else {
        const friendly = isOpenAIError(err) ? transformOpenAIError(err) : null;
        if (friendly) {
          console.error('[orchestrator] stream error:', friendly.type, friendly.message);
          finalizeWithPartial('error');
          return friendly.message;
        } else {
          console.error('[orchestrator] stream error', err);
          finalizeWithPartial('error');
          return err instanceof Error ? err.message : 'An error occurred';
        }
      }
    },
  });

  return { stream, finishPromise };
}
