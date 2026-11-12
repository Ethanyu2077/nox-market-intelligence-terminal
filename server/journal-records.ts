import { constants as bufferLimits, isUtf8 } from "node:buffer";
import type { HistoryEvent } from "../shared/history.ts";
import { storageLimit } from "./storage-limits.ts";

export const JOURNAL_APPEND_MAX_BYTES = 16 * 1024 ** 2;

export class JournalRecordError extends Error {
  constructor(
    readonly code: "invalid-json" | "invalid-utf8" | "invalid-envelope" | "incomplete" | "record-too-large",
    readonly offset: number,
    message: string,
  ) {
    super(message);
    this.name = "JournalRecordError";
  }
}

function decodeRecord(line: Buffer, name: string, offset: number): HistoryEvent {
  if (!isUtf8(line)) {
    throw new JournalRecordError("invalid-utf8", offset, `Corrupt journal ${name} at byte ${offset} (invalid UTF-8)`);
  }
  let event: HistoryEvent;
  try {
    event = JSON.parse(line.toString("utf8"));
  } catch {
    throw new JournalRecordError("invalid-json", offset, `Corrupt journal ${name} at byte ${offset} (invalid JSON)`);
  }
  if (!event || typeof event.id !== "string" || typeof event.kind !== "string" ||
      typeof event.marketKey !== "string" || typeof event.source !== "string" ||
      typeof event.quality !== "string" || !Number.isFinite(event.eventTime) ||
      !Number.isFinite(event.ingestTime) || !Object.hasOwn(event, "payload")) {
    throw new JournalRecordError("invalid-envelope", offset, `Corrupt journal ${name} at byte ${offset} (invalid event fields)`);
  }
  return event;
}

export async function* parseJournalRecords(
  chunks: AsyncIterable<Buffer>,
  name: string,
  identity: string,
  start = 0,
  maxBytes = Math.min(bufferLimits.MAX_STRING_LENGTH,
    Math.max(JOURNAL_APPEND_MAX_BYTES, storageLimit("NOX_HISTORY_MAX_RECORD_BYTES", JOURNAL_APPEND_MAX_BYTES))),
) {
  let offset = start;
  let scratch = Buffer.alloc(0);
  let used = 0;
  for await (const chunk of chunks) {
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(10, cursor);
      const end = newline < 0 ? chunk.length : newline;
      const size = used + end - cursor;
      if (size > maxBytes) {
        throw new JournalRecordError("record-too-large", offset, `Journal ${name} at byte ${offset} exceeds ${maxBytes} bytes per record`);
      }
      let line: Buffer;
      if (used || newline < 0) {
        // A geometric buffer bounds both total copying and memory for a fragmented record.
        if (size > scratch.length) {
          const next = Buffer.allocUnsafe(Math.min(maxBytes, Math.max(size, scratch.length * 2, 256)));
          scratch.copy(next, 0, 0, used);
          scratch = next;
        }
        chunk.copy(scratch, used, cursor, end);
        used = size;
        if (newline < 0) break;
        line = scratch.subarray(0, used);
      } else {
        line = chunk.subarray(cursor, end);
      }
      const event = decodeRecord(line, name, offset);
      offset += size + 1;
      used = 0;
      cursor = newline + 1;
      yield { event, offset, identity };
    }
  }
  if (used) {
    throw new JournalRecordError("incomplete", offset, `Incomplete journal tail in ${name} at byte ${offset}`);
  }
}
