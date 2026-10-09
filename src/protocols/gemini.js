// Google Gemini API (generateContent) wire format.
// The key travels in the x-goog-api-key header, never in the URL.

import { AIError } from '../errors.js';

const FILTERED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

function finishOf(reason) {
  if (!reason || reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (FILTERED.has(reason)) return 'content_filter';
  if (reason === 'MALFORMED_FUNCTION_CALL') return 'tool';
  return 'other';
}

function modelPath(model) {
  const m = String(model);
  return m.startsWith('models/') || m.startsWith('tunedModels/') ? m : `models/${m}`;
}

export function buildRequest(ctx, req, { stream = false } = {}) {
  const headers = { 'content-type': 'application/json', ...ctx.headers };
  if (ctx.apiKey) headers['x-goog-api-key'] = ctx.apiKey;
  const body = {
    contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: req.maxTokens },
  };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  if (req.temperature !== undefined) body.generationConfig.temperature = req.temperature;
  if (req.stop?.length) body.generationConfig.stopSequences = req.stop;
  if (req.json) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseJsonSchema = req.json.schema;
  }
  Object.assign(body, req.extraBody);
  const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return { url: `${ctx.baseUrl}/${modelPath(ctx.model)}:${method}`, init: { method: 'POST', headers, body: JSON.stringify(body) } };
}

function textOf(candidate) {
  const parts = candidate?.content?.parts ?? [];
  return parts.filter((p) => typeof p?.text === 'string' && !p.thought).map((p) => p.text).join('');
}

function usageOf(meta) {
  return { inputTokens: meta?.promptTokenCount ?? 0, outputTokens: (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0) };
}

export function parseResponse(payload, ctx) {
  const candidate = payload?.candidates?.[0];
  if (!candidate) {
    const block = payload?.promptFeedback?.blockReason;
    if (block) throw new AIError('content_filter', `${ctx.preset.id}: prompt was blocked (${block})`, { provider: ctx.preset.id });
    throw new AIError('invalid_response', `${ctx.preset.id}: response had no candidates`, { provider: ctx.preset.id });
  }
  const finishReason = finishOf(candidate.finishReason);
  const text = textOf(candidate);
  if (finishReason === 'content_filter' && !text) {
    throw new AIError('content_filter', `${ctx.preset.id}: response was blocked (${candidate.finishReason})`, { provider: ctx.preset.id });
  }
  return { text, finishReason, usage: usageOf(payload.usageMetadata) };
}

export async function* parseStream(events, ctx) {
  let usage = { inputTokens: 0, outputTokens: 0 };
  let finishReason = 'stop';
  for await (const { data } of events) {
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) throw new AIError('unavailable', `${ctx.preset.id}: stream error: ${String(chunk.error.message ?? '').slice(0, 300)}`, { provider: ctx.preset.id });
    const candidate = chunk.candidates?.[0];
    if (!candidate && chunk.promptFeedback?.blockReason) {
      throw new AIError('content_filter', `${ctx.preset.id}: prompt was blocked (${chunk.promptFeedback.blockReason})`, { provider: ctx.preset.id });
    }
    const text = textOf(candidate);
    if (text) yield { type: 'text', text };
    if (candidate?.finishReason) finishReason = finishOf(candidate.finishReason);
    if (chunk.usageMetadata) usage = usageOf(chunk.usageMetadata);
  }
  yield { type: 'done', usage, finishReason };
}
