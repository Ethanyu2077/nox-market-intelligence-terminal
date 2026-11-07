import type { AiModelId, AiModelInfo } from '../../shared/ai.ts';

/**
 * DeepSeek provider configuration.
 *
 * Everything here is read from the server environment only. The browser never sees the
 * server key; when browser-key mode is enabled the key is forwarded per request and
 * never logged or persisted on the server.
 */

export const DEEPSEEK_MODELS: AiModelInfo[] = [
  { id: 'deepseek-flash', label: 'DeepSeek Flash', reasoning: true, note: 'Current fast model. Thinking is disabled for chat and briefs by default.' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', reasoning: true, note: 'Current flagship. Slower and costlier; use for multi-step reconciliation.' },
  { id: 'deepseek-chat', label: 'DeepSeek Chat (legacy)', reasoning: false, legacy: true, note: 'Older deployment alias; keep if your key predates the Flash/V4 catalogue.' },
  { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (legacy)', reasoning: true, legacy: true, note: 'Older chain-of-thought alias.' },
];

export const DEFAULT_MODEL: AiModelId = 'deepseek-flash';

/** Models that accept the `thinking` switch introduced with the Flash/V4 API. */
export function supportsThinking(model: AiModelId): boolean {
  return model === 'deepseek-flash' || model === 'deepseek-v4-pro' || model.startsWith('deepseek-v4') || model.startsWith('deepseek-flash');
}

export interface DeepSeekConfig {
  apiKey: string | null;
  /** Normalized base URL without a trailing slash, e.g. https://api.deepseek.com. */
  baseUrl: string;
  defaultModel: AiModelId;
  allowClientKey: boolean;
  maxOutputTokens: number;
  maxInputChars: number;
  timeoutMs: number;
  requestsPerMinute: number;
}

export class ConfigError extends Error {}

const MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/**
 * Accept any provider-shaped model id, not just the built-in catalog: DeepSeek renames
 * models and self-hosted gateways expose their own names. The value is only ever placed
 * in a JSON body, never in a URL or shell command.
 */
export function isModelId(value: unknown): value is AiModelId {
  return typeof value === 'string' && MODEL_PATTERN.test(value);
}

export function modelInfo(id: AiModelId): AiModelInfo {
  return DEEPSEEK_MODELS.find((model) => model.id === id) ?? { id, label: id, reasoning: false, note: 'Custom model id from configuration.' };
}

/** Public DeepSeek endpoint. Override only when pointing at a compatible gateway. */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com';

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Validate the configured endpoint. Plain HTTP is accepted only for loopback, so an
 * operator can front DeepSeek with a local gateway without weakening remote traffic.
 */
export function normalizeBaseUrl(raw: string | undefined): string {
  const candidate = (raw ?? DEFAULT_BASE_URL).trim();
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ConfigError('DEEPSEEK_BASE_URL is not a valid absolute URL');
  }
  if (url.username || url.password) throw new ConfigError('DEEPSEEK_BASE_URL must not embed credentials');
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError('DEEPSEEK_BASE_URL must use HTTPS (plain HTTP is allowed only for loopback gateways)');
  }
  if (url.search || url.hash) throw new ConfigError('DEEPSEEK_BASE_URL must not contain a query string or fragment');
  // Operators paste either the API root or the full completions path; accept both.
  const path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) url.pathname = path.slice(0, -'/chat/completions'.length);
  else url.pathname = path;
  return url.toString().replace(/\/+$/, '');
}

/** Endpoint actually called by the client. */
export function completionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/**
 * Honoured environment switches:
 * - DEEPSEEK_API_KEY            server-side credential (preferred)
 * - DEEPSEEK_BASE_URL           compatible gateway (default https://api.deepseek.com)
 * - DEEPSEEK_MODEL              default model id
 * - NOX_AI_ALLOW_CLIENT_KEY     allow a browser-supplied key (default true)
 * - NOX_AI_MAX_OUTPUT_TOKENS    hard output cap (default 1600, max 8192)
 * - NOX_AI_TIMEOUT_MS           per-request upstream timeout (default 90s)
 * - NOX_AI_RPM                  per-IP request budget (default 20)
 *
 * The legacy NOX_RESEARCH_AI_* switches keep working: NOX_RESEARCH_AI_KEY is used as a
 * last-resort server key and NOX_RESEARCH_AI_MODEL as the default model.
 */
export function resolveConfig(env: NodeJS.ProcessEnv = process.env): DeepSeekConfig {
  const apiKey = (env.DEEPSEEK_API_KEY ?? env.NOX_RESEARCH_AI_KEY ?? '').trim() || null;
  // The legacy research route is opt-in; its model id must not leak into the DeepSeek
  // default (a leftover NOX_RESEARCH_AI_MODEL=local-model produced a bogus default).
  const legacyModel = env.NOX_RESEARCH_AI_ENABLED === 'true' && isModelId(env.NOX_RESEARCH_AI_MODEL) ? env.NOX_RESEARCH_AI_MODEL : null;
  const model = isModelId(env.DEEPSEEK_MODEL) ? env.DEEPSEEK_MODEL : legacyModel ?? DEFAULT_MODEL;
  const baseUrl = normalizeBaseUrl(env.DEEPSEEK_BASE_URL);
  return {
    apiKey,
    baseUrl,
    defaultModel: model,
    // Client keys are allowed by default: the key stays in the operator's browser and the
    // server only proxies the call. Set NOX_AI_ALLOW_CLIENT_KEY=false for hard lockdown.
    allowClientKey: (env.NOX_AI_ALLOW_CLIENT_KEY ?? 'true').trim().toLowerCase() !== 'false',
    maxOutputTokens: clampInt(env.NOX_AI_MAX_OUTPUT_TOKENS, 1600, 128, 8192),
    maxInputChars: clampInt(env.NOX_AI_MAX_INPUT_CHARS, 48_000, 4_000, 200_000),
    timeoutMs: clampInt(env.NOX_AI_TIMEOUT_MS, 90_000, 5_000, 300_000),
    requestsPerMinute: clampInt(env.NOX_AI_RPM, 20, 1, 600),
  };
}

/** Safe for logs and for the /api/ai/status payload: host only. */
export function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'invalid';
  }
}

/** Redact anything that looks like a bearer token, API key or cookie before logging. */
export function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
    .replace(/((?:api[_-]?key|token|authorization)["'\s:=]+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***');
}
