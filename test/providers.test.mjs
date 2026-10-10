import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAI } from '../src/index.js';
import { startFakeServer, json, sse } from './fake-server.mjs';

let srv;
before(async () => { srv = await startFakeServer(); });
after(async () => { await srv.close(); });
beforeEach(() => srv.reset());

const KEY = 'test-key-' + 'x'.repeat(12);
const env = {};

// ---------------------------------------------------------------- OpenAI

test('openai: request mapping and response parsing', async () => {
  srv.next(json(200, { choices: [{ message: { role: 'assistant', content: 'Hi there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
  const ai = createAI({ provider: 'openai', model: 'gpt-test', apiKey: KEY, baseUrl: `${srv.url}/v1`, env });
  const res = await ai.generate({ system: 'Be brief.', prompt: 'Hello', maxTokens: 50 });

  const r = srv.requests[0];
  assert.equal(r.url, '/v1/chat/completions');
  assert.equal(r.headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(r.body.messages, [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello' }]);
  assert.equal(r.body.model, 'gpt-test');
  assert.equal(r.body.max_completion_tokens, 50);
  assert.equal('temperature' in r.body, false, 'temperature is omitted unless set');
  assert.equal(res.text, 'Hi there');
  assert.deepEqual(res.usage, { inputTokens: 12, outputTokens: 3 });
  assert.equal(res.finishReason, 'stop');
  assert.equal(res.provider, 'openai');
});

test('openai-compatible presets use max_tokens; json_object adds a schema instruction', async () => {
  srv.next(json(200, { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  const ai = createAI({ provider: 'groq', model: 'llama-test', apiKey: KEY, baseUrl: `${srv.url}/openai/v1`, env });
  const res = await ai.generateJSON({ prompt: 'Is it ok?', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, temperature: 0 });
  const r = srv.requests[0];
  assert.equal(r.body.max_tokens, 1024);
  assert.equal(r.body.temperature, 0);
  assert.deepEqual(r.body.response_format, { type: 'json_object' });
  assert.match(r.body.messages[0].content, /JSON Schema/);
  assert.deepEqual(res.data, { ok: true });
});

test('openai: json_schema response_format', async () => {
  srv.next(json(200, { choices: [{ message: { content: '{"city":"Ankara"}' }, finish_reason: 'stop' }] }));
  const ai = createAI({ provider: 'openai', model: 'gpt-test', apiKey: KEY, baseUrl: `${srv.url}/v1`, env });
  const schema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false };
  const res = await ai.generateJSON({ prompt: 'Capital of Türkiye?', schema, name: 'capital', strict: true });
  assert.deepEqual(srv.requests[0].body.response_format, { type: 'json_schema', json_schema: { name: 'capital', schema, strict: true } });
  assert.deepEqual(res.data, { city: 'Ankara' });
  assert.equal(res.repairs, 0);
});

test('openai: refusal becomes content_filter', async () => {
  srv.next(json(200, { choices: [{ message: { content: null, refusal: 'I cannot help with that.' }, finish_reason: 'stop' }] }));
  const ai = createAI({ provider: 'openai', model: 'm', apiKey: KEY, baseUrl: `${srv.url}/v1`, env });
  await assert.rejects(ai.generate({ prompt: 'x' }), { code: 'content_filter' });
});

test('openai: streaming with usage chunk', async () => {
  srv.next(sse([
    { data: { choices: [{ delta: { role: 'assistant' } }] } },
    { data: { choices: [{ delta: { content: 'Mer' } }] } },
    { data: { choices: [{ delta: { content: 'haba' } }] } },
    { data: { choices: [{ delta: {}, finish_reason: 'length' }] } },
    { data: { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } } },
    '[DONE]',
  ], { crlf: true }));
  const ai = createAI({ provider: 'openai', model: 'm', apiKey: KEY, baseUrl: `${srv.url}/v1`, env });
  const events = [];
  for await (const ev of ai.stream({ prompt: 'Selam' })) events.push(ev);
  assert.equal(srv.requests[0].body.stream, true);
  assert.deepEqual(srv.requests[0].body.stream_options, { include_usage: true });
  assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.text), ['Mer', 'haba']);
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.text, 'Merhaba');
  assert.equal(done.finishReason, 'length');
  assert.deepEqual(done.usage, { inputTokens: 4, outputTokens: 2 });
});

// ---------------------------------------------------------------- Anthropic

test('anthropic: headers, top-level system, response parsing', async () => {
  srv.next(json(200, { content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }], stop_reason: 'max_tokens', usage: { input_tokens: 9, output_tokens: 2 } }));
  const ai = createAI({ provider: 'anthropic', model: 'claude-test', apiKey: KEY, baseUrl: srv.url, env });
  const res = await ai.generate({ messages: [{ role: 'system', content: 'Sys' }, { role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Yo' }, { role: 'user', content: 'Again' }], stop: 'END' });
  const r = srv.requests[0];
  assert.equal(r.url, '/v1/messages');
  assert.equal(r.headers['x-api-key'], KEY);
  assert.equal(r.headers['anthropic-version'], '2023-06-01');
  assert.equal(r.headers.authorization, undefined);
  assert.equal(r.body.system, 'Sys');
  assert.deepEqual(r.body.stop_sequences, ['END']);
  assert.equal(r.body.messages.length, 3);
  assert.equal(res.text, 'Hello world');
  assert.equal(res.finishReason, 'length');
  assert.deepEqual(res.usage, { inputTokens: 9, outputTokens: 2 });
});

test('anthropic: structured output via forced tool; non-object schemas are wrapped', async () => {
  srv.next(json(200, { content: [{ type: 'tool_use', id: 't1', name: 'tags', input: { value: ['a', 'b'] } }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 5 } }));
  const ai = createAI({ provider: 'anthropic', model: 'claude-test', apiKey: KEY, baseUrl: srv.url, env });
  const res = await ai.generateJSON({ prompt: 'Two tags', name: 'tags', schema: { type: 'array', items: { type: 'string' }, minItems: 2 } });
  const r = srv.requests[0];
  assert.deepEqual(r.body.tool_choice, { type: 'tool', name: 'tags' });
  assert.equal(r.body.tools[0].input_schema.type, 'object');
  assert.deepEqual(r.body.tools[0].input_schema.required, ['value']);
  assert.deepEqual(res.data, ['a', 'b']);
});

test('anthropic: streaming events', async () => {
  srv.next(sse([
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 25, output_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'ping', data: { type: 'ping' } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' friend' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 15 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]));
  const ai = createAI({ provider: 'anthropic', model: 'claude-test', apiKey: KEY, baseUrl: srv.url, env });
  let text = '';
  let done;
  for await (const ev of ai.stream({ prompt: 'hi' })) {
    if (ev.type === 'text') text += ev.text;
    else done = ev;
  }
  assert.equal(text, 'Hello friend');
  assert.deepEqual(done.usage, { inputTokens: 25, outputTokens: 15 });
  assert.equal(done.finishReason, 'stop');
});

test('anthropic: error event mid-stream is raised', async () => {
  srv.next(sse([
    { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 1 } } } },
    { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
  ]));
  const ai = createAI({ provider: 'anthropic', model: 'c', apiKey: KEY, baseUrl: srv.url, env });
  await assert.rejects(async () => { for await (const _ of ai.stream({ prompt: 'hi' })) { /* drain */ } }, { code: 'overloaded' });
});

// ---------------------------------------------------------------- Gemini

test('gemini: URL, header auth (key never in URL), roles and JSON config', async () => {
  srv.next(json(200, { candidates: [{ content: { parts: [{ text: '{"n":', thought: false }, { text: '3}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 } }));
  const ai = createAI({ provider: 'gemini', model: 'gemini-test', apiKey: KEY, baseUrl: `${srv.url}/v1beta`, env });
  const res = await ai.generateJSON({ system: 'Count.', messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'how many?' }], schema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } });
  const r = srv.requests[0];
  assert.equal(r.url, '/v1beta/models/gemini-test:generateContent');
  assert.ok(!r.url.includes(KEY));
  assert.equal(r.headers['x-goog-api-key'], KEY);
  assert.deepEqual(r.body.contents.map((c) => c.role), ['user', 'model', 'user']);
  assert.deepEqual(r.body.systemInstruction, { parts: [{ text: 'Count.' }] });
  assert.equal(r.body.generationConfig.responseMimeType, 'application/json');
  assert.equal(r.body.generationConfig.responseJsonSchema.properties.n.type, 'integer');
  assert.deepEqual(res.data, { n: 3 });
  assert.deepEqual(res.usage, { inputTokens: 7, outputTokens: 4 });
});

test('gemini: thought parts are excluded and blocked prompts raise content_filter', async () => {
  srv.next(json(200, { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Answer' }] }, finishReason: 'STOP' }] }));
  srv.next(json(200, { promptFeedback: { blockReason: 'SAFETY' } }));
  const ai = createAI({ provider: 'gemini', model: 'models/g', apiKey: KEY, baseUrl: `${srv.url}/v1beta`, env });
  assert.equal((await ai.generate({ prompt: 'q' })).text, 'Answer');
  assert.equal(srv.requests[0].url, '/v1beta/models/g:generateContent');
  await assert.rejects(ai.generate({ prompt: 'q' }), { code: 'content_filter' });
});

test('gemini: streaming via alt=sse', async () => {
  srv.next(sse([
    { data: { candidates: [{ content: { parts: [{ text: 'Mer' }] } }] } },
    { data: { candidates: [{ content: { parts: [{ text: 'haba' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } } },
  ]));
  const ai = createAI({ provider: 'gemini', model: 'g', apiKey: KEY, baseUrl: `${srv.url}/v1beta`, env });
  const parts = [];
  for await (const t of ai.streamText({ prompt: 'q' })) parts.push(t);
  assert.equal(srv.requests[0].url, '/v1beta/models/g:streamGenerateContent?alt=sse');
  assert.deepEqual(parts, ['Mer', 'haba']);
});

// ---------------------------------------------------------------- Local providers

test('ollama works without an API key on loopback', async () => {
  srv.next(json(200, { choices: [{ message: { content: 'local!' }, finish_reason: 'stop' }] }));
  const ai = createAI({ provider: 'ollama', model: 'llama3.2', baseUrl: `${srv.url}/v1`, env });
  const res = await ai.generate({ prompt: 'hi' });
  assert.equal(res.text, 'local!');
  assert.equal(srv.requests[0].headers.authorization, undefined);
});

test('providerOptions are merged into the request body', async () => {
  srv.next(json(200, { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
  const ai = createAI({ provider: 'openai', model: 'm', apiKey: KEY, baseUrl: `${srv.url}/v1`, env, headers: { 'x-team': 'shop' } });
  await ai.generate({ prompt: 'hi', providerOptions: { seed: 7, user: 'u1' } });
  assert.equal(srv.requests[0].body.seed, 7);
  assert.equal(srv.requests[0].headers['x-team'], 'shop');
});
