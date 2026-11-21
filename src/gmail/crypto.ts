/**
 * Google token-ref decryption
 * ===========================
 * GmailAccount.accessTokenRef / refreshTokenRef are AES-256-GCM ciphertexts in
 * the same "v1:<iv>:<tag>:<data>" envelope the frontend lib/crypto.ts produces
 * (and that src/agents/shopify/credentials.ts already decrypts). The AES key is
 * derived identically: sha256(DATASOURCE_ENC_KEY).
 *
 * Kept separate from the Shopify resolver because that one has a Shopify-token
 * dev passthrough (shpat_…) that does not apply to Google OAuth tokens.
 */

import { createDecipheriv, createHash } from 'node:crypto';

function getEncryptionKey(): Buffer {
  const raw = process.env.DATASOURCE_ENC_KEY;
  if (!raw) throw new Error('DATASOURCE_ENC_KEY env var is not set');
  return createHash('sha256').update(raw).digest();
}

/**
 * Decrypt a "v1:<iv>:<tag>:<data>" token ref. Google OAuth tokens have no
 * recognizable prefix, so unlike the Shopify path there is no plaintext
 * passthrough — a malformed ref is always an error.
 */
export function decryptTokenRef(encrypted: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error(
      `token ref has unexpected format. Expected "v1:<iv>:<tag>:<data>" ` +
        `(AES-256-GCM from frontend encryptString). Got prefix: "${encrypted.slice(0, 12)}"`,
    );
  }

  const [, ivB64, tagB64, dataB64] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
