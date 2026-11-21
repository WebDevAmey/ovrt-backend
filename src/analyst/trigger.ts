import type { Context } from 'hono';
import { INSIGHT_MODULES } from './modules/index.js';
import { getAnalystTaskRunner } from './runner-instance.js';
import { runSweep } from './sweep.js';

export async function handleTrigger(c: Context): Promise<Response> {
  const auth = c.get('analystAuth') as { userId: string; orgId: string };
  const { orgId } = auth;
  const triggered: string[] = [];

  for (const module of INSIGHT_MODULES) {
    const insightType = module.insightType;
    getAnalystTaskRunner().run(`trigger-sweep:${orgId}:${insightType}`, () =>
      runSweep(insightType, orgId, true),
    );
    triggered.push(insightType);
  }

  return c.json({ triggered, orgId });
}
