import { signServiceToken, type ServicePurpose } from '../src/service-token.js';
import { isPersona, type Persona } from '../src/personas.js';

const args = process.argv.slice(2);
let purpose: ServicePurpose = 'chat';
let model: Persona | undefined;
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--purpose') {
    const v = args[i + 1];
    if (v !== 'chat' && v !== 'revenue-loss' && v !== 'analyst') {
      console.error("--purpose must be 'chat', 'revenue-loss', or 'analyst'");
      process.exit(1);
    }
    purpose = v;
    i++;
  } else if (a === '--model') {
    const v = args[i + 1];
    if (!isPersona(v)) {
      console.error("--model must be 'greenet' | 'idol-3' | 'desert-blue'");
      process.exit(1);
    }
    model = v;
    i++;
  } else {
    positional.push(a!);
  }
}

const [userId, orgId, third, fourth] = positional;
if (!userId || !orgId) {
  console.error(
    'Usage:\n' +
      "  chat:     tsx --env-file=.env scripts/sign-token.ts [--purpose chat] <userId> <orgId> <conversationId> [ttlSeconds]\n" +
      "  analyst:  tsx --env-file=.env scripts/sign-token.ts --purpose analyst <userId> <orgId> [ttlSeconds]",
  );
  process.exit(1);
}
if (!process.env.LLM_PROXY_SECRET) {
  console.error('LLM_PROXY_SECRET is not set. Add it to .env or export it.');
  process.exit(1);
}

let conversationId: string | undefined;
let ttlArg: string | undefined;
if (purpose === 'chat') {
  conversationId = third;
  ttlArg = fourth;
  if (!conversationId) {
    console.error('chat purpose requires <conversationId>');
    process.exit(1);
  }
} else {
  ttlArg = third;
}

const ttl = Number(ttlArg) > 0 ? Number(ttlArg) : 60;
const payload = conversationId
  ? { userId, orgId, purpose, conversationId, ...(model ? { model } : {}) }
  : { userId, orgId, purpose, ...(model ? { model } : {}) };
const token = signServiceToken(payload, ttl);
console.log(token);
