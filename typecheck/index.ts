// Compile-only check of the public type definitions (run by CI with `tsc`).
import { createAI, fromEnv, AIError, PROVIDERS, validateSchema, type AIClient, type GenerateResult, type StreamEvent } from '../src/index.js';

const ai: AIClient = createAI({
  provider: 'anthropic',
  model: 'claude-model-id',
  fallback: [{ provider: 'openai', model: 'gpt-model-id' }, 'ollama:llama3.2', 'mock'],
  onFallback: (e) => console.log(e.from.provider, e.to.provider, e.error.code),
  timeoutMs: 30_000,
});

async function main() {
  const r: GenerateResult = await ai.generate({ system: 'Be brief.', prompt: 'Hi', maxTokens: 200, temperature: 0.2 });
  const text: string = r.text;
  const tokens: number = r.usage.inputTokens + r.usage.outputTokens;

  type Product = { title: string; price: number };
  const j = await ai.generateJSON<Product>({
    prompt: 'Extract the product',
    schema: { type: 'object', properties: { title: { type: 'string' }, price: { type: 'number' } }, required: ['title', 'price'] },
    validate: (d) => d as Product,
  });
  const title: string = j.data.title;

  for await (const ev of ai.stream({ prompt: 'Tell me' })) {
    const e: StreamEvent = ev;
    if (e.type === 'text') e.text.toUpperCase();
    else e.usage.outputTokens.toFixed();
  }
  for await (const chunk of ai.streamText({ messages: [{ role: 'user', content: 'x' }] })) chunk.trim();

  try {
    await fromEnv().generate({ prompt: 'x' });
  } catch (err) {
    if (err instanceof AIError && err.code === 'rate_limit') err.retryAfterMs?.toFixed();
  }

  const errors: string[] = validateSchema({}, { type: 'object' });
  const base: string = PROVIDERS.groq.baseUrl;
  return [text, tokens, title, errors, base];
}

// @ts-expect-error unknown provider ids are rejected
createAI({ provider: 'not-a-provider' });

void main;
