/**
 * Real ActionLog — prisma-backed SupportActionLog
 * ===============================================
 * Audit + idempotency store for write-actions. `hasExecuted` powers the
 * executors' idempotency guard (a retried cancel/edit is a no-op); `record`
 * writes the audit row. Best-effort by design: a logging failure must never
 * crash a customer reply, so writes are wrapped and only surfaced in logs.
 */

import { prisma } from '../../prisma.js';
import type { ActionLog } from './executors.js';

export const prismaActionLog: ActionLog = {
  async hasExecuted({ conversationId, orderRef, actionType }) {
    try {
      const existing = await prisma.supportActionLog.findFirst({
        where: { conversationId, orderRef, actionType, status: 'executed' },
        select: { id: true },
      });
      return existing !== null;
    } catch (err) {
      // If we can't read the log, fail SAFE for irreversible actions by treating
      // it as "already executed" would block legitimate first-time actions — so
      // instead we treat it as not-executed but let the caller's other guards and
      // the customer-confirmation handshake stand. Logged for visibility.
      console.warn('[support-action-log] hasExecuted read failed (treating as not-executed):', err instanceof Error ? err.message : String(err));
      return false;
    }
  },

  async record({ organisationId, conversationId, orderRef, actionType, status, detail }) {
    try {
      await prisma.supportActionLog.create({
        data: { organisationId, conversationId, orderRef, actionType, status, detail: detail as object },
      });
    } catch (err) {
      console.warn('[support-action-log] record failed (non-fatal):', err instanceof Error ? err.message : String(err));
    }
  },
};
