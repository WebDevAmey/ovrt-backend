import { generateText } from 'ai';
import { openaiModel, samplingFor } from '../openai.js';
import { logAiTokenUsage } from '../ai-token-usage.js';
import { signServiceToken } from '../service-token.js';
import { fetchContentProducts, formatProductsForPrompt, type ContentProduct } from './shopify-products.js';
import { resolvePlaybooksForBrief, formatPlaybooksForPrompt, type ContentPlaybook } from './playbooks.js';

const CONTENT_MODEL = process.env.CONTENT_GEN_MODEL ?? 'gpt-4o';
// Cheaper model for the short ideation step that splits one brief into N angles.
const CONTENT_IDEATION_MODEL = process.env.CONTENT_IDEATION_MODEL ?? CONTENT_MODEL;

const DIMENSIONS: Record<string, { width: number; height: number }> = {
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1.91:1': { width: 1200, height: 628 },
};

export type BrandTokens = {
  // Identity
  brandName?: string;
  industry?: string;
  websiteUrl?: string;
  // Colors
  primaryColor?: string;
  secondaryColor?: string;
  accentColor?: string;
  backgroundColor?: string;
  textColor?: string;
  mutedColor?: string;
  extraColors?: string[];
  colorPalette?: string;
  // Typography
  headingFont?: string;
  bodyFont?: string;
  monoFont?: string;
  headingWeight?: string;
  bodySize?: string;
  extraFonts?: string[];
  // Decorative tokens
  borderRadius?: string;
  shadowStyle?: string;
  spacing?: string;
  // Style direction
  toneOfVoice?: string;
  visualStyle?: string;
  imageStyle?: string;
  brandKeywords?: string[];
  // Assets
  logoUrl?: string;
  // Free-form per-brand LLM instructions (from BrandDesignSystem.agentInstructions)
  agentInstructions?: string;
};

export type ContentGenerateJobParams = {
  treeId: string;
  nodeIds: string[];
  prompt: string;
  ratio: string;
  count: number;
  platform: string;
  extraInstructions?: string | null;
  brandTokens?: BrandTokens | null;
  orgId: string;
  userId: string;
  // When set, this is a refinement of existing content: each new variant should
  // evolve from this HTML rather than start from scratch.
  previousHtml?: string | null;
  // Optional Shopify product GIDs the user picked to feature in the content. When
  // omitted, the most recently updated active products are pulled for grounding.
  productIds?: string[] | null;
  // Optional user-uploaded image URLs (from the Files section) to make
  // available to the model as reference/background/product images.
  referenceImageUrls?: string[] | null;
};

// Resolved once per job and threaded into every variant's prompt so we don't
// re-fetch products/playbooks per variant.
type ContentContext = {
  products: ContentProduct[];
  playbooks: ContentPlaybook[];
};

function borderRadiusCss(value?: string): string {
  switch (value) {
    case 'none': return '0px';
    case 'small': return '4px';
    case 'large': return '16px';
    case 'full': return '9999px';
    default: return '8px'; // medium
  }
}

function shadowCss(value?: string): string {
  switch (value) {
    case 'none': return 'none';
    case 'medium': return '0 4px 16px rgba(0,0,0,0.2)';
    case 'hard': return '3px 3px 0 rgba(0,0,0,0.8)';
    default: return '0 2px 8px rgba(0,0,0,0.1)'; // soft
  }
}

function spacingCss(value?: string): string {
  switch (value) {
    case 'compact': return '12px';
    case 'spacious': return '32px';
    default: return '20px'; // comfortable
  }
}

function imageStyleDescription(value?: string): string {
  switch (value) {
    case 'illustration': return 'illustration / vector art (avoid pure photo crops; prefer graphic, stylised visuals)';
    case 'minimal': return 'minimal / type-forward (product image is secondary; let typography and negative space carry the piece)';
    default: return 'photography (lead with real product or lifestyle photography where available)';
  }
}

function formatBrandTokens(tokens: BrandTokens): string {
  const sections: string[] = [];

  // ── Identity ──────────────────────────────────────────────────────────────
  const identity: string[] = [];
  if (tokens.brandName) identity.push(`Brand name: ${tokens.brandName} — use this name in the copy where appropriate (taglines, CTA labels, etc.)`);
  if (tokens.industry) identity.push(`Industry / category: ${tokens.industry}`);
  if (tokens.websiteUrl) identity.push(`Website: ${tokens.websiteUrl}`);
  if (identity.length) sections.push(identity.join('\n'));

  // ── Color ─────────────────────────────────────────────────────────────────
  const colors: string[] = [];
  if (tokens.primaryColor) colors.push(`Primary: ${tokens.primaryColor} — dominant brand color; use for backgrounds, large shapes, or the hero element`);
  if (tokens.secondaryColor) colors.push(`Secondary: ${tokens.secondaryColor} — CTA buttons, highlights, interactive elements`);
  if (tokens.accentColor) colors.push(`Accent: ${tokens.accentColor} — decorative pops, borders, underlines`);
  if (tokens.backgroundColor) colors.push(`Background: ${tokens.backgroundColor}`);
  if (tokens.textColor) colors.push(`Text: ${tokens.textColor}`);
  if (tokens.mutedColor) colors.push(`Muted / supporting text: ${tokens.mutedColor}`);
  if (tokens.extraColors?.length) colors.push(`Extended palette: ${tokens.extraColors.join(', ')}`);
  if (tokens.colorPalette) colors.push(`Palette character: ${tokens.colorPalette}`);
  if (colors.length) sections.push('Colors:\n' + colors.join('\n'));

  // ── Typography ────────────────────────────────────────────────────────────
  const type: string[] = [];
  if (tokens.headingFont) type.push(`Heading font: ${tokens.headingFont} (load from Google Fonts)`);
  if (tokens.bodyFont) type.push(`Body font: ${tokens.bodyFont} (load from Google Fonts)`);
  if (tokens.monoFont) type.push(`Mono / price font: ${tokens.monoFont} (load from Google Fonts; use for prices, codes, counters)`);
  if (tokens.headingWeight) type.push(`Heading weight: ${tokens.headingWeight}`);
  if (tokens.bodySize) type.push(`Base body size: ${tokens.bodySize}px`);
  if (tokens.extraFonts?.length) type.push(`Additional fonts: ${tokens.extraFonts.join(', ')}`);
  if (type.length) sections.push('Typography:\n' + type.join('\n'));

  // ── Decoration & layout rhythm ────────────────────────────────────────────
  const deco: string[] = [];
  deco.push(`Border radius: ${borderRadiusCss(tokens.borderRadius)}`);
  deco.push(`Box shadow: ${shadowCss(tokens.shadowStyle)}`);
  deco.push(`Base spacing / padding unit: ${spacingCss(tokens.spacing)}`);
  sections.push('Decoration:\n' + deco.join('\n'));

  // ── Style direction ───────────────────────────────────────────────────────
  const style: string[] = [];
  if (tokens.toneOfVoice) style.push(`Tone of voice: ${tokens.toneOfVoice} — write all copy in this register`);
  if (tokens.visualStyle) style.push(`Visual style: ${tokens.visualStyle}`);
  style.push(`Image treatment: ${imageStyleDescription(tokens.imageStyle)}`);
  if (tokens.brandKeywords?.length) style.push(`Brand keywords / themes: ${tokens.brandKeywords.join(', ')} — let these inform headline language and visual motifs`);
  if (style.length) sections.push('Style direction:\n' + style.join('\n'));

  // ── Assets ────────────────────────────────────────────────────────────────
  if (tokens.logoUrl) {
    sections.push(
      `Logo: <img src="${tokens.logoUrl}"> — place at a consistent brand corner (top-left preferred). ` +
      `Size to roughly 8–12% of canvas width. Never distort or recolor it.`,
    );
  }

  // ── Custom agent instructions (brand-specific overrides) ──────────────────
  if (tokens.agentInstructions?.trim()) {
    sections.push(
      `BRAND-SPECIFIC INSTRUCTIONS (these override general rules where they conflict):\n${tokens.agentInstructions.trim()}`,
    );
  }

  return sections.join('\n\n');
}

// Distinct compositional "looks" we cycle through per variant so the model
// doesn't default to the same centered-text-on-gradient layout every time.
const LAYOUT_ARCHETYPES = [
  'Hero-dominant: one bold focal headline anchored to a strong corner or edge, generous negative space, a single accent shape bleeding off-canvas. Asymmetric, confident.',
  'Split composition: the canvas divided (vertical, diagonal, or 60/40) into a color/visual field and a content field. Strong edge between the two, content aligned to the grid.',
  'Layered depth: overlapping translucent panels, soft shadows, and a clear foreground/background separation. Any CTA or key element floats on the topmost layer.',
  'Editorial / poster: oversized typographic statement as the hero element, type set at multiple scales, tight baseline grid, minimal decoration — let the words carry it.',
  'Card / product spotlight: a contained "card" with a clear visual frame, the subject or product framed inside, supporting copy below or beside it.',
];

// ── Variant ideation ─────────────────────────────────────────────────────────
// One brief, N distinct creative angles. Rather than handing the identical
// prompt to every variant (and relying only on layout to differentiate them),
// we first ask the model to split the brief into `count` genuinely different
// creative concepts — different hook, audience emotion, and message emphasis —
// then each variant's HTML is built from its own angle. Falls back to the raw
// brief per-variant if ideation fails, so generation never hard-blocks on it.
async function generateVariantAngles(
  params: ContentGenerateJobParams,
  count: number,
): Promise<string[]> {
  if (count <= 1) return [params.prompt];

  const brandParts: string[] = [];
  if (params.brandTokens?.brandName) brandParts.push(`Brand: ${params.brandTokens.brandName}`);
  if (params.brandTokens?.industry) brandParts.push(`Industry: ${params.brandTokens.industry}`);
  if (params.brandTokens?.toneOfVoice) brandParts.push(`Tone: ${params.brandTokens.toneOfVoice}`);
  if (params.brandTokens?.brandKeywords?.length) brandParts.push(`Keywords: ${params.brandTokens.brandKeywords.join(', ')}`);
  const brandHint = brandParts.length ? `\n${brandParts.join(' | ')}.` : '';
  const extraHint = params.extraInstructions ? `\nAdditional direction: ${params.extraInstructions}` : '';

  const startedAt = new Date();
  try {
    const result = await generateText({
      model: openaiModel(CONTENT_IDEATION_MODEL),
      system:
        'You are a creative director briefing a design team. Given one content brief, you split it into distinct creative concepts. Each concept approaches the SAME brief from a different angle — a different hook, emotional driver, audience framing, or emphasis — so the variants feel like separate creative routes, not recolors of one piece. Return ONLY a JSON array of strings, no prose, no code fences.',
      prompt: `Brief (target platform: ${params.platform}):\n${params.prompt}${brandHint}${extraHint}\n\nProduce exactly ${count} distinct creative concepts for this brief. Each is 1–2 sentences naming the angle, the hook/headline direction, and the emotional driver. Keep the underlying message and any real facts identical across all concepts — only the creative approach changes.\n\nReturn ONLY a JSON array of ${count} strings.`,
      ...samplingFor(CONTENT_IDEATION_MODEL, 0.9),
      maxOutputTokens: 1500,
    });

    logAiTokenUsage({
      organisationId: params.orgId,
      modelName: CONTENT_IDEATION_MODEL,
      feature: 'content-studio',
      agentName: 'content-generator',
      operation: 'ideate-variants',
      usage: result.usage,
      finishReason: result.finishReason,
      latencyMs: Date.now() - startedAt.getTime(),
      startedAt,
      metadata: { treeId: params.treeId, count },
    });

    const angles = parseAngles(result.text, count);
    if (angles) return angles;
    console.warn('[content] variant ideation returned unparseable output, falling back to base brief');
  } catch (err) {
    console.warn('[content] variant ideation failed, falling back to base brief:', err);
  }

  // Fallback: every variant uses the raw brief (layout archetypes still vary them).
  return Array.from({ length: count }, () => params.prompt);
}

function parseAngles(raw: string, count: number): string[] | null {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)```\s*$/i);
  if (fence) text = fence[1].trim();
  // Salvage the array even if the model wrapped it in commentary.
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    const angles = parsed.map((a) => String(a).trim()).filter(Boolean);
    if (angles.length === 0) return null;
    // Pad (by cycling) or trim to exactly `count`.
    return Array.from({ length: count }, (_, i) => angles[i % angles.length]);
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `You are a senior visual designer and front-end engineer who has shipped award-winning social media and marketing creative for major consumer brands. You think in composition, hierarchy, and contrast first, and you write production-grade HTML/CSS to realize it.

Your output is judged like real content in a feed: it must stop the scroll, communicate one idea instantly, and look like it came out of a design studio — not a code generator.

WHAT YOU'RE MAKING:
The brief below tells you what to create — it could be a paid ad, an Instagram/social post, an announcement, a quote card, a product showcase, an event graphic, or any other piece of visual content. Read the brief carefully and follow its intent. Do NOT force every piece of content into an "ad" mold (e.g. don't invent a discount, CTA button, or sales pitch) unless the brief actually calls for one.

DESIGN PRINCIPLES (apply all):
- Strong visual hierarchy: exactly one hero element (headline, image, or focal statement). Everything else is clearly secondary. Use scale, weight, and color contrast to enforce it — the biggest thing should be 3–5x the smallest.
- Intentional composition: use an asymmetric layout, a real grid, and deliberate negative space. Never just center everything vertically and call it done.
- Depth and texture: layer at least two of — gradient meshes, large soft background shapes/blobs, geometric accents, subtle noise (via SVG), translucent overlays, fine borders, soft shadows. Flat single-color backgrounds read as unfinished.
- Typographic craft: pair a characterful display face with a clean body face (Google Fonts). Use tight, deliberate line-height on headlines, letter-spacing where it helps, and a clear type scale. No system-default fonts.
- If the content calls for a call-to-action (e.g. it's an ad or promo), make it one unmistakable button or pill that contrasts hard with its surroundings. If the content is informational, editorial, or a post that doesn't need a CTA, leave it out — don't bolt one on.
- Color with confidence: honor the brand palette, but build real contrast and at least one gradient or accent moment. Avoid muddy mid-tones and low-contrast text.
- Edge discipline: respect comfortable internal padding (no element touching the canvas edge unless it's an intentional full-bleed shape). Text never clips or overflows.

HARD RULES — never violate:
- All facts, copy, products, prices, and claims come ONLY from the brief and the provided Shopify product catalogue. Never invent fake brand names, fake prices, or fake claims. When a real product price/title is provided, use it verbatim.
- Never use placeholder content: no "Lorem ipsum", no "Your headline here", no empty gray image boxes, no "[CTA]".
- Write real, specific copy that matches the brief's tone — punchy and benefit-driven for ads/promos, more narrative or editorial for posts/announcements. Headlines are short and impactful (≤ 7 words) unless the brief calls for longer-form text (e.g. a quote card).
- This is a STATIC IMAGE, not a web page or video. The output will be rasterized to a single still frame — anything animated, transitioning, or time-based is invisible or broken in the final image and is strictly forbidden. NEVER use @keyframes, animation, transition, transform with motion intent, @property, <animate>/<animateTransform> SVG tags, autoplay, or any CSS that changes over time. Every element's final, settled visual state must be correct at frame zero with no animation engine involved.

IMAGES — this is critical, get it right:
- When a product is featured, you MUST render the REAL product photo using a plain <img src="<the exact Shopify image URL provided>"> tag. Real product photography is what makes the content credible.
- NEVER attempt to recreate, illustrate, or fake a product, person, or photograph using SVG, CSS shapes, gradients, or <path>/<rect>/<circle> drawings. A hand-drawn SVG "product" looks amateur and is forbidden. If you need a product visual and a real image URL exists, use the <img>. If no product image is available, lean into bold typography, color fields, and abstract geometry instead — do NOT draw a fake product.
- Allowed external images: the provided logo URL and any product image URL from the catalogue below. Style product <img>s with object-fit:cover, sizing, border-radius, and shadows; you may layer gradients/overlays OVER them, but the underlying photo stays a real <img>.
- Decorative/abstract graphics (background blobs, meshes, accent shapes, noise, dividers) should still be CSS/inline-SVG. SVG is for abstract decoration ONLY, never for depicting real subjects. Never reference stock-photo URLs or any image URL not provided to you.

OUTPUT FORMAT — you are NOT writing a full HTML page. You output a single self-contained <div> component:
- The entire creative is ONE root <div> element. No <!DOCTYPE>, no <html>, <head>, or <body>.
- Style every element with inline style="" attributes. The root <div> carries its own fixed dimensions and box-sizing.
- If you need @font-face/@import (Google Fonts) or static pseudo-elements (e.g. ::before for a decorative shape), place a SINGLE <style> tag as the FIRST child inside the root <div>, and scope every selector to a unique class on the root (e.g. .content-x...) so it can never leak to a host page. Everything else stays inline. Do NOT include @keyframes or any animation/transition rules — this is a static image.
- The component must be drop-in: rendering this <div> alone (no surrounding page CSS) must look identical to your intent.

QUALITY BAR: if the result would look generic, templated, or like a default Bootstrap card, it has failed. Push for something a creative director would approve.`;

function buildPrompt(
  params: ContentGenerateJobParams,
  variantIndex: number,
  width: number,
  height: number,
  angle: string,
  context: ContentContext,
): string {
  const brandSection = params.brandTokens
    ? `BRAND DESIGN SYSTEM (honor strictly — these are the brand's real tokens):\n${formatBrandTokens(params.brandTokens)}`
    : `BRAND DESIGN SYSTEM:\nNone provided. Infer the brand identity from the brief and product catalogue. Invent a cohesive, premium palette and type pairing that fits the category and mood — tasteful and confident, not safe. Pick a brand name only if the brief or product titles make one obvious; otherwise omit it from copy.`;

  const extraSection = params.extraInstructions
    ? `\nADDITIONAL DIRECTION (these override defaults where they conflict):\n${params.extraInstructions}\n`
    : '';

  const productsText = formatProductsForPrompt(context.products);
  const productsSection = productsText ? `\n${productsText}\n` : '';

  const playbooksText = formatPlaybooksForPrompt(context.playbooks);
  const playbooksSection = playbooksText ? `\n${playbooksText}\n` : '';

  const refImgSection = params.referenceImageUrls?.length
    ? `\nUSER-PROVIDED REFERENCE IMAGES:\nThe following image URLs have been supplied by the user for use in this content. You MAY use any of them as product visuals, background images, or any other creative element — embed them as real <img src="..."> tags. These are fully authorised external URLs; treat them the same as product image URLs.\n${params.referenceImageUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')}\n`
    : '';

  const archetype = LAYOUT_ARCHETYPES[variantIndex % LAYOUT_ARCHETYPES.length];

  const orientation = width > height ? 'wide/landscape' : width < height ? 'tall/portrait' : 'square';

  // Refinement mode: evolve from the previous creative instead of starting cold.
  const refinementSection = params.previousHtml
    ? `\nREFINE THE EXISTING CREATIVE (this is a regeneration):
Below is the current version of this content. Treat it as the starting point. Apply the CHANGE REQUEST below — keep what already works (brand feel, the core message, any real facts) and improve or redirect it as requested. Produce a genuinely improved, distinct result; do NOT return the same markup unchanged.

--- CURRENT HTML (start) ---
${params.previousHtml}
--- CURRENT HTML (end) ---
`
    : '';

  // The per-variant angle is the distinct creative concept this variant must
  // realize. The brief is the shared, factual brief; the angle is the route.
  const briefHeading = params.previousHtml
    ? 'CHANGE REQUEST (apply this to the content above):'
    : 'BRIEF (the single message this content must land):';

  const allowedImageUrls = [
    params.brandTokens?.logoUrl ? 'the logo URL' : null,
    context.products.length ? 'the product image URLs from the catalogue' : null,
    params.referenceImageUrls?.length ? 'the user-provided reference image URLs listed above' : null,
  ].filter(Boolean).join(', ') || 'the logo URL and product image URLs';

  return `Design and build ONE piece of visual content as a single self-contained <div> component.

CANVAS & PLATFORM:
- Target platform: ${params.platform}
- Aspect ratio ${params.ratio} → exact canvas ${width}x${height}px (a ${orientation} frame)
- The root <div> MUST set, in its inline style: width:${width}px; height:${height}px; aspect-ratio:${width}/${height}; box-sizing:border-box; overflow:hidden; position:relative.
  Keep all three of width, height, and aspect-ratio so the content holds its ${params.ratio} proportions even if it's later rendered fluid.
- Design specifically for this ${orientation} shape and use the full space — the composition must be built for these proportions, not a square crop.

COMPOSITION FOR THIS VARIANT (variant ${variantIndex + 1} of ${params.count}):
CREATIVE ANGLE for this variant (its distinct hook and emphasis — make the creative land THIS angle):
${angle}
Build it in this style: ${archetype}
Make this variant genuinely distinct from the others — different focal point, layout skeleton, color emphasis, and typographic treatment. Do not just recolor the same template.

${brandSection}
${productsSection}${refImgSection}${playbooksSection}${refinementSection}
${briefHeading}
${params.prompt}
${extraSection}
TECHNICAL CONSTRAINTS:
- Output is ONE root <div> with the dimensions above. No <!DOCTYPE>, <html>, <head>, or <body>.
- Style each element with inline style="" attributes. The only allowed <style> tag is a single optional one as the first child of the root <div>, used solely for @import (Google Fonts) and static pseudo-elements, with every selector scoped to a unique class on the root div.
- Absolutely NO JavaScript: no <script>, no onclick, no event handlers. Absolutely NO animation: no @keyframes, animation, transition, or motion-based transform/@property — this is a single static frame, not a video.
- Decorative/abstract graphics via CSS gradients, inline SVG, CSS shapes, or base64 data URIs. The ONLY allowed external image URLs are ${allowedImageUrls} — embed those as real <img src="..."> tags. NEVER draw a real product or photo with SVG/CSS; SVG is for abstract decoration only.
- Position inner elements with flexbox/absolute positioning relative to the root div. Every text element must fit inside the canvas — size type so nothing clips or wraps awkwardly. Size product <img>s explicitly (width/height or object-fit:cover) so they never overflow the canvas.

Output ONLY the raw markup, starting with <div. No markdown, no code fences, no commentary.`.trim();
}

function extractHtml(raw: string): string {
  let text = raw.trim();
  // Strip markdown code fences: ```html ... ``` or ``` ... ```
  const fenceMatch = text.match(/^```(?:html|HTML)?\s*\n([\s\S]*?)```\s*$/);
  if (fenceMatch) text = fenceMatch[1].trim();
  // We expect a bare <div> component. If the model slipped and returned a full
  // document anyway, salvage the <body> inner markup so the iframe still works.
  const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) text = bodyMatch[1].trim();
  return text;
}

function isValidHtml(text: string): boolean {
  return /^<div[\s>]/i.test(text.trim());
}

async function generateContentHtml(
  params: ContentGenerateJobParams,
  variantIndex: number,
  width: number,
  height: number,
  orgId: string,
  angle: string,
  context: ContentContext,
): Promise<string> {
  const MAX_RETRIES = 2;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = new Date();
    try {
      const result = await generateText({
        model: openaiModel(CONTENT_MODEL),
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(params, variantIndex, width, height, angle, context),
        ...samplingFor(CONTENT_MODEL, 0.85),
        maxOutputTokens: 12000,
      });

      logAiTokenUsage({
        organisationId: orgId,
        modelName: CONTENT_MODEL,
        feature: 'content-studio',
        agentName: 'content-generator',
        operation: 'generate-html',
        usage: result.usage,
        finishReason: result.finishReason,
        latencyMs: Date.now() - startedAt.getTime(),
        startedAt,
        metadata: { treeId: params.treeId, variantIndex, platform: params.platform, ratio: params.ratio },
      });

      const html = extractHtml(result.text);
      if (!isValidHtml(html)) {
        throw new Error(`LLM returned invalid HTML (attempt ${attempt + 1})`);
      }

      return html;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const delay = 2000 * Math.pow(2, attempt);
        console.warn(`[content] generate attempt ${attempt + 1}/${MAX_RETRIES + 1} failed, retry in ${delay}ms:`, err);
        await new Promise<void>((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastErr;
}

async function callFrontendCallback(
  nodeId: string,
  treeId: string,
  htmlContent: string | null,
  status: 'SUCCEEDED' | 'FAILED',
  error?: string,
): Promise<void> {
  const frontendBaseUrl = process.env.NEXT_JS_URL;
  if (!frontendBaseUrl) {
    console.error('[content] NEXT_JS_URLnot set — cannot deliver callback');
    return;
  }

  const token = signServiceToken(
    { userId: 'service', orgId: 'service', purpose: 'content' },
    120,
  );

  const body = JSON.stringify({ nodeId, treeId, htmlContent, status, ...(error ? { error } : {}) });

  const MAX_RETRIES = 3;
  let backoff = 1000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${frontendBaseUrl}/api/content/callback`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-service-token': token,
        },
        body,
      });

      if (res.ok) return;

      console.warn(`[content] callback attempt ${attempt}/${MAX_RETRIES} returned ${res.status} for nodeId=${nodeId}`);
    } catch (err) {
      console.warn(`[content] callback attempt ${attempt}/${MAX_RETRIES} threw for nodeId=${nodeId}:`, err);
    }

    if (attempt < MAX_RETRIES) {
      await new Promise<void>((r) => setTimeout(r, backoff));
      backoff *= 2;
    }
  }

  console.error(`[content] callback permanently failed for nodeId=${nodeId}`);
}

export async function runContentGenerationJob(params: ContentGenerateJobParams): Promise<void> {
  const dims = DIMENSIONS[params.ratio] ?? DIMENSIONS['1:1'];

  // Resolve grounding context once per job: the merchant's real Shopify
  // products (with image URLs) and the brand's creative playbooks. Both are
  // best-effort and degrade to empty so generation never blocks on them.
  const [products, playbooks] = await Promise.all([
    fetchContentProducts(params.orgId, params.productIds),
    resolvePlaybooksForBrief(params.prompt, params.platform, params.orgId, params.extraInstructions),
  ]);
  const context: ContentContext = { products, playbooks };

  // Split the one brief into N distinct creative angles up-front so each
  // variant generates from its own concept rather than the identical prompt.
  const angles = await generateVariantAngles(params, params.nodeIds.length);

  await Promise.all(
    params.nodeIds.map(async (nodeId, index) => {
      try {
        const angle = angles[index] ?? params.prompt;
        const html = await generateContentHtml(params, index, dims.width, dims.height, params.orgId, angle, context);
        await callFrontendCallback(nodeId, params.treeId, html, 'SUCCEEDED');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[content] node ${nodeId} failed: ${message}`);
        await callFrontendCallback(nodeId, params.treeId, null, 'FAILED', message);
      }
    }),
  );
}
