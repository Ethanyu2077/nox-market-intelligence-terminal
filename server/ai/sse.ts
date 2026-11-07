/**
 * Minimal server-sent-events decoder.
 *
 * Kept separate from the DeepSeek client so the framing rules (chunk boundaries, CRLF,
 * multi-line data, comments, [DONE]) can be unit tested without a network.
 */

export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
}

export class SseDecoder {
  private buffer = '';

  /** Feed a decoded text chunk; returns every event completed by this chunk. */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk.replace(/\r\n?/g, '\n');
    const events: SseEvent[] = [];
    let boundary = this.buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const parsed = parseBlock(block);
      if (parsed) events.push(parsed);
      boundary = this.buffer.indexOf('\n\n');
    }
    return events;
  }

  /** Flush a trailing event that did not end with a blank line. */
  flush(): SseEvent[] {
    const block = this.buffer;
    this.buffer = '';
    const parsed = block.trim() ? parseBlock(block) : null;
    return parsed ? [parsed] : [];
  }
}

export function parseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  let id: string | null = null;
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    // A single leading space after the colon is part of the framing, not the payload.
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }
  if (!data.length) return null;
  return { event, data: data.join('\n'), id };
}

/**
 * Parse an SSE byte stream into data payloads. `[DONE]` is surfaced as-is so callers can
 * decide how to terminate; every other payload is returned verbatim.
 */
export async function* readSseStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const sse = new SseDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of sse.push(decoder.decode(value, { stream: true }))) yield event.data;
    }
    for (const event of sse.flush()) yield event.data;
  } finally {
    reader.releaseLock();
  }
}
