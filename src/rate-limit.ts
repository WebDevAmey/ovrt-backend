import { prisma } from './prisma.js';

export type RateScope = 'user' | 'org';
export type RateReason = 'TOKEN_CAP' | 'MESSAGE_CAP';

export type RateCheckOk = { ok: true };
export type RateCheckBlocked = {
  ok: false;
  scope: RateScope;
  reason: RateReason;
  resetAt: string;
  tokensUsed: number;
  tokenLimit: number;
  messagesUsed: number;
  messageLimit: number;
};
export type RateCheckResult = RateCheckOk | RateCheckBlocked;

type ActorState = {
  rateWindowStartedAt: Date | null;
  rateWindowTokens: number;
  rateWindowMessages: number;
  tokenLimitPerWindow: number;
  messageLimitPerWindow: number;
  windowDurationMs: number;
};

function toDateOrNull(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function toInt(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

function normalizeActor(row: Record<string, unknown>): ActorState {
  return {
    rateWindowStartedAt: toDateOrNull(row.rateWindowStartedAt),
    rateWindowTokens: toInt(row.rateWindowTokens),
    rateWindowMessages: toInt(row.rateWindowMessages),
    tokenLimitPerWindow: toInt(row.tokenLimitPerWindow),
    messageLimitPerWindow: toInt(row.messageLimitPerWindow),
    windowDurationMs: toInt(row.windowDurationMs),
  };
}

function windowActive(s: ActorState, now: Date): boolean {
  return (
    s.rateWindowStartedAt !== null &&
    now.getTime() - s.rateWindowStartedAt.getTime() < s.windowDurationMs
  );
}

type ActorEvaluation = {
  blocked: boolean;
  reason: RateReason | null;
  resetAt: Date;
  tokensUsed: number;
  messagesUsed: number;
};

function evaluateActor(s: ActorState, now: Date): ActorEvaluation {
  if (!windowActive(s, now)) {
    return {
      blocked: false,
      reason: null,
      resetAt: new Date(now.getTime() + s.windowDurationMs),
      tokensUsed: 0,
      messagesUsed: 0,
    };
  }
  const resetAt = new Date(s.rateWindowStartedAt!.getTime() + s.windowDurationMs);
  if (s.rateWindowTokens >= s.tokenLimitPerWindow) {
    return {
      blocked: true,
      reason: 'TOKEN_CAP',
      resetAt,
      tokensUsed: s.rateWindowTokens,
      messagesUsed: s.rateWindowMessages,
    };
  }
  if (s.rateWindowMessages >= s.messageLimitPerWindow) {
    return {
      blocked: true,
      reason: 'MESSAGE_CAP',
      resetAt,
      tokensUsed: s.rateWindowTokens,
      messagesUsed: s.rateWindowMessages,
    };
  }
  return {
    blocked: false,
    reason: null,
    resetAt,
    tokensUsed: s.rateWindowTokens,
    messagesUsed: s.rateWindowMessages,
  };
}

// Atomically evaluate caps for user+org, and on success increment the
// per-window message counter on both. Uses SELECT ... FOR UPDATE inside an
// interactive transaction so concurrent submissions from the same actor
// cannot race past the cap.
export async function checkAndConsumeMessage(
  userId: string,
  orgId: string,
): Promise<RateCheckResult> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();

    const userRows = await tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT
        "rateWindowStartedAt",
        "rateWindowTokens",
        "rateWindowMessages",
        "tokenLimitPerWindow",
        "messageLimitPerWindow",
        "windowDurationMs"
      FROM "User"
      WHERE id = ${userId}
      FOR UPDATE
    `;
    if (userRows.length === 0) {
      throw new Error(`rate-limit: user ${userId} not found`);
    }

    const orgRows = await tx.$queryRaw<Array<Record<string, unknown>>>`
      SELECT
        "rateWindowStartedAt",
        "rateWindowTokens",
        "rateWindowMessages",
        "tokenLimitPerWindow",
        "messageLimitPerWindow",
        "windowDurationMs"
      FROM "Organisation"
      WHERE id = ${orgId}
      FOR UPDATE
    `;
    if (orgRows.length === 0) {
      throw new Error(`rate-limit: organisation ${orgId} not found`);
    }

    const userState = normalizeActor(userRows[0]!);
    const orgState = normalizeActor(orgRows[0]!);

    const userEval = evaluateActor(userState, now);
    const orgEval = evaluateActor(orgState, now);

    if (userEval.blocked || orgEval.blocked) {
      const blockers: Array<{ scope: RateScope; e: ActorEvaluation; s: ActorState }> = [];
      if (userEval.blocked) blockers.push({ scope: 'user', e: userEval, s: userState });
      if (orgEval.blocked) blockers.push({ scope: 'org', e: orgEval, s: orgState });
      // Pick the blocking actor with the tightest (earliest) reset time.
      blockers.sort((a, b) => a.e.resetAt.getTime() - b.e.resetAt.getTime());
      const chosen = blockers[0]!;
      return {
        ok: false,
        scope: chosen.scope,
        reason: chosen.e.reason!,
        resetAt: chosen.e.resetAt.toISOString(),
        tokensUsed: chosen.e.tokensUsed,
        tokenLimit: chosen.s.tokenLimitPerWindow,
        messagesUsed: chosen.e.messagesUsed,
        messageLimit: chosen.s.messageLimitPerWindow,
      };
    }

    const userActive = windowActive(userState, now);
    if (userActive) {
      await tx.$executeRaw`
        UPDATE "User"
        SET "rateWindowMessages" = "rateWindowMessages" + 1,
            "updatedAt" = ${now}
        WHERE id = ${userId}
      `;
    } else {
      await tx.$executeRaw`
        UPDATE "User"
        SET "rateWindowStartedAt" = ${now},
            "rateWindowTokens" = 0,
            "rateWindowMessages" = 1,
            "updatedAt" = ${now}
        WHERE id = ${userId}
      `;
    }

    const orgActive = windowActive(orgState, now);
    if (orgActive) {
      await tx.$executeRaw`
        UPDATE "Organisation"
        SET "rateWindowMessages" = "rateWindowMessages" + 1,
            "updatedAt" = ${now}
        WHERE id = ${orgId}
      `;
    } else {
      await tx.$executeRaw`
        UPDATE "Organisation"
        SET "rateWindowStartedAt" = ${now},
            "rateWindowTokens" = 0,
            "rateWindowMessages" = 1,
            "updatedAt" = ${now}
        WHERE id = ${orgId}
      `;
    }

    return { ok: true };
  });
}
