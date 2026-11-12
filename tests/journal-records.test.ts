import assert from "node:assert/strict";
import test from "node:test";
import { JournalRecordError, parseJournalRecords } from "../server/journal-records.ts";

const event = {
  id: "行情", kind: "trade", marketKey: "ETH", projectId: null, eventTime: 10, ingestTime: 11,
  source: "fixture", quality: "live", payload: { value: "涨" },
};
async function* split(input: Buffer, step: number) {
  for (let pos = 0; pos < input.length; pos += step) yield input.subarray(pos, pos + step);
}

test("journal byte checkpoints handle fragmented UTF-8, CRLF, and an exact-limit record", async () => {
  const first = Buffer.from(JSON.stringify(event) + "\r\n");
  const all = Buffer.concat([first, Buffer.from(JSON.stringify(event) + "\n")]);
  for (const step of [1, 32, first.length - 1, all.length]) {
    const rows = [];
    for await (const row of parseJournalRecords(split(all, step), "journal", "inode", 97, first.length - 1)) rows.push(row);
    assert.deepEqual(rows, [first, all].map(bytes => ({ event, offset: 97 + bytes.length, identity: "inode" })));
  }
});

test("a malformed row reports its start without leaking data or consuming the rest of the journal", async () => {
  const first = Buffer.from(JSON.stringify(event) + "\n");
  for (const [bad, code] of [
    ['{"secret":\n', "invalid-json"], ['"secret"\n', "invalid-envelope"], ['null\n', "invalid-envelope"],
    ['{"secret":0}', "incomplete"],
  ]) {
    const stream = parseJournalRecords(split(Buffer.concat([first, Buffer.from(bad)]), 37), "trades", "identity", 13);
    assert.deepEqual((await stream.next()).value, { event, offset: 13 + first.length, identity: "identity" });
    await assert.rejects(stream.next(), err => err instanceof JournalRecordError && err.code === code &&
      err.offset === 13 + first.length && !err.message.includes("secret"));
  }
});

test("an unterminated 512 MiB record stops after a single bounded lookahead chunk", async () => {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const limit = 16 * 1024 ** 2;
  let consumed = 0;
  let closed = false;
  async function* source() {
    try {
      while (consumed < 512 * 1024 ** 2) { consumed += chunk.length; yield chunk; }
    } finally { closed = true; }
  }
  const stream = parseJournalRecords(source(), "trades", "identity", 234, limit);
  await assert.rejects(stream.next(), err => err instanceof JournalRecordError && err.code === "record-too-large" &&
    err.offset === 234 && err.message.includes(String(limit)));
  assert.equal(consumed, limit + chunk.length);
  assert.equal(closed, true);
});

test("invalid UTF-8 inside a valid envelope is preserved for recovery", async () => {
  const bytes = Buffer.from(JSON.stringify(event) + "\n");
  bytes[bytes.indexOf(Buffer.from(event.id))] = 0xff;
  const stream = parseJournalRecords(split(bytes, 32), "trades", "identity");
  await assert.rejects(stream.next(), err => err instanceof JournalRecordError && err.code === "invalid-utf8");
});

test("a legitimate legacy row over the default limit can be replayed by increasing the byte limit", async () => {
  const largePayload = "a".repeat(16 * 1024 ** 2);
  const data = Buffer.from(JSON.stringify({ ...event, payload: largePayload }) + "\n");
  const stream = parseJournalRecords(split(data, 64 * 1024), "legacy", "identity", 0, data.length);
  const next = await stream.next();
  assert.equal(next.done, false);
  assert.equal(next.value?.event.payload, largePayload);
  assert.equal(next.value?.offset, data.length);
  assert.equal((await stream.next()).done, true);
});
