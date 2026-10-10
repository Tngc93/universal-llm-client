# AGENTS.md

Guidance for coding agents working **on this repository**. (Agents writing code that *uses* universal-llm-client should read `llms.txt` instead.)

## Ground rules

- Zero runtime dependencies. Do not add any. Dev tooling (TypeScript for the type check) is fetched by CI with `npx`.
- Plain ESM JavaScript in `src/`; public types are hand-written in `src/index.d.ts`. Any change to the public API must update `index.d.ts`, `typecheck/index.ts`, `README.md`, `README.tr.md` and `llms.txt` together.
- No default model names anywhere. Model ids go stale; callers must choose.
- Never put API keys in URLs, error messages, logs or serialised objects. Run new error paths through `redact()`.
- Keep provider quirks as data in `src/providers.js` when possible (`jsonMode`, `maxTokensField`, `streamUsage`) rather than branching in the client.

## Layout

| Path | Role |
| --- | --- |
| `src/index.js` | Client: provider resolution, preflight checks, retries, fallback chain, `generate` / `generateJSON` / `stream`, mock provider, `fromEnv` |
| `src/providers.js` | Provider presets (protocol, base URL, env var names, quirks) |
| `src/protocols/*.js` | Wire formats: `buildRequest`, `parseResponse`, `parseStream` for `openai`, `anthropic`, `gemini` |
| `src/errors.js` | `AIError`, HTTP error classification, secret redaction |
| `src/sse.js` | Server-Sent Events parser |
| `src/json.js` | JSON extraction, JSON Schema subset validator, example generator |
| `test/fake-server.mjs` | Scriptable local server impersonating providers (JSON + chunked SSE) |

## Adding a provider

1. If it speaks an existing protocol, add a preset to `src/providers.js` and the id to `ProviderId` in `src/index.d.ts`.
2. Otherwise add `src/protocols/<name>.js` exporting `buildRequest`, `parseResponse`, `parseStream`, and register it in `PROTOCOLS` in `src/index.js`.
3. Add request-mapping, response, streaming and error tests in `test/providers.test.mjs` using the fake server.
4. Update the provider table in both READMEs and the list in `llms.txt`.

## Checks

```bash
npm test                                         # no network needed
npx -y -p typescript@5.6.3 tsc -p tsconfig.json  # type definitions
for f in examples/*.mjs; do node "$f"; done      # run offline on the mock provider
```

## Git

One branch per change, then a PR. Do not push to `main` directly.
