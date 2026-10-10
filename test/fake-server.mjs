// A scriptable local HTTP server that impersonates provider APIs.
// Each test queues handlers; every request is recorded for assertions.

import { createServer } from 'node:http';

export async function startFakeServer() {
  const requests = [];
  const queue = [];
  let fallback = null;

  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const record = { method: req.method, url: req.url, headers: req.headers, body };
    requests.push(record);
    const handler = queue.shift() ?? fallback;
    if (!handler) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no handler queued' } }));
      return;
    }
    await handler(record, res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    /** Queue handlers for the next requests, in order. */
    next(...handlers) {
      queue.push(...handlers);
    },
    always(handler) {
      fallback = handler;
    },
    reset() {
      requests.length = 0;
      queue.length = 0;
      fallback = null;
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

export const json = (status, payload, headers = {}) => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
};

/** Send SSE events, deliberately splitting the byte stream at awkward places. */
export const sse = (events, { split = 7, crlf = false, delayMs = 2 } = {}) => async (_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const nl = crlf ? '\r\n' : '\n';
  const text = events
    .map((e) => (typeof e === 'string' ? `data: ${e}${nl}${nl}` : `${e.event ? `event: ${e.event}${nl}` : ''}data: ${JSON.stringify(e.data)}${nl}${nl}`))
    .join('');
  for (let i = 0; i < text.length; i += split) {
    res.write(text.slice(i, i + split));
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  res.end();
};

export const hang = (ms) => async (_req, res) => {
  await new Promise((r) => setTimeout(r, ms));
  if (!res.destroyed) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  }
};
