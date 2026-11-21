import { prisma } from '../prisma.js';
import { AGENT_REGISTRY } from '../agents/registry.js';
import type { Evidence } from '../agents/router.js';

export const PLANNER_CONTEXT_CHAR_CAP = 4000;

export type ChatContext = {
  orgContextBlock: string;
  orgSummaryBlock: string;
};

export async function loadChatContext(orgId: string): Promise<ChatContext> {
  try {
    const [org] = await Promise.all([
      prisma.organisation.findUnique({
        where: { id: orgId },
        select: { name: true, businessContext: true },
      }),
    ]);

    let summary = '';
    if (org) {
      const base = `Organisation: ${org.name}\nBusiness context: ${JSON.stringify(org.businessContext ?? {})}`;
      summary =
        base.length > PLANNER_CONTEXT_CHAR_CAP
          ? base.slice(0, PLANNER_CONTEXT_CHAR_CAP) + '…(truncated)'
          : base;
    }

    return { orgContextBlock: '', orgSummaryBlock: summary };
  } catch (err) {
    console.error('[orchestrator] loadChatContext failed — continuing without org context', err);
    return { orgContextBlock: '', orgSummaryBlock: '' };
  }
}

export async function buildResourceManifest(orgId: string): Promise<string> {
  try {
    const [ shopifyStores, playbooks] = await Promise.all([
      prisma.shopifyIntegration.findMany({
        where: { organisationId: orgId, status: 'ACTIVE' },
        select: { id: true, name: true, shopDomain: true },
      }),
      prisma.playbook.findMany({
        where: { isActive: true, type: 'CHAT' },
        select: { name: true, description: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    const lines: string[] = ['Available evidence agents and data sources:'];

    const shopifyAgent = AGENT_REGISTRY.find((a) => a.type === 'shopify');
    if (shopifyAgent && shopifyStores.length > 0) {
      lines.push(`\n${shopifyAgent.manifestLine}`);
      for (const s of shopifyStores) {
        lines.push(`  source: "${s.name}" | domain: ${s.shopDomain} | sourceId: "${s.id}"`);
      }
    }

    const readOnlySources: string[] = [];
    if (readOnlySources.length > 0) {
      lines.push('\n[research] — industry benchmarks, no live data (also use for these unavailable sources):');
      lines.push(...readOnlySources);
    }

    for (const agent of AGENT_REGISTRY.filter((a) => !a.requiresDbSource)) {
      lines.push(`\n${agent.manifestLine}`);
      if (agent.type === 'playbook') {
        for (const p of playbooks) {
          lines.push(`  playbook: "${p.name}" — ${p.description}`);
        }
      }
    }

    if (
      shopifyStores.length === 0 &&
      playbooks.length === 0
    ) {
      return 'No live data sources connected. Use agentType: "research" or "web_search" as available.';
    }

    return lines.join('\n');
  } catch (err) {
    console.error('[orchestrator] buildResourceManifest failed', err);
    return 'Resource manifest unavailable. Use agentType: "research" for all tasks.';
  }
}

export function buildGovernancePrompt(allowed: string[], restricted: string[]): string {
  const parts: string[] = [];
  if (allowed.length > 0) {
    parts.push(
      `You are only permitted to discuss the following topics or resources: ${allowed.join(', ')}. Do not discuss anything outside of these. If the user asks about something outside this scope, politely decline by saying you cannot help with that.`,
    );
  }
  if (restricted.length > 0) {
    parts.push(
      `You are NOT permitted to access, reference, or disclose any information about: ${restricted.join(', ')}. If the user asks about these, politely decline — do not reveal the reason.`,
    );
  }
  return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
}

export function filterRestrictedEvidence(evidences: Evidence[], restricted: string[]): Evidence[] {
  if (restricted.length === 0 || evidences.length === 0) return evidences;
  const lowerRestricted = restricted.map((r) => r.toLowerCase());
  return evidences.filter((e) => {
    const combined = (e.question + ' ' + e.summary).toLowerCase();
    const matches = lowerRestricted.some((r) => combined.includes(r));
    if (matches) {
      console.log('[orchestrator] filtered evidence referencing restricted item');
    }
    return !matches;
  });
}
