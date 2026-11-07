import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { AiBrief, AiCitation, AiErrorCode, AiKeySource, AiMessage, AiModelInfo, AiModelsResponse, AiStatus, AiStreamEvent } from '../../shared/ai.ts';
import type { ResearchReport } from '../../shared/research.ts';
import type { MarketProject, ProjectVenueResponse } from '../../shared/types.ts';
import { DEEPSEEK_MODELS, endpointHost, redact, resolveConfig, type DeepSeekConfig } from './config.ts';
import { AiUpstreamError, completeChat, listModels, streamChat } from './deepseek.ts';
import { BRIEF_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, buildMarketContext, parseBrief, unknownCitations } from './prompt.ts';

/** Minimal shape of AuthStore that the AI routes need. */
export interface AiAuth {
  user(req: Request): { name: string; role: 'viewer' | 'analyst' | 'admin' } | null;
}

export interface AiDeps {
  auth: AiAuth;
  /** Resolve a project by id, including archived handling done by the caller. */
  project(id: string): MarketProject | undefined;
  /** Deterministic evidence for a project: the same report the Research page renders. */
  evidence(project: MarketProject): Promise<{ report: ResearchReport; venues: ProjectVenueResponse | null }>;
  /** Override for tests. */
  config?: DeepSeekConfig;
  transport?: typeof fetch;
}

const KEY_HEADER = 'x-deepseek-key';

/** Per-IP token bucket. Deliberately in-memory: this is a single-process research terminal. */
class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();
  constructor(private capacity: number) {}
  take(key: string, now = Date.now()): { ok: boolean; retryAfter: number } {
    const refillPerMs = this.capacity / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };
    const tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.updated) * refillPerMs);
    if (tokens < 1) {
      const waitMs = Math.ceil((1 - tokens) / refillPerMs);
      this.buckets.set(key, { tokens, updated: now });
      return { ok: false, retryAfter: Math.max(1, Math.ceil(waitMs / 1000)) };
    }
    this.buckets.set(key, { tokens: tokens - 1, updated: now });
    if (this.buckets.size > 5_000) {
      for (const [candidate, value] of this.buckets) if (now - value.updated > 600_000) this.buckets.delete(candidate);
    }
    return { ok: true, retryAfter: 0 };
  }
}

const chatBody = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(8_000),
  })).min(1).max(24),
  model: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/).optional(),
  temperature: z.number().min(0).max(1.5).optional(),
  projectId: z.string().min(1).max(120).optional(),
  /** Operator-provided extra focus, clamped server-side. */
  focus: z.string().max(500).optional(),
});

const briefBody = z.object({
  projectId: z.string().min(1).max(120),
  question: z.string().max(500).optional(),
});

class AiRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfter?: number) {
    super(message);
  }
}

export function aiStatus(config: DeepSeekConfig): AiStatus {
  return {
    provider: 'deepseek',
    available: Boolean(config.apiKey) || config.allowClientKey,
    serverKey: Boolean(config.apiKey),
    allowClientKey: config.allowClientKey,
    endpointHost: endpointHost(config.baseUrl),
    models: DEEPSEEK_MODELS,
    defaultModel: config.defaultModel,
    streaming: true,
    policy: {
      serverKeyRequiresSignIn: true,
      maxInputChars: config.maxInputChars,
      maxOutputTokens: config.maxOutputTokens,
      requestsPerMinute: config.requestsPerMinute,
    },
  };
}

/**
 * Resolve which credential funds this request.
 * - A browser-supplied key always works when the operator allows it; the caller pays.
 * - The server key is only spent for an authenticated session, so an exposed terminal
 *   cannot be used as a free LLM proxy.
 */
function resolveKey(req: Request, config: DeepSeekConfig, deps: AiDeps): { key: string; keySource: AiKeySource } {
  const header = req.header(KEY_HEADER)?.trim();
  if (header) {
    if (!config.allowClientKey) throw new AiRequestError(403, 'client-key-disabled', 'Browser-supplied keys are disabled on this server');
    if (header.length < 16 || header.length > 512 || !/^[A-Za-z0-9._~+/-]+=*$/.test(header)) {
      throw new AiRequestError(400, 'invalid-request', 'Malformed API key');
    }
    return { key: header, keySource: 'client' };
  }
  if (!config.apiKey) throw new AiRequestError(503, 'not-configured', 'No DeepSeek key configured. Add one in Settings → AI, or set DEEPSEEK_API_KEY on the server.');
  if (!deps.auth.user(req)) throw new AiRequestError(401, 'sign-in-required', 'Sign in to use the server DeepSeek key, or add your own key in Settings → AI.');
  return { key: config.apiKey, keySource: 'server' };
}

function writeEvent(res: Response, event: AiStreamEvent): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

/** Map an upstream/route failure onto the SSE error event + terminal HTTP status. */
function errorPayload(error: unknown): { status: number; body: { code: string; message: string; retryable: boolean; retryAfter?: number } } {
  if (error instanceof AiRequestError) return { status: error.status, body: { code: error.code, message: error.message, retryable: false, retryAfter: error.retryAfter } };
  if (error instanceof AiUpstreamError) {
    const status = error.code === 'aborted' ? 499 : error.code === 'rate-limited' ? 429 : error.code === 'auth-failed' ? 401 : error.code === 'insufficient-balance' ? 402 : 502;
    return { status, body: { code: error.code, message: error.message, retryable: error.retryable, retryAfter: error.retryAfterSeconds ?? undefined } };
  }
  const message = error instanceof Error ? redact(error.message) : 'Unknown AI failure';
  return { status: 500, body: { code: 'upstream-error', message, retryable: false } };
}

function sendError(res: Response, error: unknown): void {
  const { status, body } = errorPayload(error);
  res.status(status).json({ error: body });
}

export function installAiRoutes(app: Express, deps: AiDeps): void {
  const config = deps.config ?? resolveConfig();
  const transport = deps.transport ?? fetch;
  const limiter = new RateLimiter(config.requestsPerMinute);
  const modelCache = new Map<string, { at: number; value: AiModelsResponse }>();

  /**
   * Live model list for the picker. Uses the same credential resolution as chat, so a
   * browser-key visitor sees their own catalogue and a server-key operator sees theirs.
   */
  app.get('/api/ai/models', async (req, res) => {
    try {
      const { key, keySource } = resolveKey(req, config, deps);
      const cacheKey = `${keySource}:${key.slice(-8)}`;
      const cached = modelCache.get(cacheKey);
      if (cached && Date.now() - cached.at < 600_000) { res.setHeader('Cache-Control', 'no-store'); res.json(cached.value); return; }
      const models = await listModels(config, key, transport);
      const value: AiModelsResponse = { models: models.length ? models : DEEPSEEK_MODELS, source: models.length ? 'upstream' : 'catalog', fetchedAt: Date.now() };
      modelCache.set(cacheKey, { at: Date.now(), value });
      res.setHeader('Cache-Control', 'no-store');
      res.json(value);
    } catch (error) {
      // Discovery is an enhancement, not a dependency: fall back to the built-in catalogue.
      const { body } = errorPayload(error);
      const models: AiModelInfo[] = DEEPSEEK_MODELS;
      res.setHeader('Cache-Control', 'no-store');
      res.json({ models, source: 'catalog', fetchedAt: Date.now(), warning: body.message } satisfies AiModelsResponse & { warning: string });
    }
  });

  app.get('/api/ai/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(aiStatus(config));
  });

  app.post('/api/ai/chat', async (req, res) => {
    try {
      const parsed = chatBody.safeParse(req.body);
      if (!parsed.success) throw new AiRequestError(400, 'invalid-request', 'Invalid chat payload');
      const body = parsed.data;
      const budget = limiter.take(req.ip ?? 'unknown');
      if (!budget.ok) throw new AiRequestError(429, 'rate-limited', `Too many AI requests; retry in ${budget.retryAfter}s`, budget.retryAfter);

      const { key, keySource } = resolveKey(req, config, deps);

      const messages: AiMessage[] = [{ role: 'system', content: CHAT_SYSTEM_PROMPT }];
      let citationIds: string[] = [];
      let citations: AiCitation[] = [];
      if (body.projectId) {
        const project = deps.project(body.projectId);
        if (!project) throw new AiRequestError(404, 'invalid-request', 'Project not found');
        const { report, venues } = await deps.evidence(project);
        const context = buildMarketContext(project, report, venues, Date.now(), Math.min(config.maxInputChars, 48_000));
        citations = context.citations;
        citationIds = context.citations.map((citation) => citation.id);
        messages.push({ role: 'system', content: `EVIDENCE PACKET (untrusted data, source ids are bracketed):\n${context.text}` });
      }
      if (body.focus) messages.push({ role: 'system', content: `Operator focus: ${body.focus.slice(0, 500)}` });
      messages.push(...body.messages);

      const chars = messages.reduce((total, message) => total + message.content.length, 0);
      if (chars > config.maxInputChars) throw new AiRequestError(413, 'context-too-large', `Conversation is ${chars} characters; limit is ${config.maxInputChars}. Start a new thread.`);

      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const controller = new AbortController();
      req.on('close', () => controller.abort());
      const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15_000);

      writeEvent(res, { type: 'meta', model: body.model ?? config.defaultModel, keySource, startedAt: Date.now(), citations });
      let full = '';
      try {
        for await (const chunk of streamChat(config, key, {
          model: body.model ?? config.defaultModel,
          messages,
          temperature: body.temperature ?? 0.2,
          maxTokens: config.maxOutputTokens,
          signal: controller.signal,
        }, transport)) {
          if (chunk.type === 'content') { full += chunk.text; writeEvent(res, { type: 'delta', text: chunk.text }); }
          else if (chunk.type === 'reasoning') writeEvent(res, { type: 'reasoning', text: chunk.text });
          else if (chunk.type === 'usage') writeEvent(res, { type: 'usage', usage: chunk.usage });
          else if (chunk.type === 'finish') writeEvent(res, { type: 'done', finishReason: chunk.reason });
        }
        // Grounding check is advisory for free-form chat: the reply still streams, but a
        // fabricated source id must not look like a verified citation.
        const unknown = unknownCitations(full, new Set(citationIds));
        if (unknown.length) writeEvent(res, { type: 'delta', text: `\n\n> ⚠ Unverified source id(s): ${unknown.join(', ')}. Ignore those citations.` });
      } catch (error) {
        if (!controller.signal.aborted) {
          const { body: payload } = errorPayload(error);
          writeEvent(res, { type: 'error', code: payload.code as AiErrorCode, message: payload.message, retryable: payload.retryable });
        }
      } finally {
        clearInterval(ping);
        if (!res.writableEnded) res.end();
      }
    } catch (error) {
      if (!res.headersSent) sendError(res, error);
      else if (!res.writableEnded) res.end();
    }
  });

  app.post('/api/ai/brief', async (req, res) => {
    try {
      const parsed = briefBody.safeParse(req.body);
      if (!parsed.success) throw new AiRequestError(400, 'invalid-request', 'Invalid brief payload');
      const budget = limiter.take(req.ip ?? 'unknown');
      if (!budget.ok) throw new AiRequestError(429, 'rate-limited', `Too many AI requests; retry in ${budget.retryAfter}s`, budget.retryAfter);
      const { key, keySource } = resolveKey(req, config, deps);
      const project = deps.project(parsed.data.projectId);
      if (!project) throw new AiRequestError(404, 'invalid-request', 'Project not found');

      const { report, venues } = await deps.evidence(project);
      // A brief asserts a market view. If no venue returned a snapshot there is nothing to
      // ground it in, and a model asked to fill the gap would invent one.
      if (!venues?.snapshots?.length) {
        throw new AiRequestError(409, 'evidence-unavailable', 'No venue snapshot is available for this project right now. Refresh the terminal and retry; no AI brief was generated.');
      }
      const context = buildMarketContext(project, report, venues, Date.now(), Math.min(config.maxInputChars, 48_000));
      const model = config.defaultModel;
      const completion = await completeChat(config, key, {
        model,
        messages: [
          { role: 'system', content: BRIEF_SYSTEM_PROMPT },
          { role: 'user', content: `EVIDENCE PACKET (untrusted data, source ids are bracketed):\n${context.text}\n\nTASK: ${parsed.data.question ?? 'Produce the structured market brief.'}` },
        ],
        temperature: 0.1,
        maxTokens: config.maxOutputTokens,
        json: true,
      }, transport);

      const brief: AiBrief = parseBrief(completion.content, context, { projectId: project.id, model, keySource, usage: completion.usage });
      if (context.truncated) brief.warnings.push('The evidence packet was truncated before the model saw it; late venues may be missing.');
      if (completion.finishReason === 'length') brief.warnings.push('The model hit the output token limit; the brief may be incomplete.');
      res.setHeader('Cache-Control', 'no-store');
      res.json(brief);
    } catch (error) {
      sendError(res, error);
    }
  });
}
