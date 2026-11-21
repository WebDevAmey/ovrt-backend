import { generateText, Output } from 'ai';
import { z } from 'zod';
import { openaiModel, samplingFor, reasoningOpts } from '../openai.js';
import { prisma } from '../prisma.js';
import { logAiTokenUsage } from '../ai-token-usage.js';

const MEMORY_MODEL = process.env.MEMORY_MODEL ?? 'gpt-4o-mini';

const memorySchema = z.object({
  shouldRemember: z.boolean(),
  scope: z.enum(['conversation', 'user']).nullable(),
  memory: z.string().max(200).nullable(),
});

export async function extractAndSaveMemory(
  assistantResponse: string,
  userText: string,
  existingUserMemory: string[],
  existingConversationMemory: string[],
  userId: string,
  conversationId: string,
  organisationId: string,
  messageId: string | undefined,
): Promise<void> {
  if (!assistantResponse || !userText) return;

  const MEMORY_TRIGGER = /\b(remember|always|prefer|from now on|for this chat|never|my preference|save this)\b/i;
  if (!MEMORY_TRIGGER.test(userText) && !MEMORY_TRIGGER.test(assistantResponse.slice(0, 200))) return;

  const startedAt = new Date();
  const memoryResult = await generateText({
    model: openaiModel(MEMORY_MODEL),
    output: Output.object({ schema: memorySchema }),
    ...samplingFor(MEMORY_MODEL, 0),
    ...reasoningOpts(MEMORY_MODEL, 'minimal'),
    system: `You are a memory extraction system. Analyze the conversation and decide if there's information that should be remembered.

You have two memory stores:
1. **User memory** (general preferences that apply across all conversations): Use this for statements like "I prefer British English", "always give short answers", "I work at Google", "from now on always X".
2. **Conversation memory** (specific to this chat only): Use this for statements like "remember this calculation", "save this link", "remember this for later in our conversation", "for this chat...".

Return shouldRemember=true if something should be remembered, and set scope to "user" or "conversation" accordingly. If nothing to remember, return shouldRemember=false and scope=null.

Current user memory: ${existingUserMemory.length > 0 ? existingUserMemory.join('; ') : '(none)'}
Current conversation memory: ${existingConversationMemory.length > 0 ? existingConversationMemory.join('; ') : '(none)'}`,
    prompt: `Conversation:\nUser: ${userText}\nAssistant: ${assistantResponse}\n\nDecide if anything should be remembered and whether it's a general user preference (scope: "user") or conversation-specific (scope: "conversation").`,
  });

  const parsed = memoryResult.output;
  logAiTokenUsage({
    organisationId,
    userId,
    conversationId,
    messageId: messageId || undefined,
    modelName: MEMORY_MODEL,
    feature: 'orchestrator',
    operation: 'memory-extract',
    usage: memoryResult.usage,
    finishReason: memoryResult.finishReason,
    latencyMs: Date.now() - startedAt.getTime(),
    startedAt,
  });

  if (parsed.shouldRemember && parsed.memory && parsed.scope) {
    if (parsed.scope === 'user') {
      const newMemory = [...existingUserMemory, parsed.memory].slice(-10);
      await prisma.user.update({
        where: { id: userId },
        data: { memory: newMemory },
      });
      console.log('[orchestrator] saved user memory:', parsed.memory);
    } else {
      const newMemory = [...existingConversationMemory, parsed.memory].slice(-10);
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { memory: newMemory },
      });
      console.log('[orchestrator] saved conversation memory:', parsed.memory);
    }
  }
}
