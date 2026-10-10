export function jsonInstruction(schema) {
  return [
    'Respond with a single JSON value and nothing else: no prose, no markdown fences.',
    'It must conform to this JSON Schema:',
    JSON.stringify(schema),
  ].join('\n');
}

/** Tool input schemas must be objects; wrap anything else under `value`. */
export function asObjectSchema(schema) {
  const isObject = schema && (schema.type === 'object' || (!schema.type && schema.properties));
  if (isObject) return { schema, wrapped: false };
  return { schema: { type: 'object', properties: { value: schema }, required: ['value'] }, wrapped: true };
}
