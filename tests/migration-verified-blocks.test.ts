import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
// @ts-expect-error plain ESM migration tooling
import { fingerprint, verifiedBlocks } from '../scripts/migration/lib/verified-blocks.mjs';

async function collect(stream: AsyncIterable<Buffer>) {
  const rows: Buffer[] = [];
  for await (const row of stream) rows.push(row);
  return rows;
}

test('migration accepts identical bytes across chunk boundaries and withholds changed blocks before writing', async () => {
  const a = Buffer.alloc(1024*1024, 42), b = Buffer.from('last line\n');
  const {digests} = await fingerprint([a.subarray(0,3000),Buffer.concat([a.subarray(3000),b])]);
  assert.deepEqual(await collect(verifiedBlocks([a,b],digests)), [a,b]);
  const verified = verifiedBlocks([a,Buffer.from('mutation\n')],digests);
  assert.deepEqual((await verified.next()).value,a);
  await assert.rejects(verified.next(),/changed/);
  await assert.rejects(collect(verifiedBlocks([a],digests)),/truncated/);
});
