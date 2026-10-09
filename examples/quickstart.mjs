// node examples/quickstart.mjs
// With no environment variables this runs offline on the mock provider.
// Try: LLM_PROVIDER=anthropic LLM_MODEL=<model id> ANTHROPIC_API_KEY=... node examples/quickstart.mjs
import { fromEnv } from '../src/index.js';

const ai = fromEnv();
console.log('Providers:', ai.info().map((p) => `${p.provider}:${p.model}`).join(' → '));

const res = await ai.generate({
  system: 'You are a concise assistant.',
  prompt: 'Explain what a fallback chain is in one sentence.',
  maxTokens: 120,
});

console.log(res.text);
console.log(`[${res.provider} · ${res.usage.inputTokens} in / ${res.usage.outputTokens} out · ${res.finishReason}]`);
