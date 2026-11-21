/**
 * Agent Registry
 * ==============
 * The single source of truth for all available agents.
 *
 * To add a new agent:
 *   1. Add its type string to EvidenceTaskType in src/agents/types.ts
 *   2. Create src/agents/<name>/index.ts exporting a runner + AgentDefinition
 *   3. Import and push that definition into AGENT_REGISTRY here
 *
 * Everything else — router dispatch, planner routing rules, resource manifest,
 * taskSchema enum — is derived from this registry automatically.
 */

import type { AgentDefinition } from './types.js';
import { shopifyAgentDef } from './shopify/index.js';
import { researchAgentDef } from './research/index.js';
import { webSearchAgentDef } from './web-search/index.js';
import { playbookAgentDef } from './playbook/index.js';

export const AGENT_REGISTRY: AgentDefinition[] = [
  shopifyAgentDef,
  researchAgentDef,
  webSearchAgentDef,
  playbookAgentDef,
];
