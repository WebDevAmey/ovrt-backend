import { prisma } from '../../prisma.js';
import { resolveShopifySource, getShopifyConn } from '../modules/shopify-shared.js';
import { getAnalystTaskRunner } from '../runner-instance.js';
import { runWeeklyDigest } from './runner.js';
import { computeDigestWindow } from './fetcher.js';
import { BUSINESS_TIMEZONE } from '../constants.js';

export async function runDigestSweep(orgId?: string): Promise<void> {
  const orgs = orgId
    ? await prisma.organisation.findMany({ where: { id: orgId }, select: { id: true } })
    : await prisma.organisation.findMany({ select: { id: true } });

  let submitted = 0;

  for (const org of orgs) {
    try {
      const sourceId = await resolveShopifySource(org.id);
      if (!sourceId) continue;

      // Compute the window per-org using the shop's own timezone (falling back
      // to the business timezone, IST) so merchants east of UTC don't get the
      // previous week when they trigger on their Monday.
      const conn = await getShopifyConn(sourceId);
      const window = computeDigestWindow(new Date(), conn.timezone ?? BUSINESS_TIMEZONE);
      const weekStartDt = new Date(`${window.weekStart}T00:00:00Z`);

      // Skip if a non-failed digest already exists for this week.
      // FAILED rows are excluded so they can be retried: the task closure
      // below resets a FAILED row back to QUEUED rather than trying to create
      // a new one (which would P2002 and silently swallow the retry).
      const existing = await prisma.weeklyDigest.findFirst({
        where: {
          organisationId: org.id,
          weekStart: weekStartDt,
          status: { in: ['QUEUED', 'RUNNING', 'SUCCEEDED'] },
        },
        select: { id: true },
      });
      if (existing) continue;

      const orgId_ = org.id;
      const sourceId_ = sourceId;
      const ws = window.weekStart;
      const we = window.weekEnd;

      getAnalystTaskRunner().run(`digest:${orgId_}:${ws}`, async () => {
        // Upsert: reset a FAILED row back to QUEUED, or create fresh if none exists.
        // This avoids a P2002 on the unique(organisationId, weekStart) constraint
        // while still allowing retries after transient failures.
        const failedRow = await prisma.weeklyDigest.findFirst({
          where: { organisationId: orgId_, weekStart: weekStartDt, status: 'FAILED' },
          select: { id: true },
        });

        let digest: { id: string };
        if (failedRow) {
          digest = await prisma.weeklyDigest.update({
            where: { id: failedRow.id },
            data: { status: 'QUEUED', error: null, completedAt: null, startedAt: null },
            select: { id: true },
          });
          console.log(`[digest] retrying failed digest org=${orgId_}, digestId=${failedRow.id}, weekStart=${ws}`);
        } else {
          try {
            digest = await prisma.weeklyDigest.create({
              data: {
                organisationId: orgId_,
                weekStart: weekStartDt,
                weekEnd: new Date(`${we}T23:59:59Z`),
                status: 'QUEUED',
              },
              select: { id: true },
            });
          } catch (err: unknown) {
            if ((err as { code?: string })?.code === 'P2002') {
              // Lost a race with a concurrent sweep or HTTP trigger — the winner
              // will handle this org, so silently skip.
              console.log(`[digest] skipped: digest already exists org=${orgId_}, weekStart=${ws}`);
              return;
            }
            throw err;
          }
        }

        await runWeeklyDigest(digest.id, sourceId_, orgId_, ws, we);
      });
      submitted++;
    } catch (err) {
      console.error(`[digest] sweep error: org=${org.id}`, err);
    }
  }

  console.log(
    `[digest] sweep complete: submitted=${submitted}/${orgs.length}${orgId ? `, scope=org:${orgId}` : ''}`,
  );
}
