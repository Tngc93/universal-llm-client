// node examples/fallback-chain.mjs
// Primary cloud model → local Ollama → offline mock. Each provider is skipped
// if it is not configured (no key) or fails with an outage, rate limit, etc.
import { createAI } from '../src/index.js';

const ai = createAI({
  provider: 'anthropic',
  model: process.env.ANTHROPIC_MODEL ?? 'set-ANTHROPIC_MODEL',
  fallback: [
    { provider: 'ollama', model: process.env.OLLAMA_MODEL ?? 'llama3.2', timeoutMs: 2_000, maxRetries: 0 },
    'mock',
  ],
  onFallback: ({ from, to, error }) => console.warn(`↪ ${from.provider} failed (${error.code}), trying ${to.provider}`),
});

const res = await ai.generate({ prompt: 'Say hello in Turkish.' });
console.log(res.text);
console.log('Attempts:', res.attempts.map((a) => `${a.provider}${a.ok ? ' ✓' : ` ✗ ${a.code}`}`).join(', '));
