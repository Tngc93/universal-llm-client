// Minimal Server-Sent Events parser for fetch() response bodies.
// Yields { event, data } for every dispatched event. Handles CRLF, multi-line
// data fields, comments and events split across network chunks.

export async function* parseSSE(body) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data = [];

  const dispatch = function* () {
    if (data.length) yield { event: event || 'message', data: data.join('\n') };
    event = '';
    data = [];
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer[nl] === '\r' && buffer[nl + 1] === '\n' ? 2 : 1));
        if (line === '') {
          yield* dispatch();
          continue;
        }
        if (line.startsWith(':')) continue;
        const idx = line.indexOf(':');
        const field = idx === -1 ? line : line.slice(0, idx);
        let val = idx === -1 ? '' : line.slice(idx + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') event = val;
        else if (field === 'data') data.push(val);
      }
    }
    buffer += decoder.decode();
    if (buffer) {
      for (const line of buffer.split(/\r\n|\r|\n/)) {
        if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line.startsWith('event:')) event = line.slice(6).trim();
      }
    }
    yield* dispatch();
  } finally {
    reader.releaseLock?.();
  }
}
