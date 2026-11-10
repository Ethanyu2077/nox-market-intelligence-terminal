interface Stream {
  readonly destroyed: boolean;
  readonly writableEnded: boolean;
  readonly writableNeedDrain: boolean;
  once(event: 'close', listener: () => void): unknown;
  write(frame: string): boolean;
  end(): unknown;
}

interface Source<T> {
  sample: () => T | null;
  release: () => void;
}

interface Channel<T> {
  value: T;
  frame: string;
  timer: NodeJS.Timeout;
  viewers: Set<Stream>;
  lastRead: number | null;
  source: Source<T>;
}

/** One sampling clock and one serialized SSE frame for each active data key. */
export class LiveSnapshots<T> {
  private channels = new Map<string, Channel<T>>();

  constructor(
    private event: string,
    private intervalMs: number,
    private streamValue: (value: T) => unknown = (value) => value,
  ) {}

  private frame(value: T) {
    return `event: ${this.event}\ndata: ${JSON.stringify(this.streamValue(value))}\n\n`;
  }

  private send(stream: Stream, frame: string) {
    if (!stream.destroyed && !stream.writableEnded && !stream.writableNeedDrain) stream.write(frame);
  }

  private closeChannel(key: string, channel: Channel<T>) {
    this.channels.delete(key);
    clearInterval(channel.timer);
    for (const viewer of channel.viewers) viewer.end();
    channel.source.release();
  }

  private hasReaders(channel: Channel<T>) {
    return channel.lastRead !== null && Date.now() - channel.lastRead < 10_000;
  }

  private open(key: string, create: () => Source<T>) {
    const existing = this.channels.get(key);
    if (existing) return existing;
    const source = create();
    let value: T;
    let frame: string;
    try {
      const sample = source.sample();
      if (sample === null) { source.release(); return null; }
      value = sample;
      frame = this.frame(value);
    } catch (error) {
      source.release();
      throw error;
    }
    const timer = setInterval(() => {
      if (!channel.viewers.size && !this.hasReaders(channel)) {
        this.closeChannel(key, channel);
        return;
      }
      try {
        const next = source.sample();
        if (next === null) { this.closeChannel(key, channel); return; }
        channel.value = next;
        channel.frame = this.frame(next);
        for (const viewer of channel.viewers) this.send(viewer, channel.frame);
      } catch {
        this.closeChannel(key, channel);
      }
    }, this.intervalMs);
    timer.unref();
    const channel: Channel<T> = { value, frame, timer, source, viewers: new Set(), lastRead: null };
    this.channels.set(key, channel);
    return channel;
  }

  read(key: string, create: () => Source<T>): T | null {
    const channel = this.open(key, create);
    if (!channel) return null;
    channel.lastRead = Date.now();
    return channel.value;
  }

  subscribe(key: string, create: () => Source<T>, stream: Stream) {
    const channel = this.open(key, create);
    if (!channel) { stream.end(); return; }
    channel.viewers.add(stream);
    stream.once('close', () => {
      channel.viewers.delete(stream);
      if (this.channels.get(key) === channel && !channel.viewers.size && !this.hasReaders(channel)) {
        this.closeChannel(key, channel);
      }
    });
    this.send(stream, channel.frame);
  }

  close() {
    for (const [key, channel] of this.channels) this.closeChannel(key, channel);
  }
}
