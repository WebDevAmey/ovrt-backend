/**
 * WhatsApp routes
 * ===============
 * Mounted at /whatsapp in src/index.ts.
 *
 *   GET  /whatsapp/webhook       public — Meta's webhook URL handshake.
 *   POST /whatsapp/webhook       public — Meta's message delivery push.
 */

import { Hono } from 'hono';
import { handleWhatsAppVerify, handleWhatsAppEvent } from './webhook.js';

const whatsapp = new Hono();

whatsapp.get('/webhook', handleWhatsAppVerify);
whatsapp.post('/webhook', handleWhatsAppEvent);

export { whatsapp };
