import { z } from 'zod';
import type { AiErrorCode, AiModelId, AiModelInfo, AiUsage } from '../../shared/ai.ts';
import { completionsUrl, supportsThinking, type DeepSeekConfig } from './config.ts';
import { readSseStream } from './sse.ts';

/** Normalized upstream failure. The HTTP layer maps `code` to status + retry hints. */
export class AiUpstreamError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly status: number | null = null,
    readonly retryable = false,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'AiUpstreamError';
  }
}

export interface ChatRequest {
  model: AiModelId;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens: number;
  /** Ask DeepSeek for a JSON object. Used by the structured brief route. */
  json?: boolean;
  /** Enable thinking mode on models that support it. Off by default: slow and costly. */
  thinking?: boolean;
  signal?: AbortSignal;
}

export type ChatChunk =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'usage'; usage: AiUsage }
  | { type: 'finish'; reason: string | null };

const usageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().default(0),
  completion_tokens: z.number().int().nonnegative().default(0),
  total_tokens: z.number().int().nonnegative().default(0),
  prompt_cache_hit_tokens: z.number().int().nonnegative().nullish(),
}).passthrough();

const chunkSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({
      content: z.string().nullish(),
      reasoning_content: z.string().nullish(),
    }).partial().nullish(),
    finish_reason: z.string().nullish(),
  })).default([]),
  usage: usageSchema.nullish(),
  error: z.object({ message: z.string().optional(), type: z.string().optional() }).nullish(),
}).passthrough();

const responseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.string().nullish(), reasoning_content: z.string().nullish() }).nullish(),
    finish_reason: z.string().nullish(),
  })).default([]),
  usage: usageSchema.nullish(),
}).passthrough();

export function normalizeUsage(raw: z.infer<typeof usageSchema> | null | undefined): AiUsage {
  if (!raw) return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: null };
  return {
    promptTokens: raw.prompt_tokens,
    completionTokens: raw.completion_tokens,
    totalTokens: raw.total_tokens || raw.prompt_tokens + raw.completion_tokens,
    cachedTokens: raw.prompt_cache_hit_tokens ?? null,
  };
}

/** Map an HTTP status (and DeepSeek error text) to the terminal's error taxonomy. */
export function classifyStatus(status: number, detail = ''): AiUpstreamError {
  const text = detail.toLowerCase();
  if (/insufficient|balance|quota/.test(text)) return new AiUpstreamError('insufficient-balance', 'DeepSeek account has insufficient balance', status, false);
  if (status === 400 || status === 422) {
    const tooLarge = /context|too long|maximum|token/.test(text);
    return new AiUpstreamError(tooLarge ? 'context-too-large' : 'invalid-request', detail || 'DeepSeek rejected the request', status, false);
  }
  if (status === 401 || status === 403) return new AiUpstreamError('auth-failed', 'DeepSeek rejected the API key', status, false);
  if (status === 402) return new AiUpstreamError('insufficient-balance', 'DeepSeek account has insufficient balance', status, false);
  if (status === 429) return new AiUpstreamError('rate-limited', 'DeepSeek rate limit reached', status, true);
  if (status >= 500) return new AiUpstreamError('upstream-error', 'DeepSeek service error', status, true);
  return new AiUpstreamError('upstream-error', detail || `DeepSeek returned HTTP ${status}`, status, false);
}

async function upstreamError(response: Response): Promise<AiUpstreamError> {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      detail = parsed.error?.message ?? text.slice(0, 300);
    } catch {
      detail = text.slice(0, 300);
    }
  } catch { /* body unreadable; the status alone must carry the message */ }
  const error = classifyStatus(response.status, detail);
  const retryAfter = Number(response.headers.get('retry-after'));
  return Number.isFinite(retryAfter) && retryAfter > 0
    ? new AiUpstreamError(error.code, error.message, error.status, error.retryable, retryAfter)
    : error;
}

function bodyFor(request: ChatRequest, stream: boolean): string {
  return JSON.stringify({
    model: request.model,
    messages: request.messages,
    temperature: request.temperature ?? 0.2,
    max_tokens: request.maxTokens,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(request.json ? { response_format: { type: 'json_object' } } : {}),
    // Flash/V4 default to thinking *on* when the field is omitted. Chat must stay fast and
    // cheap, so the switch is explicit for those models; legacy ids reject unknown fields.
    ...(supportsThinking(request.model) ? { thinking: { type: request.thinking ? 'enabled' : 'disabled' } } : {}),
  });
}

async function post(config: DeepSeekConfig, key: string, request: ChatRequest, body: string, transport: typeof fetch): Promise<Response> {
  return transport(completionsUrl(config.baseUrl), {
    method: 'POST',
    redirect: 'error',
    signal: request.signal ?? AbortSignal.timeout(config.timeoutMs),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${key}`,
    },
    body,
  });
}

/**
 * Stream a chat completion. Yields content/reasoning deltas and a final usage chunk.
 *
 * A 429/5xx is retried once, but only when nothing has been emitted yet: a partially
 * streamed answer must not be duplicated in the UI.
 */
export async function* streamChat(
  config: DeepSeekConfig,
  key: string,
  request: ChatRequest,
  transport: typeof fetch = fetch,
): AsyncGenerator<ChatChunk> {
  const body = bodyFor(request, true);
  let emitted = false;
  let attempt = 0;
  let response: Response | null = null;
  while (!response) {
    attempt += 1;
    let candidate: Response;
    try {
      candidate = await post(config, key, request, body, transport);
    } catch (error) {
      if (isAbort(error)) throw new AiUpstreamError('aborted', 'Request aborted by client', null, false);
      if (attempt >= 2) throw new AiUpstreamError('network-error', 'Cannot reach DeepSeek', null, true);
      await sleep(400 * attempt);
      continue;
    }
    if (!candidate.ok) {
      const failure = await upstreamError(candidate);
      if (failure.retryable && attempt < 2 && !emitted) {
        await sleep((failure.retryAfterSeconds ?? 1) * 1000);
        continue;
      }
      throw failure;
    }
    response = candidate;
  }
  if (!response.body) throw new AiUpstreamError('bad-response', 'DeepSeek returned an empty stream', 200, true);

  let finish: string | null = null;
  try {
    for await (const payload of readSseStream(response.body)) {
      if (payload === '[DONE]') break;
      let json: unknown;
      try {
        json = JSON.parse(payload);
      } catch {
        throw new AiUpstreamError('bad-response', 'DeepSeek stream contained malformed JSON', 200, true);
      }
      const parsed = chunkSchema.safeParse(json);
      if (!parsed.success) throw new AiUpstreamError('bad-response', 'DeepSeek stream failed schema validation', 200, true);
      if (parsed.data.error?.message) throw new AiUpstreamError('upstream-error', parsed.data.error.message, 200, false);
      for (const choice of parsed.data.choices) {
        const reasoning = choice.delta?.reasoning_content;
        if (reasoning) { emitted = true; yield { type: 'reasoning', text: reasoning }; }
        const content = choice.delta?.content;
        if (content) { emitted = true; yield { type: 'content', text: content }; }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      if (parsed.data.usage) yield { type: 'usage', usage: normalizeUsage(parsed.data.usage) };
    }
  } finally {
    await response.body.cancel().catch(() => undefined);
  }
  yield { type: 'finish', reason: finish };
}

/** Non-streaming completion with one retry for transient upstream failures. */
export async function completeChat(
  config: DeepSeekConfig,
  key: string,
  request: ChatRequest,
  transport: typeof fetch = fetch,
): Promise<{ content: string; reasoning: string; usage: AiUsage; finishReason: string | null }> {
  const body = bodyFor(request, false);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await post(config, key, request, body, transport);
    } catch (error) {
      lastError = isAbort(error) ? new AiUpstreamError('aborted', 'Request aborted by client') : new AiUpstreamError('network-error', 'Cannot reach DeepSeek', null, true);
      if ((lastError as AiUpstreamError).code === 'aborted') throw lastError;
      await sleep(400 * (attempt + 1));
      continue;
    }
    if (!response.ok) {
      const failure = await upstreamError(response);
      lastError = failure;
      if (failure.retryable && attempt === 0) { await sleep((failure.retryAfterSeconds ?? 1) * 1000); continue; }
      throw failure;
    }
    const parsed = responseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new AiUpstreamError('bad-response', 'DeepSeek returned an unexpected response body', 200, true);
    const choice = parsed.data.choices[0];
    return {
      content: choice?.message?.content ?? '',
      reasoning: choice?.message?.reasoning_content ?? '',
      usage: normalizeUsage(parsed.data.usage),
      finishReason: choice?.finish_reason ?? null,
    };
  }
  throw lastError instanceof AiUpstreamError ? lastError : new AiUpstreamError('network-error', 'Cannot reach DeepSeek', null, true);
}

const modelsSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1), name: z.string().nullish(), owned_by: z.string().nullish() })).default([]),
}).passthrough();

/** Live model discovery so a renamed provider catalogue does not break the picker. */
export async function listModels(config: DeepSeekConfig, key: string, transport: typeof fetch = fetch): Promise<AiModelInfo[]> {
  const response = await transport(`${config.baseUrl.replace(/\/+$/, '')}/models`, {
    method: 'GET',
    redirect: 'error',
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw await upstreamError(response);
  const parsed = modelsSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new AiUpstreamError('bad-response', 'Unexpected model list from DeepSeek', 200, false);
  return parsed.data.data.map((model) => ({
    id: model.id,
    label: model.name ?? model.id,
    reasoning: /reason|think|pro|v4/i.test(model.id),
    note: model.owned_by ? `Provided by ${model.owned_by}` : 'Discovered from the provider model list.',
  }));
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
