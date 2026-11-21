import { prisma } from '../../prisma.js';
import { sendOpportunityAlertEmail } from '../../email/opportunity-alert.js';
import type { OpportunityDraft } from './types.js';

/**
 * Persists curated opportunity drafts for an org, skipping any draft whose
 * dedupeKey already matches an open opportunity (covers both re-runs of the
 * curation engine and overlap with weekly-digest-sourced opportunities —
 * dedupeKey is the cross-producer dedup key).
 *
 * Sends one batch "new opportunities" email when at least one draft is
 * actually persisted (not skipped as a duplicate).
 */
export async function writeOpportunities(
  orgId: string,
  drafts: OpportunityDraft[],
  modelName: string,
): Promise<number> {
  if (drafts.length === 0) return 0;

  const dedupeKeys = drafts.map((d) => d.dedupeKey).filter(Boolean);
  const existing = dedupeKeys.length
    ? await prisma.opportunity.findMany({
        where: {
          organisationId: orgId,
          dedupeKey: { in: dedupeKeys },
          status: { in: ['OPEN', 'VIEWED', 'EXPLORING'] },
        },
        select: { dedupeKey: true },
      })
    : [];
  const existingKeys = new Set(existing.map((e) => e.dedupeKey));

  const toCreate = drafts.filter((d) => !existingKeys.has(d.dedupeKey));
  if (toCreate.length === 0) {
    console.log(`[opportunity] writer: all ${drafts.length} draft(s) deduped for org=${orgId}`);
    return 0;
  }

  const created = await prisma.opportunity.createManyAndReturn({
    data: toCreate.map((d) => ({
      organisationId: orgId,
      title: d.title,
      description: d.description,
      category: d.category as any,
      priority: d.priority,
      source: 'ANOMALY_CURATION' as const,
      status: 'OPEN' as const,
      evidence: d.evidence as object[],
      dedupeKey: d.dedupeKey,
      sourceAnomalyId: d.sourceAnomalyId,
      generatedByModel: modelName,
    })),
    select: { id: true, title: true, description: true, category: true, priority: true },
  });

  console.log(
    `[opportunity] writer: created ${created.length} opportunity(ies) for org=${orgId} (${toCreate.length - created.length} deduped)`,
  );

  try {
    const recipients = await prisma.user.findMany({
      where: { organisationId: orgId },
      select: { email: true, name: true },
    });
    for (const u of recipients) {
      await sendOpportunityAlertEmail(u.email, u.name, created);
    }
  } catch (emailErr) {
    console.error(`[opportunity] batch email failed for org=${orgId}`, emailErr);
  }

  return created.length;
}
