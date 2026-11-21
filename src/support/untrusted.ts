/**
 * Prompt-injection fencing for untrusted customer text
 * =====================================================
 * Customer-supplied text (message bodies, names, subjects) is placed inside
 * XML-ish tags in the prompt (see prompt.ts) so the model can distinguish
 * "data from a customer" from "instructions from us". That only works if the
 * customer can't forge the closing tag and break out — so before fencing,
 * neutralise any sequence that looks like our delimiter tags.
 */

/** Angle brackets that could open/close one of our prompt delimiter tags. */
const DANGEROUS_OPEN =
  /<(\/?customer_message|\/?customer_name|\/?customer_topic|\/?conversation|system|\/?grounding)/gi;

/**
 * Neutralise delimiter-tag lookalikes and cap length. Replaces `<` in any
 * `<customer_message/name/topic...`, `</customer_message/name/topic...`,
 * `<conversation>`/`</conversation>`, `<system...`, `<grounding...` /
 * `</grounding...` sequence with a visually-similar non-ASCII character so
 * the text can never close or spoof a fence, then truncates to maxChars.
 */
export function fenceUntrusted(text: string, maxChars: number): string {
  const neutralised = (text ?? '').replace(DANGEROUS_OPEN, (m) => `‹${m.slice(1)}`);
  if (neutralised.length <= maxChars) return neutralised;
  return `${neutralised.slice(0, maxChars)}…`;
}
