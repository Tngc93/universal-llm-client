// Normalised, secret-free errors.
//
// Every provider failure becomes an AIError with a stable `code`, so callers can
// branch on what happened (rate limit vs. bad key vs. outage) without parsing
// each vendor's error format. Messages never contain API keys.

/** @typedef {import('./index.js').AIErrorCode} AIErrorCode */

const RETRYABLE = new Set(['rate_limit', 'overloaded', 'unavailable', 'timeout', 'network']);

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-or-v1-[A-Za-z0-9_-]{8,}/g,
  /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bgsk_[A-Za-z0-9]{16,}/g,
  /\bxai-[A-Za-z0-9]{16,}/g,
  /\bhf_[A-Za-z0-9]{16,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /([?&](?:key|api_key|apikey|token)=)[^&\s"']+/gi,
];

/** Remove anything that looks like a credential from a string. */
export function redact(value, extraSecrets = []) {
  let out = String(value ?? '');
  for (const secret of extraSecrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join('[REDACTED]');
  }
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, prefix) => (typeof prefix === 'string' && m.startsWith(prefix) ? `${prefix}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}

export class AIError extends Error {
  /**
   * @param {AIErrorCode} code
   * @param {string} message
   * @param {{ provider?: string, status?: number, retryAfterMs?: number, cause?: unknown, attempts?: Array<{provider: string, model?: string, code: string}> }} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.provider = details.provider;
    this.status = details.status;
    this.retryable = RETRYABLE.has(code);
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
    if (details.attempts) this.attempts = details.attempts;
    if (details.cause !== undefined) Object.defineProperty(this, 'cause', { value: details.cause, enumerable: false });
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, provider: this.provider, status: this.status, retryable: this.retryable };
  }
}

function parseRetryAfter(headers) {
  if (!headers || typeof headers.get !== 'function') return undefined;
  const ms = headers.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const s = headers.get('retry-after');
  if (!s) return undefined;
  if (Number.isFinite(Number(s))) return Math.max(0, Number(s) * 1000);
  const date = Date.parse(s);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function extractVendorError(body) {
  // OpenAI / compatible:   { error: { message, type, code } }
  // Anthropic:             { type: 'error', error: { type, message } }
  // Gemini:                { error: { code, message, status } }
  if (!body || typeof body !== 'object') return { message: typeof body === 'string' ? body : '' };
  const e = body.error && typeof body.error === 'object' ? body.error : body;
  return {
    message: String(e.message ?? body.message ?? ''),
    type: String(e.type ?? e.status ?? ''),
    code: String(e.code ?? ''),
  };
}

/**
 * Build an AIError from an HTTP error response.
 * @param {Response} response
 * @param {string} provider
 * @param {string[]} secrets values to scrub from the message
 */
export async function errorFromResponse(response, provider, secrets = []) {
  let body = null;
  let text = '';
  try {
    text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const { message, type, code } = extractVendorError(body);
  const status = response.status;
  const hay = `${message} ${type} ${code}`.toLowerCase();
  let kind;

  if (hay.includes('context_length') || hay.includes('context window') || hay.includes('maximum context') || hay.includes('too many tokens') || hay.includes('prompt is too long')) kind = 'context_length';
  else if (hay.includes('insufficient_quota') || hay.includes('credit balance') || hay.includes('insufficient credits') || hay.includes('billing')) kind = 'insufficient_credits';
  else if (status === 401 || hay.includes('authentication_error') || hay.includes('invalid_api_key') || hay.includes('api key not valid') || hay.includes('unauthenticated') || hay.includes('incorrect api key')) kind = 'authentication';
  else if (status === 403 || hay.includes('permission')) kind = 'permission';
  else if (status === 402) kind = 'insufficient_credits';
  else if (status === 404 || hay.includes('not_found') || hay.includes('model_not_found')) kind = 'not_found';
  else if (status === 408) kind = 'timeout';
  else if (status === 429 || hay.includes('rate_limit') || hay.includes('resource_exhausted')) kind = 'rate_limit';
  else if (status === 529 || hay.includes('overloaded')) kind = 'overloaded';
  else if (status >= 500) kind = 'unavailable';
  else if (hay.includes('safety') || hay.includes('content_filter') || hay.includes('content management policy')) kind = 'content_filter';
  else kind = 'invalid_request';

  const detail = message ? `: ${message}` : '';
  const human = redact(`${provider} returned HTTP ${status}${detail}`, secrets).slice(0, 500);
  return new AIError(kind, human, { provider, status, retryAfterMs: parseRetryAfter(response.headers) });
}

/** Normalise anything thrown during a request (fetch failures, aborts, JSON errors). */
export function normalizeError(error, provider, secrets = [], { userAborted = false } = {}) {
  if (error instanceof AIError) return error;
  const name = error?.name;
  if (userAborted) return new AIError('aborted', `${provider}: request was aborted by the caller`, { provider, cause: error });
  if (name === 'AbortError' || name === 'TimeoutError') return new AIError('timeout', `${provider}: request timed out`, { provider, cause: error });
  if (error instanceof SyntaxError) return new AIError('invalid_response', redact(`${provider}: response was not valid JSON (${error.message})`, secrets), { provider, cause: error });
  const msg = redact(String(error?.message ?? error), secrets);
  if (error instanceof TypeError || /fetch failed|network|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket/i.test(msg)) {
    const cause = error?.cause?.code ? ` (${error.cause.code})` : '';
    return new AIError('network', `${provider}: network error${cause}: ${msg}`.slice(0, 500), { provider, cause: error });
  }
  return new AIError('unavailable', `${provider}: ${msg}`.slice(0, 500), { provider, cause: error });
}
