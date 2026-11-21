import { createOpenAI } from '@ai-sdk/openai';

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY! });

export function openaiModel(modelId: string) {
  return openai(modelId);
}

// Reasoning models (gpt-5, o1, o3, o4 family) reject `temperature` and a few
// other sampling params — pass them and OpenAI returns 400 / the AI SDK warns.
// Use this to gate temperature on every call.
export function isReasoningModel(modelId: string): boolean {
  return /^(gpt-5|o1|o3|o4)\b/i.test(modelId);
}

// Spread the result into a call config to add `temperature` only when the
// model accepts it.
export function samplingFor(
  modelId: string,
  temperature: number,
): { temperature: number } | Record<string, never> {
  return isReasoningModel(modelId) ? {} : { temperature };
}

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

// Reasoning models share their output-token budget between reasoning and
// visible output. Without setting effort, gpt-5 will burn ~1k reasoning
// tokens on trivial classification tasks and truncate the JSON. Set this
// per call (minimal for plan/research, medium for synthesis).
export function reasoningOpts(
  modelId: string,
  effort: ReasoningEffort,
):
  | { providerOptions: { openai: { reasoningEffort: ReasoningEffort } } }
  | Record<string, never> {
  if (!isReasoningModel(modelId)) return {};
  return { providerOptions: { openai: { reasoningEffort: effort } } };
}

// Reasoning tokens count against maxOutputTokens. A 1024-budget call that
// would be fine for a normal model can truncate on gpt-5 because reasoning
// eats most of it. Inflate the budget so visible output still fits even
// when effort kicks up.
export function maxTokensFor(modelId: string, requested: number): number {
  return isReasoningModel(modelId) ? requested * 4 : requested;
}
