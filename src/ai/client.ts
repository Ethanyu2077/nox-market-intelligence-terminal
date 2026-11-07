/**
 * Browser-side DeepSeek client.
 *
 * The key never leaves this device except as a per-request header to the local NOX
 * server, which forwards it to DeepSeek and forgets it. Nothing here logs the key.
 */
import type { AiBrief, AiErrorCode, AiMessage, AiModelId, AiModelsResponse, AiStatus, AiStreamEvent } from '../../shared/ai';

export class AiClientError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string,
    readonly retryable = false,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'AiClientError';
  }
}

export async function getAiStatus(): Promise<AiStatus> {
  const response = await fetch('/api/ai/status', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new AiClientError('upstream-error', `AI status unavailable (HTTP ${response.status})`);
  return response.json() as Promise<AiStatus>;
}

/** Live model list for the current credential; falls back to the server catalogue. */
export async function getAiModels(apiKey?: string | null): Promise<AiModelsResponse> {
  const response = await fetch('/api/ai/models', {
    headers: { Accept: 'application/json', ...(apiKey ? { 'x-deepseek-key': apiKey } : {}) },
  });
  if (!response.ok) throw new AiClientError('upstream-error', `Model list unavailable (HTTP ${response.status})`);
  return response.json() as Promise<AiModelsResponse>;
}

/** Parse one SSE frame block into an event payload. */
function parseFrames(buffer: string): { events: AiStreamEvent[]; rest: string } {
  const events: AiStreamEvent[] = [];
  const normalized = buffer.replace(/\r\n?/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) continue;
    try {
      events.push(JSON.parse(data) as AiStreamEvent);
    } catch {
      // A malformed frame is treated as a transport error rather than silently dropped.
      events.push({ type: 'error', code: 'bad-response', message: 'Malformed stream frame', retryable: true });
    }
  }
  return { events, rest };
}

function errorFromBody(body: unknown, status: number): AiClientError {
  const payload = (body as { error?: { code?: AiErrorCode; message?: string; retryable?: boolean; retryAfter?: number } } | null)?.error;
  if (payload?.code) return new AiClientError(payload.code, payload.message ?? 'AI request failed', payload.retryable ?? false, payload.retryAfter);
  return new AiClientError(status === 401 ? 'sign-in-required' : 'upstream-error', `AI request failed (HTTP ${status})`, status >= 500);
}

export interface StreamAssistantOptions {
  messages: AiMessage[];
  projectId?: string;
  model?: AiModelId;
  /** Browser-stored key. Omitted when the server key should be used. */
  apiKey?: string | null;
  signal?: AbortSignal;
  onEvent: (event: AiStreamEvent) => void;
}

/** Stream a chat completion, emitting every typed event to `onEvent`. */
export async function streamAssistant(options: StreamAssistantOptions): Promise<void> {
  const response = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(options.apiKey ? { 'x-deepseek-key': options.apiKey } : {}),
    },
    body: JSON.stringify({
      messages: options.messages,
      projectId: options.projectId,
      model: options.model,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw errorFromBody(body, response.status);
  }
  if (!response.body) throw new AiClientError('bad-response', 'Streaming is not supported by this browser', false);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseFrames(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        options.onEvent(event);
        if (event.type === 'error' && !event.retryable) return;
      }
    }
    buffer += decoder.decode();
    for (const event of parseFrames(`${buffer}\n\n`).events) options.onEvent(event);
  } finally {
    reader.releaseLock();
  }
}

export async function requestBrief(projectId: string, apiKey?: string | null, question?: string): Promise<AiBrief> {
  const response = await fetch('/api/ai/brief', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(apiKey ? { 'x-deepseek-key': apiKey } : {}),
    },
    body: JSON.stringify({ projectId, question }),
  });
  if (!response.ok) throw errorFromBody(await response.json().catch(() => null), response.status);
  return response.json() as Promise<AiBrief>;
}
