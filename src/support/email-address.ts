/**
 * Email address parsing (pure)
 * ============================
 * Inbound mail's `From` header is a *display address*, not a bare email:
 * `"Jane Doe" <jane@acme.com>`, `Jane Doe <jane@acme.com>`, `jane@acme.com`,
 * or `<jane@acme.com>`. The Gmail agent used to store and compare the WHOLE
 * header as if it were the email — which meant the Shopify `email:` order
 * lookup was built from `"jane doe" <jane@acme.com>` (matching nothing) and the
 * defence-in-depth filter compared a bare order email against that full string
 * (never equal). Every order lookup returned zero rows, so the agent told real
 * customers their real order "does not exist".
 *
 * This helper is the single source of truth for turning a raw address header
 * into a usable, normalised email. Channel adapters call it so the agent core
 * always sees a clean address regardless of how the channel framed it.
 */

export type ParsedAddress = {
  /** The display name if present (`Jane Doe`), else null. */
  name: string | null;
  /** The lower-cased, trimmed bare email (`jane@acme.com`), or null if none found. */
  email: string | null;
};

// Pulls the email out of `<...>` if present, else the first token that looks
// like an address. Intentionally permissive — we'd rather extract a slightly
// odd address than fail closed and tell a customer their order is missing.
const ANGLE_RE = /<([^<>]+)>/;
const BARE_RE = /[^\s<>"',;]+@[^\s<>"',;]+/;

/**
 * Parse a raw address header into { name, email }. Never throws. `email` is
 * normalised (trimmed + lower-cased); `name` is the un-quoted display name.
 */
export function parseEmailAddress(raw: string | null | undefined): ParsedAddress {
  const input = (raw ?? '').trim();
  if (!input) return { name: null, email: null };

  let email: string | null = null;
  let namePart = input;

  const angle = input.match(ANGLE_RE);
  if (angle) {
    email = angle[1].trim();
    namePart = input.slice(0, angle.index).trim();
  } else {
    const bare = input.match(BARE_RE);
    if (bare) {
      email = bare[0].trim();
      namePart = input.slice(0, bare.index).trim();
    }
  }

  // Strip surrounding quotes from a display name (`"Jane Doe"` → `Jane Doe`).
  const name = namePart.replace(/^["']|["']$/g, '').trim() || null;
  const normEmail = email ? email.toLowerCase() : null;

  return { name, email: normEmail };
}

/** Convenience: just the normalised bare email, or null. */
export function extractEmail(raw: string | null | undefined): string | null {
  return parseEmailAddress(raw).email;
}
