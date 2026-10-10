// node examples/structured-output.mjs
// Extract typed data from free text. The answer is validated against the schema;
// on a mismatch the model sees the errors and gets one more try.
import { fromEnv } from '../src/index.js';

const ai = fromEnv();

const schema = {
  type: 'object',
  properties: {
    product: { type: 'string', description: 'product name' },
    sentiment: { enum: ['positive', 'neutral', 'negative'] },
    issues: { type: 'array', items: { type: 'string' } },
    rating: { type: 'integer', minimum: 1, maximum: 5 },
  },
  required: ['product', 'sentiment', 'issues', 'rating'],
  additionalProperties: false,
};

const review = 'The X15 laptop is fast and the screen is great, but the fan gets loud and the charger died after a month. 3 stars.';

const { data, repairs, provider } = await ai.generateJSON({
  system: 'Extract structured data from customer reviews.',
  prompt: review,
  schema,
  name: 'review',
});

console.log(data);
console.log(`[${provider}, repairs: ${repairs}]`);
