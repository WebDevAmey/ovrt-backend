import type { Context } from 'hono';
import { prisma } from '../prisma.js';
import { verifyPushToken } from './pubsub-auth.js';
import { parsePushEnvelope, type PubSubEnvelope } from './parse.js';
import { gmailInboundSource } from './inbound.js';

export async function handleGmailPush(c: Context): Promise<Response> {
  const auth = await verifyPushToken(c.req.header('authorization'));
  if (!auth.ok) {
    console.warn('[gmail-push] rejected:', auth.reason);
    return c.text('Unauthorized', 401);
  }

  let envelope: PubSubEnvelope;
  try {
    envelope = await c.req.json();
  } catch {
    return c.body(null, 204);
  }

  const parsed = parsePushEnvelope(envelope);
  if (!parsed) {
    console.warn('[gmail-push] unparseable envelope/payload — dropping');
    return c.body(null, 204);
  }
  const { emailAddress, historyId } = parsed;

  try {
    const connection = await prisma.supportChannelConnection.findFirst({
      where: { channelType: 'GMAIL', externalAccountId: emailAddress, status: 'ACTIVE' },
      select: { id: true, trackInbound: true },
    });

    if (!connection) {
      console.warn(`[gmail-push] no active connection for ${emailAddress} — dropping`);
      return c.body(null, 204);
    }

    if (!connection.trackInbound) {
      console.log(`[gmail-push] ${emailAddress} has trackInbound=false — discarding`);
      return c.body(null, 204);
    }

    const supportInboundJob = await prisma.supportInboundJob.create({
      data: {
        emailAddress,
        historyId,
      },
    });

    setImmediate(() => {
      gmailInboundSource.processIngestJob(supportInboundJob.id).catch((err) => {
        console.error(`[gmail-push-async] Background process crashed for job ${supportInboundJob.id}:`, err);
      });
    });

    return c.body(null, 204);
  } catch (err) {
    console.error('[gmail-push] processing failed, will be retried:', err);
    return c.text('Internal error', 500);
  }
}
