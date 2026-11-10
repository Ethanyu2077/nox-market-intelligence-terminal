#!/usr/bin/env node
/**
 * End-to-end smoke test.
 *
 * Prerequisites: the API (and either Vite dev or the production build served by the API)
 * is already running. It asserts that the shell renders, every reachable page mounts
 * without a React error, the palette and AI drawer open, and no request returns 5xx.
 *
 * Chrome is auto-detected; when no Chromium-based browser is available the script exits 0
 * with a warning so CI images without a browser do not fail spuriously.
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const args = process.argv.slice(2);
const baseArg = args.find((value) => value.startsWith('--base='));
const base = (baseArg?.split('=')[1] ?? process.env.E2E_BASE ?? 'http://127.0.0.1:4173').replace(/\/$/, '');
const outDir = path.resolve('artifacts', 'e2e');

const CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

async function findChrome() {
  const { access } = await import('node:fs/promises');
  for (const candidate of CANDIDATES) {
    try { await access(candidate); return candidate; } catch { /* keep looking */ }
  }
  return null;
}

const chrome = await findChrome();
if (!chrome) {
  console.warn('[e2e] No Chromium-based browser found; skipping (set CHROME_PATH to enable).');
  process.exit(0);
}

await mkdir(outDir, { recursive: true });
const failures = [];
const pageErrors = [];
const serverErrors = [];
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('response', (response) => { if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`); });

try {
  await page.goto(base, { waitUntil: 'networkidle2', timeout: 45_000 });
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  const nav = await page.$$eval('nav button', (buttons) => buttons.map((button) => ({ label: button.textContent.trim(), disabled: button.disabled })));
  check('shell renders navigation', nav.length >= 8, `${nav.length} items`);
  check('no page errors on load', pageErrors.length === 0, pageErrors.slice(0, 2).join('; '));

  const hasProject = nav.some((item) => !item.disabled && !['Project Watchlist', 'Settings & Data'].includes(item.label));
  const pages = hasProject ? nav.filter((item) => !item.disabled).map((item) => item.label) : ['Project Watchlist', 'Settings & Data'];

  for (const label of pages) {
    const before = pageErrors.length;
    const clicked = await page.evaluate((target) => {
      const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === target && !item.disabled);
      if (!button) return false;
      button.click();
      return true;
    }, label);
    if (!clicked) { check(`navigate: ${label}`, false, 'button missing/disabled'); continue; }
    await new Promise((resolve) => setTimeout(resolve, 900));
    const text = await page.evaluate(() => (document.querySelector('main')?.innerText ?? '').trim().length);
    const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    await page.screenshot({ path: path.join(outDir, `${slug}.png`) });
    check(`navigate: ${label}`, text > 40 && pageErrors.length === before, text <= 40 ? `empty page (text=${text})` : pageErrors.slice(before).join('; '));
  }

  // Watchlist V2 regression: the panel must mount and never fall back to the render-error
  // boundary. Flow/Cards/Events only exist once the overview payload has rows.
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('nav button')].find((item) => item.textContent.trim() === 'Project Watchlist' && !item.disabled);
    button?.click();
  });
  await new Promise((resolve) => setTimeout(resolve, 1800));
  check('watchlist: main panel mounts', Boolean(await page.$('.wo-main-panel')));
  check('watchlist: no render-failure boundary', !/渲染失败|render failed|Cannot read properties of null/i.test(await page.evaluate(() => document.body.innerText)));
  const hasRows = await page.evaluate(() => document.querySelectorAll('.wo-main-panel button').length > 1);
  if (hasRows) {
    check('watchlist: capital flow panel', Boolean(await page.$('.cf-panel')));
    check('watchlist: flow cards panel', Boolean(await page.$('.fc-panel')));
    check('watchlist: live events panel', Boolean(await page.$('.lfe-panel')));
    check('watchlist: indicator control', Boolean(await page.$('.wo-main-panel select')));
  }
  await page.screenshot({ path: path.join(outDir, 'watchlist-v2.png'), fullPage: false });

  // Command palette. Control works on both platforms (Linux CI has no Meta mapping in
  // headless Chromium), with a click fallback if the shortcut is swallowed.
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(modifier); await page.keyboard.press('k'); await page.keyboard.up(modifier);
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (!(await page.$('.palette'))) {
    await page.click('.search-trigger').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const palette = await page.$('.palette');
  check('command palette opens', Boolean(palette));
  await page.keyboard.press('Escape');
  await new Promise((resolve) => setTimeout(resolve, 250));
  check('command palette closes', (await page.$('.palette')) === null);

  // AI drawer, same shortcut + click fallback.
  await page.keyboard.down(modifier); await page.keyboard.press('j'); await page.keyboard.up(modifier);
  await new Promise((resolve) => setTimeout(resolve, 700));
  if (!(await page.$('.ai-assistant'))) {
    await page.click('.ghost-button.ai').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check('AI drawer opens', Boolean(await page.$('.ai-assistant')));
  await page.keyboard.press('Escape');
  await new Promise((resolve) => setTimeout(resolve, 250));
  check('AI drawer closes', (await page.$('.ai-assistant')) === null);

  check('no 5xx responses', serverErrors.length === 0, serverErrors.slice(0, 3).join('; '));
  check('no page errors during navigation', pageErrors.length === 0, pageErrors.slice(0, 3).join('; '));
} catch (error) {
  failures.push(`fatal: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await browser.close();
}

const report = { base, at: new Date().toISOString(), browser: chrome, results, failures, pageErrors, serverErrors };
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(`[e2e] ${results.filter((item) => item.ok).length}/${results.length} checks passed; screenshots in ${outDir}`);
if (failures.length) {
  console.error(`[e2e] ${failures.length} failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
