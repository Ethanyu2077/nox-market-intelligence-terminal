import assert from 'node:assert/strict';
import test from 'node:test';
import { SseDecoder } from '../server/ai/sse.ts';
import { ConfigError, isModelId, modelInfo, normalizeBaseUrl, redact, resolveConfig, completionsUrl } from '../server/ai/config.ts';
import { AiUpstreamError, classifyStatus, completeChat, listModels, streamChat } from '../server/ai/deepseek.ts';
import { buildMarketContext, parseBrief, unknownCitations } from '../server/ai/prompt.ts';
import type { ResearchReport } from '../shared/research.ts';
import type { MarketProject, ProjectVenueResponse } from '../shared/types.ts';

const project: MarketProject = {
  id: 'p1', name: 'DOOD Research', tokenSymbol: 'DOOD', contractAddress: null, identitySource: 'symbol', identityNetwork: null,
  markets: [{ id: 'binance:perpetual:DOODUSDT', exchange: 'binance', marketType: 'perpetual', symbol: 'DOODUSDT', base: 'DOOD', quote: 'USDT', status: 'normal' }],
  primaryMarketId: 'binance:perpetual:DOODUSDT',
  monitoring: { defaultInterval: '5m', streamingEnabled: true, collectionMode: 'standard' },
  archived: false, order: 0, createdAt: 1, updatedAt: 1,
} as unknown as MarketProject;

const report: ResearchReport = {
  generatedAt: 1, projectId: 'p1', mode: 'evidence-only',
  observed: [{ text: 'Price moved -1.1% over 24H', sources: ['binance:perpetual:DOODUSDT'] }],
  inferences: [{ text: 'OI fell while price fell', sources: ['binance:perpetual:DOODUSDT'] }],
  hypotheses: [], limitations: [{ text: 'Only selected venues are covered', sources: [] }],
  sources: [{ id: 'S1', venue: 'binance', symbol: 'DOODUSDT', source: 'fapi', eventTime: 1, quality: 'live' }],
  tools: ['venue_snapshot'], metricDependencies: [], nonIdentifiable: ['Who opened a position.'],
};

const venues: ProjectVenueResponse = {
  snapshots: [{
    exchange: 'binance', marketType: 'perpetual', symbol: 'DOODUSDT', price: 0.001734, markPrice: 0.001736, change24hPct: -1.12,
    volume24hBase: 12_982_907, volume24hUsd: 9_960_000, oiBase: 5_150_000_000, oiUsd: 8_930_000, fundingRate: 0.0001,
    nextFundingTime: 1_700_000_000_000, fundingIntervalHours: 8, cvd: null, eventTime: 1_700_000_000_000,
    source: 'binance-fapi', quality: 'live', unavailable: [],
  }],
  aggregate: null,
  failures: [{ exchange: 'okx', message: 'timeout' }],
} as unknown as ProjectVenueResponse;

test('SSE decoder survives split chunks, CRLF, comments and multi-line data', () => {
  const decoder = new SseDecoder();
  assert.deepEqual(decoder.push('event: delta\r\ndata: {"a"'), []);
  const events = decoder.push(':1}\r\n\r\n: ping\r\n\r\ndata: [DONE]\n\n');
  assert.equal(events.length, 2);
  assert.equal(events[0].event, 'delta');
  assert.equal(events[0].data, '{"a":1}');
  assert.equal(events[1].data, '[DONE]');
});

test('trailing event without a blank line is flushed', () => {
  const decoder = new SseDecoder();
  decoder.push('data: tail');
  assert.equal(decoder.flush()[0].data, 'tail');
});

test('base URL validation rejects credentials and plain remote HTTP', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com');
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions'), 'https://api.deepseek.com/v1');
  assert.equal(completionsUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.throws(() => normalizeBaseUrl('http://api.deepseek.com'), ConfigError);
  assert.throws(() => normalizeBaseUrl('https://user:pass@api.deepseek.com'), ConfigError);
});

test('config defaults are safe and env overrides are clamped', () => {
  const config = resolveConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.apiKey, null);
  assert.equal(config.defaultModel, 'deepseek-flash');
  assert.equal(config.allowClientKey, true);
  const clamped = resolveConfig({ NOX_AI_MAX_OUTPUT_TOKENS: '999999', NOX_AI_RPM: '0', DEEPSEEK_MODEL: 'deepseek-v4-pro' } as NodeJS.ProcessEnv);
  assert.equal(clamped.maxOutputTokens, 8192);
  assert.equal(clamped.requestsPerMinute, 1);
  assert.equal(clamped.defaultModel, 'deepseek-v4-pro');
  const locked = resolveConfig({ NOX_AI_ALLOW_CLIENT_KEY: 'false', DEEPSEEK_API_KEY: 'sk-test' } as NodeJS.ProcessEnv);
  assert.equal(locked.allowClientKey, false);
  assert.equal(locked.apiKey, 'sk-test');
});

test('redaction removes keys and bearer tokens', () => {
  const value = redact('Authorization: Bearer sk-abcdef1234567890 and api_key=SECRETVALUE99');
  assert.equal(value.includes('abcdef1234567890'), false);
  assert.equal(value.includes('SECRETVALUE99'), false);
});

test('upstream status mapping distinguishes auth, balance, context and rate limits', () => {
  assert.equal(classifyStatus(401).code, 'auth-failed');
  assert.equal(classifyStatus(402).code, 'insufficient-balance');
  assert.equal(classifyStatus(429).code, 'rate-limited');
  assert.equal(classifyStatus(400, 'maximum context length exceeded').code, 'context-too-large');
  assert.equal(classifyStatus(400, 'bad param').code, 'invalid-request');
  assert.equal(classifyStatus(503).retryable, true);
});

// Minimal byte stream for a fake upstream response.
const sse = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); },
  });
};

test('streamChat parses content, reasoning and usage, then reports finish', async () => {
  const transport = (async () => new Response(sse([
    'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Price "}}]}\n\ndata: {"choices":[{"delta":{"content":"fell"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
    'data: [DONE]\n\n',
  ]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as unknown as typeof fetch;

  const seen: string[] = [];
  let usage = 0;
  for await (const chunk of streamChat(resolveConfig({} as NodeJS.ProcessEnv), 'sk-test', { model: 'deepseek-chat', messages: [{ role: 'user', content: 'q' }], maxTokens: 100 }, transport)) {
    if (chunk.type === 'content') seen.push(chunk.text);
    if (chunk.type === 'reasoning') seen.push(`r:${chunk.text}`);
    if (chunk.type === 'usage') usage = chunk.usage.totalTokens;
    if (chunk.type === 'finish') assert.equal(chunk.reason, 'stop');
  }
  assert.deepEqual(seen, ['r:thinking', 'Price ', 'fell']);
  assert.equal(usage, 12);
});

test('streamChat retries a 500 once before streaming', async () => {
  let calls = 0;
  const transport = (async () => {
    calls += 1;
    if (calls === 1) return new Response('{"error":{"message":"boom"}}', { status: 500 });
    return new Response(sse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']), { status: 200 });
  }) as unknown as typeof fetch;
  const out: string[] = [];
  for await (const chunk of streamChat(resolveConfig({} as NodeJS.ProcessEnv), 'sk-test', { model: 'deepseek-chat', messages: [{ role: 'user', content: 'q' }], maxTokens: 10 }, transport)) {
    if (chunk.type === 'content') out.push(chunk.text);
  }
  assert.equal(calls, 2);
  assert.deepEqual(out, ['ok']);
});

test('streamChat surfaces an auth failure without retrying', async () => {
  let calls = 0;
  const transport = (async () => { calls += 1; return new Response('{"error":{"message":"bad key"}}', { status: 401 }); }) as unknown as typeof fetch;
  await assert.rejects(
    async () => { for await (const _ of streamChat(resolveConfig({} as NodeJS.ProcessEnv), 'sk-test', { model: 'deepseek-chat', messages: [{ role: 'user', content: 'q' }], maxTokens: 10 }, transport)) void _; },
    (error: unknown) => error instanceof AiUpstreamError && error.code === 'auth-failed',
  );
  assert.equal(calls, 1);
});

test('thinking switch is only sent to models that support it', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const transport = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(sse(['data: [DONE]\n\n']), { status: 200 });
  }) as unknown as typeof fetch;
  for await (const _ of streamChat(resolveConfig({} as NodeJS.ProcessEnv), 'sk-test', { model: 'deepseek-flash', messages: [{ role: 'user', content: 'q' }], maxTokens: 10 }, transport)) void _;
  for await (const _ of streamChat(resolveConfig({} as NodeJS.ProcessEnv), 'sk-test', { model: 'deepseek-chat', messages: [{ role: 'user', content: 'q' }], maxTokens: 10 }, transport)) void _;
  assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
  assert.equal(bodies[1].thinking, undefined);
});

test('model discovery maps the provider catalogue', async () => {
  const transport = (async () => new Response(JSON.stringify({ data: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', owned_by: 'deepseek' }, { id: 'deepseek-v4-pro' }] }), { status: 200 })) as unknown as typeof fetch;
  const models = await listModels(resolveConfig({} as NodeJS.ProcessEnv), 'sk-test', transport);
  assert.deepEqual(models.map((model) => model.id), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(models[0].label, 'DeepSeek Flash');
  assert.equal(models[1].label, 'deepseek-v4-pro');
});

test('unknown provider model ids are accepted but malformed ones are rejected', () => {
  assert.equal(isModelId('deepseek-v4-pro'), true);
  assert.equal(isModelId('qwen3-coder'), true);
  assert.equal(isModelId('sp ace'), false);
  assert.equal(isModelId('../etc/passwd'), false);
  assert.equal(modelInfo('qwen3-coder').label, 'qwen3-coder');
});

test('completeChat parses JSON-mode content and usage', async () => {
  const transport = (async () => new Response(JSON.stringify({
    choices: [{ message: { content: '{"summary":"ok"}', reasoning_content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, prompt_cache_hit_tokens: 2 },
  }), { status: 200 })) as unknown as typeof fetch;
  const result = await completeChat(resolveConfig({} as NodeJS.ProcessEnv), 'sk-test', { model: 'deepseek-chat', messages: [], maxTokens: 50, json: true }, transport);
  assert.equal(result.content, '{"summary":"ok"}');
  assert.equal(result.usage.cachedTokens, 2);
});

test('context builder labels sources, preserves nulls and caps the packet', () => {
  const context = buildMarketContext(project, report, venues, 1_700_000_100_000, 10_000);
  assert.equal(context.citations.length, 1);
  assert.equal(context.citations[0].id, 'S1');
  assert.match(context.text, /\[S1\] binance DOODUSDT/);
  assert.match(context.text, /oiUsd=8930000/);
  assert.match(context.text, /unavailable=none/);
  assert.match(context.text, /VENUE FAILURE okx: timeout/);
  assert.match(context.text, /PUBLIC DATA CANNOT IDENTIFY/);
  const tiny = buildMarketContext(project, report, venues, 1_700_000_100_000, 200);
  assert.equal(tiny.truncated, true);
  assert.match(tiny.text, /PACKET TRUNCATED/);
});

test('brief parser drops unknown citations and keeps grounded claims', () => {
  const context = buildMarketContext(project, report, venues, 1_700_000_100_000);
  const brief = parseBrief(JSON.stringify({
    summary: 'OI down with price.',
    observed: [{ text: 'Price -1.12%', sources: ['S1'] }, { text: 'Invented', sources: ['S9'] }, { text: 'No source', sources: [] }],
    inferences: [{ text: 'Deleveraging', sources: ['S1', 'S8'] }],
    hypotheses: [{ text: 'Longs exiting', sources: ['S1'], invalidation: 'OI recovers with price' }, { text: 'Invented hypothesis', sources: ['S7'], invalidation: 'n/a' }],
    risks: [], missingData: ['Liquidation feed not covered'],
  }), context, { projectId: 'p1', model: 'deepseek-chat', keySource: 'server', usage: null });
  assert.equal(brief.observed.length, 1);
  assert.deepEqual(brief.inferences[0].sources, ['S1']);
  assert.equal(brief.hypotheses.length, 1, 'hypotheses with only unknown citations must be dropped');
  assert.equal(brief.hypotheses[0].invalidation, 'OI recovers with price');
  assert.ok(brief.warnings.some((warning) => warning.includes('S9')));
  assert.ok(brief.warnings.some((warning) => warning.includes('S8')));
});

test('brief parser recovers from fenced or invalid JSON without throwing', () => {
  const context = buildMarketContext(project, report, venues, 1_700_000_100_000);
  const fenced = parseBrief('```json\n{"summary":"x","observed":[{"text":"a","sources":["S1"]}]}\n```', context, { projectId: 'p1', model: 'deepseek-chat', keySource: 'client', usage: null });
  assert.equal(fenced.observed.length, 1);
  const broken = parseBrief('not json at all', context, { projectId: 'p1', model: 'deepseek-chat', keySource: 'client', usage: null });
  assert.equal(broken.summary, '');
  assert.ok(broken.warnings.some((warning) => warning.includes('not valid JSON')));
});

test('unknown citation detector only flags ids outside the packet', () => {
  assert.deepEqual(unknownCitations('a [S1] b [S4]', new Set(['S1', 'S2'])), ['S4']);
  assert.deepEqual(unknownCitations('no citations', new Set(['S1'])), []);
});
