// Langfuse SDK is initialized separately in langfuse-tracing.ts
// This file is kept for backward compatibility but registerTelemetry does nothing.
// All tracing now goes through the direct Langfuse SDK, not @vercel/otel.

export function registerTelemetry() {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    console.warn('Langfuse API keys not found in environment, tracing disabled.');
    return;
  }

  console.log('[telemetry] Langfuse SDK initialized in langfuse-tracing.ts');
}
