import { createHash } from 'node:crypto';

// Keep one block of verified bytes in memory. Chunk boundaries from fs and gunzip
// can differ on replay, so partition the logical byte stream at fixed offsets.
async function* blocks(stream, size = 1024 * 1024) {
  let buffer = Buffer.allocUnsafe(size), used = 0;
  for await (const chunk of stream) {
    for (let offset = 0; offset < chunk.length;) {
      const n = Math.min(size - used, chunk.length - offset);
      chunk.copy(buffer, used, offset, offset + n);
      used += n; offset += n;
      if (used === size) {
        yield buffer;
        buffer = Buffer.allocUnsafe(size);
        used = 0;
      }
    }
  }
  if (used) yield buffer.subarray(0, used);
}
const digest = block => createHash('sha256').update(block).digest('hex');

export async function fingerprint(stream) {
  const hash = createHash('sha256'), digests = [];
  for await (const block of blocks(stream)) {
    hash.update(block);
    digests.push(digest(block));
  }
  return { sha256: hash.digest('hex'), digests };
}

export async function* verifiedBlocks(stream, digests) {
  let index = 0;
  for await (const block of blocks(stream)) {
    if (digest(block) !== digests[index++]) throw new Error('Source bytes changed after migration fingerprint');
    yield block;
  }
  if (index !== digests.length) throw new Error('Source truncated after migration fingerprint');
}
