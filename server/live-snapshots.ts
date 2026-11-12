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

interface Subscriber {
  emit: (value: unknown) => void;
  unavailable: () => void;
}

interface Channel<T> {
  value: T;
  payload: unknown;
  frame?: string;
  timer: NodeJS.Timeout;
  viewers: Set<Stream>;
  subscribers: Set<Subscriber>;
  lastRead: number | null;
  source: Source<T>;
}

/** HTTP reads and streaming clients share one upstream source and sampling clock. */
export class LiveSnapshots<T> {
  private channels = new Map<string, Channel<T>>();

  constructor(
    private event: string,
    private intervalMs: number,
    private streamValue: (value: T) => unknown = (value) => value,
    private maxSources = Infinity,
  ) {}

  private send(stream: Stream, channel: Channel<T>) {
    if (stream.destroyed || stream.writableEnded || stream.writableNeedDrain) return;
    channel.frame ??= `event: ${this.event}\ndata: ${JSON.stringify(channel.payload)}\n\n`;
    stream.write(channel.frame);
  }

  private closeChannel(key: string, channel: Channel<T>) {
    this.channels.delete(key);
    clearInterval(channel.timer);
    for (const viewer of channel.subscribers) viewer.unavailable();
    for (const viewer of channel.viewers) viewer.end();
    channel.source.release();
  }

  private hasReaders(channel: Channel<T>) {
    return channel.viewers.size || channel.subscribers.size ||
      (channel.lastRead !== null && Date.now() - channel.lastRead < 10_000);
  }

  private open(key: string, create: () => Source<T>) {
    const existing = this.channels.get(key);
    if (existing) return existing;
    if (this.channels.size >= this.maxSources) return null;
    const source = create();
    let value: T;
    let payload: unknown;
    try {
      const sample = source.sample();
      if (sample === null) { source.release(); return null; }
      value = sample;
      payload = this.streamValue(value);
    } catch (error) {
      source.release();
      throw error;
    }
    const timer = setInterval(() => {
      if (!this.hasReaders(channel)) {
        this.closeChannel(key, channel);
        return;
      }
      try {
        const next = source.sample();
        if (next === null) { this.closeChannel(key, channel); return; }
        channel.value = next;
        channel.payload = this.streamValue(next);
        channel.frame = undefined;
        for (const viewer of channel.subscribers) viewer.emit(channel.payload);
        for (const viewer of channel.viewers) this.send(viewer, channel);
      } catch {
        this.closeChannel(key, channel);
      }
    }, this.intervalMs);
    timer.unref();
    const channel: Channel<T> = { value, payload, timer, source, viewers: new Set(), subscribers: new Set(), lastRead: null };
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
      if (this.channels.get(key) === channel && !this.hasReaders(channel)) {
        this.closeChannel(key, channel);
      }
    });
    this.send(stream, channel);
  }

  listen(key: string, create: () => Source<T>, emit: Subscriber['emit'], unavailable: Subscriber['unavailable']) {
    const channel = this.open(key, create);
    if (!channel) { unavailable(); return () => {}; }
    const subscriber = { emit, unavailable };
    channel.subscribers.add(subscriber);
    emit(channel.payload);
    return () => {
      channel.subscribers.delete(subscriber);
      if (this.channels.get(key) === channel && !this.hasReaders(channel)) this.closeChannel(key, channel);
    };
  }

  close() {
    for (const [key, channel] of this.channels) this.closeChannel(key, channel);
  }
}
