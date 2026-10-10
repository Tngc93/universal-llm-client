// Anthropic Messages API wire format.
// Structured output uses a forced tool call (tool_choice: { type: 'tool' }),
// which every Claude model that supports tools honours.

import { AIError } from '../errors.js';
import { asObjectSchema } from './shared.js';

const FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool', refusal: 'content_filter', pause_turn: 'other', model_context_window_exceeded: 'length' };
export const ANTHROPIC_VERSION = '2023-06-01';

export function buildRequest(ctx, req, { stream = false } = {}) {
  const headers = { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, ...ctx.headers };
  if (ctx.apiKey) headers['x-api-key'] = ctx.apiKey;
  const body = {
    model: ctx.model,
    max_tokens: req.maxTokens,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
  };
  if (req.system) body.system = req.system;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.stop?.length) body.stop_sequences = req.stop;
  if (stream) body.stream = true;
  if (req.json) {
    const { schema } = asObjectSchema(req.json.schema);
    body.tools = [{ name: req.json.name, description: 'Return the final answer as structured data.', input_schema: schema }];
    body.tool_choice = { type: 'tool', name: req.json.name };
  }
  Object.assign(body, req.extraBody);
  return { url: `${ctx.baseUrl}/v1/messages`, init: { method: 'POST', headers, body: JSON.stringify(body) } };
}

export function parseResponse(payload, ctx, req) {
  if (!Array.isArray(payload?.content)) throw new AIError('invalid_response', `${ctx.preset.id}: response had no content`, { provider: ctx.preset.id });
  const text = payload.content.filter((b) => b?.type === 'text').map((b) => b.text).join('');
  const out = {
    text,
    finishReason: FINISH[payload.stop_reason] ?? 'other',
    usage: { inputTokens: payload.usage?.input_tokens ?? 0, outputTokens: payload.usage?.output_tokens ?? 0 },
  };
  if (req?.json) {
    const tool = payload.content.find((b) => b?.type === 'tool_use' && b.name === req.json.name);
    if (tool) {
      const { wrapped } = asObjectSchema(req.json.schema);
      out.data = wrapped ? tool.input?.value : tool.input;
      out.hasData = true;
    }
  }
  if (out.finishReason === 'content_filter' && !out.text && !out.hasData) {
    throw new AIError('content_filter', `${ctx.preset.id}: the model refused to answer`, { provider: ctx.preset.id });
  }
  return out;
}

export async function* parseStream(events, ctx) {
  const usage = { inputTokens: 0, outputTokens: 0 };
  let finishReason = 'stop';
  for await (const { event, data } of events) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      continue;
    }
    const type = msg.type ?? event;
    if (type === 'message_start') {
      usage.inputTokens = msg.message?.usage?.input_tokens ?? 0;
      usage.outputTokens = msg.message?.usage?.output_tokens ?? 0;
    } else if (type === 'content_block_delta' && msg.delta?.type === 'text_delta') {
      if (msg.delta.text) yield { type: 'text', text: msg.delta.text };
    } else if (type === 'message_delta') {
      if (msg.delta?.stop_reason) finishReason = FINISH[msg.delta.stop_reason] ?? 'other';
      if (msg.usage?.output_tokens !== undefined) usage.outputTokens = msg.usage.output_tokens;
      if (msg.usage?.input_tokens !== undefined) usage.inputTokens = msg.usage.input_tokens;
    } else if (type === 'error') {
      const kind = msg.error?.type === 'overloaded_error' ? 'overloaded' : msg.error?.type === 'rate_limit_error' ? 'rate_limit' : 'unavailable';
      throw new AIError(kind, `${ctx.preset.id}: stream error: ${String(msg.error?.message ?? '').slice(0, 300)}`, { provider: ctx.preset.id });
    } else if (type === 'message_stop') {
      break;
    }
  }
  yield { type: 'done', usage, finishReason };
}
