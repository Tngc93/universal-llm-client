import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { createAI, fromEnv, AIError } from '../src/index.js';
import { startFakeServer, json, sse, hang } from './fake-server.mjs';

let srv;
before(async () => { srv = await startFakeServer(); });
after(async () => { await srv.close(); });
beforeEach(() => srv.reset());

const KEY = 'sk-' + 'proj-' + 'abcdefghijklmnopqrstuvwxyz0123';
const env = {};
const ok = (text = 'ok') => json(200, { choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const openai = (extra = {}) => createAI({ provider: 'openai', model: 'm', apiKey: KEY, baseUrl: `${srv.url}/v1`, env, ...extra });

// ---------------------------------------------------------------- errors & retries

test('401 → authentication, not retried', async () => {
  srv.always(json(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error', code: 'invalid_api_key' } }));
  await assert.rejects(openai().generate({ prompt: 'x' }), (err) => {
    assert.ok(err instanceof AIError);
    assert.equal(err.code, 'authentication');
    assert.equal(err.status, 401);
    assert.equal(err.retryable, false);
    return true;
  });
  assert.equal(srv.requests.length, 1);
});

test('429 with Retry-After is retried, then succeeds', async () => {
  srv.next(json(429, { error: { message: 'Rate limit reached' } }, { 'retry-after': '0' }), ok('after retry'));
  const retries = [];
  const res = await openai({ onRetry: (e) => retries.push(e) }).generate({ prompt: 'x' });
  assert.equal(res.text, 'after retry');
  assert.equal(srv.requests.length, 2);
  assert.equal(retries[0].code, 'rate_limit');
  assert.equal(retries[0].delayMs, 0);
});

test('529 → overloaded and retried up to maxRetries', async () => {
  srv.always(json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { 'retry-after-ms': '1' }));
  const ai = createAI({ provider: 'anthropic', model: 'c', apiKey: KEY, baseUrl: srv.url, env, maxRetries: 2 });
  await assert.rejects(ai.generate({ prompt: 'x' }), { code: 'overloaded' });
  assert.equal(srv.requests.length, 3);
});

test('insufficient quota and context length are recognised', async () => {
  srv.next(json(429, { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }));
  await assert.rejects(openai({ maxRetries: 0 }).generate({ prompt: 'x' }), { code: 'insufficient_credits' });
  srv.next(json(400, { error: { message: "This model's maximum context length is 8192 tokens", code: 'context_length_exceeded' } }));
  await assert.rejects(openai({ maxRetries: 0 }).generate({ prompt: 'x' }), { code: 'context_length' });
  srv.next(json(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }));
  const gem = createAI({ provider: 'gemini', model: 'g', apiKey: KEY, baseUrl: `${srv.url}/v1beta`, env, maxRetries: 0 });
  await assert.rejects(gem.generate({ prompt: 'x' }), { code: 'authentication' });
});

test('error messages never contain the API key', async () => {
  srv.next(json(400, { error: { message: `Bad request for key ${KEY} and Bearer ${KEY}` } }));
  await assert.rejects(openai({ maxRetries: 0 }).generate({ prompt: 'x' }), (err) => {
    assert.ok(!err.message.includes(KEY), err.message);
    assert.ok(!JSON.stringify(err).includes(KEY));
    assert.match(err.message, /\[REDACTED\]/);
    return true;
  });
});

test('timeout → timeout code after retries', async () => {
  srv.always(hang(400));
  const started = Date.now();
  await assert.rejects(openai({ timeoutMs: 60, maxRetries: 1 }).generate({ prompt: 'x' }), { code: 'timeout' });
  assert.equal(srv.requests.length, 2);
  assert.ok(Date.now() - started < 3000);
});

test('caller abort → aborted, no retry, no fallback', async () => {
  srv.always(hang(500));
  const controller = new AbortController();
  const ai = openai({ fallback: ['mock'] });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(ai.generate({ prompt: 'x', signal: controller.signal }), (err) => {
    assert.equal(err.code, 'aborted');
    assert.deepEqual(err.attempts.map((a) => a.provider), ['openai']);
    return true;
  });
});

test('network error (nothing listening)', async () => {
  const ai = createAI({ provider: 'ollama', model: 'x', baseUrl: 'http://127.0.0.1:9/v1', env, maxRetries: 0 });
  await assert.rejects(ai.generate({ prompt: 'x' }), { code: 'network' });
});

// ---------------------------------------------------------------- fallback

test('fallback chain: primary outage → secondary; attempts recorded', async () => {
  srv.next(json(503, { error: { message: 'down' } }), ok('from groq'));
  const events = [];
  const ai = createAI({
    provider: 'openai', model: 'gpt', apiKey: KEY, baseUrl: `${srv.url}/v1`, env, maxRetries: 0,
    fallback: [{ provider: 'groq', model: 'llama', apiKey: KEY, baseUrl: `${srv.url}/groq/v1` }, 'mock'],
    onFallback: (e) => events.push(`${e.from.provider}->${e.to.provider}:${e.error.code}`),
  });
  const res = await ai.generate({ prompt: 'x' });
  assert.equal(res.provider, 'groq');
  assert.equal(res.text, 'from groq');
  assert.deepEqual(res.attempts, [
    { provider: 'openai', model: 'gpt', ok: false, code: 'unavailable' },
    { provider: 'groq', model: 'llama', ok: true },
  ]);
  assert.deepEqual(events, ['openai->groq:unavailable']);
});

test('missing API key falls through to the next provider', async () => {
  const ai = createAI({ provider: 'anthropic', model: 'c', env: {}, fallback: ['mock'] });
  const res = await ai.generate({ prompt: 'hello' });
  assert.equal(res.provider, 'mock');
  assert.equal(res.attempts[0].code, 'configuration');
});

test('fallbackOn can stop the chain', async () => {
  srv.next(json(400, { error: { message: 'bad' } }));
  const ai = openai({ maxRetries: 0, fallback: ['mock'], fallbackOn: (e) => e.retryable });
  await assert.rejects(ai.generate({ prompt: 'x' }), { code: 'invalid_request' });
});

test('stream falls back before the first token, but not after', async () => {
  srv.next(json(500, { error: { message: 'boom' } }));
  const ai = openai({ maxRetries: 0, fallback: [{ provider: 'mock', mock: { reply: 'backup answer' } }] });
  let text = '';
  for await (const t of ai.streamText({ prompt: 'x' })) text += t;
  assert.equal(text, 'backup answer');

  srv.next((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
    setTimeout(() => res.destroy(), 20);
  });
  const got = [];
  await assert.rejects(async () => { for await (const t of ai.streamText({ prompt: 'x' })) got.push(t); });
  assert.deepEqual(got, ['partial']);
});

test('mock can simulate failures for testing fallbacks', async () => {
  const ai = createAI({ provider: 'mock', mock: { fail: 'rate_limit' }, fallback: [{ provider: 'mock', mock: { reply: 'second' } }] });
  const res = await ai.generate({ prompt: 'x' });
  assert.equal(res.text, 'second');
  assert.equal(res.attempts[0].code, 'rate_limit');
});

// ---------------------------------------------------------------- generateJSON repair

test('generateJSON shows the model its schema errors and retries', async () => {
  srv.next(ok('Sure! {"name": "Berk"}'), ok('```json\n{"name": "Berk", "age": 30}\n```'));
  const schema = { type: 'object', properties: { name: { type: 'string' }, age: { type: 'integer', minimum: 0 } }, required: ['name', 'age'] };
  const res = await openai({ jsonMode: 'prompt' }).generateJSON({ prompt: 'Who?', schema });
  assert.deepEqual(res.data, { name: 'Berk', age: 30 });
  assert.equal(res.repairs, 1);
  assert.deepEqual(res.usage, { inputTokens: 2, outputTokens: 2 });
  const second = srv.requests[1].body.messages;
  assert.equal(second.at(-2).role, 'assistant');
  assert.match(second.at(-1).content, /\$\.age: is required/);
});

test('generateJSON gives up with issues after repairAttempts', async () => {
  srv.always(ok('{"name": 5}'));
  await assert.rejects(openai().generateJSON({ prompt: 'x', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, repairAttempts: 1 }), (err) => {
    assert.equal(err.code, 'invalid_response');
    assert.ok(err.issues.some((i) => i.includes('$.name: expected string')));
    return true;
  });
  assert.equal(srv.requests.length, 2);
});

test('generateJSON custom validate (e.g. zod.parse) can reject and transform', async () => {
  srv.next(ok('{"n": 3}'), ok('{"n": 4}'));
  const res = await openai().generateJSON({
    prompt: 'even number', schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] },
    validate: (d) => { if (d.n % 2) throw new Error('n must be even'); return { n: d.n, even: true }; },
  });
  assert.deepEqual(res.data, { n: 4, even: true });
  assert.match(srv.requests[1].body.messages.at(-1).content, /n must be even/);
});

test('mock generateJSON synthesises schema-valid data', async () => {
  const ai = createAI({ provider: 'mock' });
  const res = await ai.generateJSON({ prompt: 'x', schema: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' }, minItems: 2 }, level: { enum: ['LOW', 'HIGH'] }, score: { type: 'number', minimum: 1 } }, required: ['tags', 'level', 'score'] } });
  assert.equal(res.data.tags.length, 2);
  assert.equal(res.data.level, 'LOW');
  assert.equal(res.data.score, 1);
});

// ---------------------------------------------------------------- configuration & safety

test('configuration problems are reported clearly', () => {
  assert.throws(() => createAI({}), { code: 'configuration' });
  assert.throws(() => createAI({ provider: 'nope' }), /Unknown provider "nope"/);
  assert.throws(() => createAI({ provider: 'openai', apiKey: KEY, env: {} }), /No model set for provider "openai".*OPENAI_MODEL/);
});

test('refuses to send keys over plain HTTP to remote hosts, or with credentials in the URL', async () => {
  const remote = createAI({ provider: 'openai-compatible', model: 'm', apiKey: KEY, baseUrl: 'http://gateway.example.com/v1', env });
  await assert.rejects(remote.generate({ prompt: 'x' }), /refusing to send an API key over plain HTTP/);
  const query = createAI({ provider: 'openai-compatible', model: 'm', baseUrl: 'https://gw.example.com/v1?key=abc', env });
  await assert.rejects(query.generate({ prompt: 'x' }), /must not contain credentials, a query string/);
});

test('the client never exposes keys through JSON or inspect', () => {
  const ai = createAI({ provider: 'anthropic', model: 'c', apiKey: KEY, env });
  assert.ok(!JSON.stringify(ai).includes(KEY));
  assert.ok(!inspect(ai, { depth: 10, showHidden: true }).includes(KEY));
  assert.equal(ai.info()[0].hasApiKey, true);
  assert.ok(Object.isFrozen(ai));
});

test('fromEnv: provider, model, fallback specs and keys come from env vars', () => {
  const ai = fromEnv({ env: { LLM_PROVIDER: 'anthropic', LLM_MODEL: 'claude-x', ANTHROPIC_API_KEY: KEY, LLM_FALLBACK: 'ollama:llama3.2:3b, mock', LLM_TIMEOUT_MS: '5000' } });
  assert.deepEqual(ai.info().map((p) => [p.provider, p.model, p.hasApiKey]), [['anthropic', 'claude-x', true], ['ollama', 'llama3.2:3b', false], ['mock', 'mock', false]]);
  assert.deepEqual(fromEnv({ env: {} }).info().map((p) => p.provider), ['mock']);
});

test('provider-specific model env vars are honoured', () => {
  const ai = createAI({ provider: 'gemini', env: { GEMINI_MODEL: 'g-env', GOOGLE_API_KEY: KEY } });
  assert.deepEqual(ai.info()[0].model, 'g-env');
  assert.equal(ai.info()[0].hasApiKey, true);
});

test('invalid requests are rejected before any network call', async () => {
  const ai = createAI({ provider: 'mock' });
  await assert.rejects(ai.generate({}), { code: 'invalid_request' });
  await assert.rejects(ai.generate({ messages: [{ role: 'tool', content: 'x' }] }), /Unsupported message role/);
  await assert.rejects(ai.generate({ prompt: 'x', maxTokens: 0 }), /maxTokens/);
  await assert.rejects(ai.generateJSON({ prompt: 'x' }), /needs a JSON Schema/);
});
