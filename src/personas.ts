import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PERSONAS = ['greenet', 'idol-3', 'desert-blue'] as const;
export type Persona = (typeof PERSONAS)[number];
export const DEFAULT_PERSONA: Persona = 'idol-3';

export function isPersona(v: unknown): v is Persona {
  return typeof v === 'string' && (PERSONAS as readonly string[]).includes(v);
}

// Token claim → persona. Unknown/absent → default + warn.
export function resolvePersona(claim: unknown): Persona {
  if (claim === undefined || claim === null) {
    console.warn('[persona] no model claim on token, defaulting to', DEFAULT_PERSONA);
    return DEFAULT_PERSONA;
  }
  if (!isPersona(claim)) {
    console.warn('[persona] unknown model claim %o, defaulting to %s', claim, DEFAULT_PERSONA);
    return DEFAULT_PERSONA;
  }
  return claim;
}

// "idol-3" → "MODEL_IDOL_3"
function envKeyFor(persona: Persona): string {
  return 'MODEL_' + persona.replace(/-/g, '_').toUpperCase();
}

// Persona → provider model id. Falls back to CHAT_MODEL for code paths whose env
// is not yet configured. Throws only if neither is set.
export function resolveProviderModelId(persona: Persona): string {
  const fromPersona = process.env[envKeyFor(persona)];
  if (fromPersona && fromPersona.length > 0) return fromPersona;
  const legacy = process.env.CHAT_MODEL;
  if (legacy && legacy.length > 0) return legacy;
  throw new Error(
    `No model configured: set ${envKeyFor(persona)} or CHAT_MODEL`,
  );
}

const promptCache = new Map<Persona, string>();

function loadPrompt(persona: Persona): string {
  const cached = promptCache.get(persona);
  if (cached) return cached;
  const path = resolve(process.cwd(), 'prompts', `${persona}.md`);
  const text = readFileSync(path, 'utf8').trim();
  promptCache.set(persona, text);
  return text;
}

export function getPersonaPrompt(persona: Persona): string {
  return loadPrompt(persona);
}
