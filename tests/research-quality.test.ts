import assert from 'node:assert/strict';
import test from 'node:test';
import { assessResearchQuality } from '../server/research-quality.ts';

const clean = { scannedRecords: 1000, samples: 100, coveragePct: 90, truncated: false, missingWindows: 0 };

test('complete only with enough samples, coverage and an untruncated scan', () => {
  assert.equal(assessResearchQuality(clean).state, 'COMPLETE');
  assert.equal(assessResearchQuality({ ...clean, truncated: true }).state, 'PARTIAL');
  assert.equal(assessResearchQuality({ ...clean, missingWindows: 2 }).state, 'PARTIAL');
  assert.equal(assessResearchQuality({ ...clean, samples: 5 }).state, 'INSUFFICIENT');
  assert.equal(assessResearchQuality({ ...clean, coveragePct: 20 }).state, 'INSUFFICIENT');
  assert.equal(assessResearchQuality({ ...clean, dataAvailable: false }).state, 'NOT VERIFIED');
  assert.equal(assessResearchQuality({ ...clean, scannedRecords: 0 }).state, 'NOT VERIFIED');
});
