/**
 * Support agent config loader
 * ============================
 * Loads an org's SupportAgentConfig + its active rules (priority desc) and
 * maps them to the pure types used by rules.ts / prompt.ts. Per-connection
 * overrides (SupportChannelConnection.agentOverrides) are merged in by the
 * caller (runner.ts), which knows which connection the conversation belongs to.
 */

import { prisma } from '../prisma.js';
import type { AgentRule } from './rules.js';
import type { SupportAgentMode } from '../../lib/generated/prisma/enums.js';

export type LoadedAgentConfig = {
  mode: SupportAgentMode;
  persona: string | null;
  signature: string | null;
  systemInstructions: string | null;
  fallbackBehavior: string;
  escalateOnLowConfidence: boolean;
  escalateOnComplex: boolean;
  /** Opaque per-action permission JSON; parsed by actions/permissions.ts. */
  actionPermissions: unknown;
  /** Store return window (days) for return-eligibility, or null to defer to policy. */
  returnWindowDays: number | null;
  rules: AgentRule[];
};

export async function loadAgentConfig(organisationId: string): Promise<LoadedAgentConfig | null> {
  const config = await prisma.supportAgentConfig.findUnique({
    where: { organisationId },
    include: {
      rules: {
        where: { isActive: true },
        orderBy: { priority: 'desc' },
      },
    },
  });

  if (!config) return null;

  return {
    mode: config.mode,
    persona: config.persona,
    signature: config.signature,
    systemInstructions: config.systemInstructions,
    fallbackBehavior: config.fallbackBehavior,
    escalateOnLowConfidence: config.escalateOnLowConfidence,
    escalateOnComplex: config.escalateOnComplex,
    actionPermissions: config.actionPermissions,
    returnWindowDays: config.returnWindowDays,
    rules: config.rules.map((r) => ({
      id: r.id,
      name: r.name,
      priority: r.priority,
      matchType: r.matchType,
      matchValue: r.matchValue,
      actionType: r.actionType,
      responseTemplate: r.responseTemplate,
      directive: r.directive,
      isActive: r.isActive,
    })),
  };
}

/** Per-connection overrides shape (SupportChannelConnection.agentOverrides JSONB). */
export type AgentOverrides = {
  signature?: string;
  mode?: SupportAgentMode;
  persona?: string;
};

/** Merge per-connection overrides onto the org config. Connection wins. */
export function applyAgentOverrides(config: LoadedAgentConfig, overrides: unknown): LoadedAgentConfig {
  if (!overrides || typeof overrides !== 'object') return config;
  const o = overrides as AgentOverrides;
  return {
    ...config,
    mode: o.mode ?? config.mode,
    signature: o.signature ?? config.signature,
    persona: o.persona ?? config.persona,
  };
}
