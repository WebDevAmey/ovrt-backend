import type { UIMessageChunk, UIMessageStreamWriter } from 'ai';
import type { Persona } from '../personas.js';
import type { TokenBreakdownEntry } from '../agents/types.js';

export type ResourceUsed =
  | { type: 'shopify'; id: string; name: string; shopDomain: string }
  | { type: 'research' }
  | { type: 'web_search'; websites: Array<{ url: string; title: string }> }
  | { type: 'playbook'; name: string };

export type FinishInfo = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  persona: Persona;
  providerModelId: string;
  tokenBreakdown: TokenBreakdownEntry[];
  agentCount: number;
  messageId: string;
  resourcesUsed: ResourceUsed[];
};

export type OrchestratorResult = {
  stream: ReadableStream<UIMessageChunk>;
  finishPromise: Promise<FinishInfo>;
};

export function writeStatus(writer: UIMessageStreamWriter, data: Record<string, unknown>): void {
  writer.write({ type: 'data-agent-status', data } as unknown as UIMessageChunk);
}
