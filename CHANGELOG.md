# Changelog

## 0.1.0 (unreleased)

First public version.

- `createAI()` and `fromEnv()` with 12 provider presets plus an offline `mock` provider.
- Three wire protocols: OpenAI Chat Completions (also used by OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, Ollama, LM Studio and custom endpoints), Anthropic Messages and Gemini `generateContent`.
- `generate`, `generateJSON` (native structured output per provider, schema validation, automatic repair round, custom `validate`), `stream` and `streamText`.
- Fallback chains with `attempts` reporting and `onFallback`; streams fall back only before the first token.
- Retries with exponential backoff that honour `Retry-After`; per-attempt timeouts; caller cancellation via `AbortSignal`.
- Normalised `AIError` codes across providers.
- Key safety: header-only auth, secret redaction in errors, keys hidden from JSON/inspect, refusal of plaintext HTTP to remote hosts and of browser use unless opted in.
- Hand-written TypeScript definitions checked in CI.
