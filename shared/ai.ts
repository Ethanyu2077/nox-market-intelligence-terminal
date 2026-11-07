/**
 * Shared contracts for the DeepSeek research assistant.
 *
 * The terminal treats an LLM as a *reader* of the deterministic evidence produced by
 * server/research.ts — never as a source of numbers. These types keep that boundary
 * explicit on both sides of the wire.
 */

/** Which credential funded a request. The browser is told so it can label its own UI. */
export type AiKeySource = 'server' | 'client';

/**
 * Model ids are not a closed union: DeepSeek renames offerings (deepseek-chat →
 * deepseek-flash/v4-pro), so the server exposes a catalog plus live discovery from the
 * provider's /models endpoint.
 */
export type AiModelId = string;

export interface AiModelInfo {
  id: AiModelId;
  label: string;
  /** Whether the model can emit a separate reasoning stream before the answer. */
  reasoning: boolean;
  /** Present in the built-in catalog but kept for older deployments. */
  legacy?: boolean;
  /** Short operator-facing description. */
  note: string;
}

export interface AiModelsResponse {
  models: AiModelInfo[];
  /** 'upstream' when fetched from DeepSeek with a real key, 'catalog' when static. */
  source: 'upstream' | 'catalog';
  fetchedAt: number;
}

export interface AiStatus {
  provider: 'deepseek';
  /** True when either a server key or browser-key mode is usable. */
  available: boolean;
  /** True when DEEPSEEK_API_KEY is configured on the server. */
  serverKey: boolean;
  /** True when the operator allows a browser-supplied key to be forwarded. */
  allowClientKey: boolean;
  /** Host only, never the full URL with credentials. */
  endpointHost: string;
  models: AiModelInfo[];
  defaultModel: AiModelId;
  streaming: boolean;
  policy: {
    /** Server-key calls require an authenticated session; client-key calls do not. */
    serverKeyRequiresSignIn: boolean;
    maxInputChars: number;
    maxOutputTokens: number;
    requestsPerMinute: number;
  };
}

export type AiRole = 'system' | 'user' | 'assistant';

export interface AiMessage {
  role: AiRole;
  content: string;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** DeepSeek reports context-cache hits here when available. */
  cachedTokens: number | null;
}

/** A citation resolvable to a real upstream snapshot. */
export interface AiCitation {
  id: string;
  exchange: string;
  symbol: string;
  eventTime: number;
  quality: string;
}

export type AiStreamEvent =
  | { type: 'meta'; model: AiModelId; keySource: AiKeySource; startedAt: number; citations: AiCitation[] }
  /** Visible answer text. */
  | { type: 'delta'; text: string }
  /** Chain-of-thought from deepseek-reasoner, rendered in a collapsed block. */
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: AiUsage }
  | { type: 'error'; code: AiErrorCode; message: string; retryable: boolean }
  | { type: 'done'; finishReason: string | null };

export type AiErrorCode =
  | 'not-configured'
  | 'sign-in-required'
  | 'auth-failed'
  | 'insufficient-balance'
  | 'rate-limited'
  | 'invalid-request'
  | 'context-too-large'
  | 'network-error'
  | 'upstream-error'
  | 'aborted'
  | 'bad-response';

/** JSON-mode answer contract for the "market brief" action. */
export interface AiBriefClaim {
  text: string;
  sources: string[];
}

export interface AiBrief {
  generatedAt: number;
  model: AiModelId;
  keySource: AiKeySource;
  projectId: string;
  summary: string;
  observed: AiBriefClaim[];
  inferences: AiBriefClaim[];
  hypotheses: Array<AiBriefClaim & { invalidation: string }>;
  risks: AiBriefClaim[];
  missingData: string[];
  citations: AiCitation[];
  usage: AiUsage | null;
  /** Non-fatal problems: dropped claims, unknown citations, truncation. */
  warnings: string[];
}

/** Error envelope shared by every AI route. */
export interface AiErrorBody {
  error: {
    code: AiErrorCode;
    message: string;
    retryable: boolean;
    /** Seconds to wait for rate limits. */
    retryAfter?: number;
  };
}
