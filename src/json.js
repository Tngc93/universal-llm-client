// JSON helpers: pull JSON out of model text, validate it against a (subset of)
// JSON Schema, and synthesise a minimal valid example for the mock provider.

/** Extract the first JSON value from model output (handles ```json fences and chatter). */
export function extractJSON(text) {
  if (typeof text !== 'string') throw new SyntaxError('model returned no text');
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const fence = trimmed.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* fall through */
    }
  }
  // First balanced {...} or [...]
  for (const open of ['{', '[']) {
    const start = trimmed.indexOf(open);
    if (start === -1) continue;
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inStr) {
        if (ch === '\\') i++;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  throw new SyntaxError('no JSON value found in model output');
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

function typeMatches(value, type) {
  const t = typeOf(value);
  if (type === 'number') return t === 'number' || t === 'integer';
  return t === type;
}

/**
 * Validate a value against a JSON Schema subset:
 * type (incl. arrays of types), enum, const, properties, required,
 * additionalProperties:false, items, minItems, maxItems, minLength, maxLength,
 * minimum, maximum, pattern, anyOf, oneOf, nullable.
 * @returns {string[]} human-readable errors (empty = valid)
 */
export function validateSchema(value, schema, path = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object' || schema === true) return errors;
  if (schema === false) return [`${path}: no value is allowed here`];

  if (schema.nullable && value === null) return errors;

  if (schema.anyOf || schema.oneOf) {
    const options = schema.anyOf || schema.oneOf;
    const ok = options.filter((s) => validateSchema(value, s, path).length === 0).length;
    if (schema.anyOf && ok === 0) errors.push(`${path}: does not match any allowed shape`);
    if (schema.oneOf && ok !== 1) errors.push(`${path}: must match exactly one allowed shape (matched ${ok})`);
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${path}: expected ${types.join(' | ')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}`);
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength} characters`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength} characters`);
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: does not match pattern ${schema.pattern}`);
      } catch {
        /* ignore invalid patterns */
      }
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: allows at most ${schema.maxItems} items`);
    if (schema.items && typeof schema.items === 'object') value.forEach((v, i) => errors.push(...validateSchema(v, schema.items, `${path}[${i}]`)));
  }
  if (typeOf(value) === 'object') {
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key}: is required`);
    }
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) errors.push(...validateSchema(v, props[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: is not an allowed property`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...validateSchema(v, schema.additionalProperties, `${path}.${key}`));
    }
  }
  return errors;
}

/** Produce a small value that satisfies the schema (used by the mock provider). */
export function exampleFromSchema(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 8) return null;
  if ('const' in schema) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (schema.anyOf || schema.oneOf) return exampleFromSchema((schema.anyOf || schema.oneOf)[0], depth + 1);
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') ?? schema.type[0] : schema.type ?? (schema.properties ? 'object' : schema.items ? 'array' : 'string');
  switch (type) {
    case 'object': {
      const out = {};
      for (const [k, v] of Object.entries(schema.properties || {})) out[k] = exampleFromSchema(v, depth + 1);
      return out;
    }
    case 'array': {
      const n = Math.max(schema.minItems ?? 1, 1);
      return Array.from({ length: Math.min(n, 3) }, () => exampleFromSchema(schema.items || {}, depth + 1));
    }
    case 'integer':
      return Math.ceil(schema.minimum ?? 0);
    case 'number':
      return schema.minimum ?? 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default: {
      const base = schema.description ? `example ${schema.description}`.slice(0, 40) : 'example';
      const min = schema.minLength ?? 0;
      return base.length >= min ? base : base.padEnd(min, 'x');
    }
  }
}
