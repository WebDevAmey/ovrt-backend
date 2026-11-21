/**
 * WhatsApp credentials resolver
 * =============================
 * Loads a SupportChannelConnection (channelType=WHATSAPP) and decrypts its
 * access token. Unlike Gmail there is no refresh step — Embedded Signup
 * issues a long-lived System User token, so this just decrypts and returns.
 */

import { prisma } from '../prisma.js';
import { decryptTokenRef } from './crypto.js';

export type WhatsAppConnection = {
  connectionId: string;
  organisationId: string;
  phoneNumberId: string;
  accessToken: string;
};

export async function resolveWhatsAppConnection(connectionId: string): Promise<WhatsAppConnection> {
  const row = await prisma.supportChannelConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      organisationId: true,
      externalAccountId: true,
      accessTokenRef: true,
    },
  });

  if (!row) throw new Error(`WhatsApp connection not found: ${connectionId}`);
  if (!row.accessTokenRef) throw new Error(`WhatsApp connection ${connectionId} has no access token`);

  return {
    connectionId: row.id,
    organisationId: row.organisationId,
    phoneNumberId: row.externalAccountId,
    accessToken: decryptTokenRef(row.accessTokenRef),
  };
}
