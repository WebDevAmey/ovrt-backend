/**
 * WhatsApp triage signal extraction
 * ==================================
 * WhatsApp 1:1 messages carry no bulk/promo header concept the way Gmail
 * labels/headers do, so there's nothing channel-native to flag here. Triage
 * relies entirely on the classifier's text lexicon for this channel.
 */

import type { ChannelSignals } from '../support/channel-adapter.js';

export function extractWhatsAppSignals(): ChannelSignals {
  return { hardNegative: false, softNegative: false, isReply: false, reasons: [] };
}
