/**
 * Playbook access for the Content Studio
 * =======================================
 * The Playbook table stores reusable SKILL.md-style documents (name +
 * description + markdown content). For content generation these act as
 * creative playbooks the design agent should follow — e.g. "High-converting
 * paid-social hooks", "Brand voice rules", "Discount-offer layouts".
 *
 * Selection is two-phase to keep prompts lean and relevant:
 *   1. We load only each active playbook's name + description (cheap) and ask a
 *      small model which playbooks are relevant to THIS brief.
 *   2. Only the selected playbooks' full `content` is injected into the
 *      generation prompt. A 30-page SKILL.md never reaches the generator unless
 *      it was actually chosen.
 *
 * Best-effort throughout: a DB or LLM failure degrades to "no playbooks" (or,
 * on selection failure, a small recency-ordered fallback) so generation never
 * blocks.
 */

import { generateText } from 'ai';
import { prisma } from '../prisma.js';
import { openaiModel, samplingFor } from '../openai.js';
import { logAiTokenUsage } from '../ai-token-usage.js';

const PLAYBOOK_SELECT_MODEL = process.env.CONTENT_PLAYBOOK_SELECT_MODEL ?? process.env.CONTENT_IDEATION_MODEL ?? 'gpt-4o';

// A playbook as it lives in the catalogue (no content — used for selection).
export type PlaybookSummary = {
  id: string;
  name: string;
  description: string;
};

// A fully-resolved playbook whose content is injected into the prompt.
export type ContentPlaybook = {
  name: string;
  description: string;
  content: string;
};

// Most playbooks we'll ever surface for selection, and how many the selector
// may pick. Selecting too many defeats the purpose of selection.
const MAX_CANDIDATES = 40;
const MAX_SELECTED = 1;

// Content-injection budgets (characters). Applies to the SELECTED playbooks.
const MAX_CHARS_PER_PLAYBOOK = 16000;
const MAX_TOTAL_CHARS = 16000;

/** Phase 1a: load lightweight summaries (no content) of active playbooks. */
export async function fetchPlaybookSummaries(): Promise<PlaybookSummary[]> {
  try {
    return await prisma.playbook.findMany({
      where: { isActive: true, type: 'AD_GEN' },
      select: { id: true, name: true, description: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_CANDIDATES,
    });
  } catch (err) {
    console.warn('[content] playbook summary fetch failed, continuing without playbooks:', err);
    return [];
  }
}

/** Phase 2: load the full content for the chosen playbook ids, preserving order. */
async function fetchPlaybookContent(ids: string[]): Promise<ContentPlaybook[]> {
  if (ids.length === 0) return [];
  try {
    const rows = await prisma.playbook.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, description: true, content: true },
    });
    // Preserve the selector's ordering (findMany order is not guaranteed).
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => r != null)
      .map((r) => ({ name: r.name, description: r.description, content: r.content }));
  } catch (err) {
    console.warn('[content] playbook content fetch failed, continuing without playbooks:', err);
    return [];
  }
}

/**
 * Phase 1b: ask a small model which playbooks fit this brief. The model only
 * ever sees names + descriptions, never content. Returns the chosen ids in
 * priority order. Falls back to the top-N most recent on any failure.
 */
async function selectPlaybookIds(
  candidates: PlaybookSummary[],
  brief: string,
  platform: string,
  orgId: string,
  extraInstructions?: string | null,
): Promise<string[]> {
  if (candidates.length === 0) return [];
  // Nothing to choose from / few enough that selection is moot.
  if (candidates.length <= MAX_SELECTED) return candidates.map((c) => c.id);

  const catalogue = candidates
    .map((c, i) => `${i + 1}. id=${c.id} | ${c.name} — ${c.description}`)
    .join('\n');

  const extraHint = extraInstructions ? `\nAdditional direction: ${extraInstructions}` : '';

  const startedAt = new Date();
  try {
    const result = await generateText({
      model: openaiModel(PLAYBOOK_SELECT_MODEL),
      system:
        'You are a creative director choosing which of the brand\'s creative playbooks apply to a specific content brief. ' +
        'You see only each playbook\'s name and description. Pick ONLY the playbooks genuinely relevant to this brief and platform — ' +
        'fewer, well-matched playbooks beat many loosely-related ones. It is valid to pick none. ' +
        'Return ONLY a JSON array of the chosen playbook id strings, in priority order, no prose, no code fences.',
      prompt: `Content brief (platform: ${platform}):\n${brief}${extraHint}\n\nAvailable playbooks:\n${catalogue}\n\nReturn ONLY a JSON array of up to ${MAX_SELECTED} playbook id strings (the most relevant first). If none fit, return [].`,
      ...samplingFor(PLAYBOOK_SELECT_MODEL, 0.2),
      maxOutputTokens: 300,
    });

    logAiTokenUsage({
      organisationId: orgId,
      modelName: PLAYBOOK_SELECT_MODEL,
      feature: 'content-studio',
      agentName: 'content-generator',
      operation: 'select-playbooks',
      usage: result.usage,
      finishReason: result.finishReason,
      latencyMs: Date.now() - startedAt.getTime(),
      startedAt,
      metadata: { candidateCount: candidates.length },
    });

    const validIds = new Set(candidates.map((c) => c.id));
    const ids = parseSelectedIds(result.text, validIds);
    if (ids) return ids.slice(0, MAX_SELECTED);
    console.warn('[content] playbook selection returned unparseable output, falling back to recency');
  } catch (err) {
    console.warn('[content] playbook selection failed, falling back to recency:', err);
  }

  // Fallback: the most recently updated few (candidates are already recency-ordered).
  return candidates.slice(0, MAX_SELECTED).map((c) => c.id);
}

function parseSelectedIds(raw: string, validIds: Set<string>): string[] | null {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)```\s*$/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    // Keep only known ids, de-duplicated, in the model's order. Empty is valid.
    const seen = new Set<string>();
    const ids = parsed
      .map((v) => String(v).trim())
      .filter((id) => validIds.has(id) && !seen.has(id) && (seen.add(id), true));
    return ids;
  } catch {
    return null;
  }
}

/**
 * Phase 1+2 orchestration: pick the relevant playbooks for this brief, then
 * load only their content. This is what the runner calls.
 */
export async function resolvePlaybooksForBrief(
  brief: string,
  platform: string,
  orgId: string,
  extraInstructions?: string | null,
): Promise<ContentPlaybook[]> {
  const candidates = await fetchPlaybookSummaries();
  if (candidates.length === 0) {
    console.log('[content:playbooks] no active playbooks found — generating without playbook guidance');
    return [];
  }

  const ids = await selectPlaybookIds(candidates, brief, platform, orgId, extraInstructions);

  if (ids.length === 0) {
    console.log(`[content:playbooks] selector reviewed ${candidates.length} playbook(s) and chose none for this brief`);
    return [];
  }

  // Log the names of selected playbooks before fetching content, so we can see
  // what was chosen even if the content fetch fails.
  const summaryMap = new Map(candidates.map((c) => [c.id, c.name]));
  const selectedNames = ids.map((id) => summaryMap.get(id) ?? id);
  console.log(
    `[content:playbooks] selected ${ids.length}/${candidates.length} playbook(s): ${selectedNames.map((n) => `"${n}"`).join(', ')}`,
  );

  const playbooks = await fetchPlaybookContent(ids);

  if (playbooks.length !== ids.length) {
    const loadedNames = playbooks.map((p) => `"${p.name}"`).join(', ');
    console.warn(`[content:playbooks] content fetch returned ${playbooks.length}/${ids.length} playbook(s) — injecting: ${loadedNames || 'none'}`);
  }

  return playbooks;
}

/**
 * Render the selected playbooks into a prompt section. Each is presented as a
 * named skill with its description and (budget-capped) content.
 */
export function formatPlaybooksForPrompt(playbooks: ContentPlaybook[]): string {
  if (playbooks.length === 0) return '';

  let total = 0;
  const blocks: string[] = [];

  for (const pb of playbooks) {
    if (total >= MAX_TOTAL_CHARS) break;
    const remaining = MAX_TOTAL_CHARS - total;
    const budget = Math.min(MAX_CHARS_PER_PLAYBOOK, remaining);
    const content =
      pb.content.length > budget ? `${pb.content.slice(0, budget)}…` : pb.content;
    total += content.length;

    blocks.push(`### Playbook: ${pb.name}\n${pb.description}\n\n${content}`);
  }

  return [
    'CREATIVE PLAYBOOKS (the brand\'s house rules — follow these over generic best-practice):',
    'These playbooks were selected as relevant to this brief. Where a playbook gives a concrete rule',
    '(a hook formula, a layout pattern, copy do/don\'ts), follow it. Where playbooks conflict',
    'with the brief or brand tokens, the brief and brand tokens win.',
    '',
    blocks.join('\n\n---\n\n'),
  ].join('\n');
}
