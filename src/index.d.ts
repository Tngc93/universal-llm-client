// Type definitions for universal-llm-client.

export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'deepseek'
  | 'xai'
  | 'together'
  | 'ollama'
  | 'lmstudio'
  | 'openai-compatible'
  | 'mock';

export type Protocol = 'openai' | 'anthropic' | 'gemini' | 'mock';

/** How structured JSON output is requested from an OpenAI-compatible provider. */
export type JsonMode = 'json_schema' | 'json_object' | 'prompt' | 'tool' | 'native';

export interface ProviderPreset {
  id: ProviderId;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKeyEnv?: string | string[];
  baseUrlEnv?: string;
  modelEnv?: string;
  requiresKey: boolean;
  local?: boolean;
  jsonMode: JsonMode;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  streamUsage?: boolean;
}

export declare const PROVIDERS: Readonly<Record<ProviderId, ProviderPreset>>;

export type AIErrorCode =
  | 'configuration'
  | 'authentication'
  | 'permission'
  | 'insufficient_credits'
  | 'not_found'
  | 'rate_limit'
  | 'overloaded'
  | 'unavailable'
  | 'timeout'
  | 'network'
  | 'invalid_request'
  | 'context_length'
  | 'content_filter'
  | 'invalid_response'
  | 'aborted';

export interface Attempt {
  provider: ProviderId;
  model: string;
  ok: boolean;
  code?: AIErrorCode;
}

export declare class AIError extends Error {
  name: 'AIError';
  readonly code: AIErrorCode;
  readonly provider?: ProviderId;
  /** HTTP status, when the provider answered. */
  readonly status?: number;
  /** True for rate limits, overloads, outages, timeouts and network errors. */
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  /** Every provider tried before giving up (set on errors thrown by the client). */
  attempts?: Attempt[];
  /** Schema problems, for `invalid_response` errors from generateJSON(). */
  issues?: string[];
  constructor(code: AIErrorCode, message: string, details?: { provider?: ProviderId; status?: number; retryAfterMs?: number; cause?: unknown });
  toJSON(): { name: 'AIError'; code: AIErrorCode; message: string; provider?: ProviderId; status?: number; retryable: boolean };
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type FinishReason = 'stop' | 'length' | 'tool' | 'content_filter' | 'other';

export interface MockOptions {
  /** Fixed reply, or a function of the normalised request. Return an object to answer generateJSON(). */
  reply?: string | object | ((request: { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; json?: { schema: JSONSchema; name: string } }) => string | object | Promise<string | object>);
  /** Simulate a failure, e.g. 'rate_limit', to test fallbacks. */
  fail?: AIErrorCode;
  delayMs?: number;
}

export interface ProviderConfig {
  provider: ProviderId;
  /** Model id. Required for every provider except `mock` (no defaults: model ids go stale). */
  model?: string;
  /** Defaults to the provider's usual env var, e.g. ANTHROPIC_API_KEY. */
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  jsonMode?: JsonMode;
  fetch?: typeof fetch;
  mock?: MockOptions;
  /** Allow sending an API key over plain HTTP to a non-loopback host. */
  allowInsecureHttp?: boolean;
  /** Allow calling a cloud provider with an API key from a browser (only for user-supplied keys). */
  allowBrowser?: boolean;
}

/** `"provider"` or `"provider:model"`, e.g. `"mock"` or `"ollama:llama3.2"`. */
export type ProviderSpec = `${ProviderId}` | `${ProviderId}:${string}`;

export interface AIOptions extends ProviderConfig {
  /** Tried in order when the primary provider fails. */
  fallback?: Array<ProviderConfig | ProviderSpec>;
  /** Decide whether an error moves on to the next provider. Default: everything except `aborted`. */
  fallbackOn?: (error: AIError) => boolean;
  onRetry?: (event: { provider: ProviderId; model: string; attempt: number; delayMs: number; code: AIErrorCode }) => void;
  onFallback?: (event: { from: { provider: ProviderId; model: string }; to: { provider: ProviderId; model: string }; error: AIError }) => void;
  /** Where to read keys/models/base URLs. Defaults to process.env when available. */
  env?: Record<string, string | undefined>;
}

export interface GenerateOptions {
  prompt?: string;
  messages?: Message[];
  system?: string;
  /** Default 1024. */
  maxTokens?: number;
  /** Omitted unless set (some reasoning models reject it). */
  temperature?: number;
  stop?: string | string[];
  signal?: AbortSignal;
  /** Extra fields merged into the provider's request body as-is. */
  providerOptions?: Record<string, unknown>;
}

export interface GenerateResult {
  text: string;
  finishReason: FinishReason;
  usage: Usage;
  provider: ProviderId;
  model: string;
  attempts: Attempt[];
}

export type JSONSchema = {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  required?: readonly string[];
  items?: JSONSchema;
  enum?: readonly unknown[];
  [keyword: string]: unknown;
};

export interface GenerateJSONOptions<T> extends GenerateOptions {
  /** JSON Schema the answer must satisfy. */
  schema: JSONSchema;
  /** Name for the schema/tool, letters, digits, _ and - (default "result"). */
  name?: string;
  /** Extra validation, e.g. a zod schema's `.parse`. Throw to reject; return a value to replace the data. */
  validate?: (data: unknown) => T | void | Promise<T | void>;
  /** Times to show the model its schema errors and ask again (default 1). */
  repairAttempts?: number;
  /** Ask OpenAI-style providers for strict schema mode. */
  strict?: boolean;
}

export interface GenerateJSONResult<T> extends GenerateResult {
  data: T;
  /** How many repair rounds were needed (0 = first answer was valid). */
  repairs: number;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; text: string; usage: Usage; finishReason: FinishReason; provider: ProviderId; model: string; attempts: Attempt[] };

export interface ProviderInfo {
  provider: ProviderId;
  name: string;
  model: string;
  protocol: Protocol;
  baseUrl?: string;
  hasApiKey: boolean;
  local: boolean;
}

export interface AIClient {
  generate(options: GenerateOptions): Promise<GenerateResult>;
  generateJSON<T = unknown>(options: GenerateJSONOptions<T>): Promise<GenerateJSONResult<T>>;
  /** Text deltas, then one `done` event. Falls back only before the first token. */
  stream(options: GenerateOptions): AsyncGenerator<StreamEvent, void, undefined>;
  /** Text deltas only. */
  streamText(options: GenerateOptions): AsyncGenerator<string, void, undefined>;
  /** The provider chain without secrets. */
  info(): ProviderInfo[];
}

export declare function createAI(options: AIOptions): AIClient;

export declare function fromEnv(overrides?: Partial<AIOptions>): AIClient;

export declare function validateSchema(value: unknown, schema: JSONSchema, path?: string): string[];
export declare function extractJSON(text: string): unknown;
export declare function redact(value: string, extraSecrets?: string[]): string;
