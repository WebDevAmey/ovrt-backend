/**
 * Transform OpenAI API errors into user-friendly messages.
 * Prevents exposing raw API error details (rate limits, auth tokens, etc.) to users.
 */

export type OpenAIErrorType =
  | 'rate_limit'
  | 'authentication'
  | 'invalid_request'
  | 'server_error'
  | 'unknown';

export interface FriendlyError {
  type: OpenAIErrorType;
  message: string;
  isRetryable: boolean;
}

export function isOpenAIError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const error = err as Record<string, unknown>;
  return 'status' in error || 'code' in error || 'type' in error;
}

export function transformOpenAIError(err: unknown): FriendlyError {
  if (!err || typeof err !== 'object') {
    return {
      type: 'unknown',
      message: 'An unexpected error occurred. Please try again.',
      isRetryable: true,
    };
  }

  const error = err as Record<string, unknown>;
  const status = error.status as number | undefined;
  const code = error.code as string | undefined;
  const message = error.message as string | undefined;

  // Rate limit errors (429)
  if (status === 429 || code === 'rate_limit_exceeded') {
    return {
      type: 'rate_limit',
      message: 'The AI service is currently busy. Please wait a moment and try again.',
      isRetryable: true,
    };
  }

  // Authentication errors (401)
  if (status === 401 || code === 'invalid_api_key' || code === 'authentication_error') {
    return {
      type: 'authentication',
      message: 'There was an authentication issue with the AI service. Please contact support.',
      isRetryable: false,
    };
  }

  // Invalid request errors (400)
  if (status === 400 || code === 'invalid_request_error') {
    return {
      type: 'invalid_request',
      message: 'The request was invalid. Please rephrase your question and try again.',
      isRetryable: true,
    };
  }

  // Server errors (5xx)
  if (status && status >= 500) {
    return {
      type: 'server_error',
      message: 'The AI service is temporarily unavailable. Please try again in a moment.',
      isRetryable: true,
    };
  }

  // Timeout or network errors
  if (code === 'ETIMEDOUT' || code === 'ECONNREFUSED' || message?.includes('timeout')) {
    return {
      type: 'server_error',
      message: 'Connection timeout. Please check your internet and try again.',
      isRetryable: true,
    };
  }

  // Fallback for any other error
  return {
    type: 'unknown',
    message: 'An unexpected error occurred. Please try again.',
    isRetryable: true,
  };
}
