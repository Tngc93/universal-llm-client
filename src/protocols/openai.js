// OpenAI Chat Completions wire format. Also spoken by OpenRouter, Groq,
// Mistral, DeepSeek, xAI, Together, Ollama, LM Studio and most self-hosted
// gateways (vLLM, LiteLLM, …).

import { AIError } from '../errors.js';
import { jsonInstruction } from './shared.js';

const FINISH = { stop: 'stop', length: 'length', tool_calls: 'tool', function_call: 'tool', content_filter: 'content_filter' };

export function buildRequest(ctx, req, { stream = false } = {}) {
  const { preset } = ctx;
  const headers = { 'content-type': 'application/json', ...ctx.headers };
  if (ctx.apiKey) headers.authorization = `Bearer ${ctx.apiKey}`;

  let system = req.system;
  const body = { model: ctx.model };

  if (req.json) {
    const mode = ctx.jsonMode ?? preset.jsonMode ?? 'json_object';
    if (mode === 'json_schema') {
      body.response_format = { type: 'json_schema', json_schema: { name: req.json.name, schema: req.json.schema, strict: Boolean(req.json.strict) } };
    } else {
      // json_object mode requires the word "JSON" in the prompt; give the schema too.
      if (mode === 'json_object') body.response_format = { type: 'json_object' };
      system = [system, jsonInstruction(req.json.schema)].filter(Boolean).join('\n\n');
    }
  }

  body.messages = [...(system ? [{ role: 'system', content: system }] : []), ...req.messages.map((m) => ({ role: m.role, content: m.content }))];
  body[preset.maxTokensField ?? 'max_tokens'] = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stop?.length) body.stop = req.stop;
  if (stream) {
    body.stream = true;
    if (preset.streamUsage) body.stream_options = { include_usage: true };
  }
  Object.assign(body, req.extraBody);

  return { url: `${ctx.baseUrl}/chat/completions`, init: { method: 'POST', headers, body: JSON.stringify(body) } };
}

function usageOf(u) {
  return u ? { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 } : undefined;
}

export function parseResponse(payload, ctx) {
  const choice = payload?.choices?.[0];
  if (!choice) throw new AIError('invalid_response', `${ctx.preset.id}: response had no choices`, { provider: ctx.preset.id });
  const message = choice.message ?? {};
  if (message.refusal) throw new AIError('content_filter', `${ctx.preset.id}: the model refused: ${String(message.refusal).slice(0, 200)}`, { provider: ctx.preset.id });
  const text = typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map((p) => p?.text ?? '').join('') : '';
  return {
    text,
    finishReason: FINISH[choice.finish_reason] ?? (choice.finish_reason ? 'other' : 'stop'),
    usage: usageOf(payload.usage) ?? { inputTokens: 0, outputTokens: 0 },
  };
}

export async function* parseStream(events, ctx) {
  let usage = { inputTokens: 0, outputTokens: 0 };
  let finishReason = 'stop';
  for await (const { data } of events) {
    if (data === '[DONE]') break;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) {
      throw new AIError('unavailable', `${ctx.preset.id}: stream error: ${String(chunk.error.message ?? '').slice(0, 300)}`, { provider: ctx.preset.id });
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta?.content;
    if (typeof delta === 'string' && delta) yield { type: 'text', text: delta };
    if (choice?.finish_reason) finishReason = FINISH[choice.finish_reason] ?? 'other';
    if (chunk.usage) usage = usageOf(chunk.usage);
  }
  yield { type: 'done', usage, finishReason };
}
