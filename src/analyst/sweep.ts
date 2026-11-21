import { prisma } from '../prisma.js';
import { getModuleByType } from './modules/index.js';
import { getAnalystTaskRunner } from './runner-instance.js';
import { runAnalystJob } from './runner.js';

export async function runSweep(insightType: string, orgId?: string, bypassRateLimit = false): Promise<void> {
  const module = getModuleByType(insightType);
  if (!module) {
    console.error(`[analyst] sweep: unknown insightType=${insightType}`);
    return;
  }

  const orgs = orgId
    ? await prisma.organisation.findMany({ where: { id: orgId }, select: { id: true } })
    : await prisma.organisation.findMany({ select: { id: true } });
  let submitted = 0;

  for (const org of orgs) {
    try {
      const sourceId = await module.resolveSource(org.id);
      if (!sourceId) continue;

      const activeJob = await prisma.analystJob.findFirst({
        where: {
          organisationId: org.id,
          insightType,
          status: { in: ['QUEUED', 'RUNNING'] },
        },
        select: { id: true },
      });
      if (activeJob) continue;

      if (!bypassRateLimit) {
        const recentJob = await prisma.analystJob.findFirst({
          where: {
            organisationId: org.id,
            insightType,
            status: { in: ['SUCCEEDED', 'FAILED'] },
          },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        });
        if (recentJob) {
          const elapsed = Date.now() - recentJob.createdAt.getTime();
          if (elapsed < module.rateLimitMs) continue;
        }
      }

      const orgId_ = org.id;
      const sourceId_ = sourceId;
      getAnalystTaskRunner().run(`run:${orgId_}:${insightType}`, async () => {
        let dbJob: { id: string };
        try {
          dbJob = await prisma.analystJob.create({
            data: {
              organisationId: orgId_,
              insightType,
              sourceType: module.sourceType,
              sourceId: sourceId_,
              status: 'QUEUED',
            },
            select: { id: true },
          });
        } catch (err: unknown) {
          if ((err as { code?: string })?.code === 'P2002') {
            console.log(`[analyst] run skipped: active job exists org=${orgId_}, type=${insightType}`);
            return;
          }
          throw err;
        }
        await runAnalystJob(dbJob.id, module);
      });
      submitted++;
    } catch (err) {
      console.error(`[analyst] sweep error: org=${org.id}, type=${insightType}`, err);
    }
  }

  console.log(
    `[analyst] sweep complete: type=${insightType}, submitted=${submitted}/${orgs.length}${orgId ? `, scope=org:${orgId}` : ''}`,
  );
}
