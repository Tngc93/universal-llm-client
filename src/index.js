// universal-llm-client — bring your own AI.
//
// One small client for OpenAI, Anthropic, Gemini, OpenRouter, Groq, Mistral,
// DeepSeek, xAI, Together, Ollama, LM Studio and any OpenAI-compatible
// endpoint, with fallback chains, retries, structured JSON output, streaming
// and an offline mock provider. Zero dependencies; uses the platform's fetch.

import { AIError, errorFromResponse, normalizeError, redact } from './errors.js';
import { PROVIDERS } from './providers.js';
import { parseSSE } from './sse.js';
import { extractJSON, validateSchema, exampleFromSchema } from './json.js';
import * as openaiProtocol from './protocols/openai.js';
import * as anthropicProtocol from './protocols/anthropic.js';
import * as geminiProtocol from './protocols/gemini.js';

export { AIError, PROVIDERS, validateSchema, extractJSON, redact };

const PROTOCOLS = { openai: openaiProtocol, anthropic: anthropicProtocol, gemini: geminiProtocol };
const DEFAULTS = { timeoutMs: 60_000, maxRetries: 2, maxTokens: 1024 };
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', 'host.docker.internal']);

const defaultEnv = () => (typeof globalThis.process !== 'undefined' && globalThis.process.env) || {};
const isBrowser = () => typeof globalThis.window !== 'undefined' && typeof globalThis.document !== 'undefined';

function firstEnv(env, names) {
  for (const n of [].concat(names ?? [])) if (n && env[n]) return env[n];
  return undefined;
}

// ---------------------------------------------------------------------------
// Provider resolution
// ---------------------------------------------------------------------------

function resolveProvider(input, shared, { primary }) {
  const cfg = typeof input === 'string' ? parseProviderSpec(input) : { ...input };
  const preset = PROVIDERS[cfg.provider];
  if (!preset) {
    throw new AIError('configuration', `Unknown provider "${cfg.provider}". Known providers: ${Object.keys(PROVIDERS).join(', ')}.`);
  }
  const env = shared.env;
  const model = cfg.model ?? firstEnv(env, preset.modelEnv) ?? (primary ? env.LLM_MODEL : undefined) ?? (preset.protocol === 'mock' ? 'mock' : undefined);
  if (!model) {
    const hint = preset.modelEnv ? ` or set ${preset.modelEnv}` : '';
    throw new AIError('configuration', `No model set for provider "${preset.id}". Pass { model: "…" }${hint}.`, { provider: preset.id });
  }
  const apiKey = cfg.apiKey ?? firstEnv(env, preset.apiKeyEnv) ?? (preset.id === 'openai-compatible' ? env.LLM_API_KEY : undefined);
  const baseUrl = String(cfg.baseUrl ?? firstEnv(env, preset.baseUrlEnv) ?? preset.baseUrl ?? '').replace(/\/+$/, '');

  return {
    preset,
    model,
    apiKey: apiKey || undefined,
    baseUrl,
    headers: { ...shared.headers, ...cfg.headers },
    jsonMode: cfg.jsonMode ?? shared.jsonMode,
    timeoutMs: cfg.timeoutMs ?? shared.timeoutMs,
    maxRetries: cfg.maxRetries ?? shared.maxRetries,
    fetch: cfg.fetch ?? shared.fetch,
    mock: cfg.mock ?? (preset.protocol === 'mock' ? shared.mock : undefined),
    allowInsecureHttp: cfg.allowInsecureHttp ?? shared.allowInsecureHttp,
    allowBrowser: cfg.allowBrowser ?? shared.allowBrowser,
  };
}

function parseProviderSpec(spec) {
  const s = String(spec).trim();
  const idx = s.indexOf(':');
  return idx === -1 ? { provider: s } : { provider: s.slice(0, idx), model: s.slice(idx + 1) || undefined };
}

/** Checks done right before a request so that a misconfigured provider can fall back. */
function preflight(p) {
  const id = p.preset.id;
  if (p.preset.protocol === 'mock') return;
  if (!p.baseUrl) throw new AIError('configuration', `Provider "${id}" has no base URL. Pass { baseUrl } or set ${p.preset.baseUrlEnv}.`, { provider: id });
  let url;
  try {
    url = new URL(p.baseUrl);
  } catch {
    throw new AIError('configuration', `Provider "${id}" has an invalid base URL.`, { provider: id });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AIError('configuration', `Provider "${id}": the base URL must not contain credentials, a query string or a fragment. Pass the API key with { apiKey } instead.`, { provider: id });
  }
  if (p.preset.requiresKey && !p.apiKey) {
    const env = [].concat(p.preset.apiKeyEnv ?? []).join(' or ');
    throw new AIError('configuration', `Provider "${id}" needs an API key. Pass { apiKey } or set ${env}.`, { provider: id });
  }
  if (p.apiKey && url.protocol === 'http:' && !LOOPBACK.has(url.hostname) && !p.allowInsecureHttp) {
    throw new AIError('configuration', `Provider "${id}": refusing to send an API key over plain HTTP to ${url.hostname}. Use HTTPS, or set { allowInsecureHttp: true } for a trusted private network.`, { provider: id });
  }
  if (p.apiKey && isBrowser() && !p.preset.local && !p.allowBrowser) {
    throw new AIError('configuration', `Provider "${id}": calling a cloud provider with an API key from a browser exposes the key to anyone who opens dev tools. Call it from your server, or set { allowBrowser: true } if each user supplies their own key.`, { provider: id });
  }
  if (typeof p.fetch !== 'function') throw new AIError('configuration', 'No fetch implementation available. Use Node 18+ or pass { fetch }.', { provider: id });
}

// ---------------------------------------------------------------------------
// Transport: timeout, cancellation, retries
// ---------------------------------------------------------------------------

function linkSignals(outer, inner) {
  if (!outer) return () => {};
  if (outer.aborted) inner.abort(outer.reason);
  const onAbort = () => inner.abort(outer.reason);
  outer.addEventListener('abort', onAbort, { once: true });
  return () => outer.removeEventListener('abort', onAbort);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
  });
}

async function withRetry(p, task, { signal, onRetry }) {
  const secrets = [p.apiKey].filter(Boolean);
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const unlink = linkSignals(signal, controller);
    const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), p.timeoutMs);
    let keepLinked = false;
    try {
      const result = await task(controller.signal, () => clearTimeout(timer));
      // A stream keeps reading the body after we return, so the caller's abort
      // signal must stay connected to this attempt's controller.
      keepLinked = Boolean(result?.res);
      return result;
    } catch (raw) {
      const err = normalizeError(raw, p.preset.id, secrets, { userAborted: Boolean(signal?.aborted) });
      const retryAfter = err.retryAfterMs;
      const canRetry = err.retryable && attempt < p.maxRetries && !(retryAfter !== undefined && retryAfter > 60_000);
      if (!canRetry) throw err;
      const backoff = retryAfter ?? Math.min(8000, 400 * 2 ** attempt * (0.75 + Math.random() * 0.5));
      onRetry?.({ provider: p.preset.id, model: p.model, attempt: attempt + 1, delayMs: Math.round(backoff), code: err.code });
      try {
        await sleep(backoff, signal);
      } catch {
        throw new AIError('aborted', `${p.preset.id}: request was aborted by the caller`, { provider: p.preset.id });
      }
    } finally {
      clearTimeout(timer);
      if (!keepLinked) unlink();
    }
  }
}

async function postOnce(p, req, { stream, signal, onRetry }) {
  const proto = PROTOCOLS[p.preset.protocol];
  const { url, init } = proto.buildRequest(p, req, { stream });
  const secrets = [p.apiKey].filter(Boolean);
  return withRetry(
    p,
    async (attemptSignal, clearTimer) => {
      const res = await p.fetch(url, { ...init, signal: attemptSignal });
      if (!res.ok) throw await errorFromResponse(res, p.preset.id, secrets);
      if (stream) {
        clearTimer(); // the timeout covers connecting; a long generation may stream for minutes
        return { res, attemptSignal };
      }
      const payload = await res.json();
      return { payload };
    },
    { signal, onRetry },
  );
}

// ---------------------------------------------------------------------------
// Request normalisation
// ---------------------------------------------------------------------------

function normalizeRequest(input) {
  if (!input || typeof input !== 'object') throw new AIError('invalid_request', 'generate() expects an options object, e.g. { prompt: "…" }.');
  const systemParts = [];
  if (input.system) systemParts.push(String(input.system));
  const messages = [];
  for (const m of input.messages ?? []) {
    if (!m || typeof m.content !== 'string') throw new AIError('invalid_request', 'Each message needs a string `content`.');
    if (m.role === 'system') systemParts.push(m.content);
    else if (m.role === 'user' || m.role === 'assistant') messages.push({ role: m.role, content: m.content });
    else throw new AIError('invalid_request', `Unsupported message role "${m.role}". Use "user", "assistant" or "system".`);
  }
  if (input.prompt !== undefined) messages.push({ role: 'user', content: String(input.prompt) });
  if (!messages.length) throw new AIError('invalid_request', 'Pass a `prompt` or at least one user message.');
  const maxTokens = input.maxTokens ?? DEFAULTS.maxTokens;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new AIError('invalid_request', '`maxTokens` must be a positive integer.');
  return {
    system: systemParts.join('\n\n') || undefined,
    messages,
    maxTokens,
    temperature: input.temperature,
    stop: input.stop ? [].concat(input.stop) : undefined,
    extraBody: input.providerOptions,
  };
}

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

const estimateTokens = (s) => Math.max(1, Math.ceil(String(s).length / 4));

async function mockGenerate(p, req) {
  const mock = p.mock ?? {};
  if (mock.fail) throw new AIError(mock.fail, `mock: simulated ${mock.fail} error`, { provider: 'mock' });
  if (mock.delayMs) await sleep(mock.delayMs);
  const last = req.messages[req.messages.length - 1]?.content ?? '';
  let reply = typeof mock.reply === 'function' ? await mock.reply(req) : mock.reply;
  let data;
  let hasData = false;
  if (req.json) {
    if (reply !== undefined && typeof reply !== 'string') data = reply;
    else if (typeof reply === 'string') data = extractJSON(reply);
    else data = exampleFromSchema(req.json.schema);
    hasData = true;
    reply = JSON.stringify(data);
  }
  const text = reply ?? `[mock] ${last.replace(/\s+/g, ' ').slice(0, 120)}`;
  const inputText = [req.system ?? '', ...req.messages.map((m) => m.content)].join('\n');
  return { text: String(text), data, hasData, finishReason: 'stop', usage: { inputTokens: estimateTokens(inputText), outputTokens: estimateTokens(text) } };
}

async function* mockStream(p, req) {
  const res = await mockGenerate(p, req);
  for (const piece of res.text.match(/\S+\s*/g) ?? [res.text]) yield { type: 'text', text: piece };
  yield { type: 'done', usage: res.usage, finishReason: res.finishReason };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function sumUsage(a, b) {
  return { inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0), outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0) };
}

/**
 * Create a client.
 * @param {import('./index.js').AIOptions} options
 * @returns {import('./index.js').AIClient}
 */
export function createAI(options = {}) {
  const shared = {
    env: options.env ?? defaultEnv(),
    headers: options.headers ?? {},
    jsonMode: options.jsonMode,
    timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
    maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
    fetch: options.fetch ?? globalThis.fetch?.bind(globalThis),
    mock: options.mock,
    allowInsecureHttp: options.allowInsecureHttp ?? false,
    allowBrowser: options.allowBrowser ?? false,
  };
  if (!options.provider) throw new AIError('configuration', 'createAI() needs a `provider`, e.g. createAI({ provider: "anthropic", model: "…" }). Use fromEnv() to pick one from environment variables.');

  const chain = [resolveProvider(options, shared, { primary: true }), ...[].concat(options.fallback ?? []).map((f) => resolveProvider(f, shared, { primary: false }))];
  const fallbackOn = options.fallbackOn ?? ((err) => err.code !== 'aborted');
  const hooks = { onRetry: options.onRetry, onFallback: options.onFallback };

  async function runChain(work, signal) {
    const attempts = [];
    for (let i = 0; i < chain.length; i++) {
      const p = chain[i];
      try {
        preflight(p);
        const out = await work(p);
        attempts.push({ provider: p.preset.id, model: p.model, ok: true });
        return { ...out, provider: p.preset.id, model: p.model, attempts };
      } catch (raw) {
        const err = normalizeError(raw, p.preset.id, [p.apiKey].filter(Boolean), { userAborted: Boolean(signal?.aborted) });
        attempts.push({ provider: p.preset.id, model: p.model, ok: false, code: err.code });
        const next = chain[i + 1];
        if (!next || !fallbackOn(err)) {
          err.attempts = attempts;
          throw err;
        }
        hooks.onFallback?.({ from: { provider: p.preset.id, model: p.model }, to: { provider: next.preset.id, model: next.model }, error: err });
      }
    }
    throw new AIError('configuration', 'No providers configured.');
  }

  async function generateWith(p, req, signal) {
    if (p.preset.protocol === 'mock') return mockGenerate(p, req);
    const { payload } = await postOnce(p, req, { stream: false, signal, onRetry: hooks.onRetry });
    return PROTOCOLS[p.preset.protocol].parseResponse(payload, p, req);
  }

  async function generate(input) {
    const req = normalizeRequest(input);
    const out = await runChain((p) => generateWith(p, req, input.signal), input.signal);
    const { hasData, data, ...rest } = out;
    return rest;
  }

  async function generateJSON(input) {
    if (!input?.schema || typeof input.schema !== 'object') throw new AIError('invalid_request', 'generateJSON() needs a JSON Schema in `schema`.');
    const base = normalizeRequest(input);
    const name = String(input.name ?? 'result').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'result';
    const repairs = input.repairAttempts ?? 1;

    return runChain(async (p) => {
      let req = { ...base, json: { schema: input.schema, name, strict: input.strict } };
      let usage = { inputTokens: 0, outputTokens: 0 };
      for (let round = 0; ; round++) {
        const res = await generateWith(p, req, input.signal);
        usage = sumUsage(usage, res.usage);
        let data;
        let issues;
        try {
          data = res.hasData ? res.data : extractJSON(res.text);
          issues = validateSchema(data, input.schema);
          if (!issues.length && typeof input.validate === 'function') {
            try {
              const v = await input.validate(data);
              if (v !== undefined) data = v;
            } catch (e) {
              issues = [String(e?.message ?? e).slice(0, 500)];
            }
          }
        } catch (e) {
          issues = [`Output was not valid JSON: ${e.message}`];
        }
        if (!issues.length) {
          return { data, text: res.hasData ? JSON.stringify(data) : res.text, usage, finishReason: res.finishReason, repairs: round };
        }
        if (round >= repairs) {
          const err = new AIError('invalid_response', `${p.preset.id}: output did not match the schema after ${round + 1} attempt(s): ${issues.slice(0, 5).join('; ')}`, { provider: p.preset.id });
          err.issues = issues;
          throw err;
        }
        req = {
          ...req,
          messages: [
            ...req.messages,
            { role: 'assistant', content: res.hasData ? JSON.stringify(data) : res.text || '(empty)' },
            { role: 'user', content: `That output does not match the required JSON Schema:\n- ${issues.slice(0, 10).join('\n- ')}\nReply again with corrected JSON only.` },
          ],
        };
      }
    }, input.signal);
  }

  async function* stream(input) {
    const req = normalizeRequest(input);
    const signal = input.signal;
    const attempts = [];
    for (let i = 0; i < chain.length; i++) {
      const p = chain[i];
      let emitted = false;
      try {
        preflight(p);
        let events;
        if (p.preset.protocol === 'mock') {
          events = mockStream(p, req);
        } else {
          const { res } = await postOnce(p, req, { stream: true, signal, onRetry: hooks.onRetry });
          events = PROTOCOLS[p.preset.protocol].parseStream(parseSSE(res.body), p);
        }
        let text = '';
        for await (const ev of events) {
          if (ev.type === 'text') {
            emitted = true;
            text += ev.text;
            yield ev;
          } else if (ev.type === 'done') {
            attempts.push({ provider: p.preset.id, model: p.model, ok: true });
            yield { type: 'done', text, usage: ev.usage, finishReason: ev.finishReason, provider: p.preset.id, model: p.model, attempts };
            return;
          }
        }
        return;
      } catch (raw) {
        const err = normalizeError(raw, p.preset.id, [p.apiKey].filter(Boolean), { userAborted: Boolean(signal?.aborted) });
        attempts.push({ provider: p.preset.id, model: p.model, ok: false, code: err.code });
        const next = chain[i + 1];
        // Once text has reached the caller we cannot silently switch models mid-answer.
        if (emitted || !next || !fallbackOn(err)) {
          err.attempts = attempts;
          throw err;
        }
        hooks.onFallback?.({ from: { provider: p.preset.id, model: p.model }, to: { provider: next.preset.id, model: next.model }, error: err });
      }
    }
  }

  async function* streamText(input) {
    for await (const ev of stream(input)) if (ev.type === 'text') yield ev.text;
  }

  function info() {
    return chain.map((p) => ({
      provider: p.preset.id,
      name: p.preset.name,
      model: p.model,
      protocol: p.preset.protocol,
      baseUrl: p.baseUrl || undefined,
      hasApiKey: Boolean(p.apiKey),
      local: Boolean(p.preset.local),
    }));
  }

  const client = { generate, generateJSON, stream, streamText, info };
  // Never let the client (or its closure) leak keys through logging or serialisation.
  Object.defineProperty(client, 'toJSON', { value: () => ({ providers: info() }), enumerable: false });
  Object.defineProperty(client, Symbol.for('nodejs.util.inspect.custom'), { value: () => `AIClient ${JSON.stringify(info())}`, enumerable: false });
  return Object.freeze(client);
}

/**
 * Build a client from environment variables.
 *   LLM_PROVIDER   anthropic | openai | gemini | … (default: mock)
 *   LLM_MODEL      model id for the primary provider (or the provider's own *_MODEL var)
 *   LLM_FALLBACK   comma-separated "provider" or "provider:model" entries
 *   LLM_TIMEOUT_MS, LLM_MAX_RETRIES
 * API keys come from each provider's usual variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, …).
 */
export function fromEnv(overrides = {}) {
  const env = overrides.env ?? defaultEnv();
  const provider = overrides.provider ?? env.LLM_PROVIDER ?? 'mock';
  const fallbackRaw = overrides.fallback ?? (env.LLM_FALLBACK ? env.LLM_FALLBACK.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
  const num = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return createAI({
    ...overrides,
    env,
    provider,
    model: overrides.model ?? env.LLM_MODEL,
    fallback: fallbackRaw,
    timeoutMs: overrides.timeoutMs ?? num(env.LLM_TIMEOUT_MS),
    maxRetries: overrides.maxRetries ?? num(env.LLM_MAX_RETRIES),
  });
}
