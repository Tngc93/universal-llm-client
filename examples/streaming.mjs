// node examples/streaming.mjs
import { fromEnv } from '../src/index.js';

const ai = fromEnv();
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000); // stop runaway generations

for await (const event of ai.stream({ prompt: 'Write a haiku about rate limits.', signal: controller.signal })) {
  if (event.type === 'text') process.stdout.write(event.text);
  else console.log(`\n[${event.provider} · ${event.usage.outputTokens} tokens · ${event.finishReason}]`);
}
