import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSE } from '../src/sse.js';
import { extractJSON, validateSchema, exampleFromSchema } from '../src/json.js';
import { redact } from '../src/errors.js';

function streamOf(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function collect(chunks) {
  const out = [];
  for await (const e of parseSSE(streamOf(chunks))) out.push(e);
  return out;
}

test('SSE: events split across chunks, CRLF, comments, multi-line data', async () => {
  const events = await collect([': keep-alive\r\n', 'event: a\r\nda', 'ta: {"x"', ':1}\r\n\r\n', 'data: line1\ndata: line2\n\n', 'data: tail']);
  assert.deepEqual(events, [
    { event: 'a', data: '{"x":1}' },
    { event: 'message', data: 'line1\nline2' },
    { event: 'message', data: 'tail' },
  ]);
});

test('extractJSON handles fences, chatter and nested braces in strings', () => {
  assert.deepEqual(extractJSON('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJSON('Here you go:\n```json\n{"a": [1,2]}\n```\nAnything else?'), { a: [1, 2] });
  assert.deepEqual(extractJSON('Result: {"msg": "use {braces} and \\"quotes\\""} done'), { msg: 'use {braces} and "quotes"' });
  assert.deepEqual(extractJSON('[1, 2, 3]'), [1, 2, 3]);
  assert.throws(() => extractJSON('no json here'), SyntaxError);
});

test('validateSchema covers the common keywords', () => {
  const schema = {
    type: 'object',
    required: ['id', 'tags', 'status'],
    additionalProperties: false,
    properties: {
      id: { type: 'integer', minimum: 1 },
      tags: { type: 'array', items: { type: 'string', minLength: 2 }, maxItems: 2 },
      status: { enum: ['open', 'closed'] },
      note: { type: ['string', 'null'] },
      ref: { anyOf: [{ type: 'string', pattern: '^R-\\d+$' }, { type: 'integer' }] },
    },
  };
  assert.deepEqual(validateSchema({ id: 3, tags: ['ab'], status: 'open', note: null, ref: 'R-12' }, schema), []);
  const errors = validateSchema({ id: 0, tags: ['a', 'bb', 'cc'], status: 'x', extra: 1, ref: 'nope' }, schema);
  assert.ok(errors.includes('$.id: below minimum 1'));
  assert.ok(errors.includes('$.tags: allows at most 2 items'));
  assert.ok(errors.includes('$.tags[0]: shorter than 2 characters'));
  assert.ok(errors.some((e) => e.startsWith('$.status: must be one of')));
  assert.ok(errors.includes('$.extra: is not an allowed property'));
  assert.ok(errors.includes('$.ref: does not match any allowed shape'));
  assert.deepEqual(validateSchema(1.5, { type: 'integer' }), ['$: expected integer, got number']);
  assert.deepEqual(validateSchema(2, { type: 'number' }), []);
});

test('exampleFromSchema produces values that validate', () => {
  const schema = { type: 'object', properties: { a: { type: 'string', minLength: 12 }, b: { type: 'array', items: { type: 'integer', minimum: 5 }, minItems: 2 }, c: { const: 'fixed' } }, required: ['a', 'b', 'c'] };
  const ex = exampleFromSchema(schema);
  assert.deepEqual(validateSchema(ex, schema), []);
});

test('redact removes common key formats and explicit secrets', () => {
  const s = ['sk', 'ant', 'api03', 'abcdefghijklmnop'].join('-');
  const out = redact(`a ${s} b AIza${'x'.repeat(35)} c ?key=zzz123&x=1 d Bearer abc.def secret-value-123`, ['secret-value-123']);
  assert.ok(!out.includes(s));
  assert.ok(!out.includes('AIza'));
  assert.ok(out.includes('?key=[REDACTED]&x=1'));
  assert.ok(!out.includes('abc.def'));
  assert.ok(!out.includes('secret-value-123'));
});
