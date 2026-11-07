#!/usr/bin/env node
/**
 * Dedicated Evidence Panel browser suite.
 *
 * Renders the real CrossExchangePanel on the Vite harness page, serves deterministic
 * fixtures by intercepting `/api/.../research/cross-factor`, and drives every control.
 * Fixtures are UI-only and are never reported as real market validation.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const args = new Map(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.join('=') || '1']; }));
const base = args.get('base') ?? process.env.E2E_BASE ?? 'http://127.0.0.1:4173';
const chrome = process.env.CHROME_PATH ?? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'].find((path) => existsSync(path));
const outDir = 'artifacts/e2e-evidence';

if (!chrome) {
  console.log(JSON.stringify({ status: 'SKIPPED', reason: 'no Chromium/Chrome binary found; set CHROME_PATH' }, null, 2));
  process.exit(2);
}

const venue = (name, coveragePct) => ({
  venue: name, samples: 120, coveragePct, gaps: coveragePct < 60 ? 4 : 0, latest: 104,
  expectedSamples: 200, observedSamples: 120, validSamples: Math.round(coveragePct * 2), excludedSamples: 10,
  missingSamples: 80, timeCoveragePct: 60, validCoveragePct: coveragePct, sourceQuality: 90,
});
const direction = (from, to, lagMs, correlation, samples, selected = false) => ({ from, to, lagMs, correlation, samples, selected });
const pair = (a, b, leader, follower, lagMs, correlation, samples) => ({
  venues: [a, b],
  directions: [direction(a, b, lagMs, correlation, samples, true), direction(b, a, 0, correlation * 0.4, samples)],
  leader, follower, lagMs, correlation, samples, verdict: 'descriptive',
});
function report(mode, factor) {
  const correlation = factor === 'funding_basis' ? 0.81 : 0.62;
  const pairs = [
    pair('binance', 'bybit', 'binance', 'bybit', 60_000, correlation, 120),
    pair('binance', 'okx', 'okx', 'binance', 0, 0.44, 96),
    pair('bybit', 'okx', null, null, null, null, 40),
  ].map((row, index) => index === 2 ? { ...row, verdict: 'insufficient' } : row);
  return {
    factor, unit: factor === 'funding_basis' ? 'bps' : 'pct', comparable: true, reasons: [],
    venues: [venue('binance', 82), venue('bybit', 74), venue('okx', 55)],
    directions: pairs[0].directions, pairs, transform: 'difference',
    dataWindow: { start: 1_700_000_000_000, end: 1_700_006_000_000, bucketMs: 300_000 },
    partial: mode === 'truncated', missingWindows: 3, excludedSamples: 7, hypothesesTested: 18, bonferroniAlpha: 0.0028,
    leader: pairs[0].leader, follower: pairs[0].follower, lagMs: pairs[0].lagMs, correlation, samples: 120,
    counterEvidence: ['Both directions are close; treat as exploratory'], verdict: 'descriptive',
    notes: ['Descriptive association only; not causality.'],
  };
}

const checks = [];
const consoleErrors = [];
const serverErrors = [];
function check(name, condition, detail = '') { checks.push({ name, passed: Boolean(condition), detail }); }
const text = (page, selector) => page.$eval(selector, (element) => element.textContent?.trim() ?? '').catch(() => '');

await mkdir(outDir, { recursive: true });
let browser;
let mode = 'ok';
let currentMode = 'ok';
try {
  browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (text.includes('favicon') || text.includes('status of 404')) return;
    if (currentMode === 'fail' && text.includes('status of 500')) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('response', (response) => {
    const status = response.status();
    if (status >= 500 && currentMode !== 'fail') serverErrors.push(`${status} ${response.url()}`);
    if (status === 404 && !response.url().endsWith('favicon.ico')) serverErrors.push(`404 ${response.url()}`);
  });

  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.endsWith('/research/cross-factor')) return request.continue();
    mode = url.searchParams.get('mode') ?? mode;
    if (mode === 'fail') return request.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'fixture failure' } }) });
    if (mode === 'empty') return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...report('ok', 'oi_delta'), comparable: false, venues: [], pairs: [], directions: [], leader: null, follower: null, lagMs: null, correlation: null, samples: 0, verdict: 'unavailable', reasons: ['No comparable venue history'] }) });
    return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(report(mode, url.searchParams.get('factor') ?? 'oi_delta')) });
  });

  const open = async (query = '') => {
    mode = new URLSearchParams(query).get('mode') ?? 'ok';
    currentMode = mode;
    await page.goto(`${base}/e2e/evidence.html${query}`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.cx-panel', { timeout: 10_000 });
  };

  await open();
  const requests = [];
  page.on('request', (request) => { if (request.url().includes('cross-factor')) requests.push(request.url()); });

  check('panel renders', (await text(page, '.cx-panel h3')).toLowerCase().includes('cross-exchange'));
  check('OOS is never a win rate', (await page.$$eval('.cx-oos', (nodes) => nodes.map((node) => node.textContent?.trim()))).every((value) => value === 'NOT VERIFIED'));
  check('coverage column present', (await text(page, '.cx-table')).includes('%'));

  const before = requests.at(-1) ?? '';
  await page.select('.cx-controls select:nth-of-type(1)', 'funding_basis').catch(() => page.select('.cx-controls select', 'funding_basis'));
  await page.waitForResponse((response) => response.url().includes('cross-factor') && response.url().includes('funding_basis'), { timeout: 10_000 }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 300));
  check('factor switch triggers a new request', (requests.at(-1) ?? '').includes('factor=funding_basis') && requests.at(-1) !== before, requests.at(-1) ?? '');
  check('factor switch updates the matrix', (await text(page, '.cx-table tbody tr td:nth-child(4)')).startsWith('0.8'));

  const selects = await page.$$('.cx-controls select');
  await selects[1].select('15m');
  await page.waitForResponse((response) => response.url().includes('timeframe=15m'), { timeout: 10_000 }).catch(() => null);
  check('timeframe switch triggers a request', (requests.at(-1) ?? '').includes('timeframe=15m'));
  const startBefore = new URL(requests.at(-1)).searchParams.get('start');
  await selects[2].select('7d');
  await page.waitForResponse((response) => response.url().includes('cross-factor'), { timeout: 10_000 }).catch(() => null);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const startAfter = new URL(requests.at(-1)).searchParams.get('start');
  check('lookback switch moves the window', Number(startAfter) < Number(startBefore));

  const pairSelect = (await page.$$('.cx-controls select'))[3];
  await pairSelect.select('binance→okx');
  await new Promise((resolve) => setTimeout(resolve, 250));
  check('pair selection updates detail', (await text(page, '.cx-detail-head')).includes('binance') && (await text(page, '.cx-detail-head')).includes('okx'));

  await (await page.$$('.cx-controls select'))[5].select('correlation');
  const correlations = await page.$$eval('.cx-table tbody tr td:nth-child(4)', (cells) => cells.map((cell) => Number(cell.textContent)).filter((value) => Number.isFinite(value)));
  check('sorting by correlation is descending', correlations.every((value, index) => index === 0 || correlations[index - 1] >= value), JSON.stringify(correlations));
  const notes = await page.$$eval('.cx-note', (nodes) => nodes.map((node) => node.textContent ?? '').join(' '));
  check('data window and exclusions visible', notes.includes('Data window') && notes.includes('excluded'), notes.slice(0, 120));
  check('English labels render', (await text(page, '.cx-panel h3')).length > 0);

  await page.click('#lang-toggle');
  await new Promise((resolve) => setTimeout(resolve, 250));
  check('Chinese labels render', (await text(page, '.cx-panel h3')).includes('跨交易所证据'));
  await page.click('#lang-toggle');

  await open('?mode=truncated');
  check('truncated state is shown', (await text(page, '.cx-panel')).includes('PARTIAL') || (await text(page, '.cx-note')).includes('truncated'));

  await open('?mode=fail');
  await new Promise((resolve) => setTimeout(resolve, 400));
  check('API error is explicit', (await text(page, '.alerts-error')).length > 0);

  await open('?mode=empty');
  await new Promise((resolve) => setTimeout(resolve, 250));
  check('empty state is explicit', (await text(page, '.cx-empty')).includes('Not comparable'));

  await page.setViewport({ width: 390, height: 844 });
  await open();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('390px has no horizontal overflow', overflow <= 1, `overflow=${overflow}px`);
  check('mobile panel still renders', (await text(page, '.cx-panel h3')).length > 0);

  check('no React/JS console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  check('no unexpected 5xx', serverErrors.length === 0, serverErrors.slice(0, 3).join(' | '));

  const failures = checks.filter((item) => !item.passed);
  const result = { status: failures.length ? 'FAIL' : 'PASS', base, browser: await browser.version(), checks, failures: failures.length };
  await writeFile(`${outDir}/report.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) {
    await page.screenshot({ path: `${outDir}/failure.png`, fullPage: true }).catch(() => undefined);
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await writeFile(`${outDir}/report.json`, JSON.stringify({ status: 'FAIL', error: message, checks }, null, 2)).catch(() => undefined);
  console.error(JSON.stringify({ status: 'FAIL', error: message, checks }, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
}
