import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allocateByCapital, computeLedger, equityCurve, fundingCash, type LedgerInput } from '../shared/execution-ledger.ts';

const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'execution-ledger-cases.json');
const close = (actual: number | null, expected: number | null, tolerance = 1e-6) => {
  if (expected == null) { assert.equal(actual, null); return; }
  assert.ok(actual != null && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

test('execution ledger golden fixtures are shared with the Python ORDER backtest', async () => {
  const fixtures = JSON.parse(await readFile(fixturePath, 'utf8'));
  for (const fixture of fixtures.ledger) {
    const result = computeLedger(fixture.input as LedgerInput);
    for (const [key, expected] of Object.entries(fixture.expect)) close((result as unknown as Record<string, number>)[key], expected as number);
  }
  for (const fixture of fixtures.fees) {
    const result = computeLedger(fixture.input as LedgerInput);
    for (const [key, expected] of Object.entries(fixture.expect)) close((result as unknown as Record<string, number>)[key], expected as number);
  }
  for (const fixture of fixtures.funding) assert.ok(Math.abs(fundingCash(fixture.input) - fixture.expectCash) <= 1e-9);
  for (const fixture of fixtures.equity) {
    const result = equityCurve(fixture.trades, fixture.initialCapital);
    close(result.finalEquity, fixture.expect.finalEquity);
    close(result.maxDrawdownPct, fixture.expect.maxDrawdownPct);
    close(result.winRatePct, fixture.expect.winRatePct);
  }
  for (const fixture of fixtures.capital) {
    const result = allocateByCapital(fixture.trades, fixture.capital, fixture.maxLeverage);
    assert.deepEqual(result.accepted, fixture.expect.accepted);
    assert.deepEqual(result.rejected, fixture.expect.rejected);
  }
});

test('execution ledger rejects invalid inputs instead of silently returning NaN', () => {
  assert.throws(() => computeLedger({ side: 'long', quantity: 0, entryPrice: 100, exitPrice: 110 }), /quantity/);
  assert.throws(() => computeLedger({ side: 'long', quantity: 1, entryPrice: 0, exitPrice: 110 }), /entryPrice/);
  assert.throws(() => computeLedger({ side: 'long', quantity: 1, entryPrice: 100, exitPrice: 110, leverage: 0 }), /leverage/);
});

test('slippage is adverse on both fills and margin ROI is separate from notional return', () => {
  const result = computeLedger({ side: 'long', quantity: 1, entryPrice: 100, exitPrice: 100, slippageBpsPerSide: 10, leverage: 5 });
  assert.ok(result.entryFillPrice > 100);
  assert.ok(result.exitFillPrice < 100);
  assert.ok(result.netPnlQuote < 0);
  assert.ok(result.marginRoiPct < result.notionalReturnPct, '5x leverage amplifies the loss on margin');
  close(result.notionalReturnPct, result.netPnlQuote / 100 * 100);
});
