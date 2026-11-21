/**
 * Intent → tool routing  (DEPRECATED — no longer on the hot path)
 * ===============================================================
 * The agent (agent.ts) now hands the model BOTH lookups via buildShopifyTools
 * whenever a store is connected, because real messages are multi-intent and the
 * single classified intent made for a poor tool gate (it could only answer one
 * half of "my order is damaged — is the blue one still in stock?"). Intent is
 * kept as a hint for the runner's escalation/logging, not for tool selection.
 *
 * This function is retained for reference/back-compat but is unused on the main
 * path. Prefer buildShopifyTools (tools/shopify.ts).
 *
 * Original behaviour:
 *   ORDER_DETAILS         → { lookupOrder }
 *   PRODUCT_INFO          → { lookupProduct }
 *   OTHER + directives     → { lookupOrder, lookupProduct }
 *   OTHER, no directives   → {} (runner routed OTHER to NEEDS_HUMAN — also removed)
 *
 * @deprecated Use buildShopifyTools from ./tools/shopify.js.
 */

import { buildLookupOrderTool, buildLookupProductTool, type ToolBuildArgs } from './tools/shopify.js';
import type { SupportIntent } from '../../lib/generated/prisma/enums.js';
import type { ToolSet } from 'ai';

/** Build the tool set for one agent run, scoped by the conversation's intent. */
export function buildToolsForIntent(
  intent: SupportIntent,
  hasDirectives: boolean,
  args: ToolBuildArgs,
): { tools: ToolSet; hasOrderTool: boolean; hasProductTool: boolean } {
  switch (intent) {
    case 'ORDER_DETAILS':
      return { tools: { lookupOrder: buildLookupOrderTool(args) }, hasOrderTool: true, hasProductTool: false };
    case 'PRODUCT_INFO':
      return { tools: { lookupProduct: buildLookupProductTool(args) }, hasOrderTool: false, hasProductTool: true };
    case 'OTHER':
    default:
      if (hasDirectives) {
        return {
          tools: { lookupOrder: buildLookupOrderTool(args), lookupProduct: buildLookupProductTool(args) },
          hasOrderTool: true,
          hasProductTool: true,
        };
      }
      return { tools: {}, hasOrderTool: false, hasProductTool: false };
  }
}
