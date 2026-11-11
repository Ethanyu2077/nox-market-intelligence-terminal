export type WatchLiveState = 'connecting' | 'live' | 'syncing' | 'offline' | 'reconnecting';
type Channel = 'quotes' | 'edge' | 'flow';
type Quote = { projectId: string; price: number | null; change24hPct: number | null; stale: boolean; at: number; priceAt?: number | null };
type Flow = { projectId: string; buy: number; sell: number; delta: number; cvd: number; spotDelta: number; perpDelta: number };
export type WatchLiveFrame = {
  type: 'tick' | 'snapshot';
  channel: Channel;
  asOf?: number;
  seq?: number;
  ticks?: Quote[];
  flows?: Flow[];
  replay?: readonly unknown[];
};

const channels: Channel[] = ['quotes', 'edge', 'flow'];
const silenceMs = 6_000;

/** Tracks the quote channel heartbeat independently of how often each market actually trades. */
export function connectWatchLive(
  projectIds: readonly string[],
  onFrame: (frame: WatchLiveFrame) => void,
  onState: (state: WatchLiveState) => void,
) {
  let socket: WebSocket | null = null;
  let disposed = false;
  let retry = 1_000;
  let timer: number | undefined;
  let lastFrameAt = 0;
  let syncAt: number | null = null;

  function release() {
    window.clearTimeout(timer);
    const previous = socket;
    socket = null;
    previous?.close();
  }

  function retryConnection() {
    release();
    if (disposed) return;
    if (!navigator.onLine) { onState('offline'); return; }
    onState('reconnecting');
    timer = window.setTimeout(connect, retry);
    retry = Math.min(15_000, retry * 2);
  }

  function resync(channel: Channel) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (channel === 'quotes') {
      if (syncAt !== null) return;
      syncAt = Date.now();
      onState('syncing');
    }
    socket.send(JSON.stringify({ op: 'resync', channel }));
  }

  function connect() {
    window.clearTimeout(timer);
    if (disposed || socket) return;
    if (!navigator.onLine) { onState('offline'); return; }
    lastFrameAt = Date.now();
    syncAt = null;
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const current = new WebSocket(`${protocol}://${window.location.host}/ws/live`);
    socket = current;
    const sequences = new Map<Channel, number>();
    let lastPublished: number | undefined;
    current.onopen = () => {
      if (socket !== current) return;
      lastFrameAt = Date.now();
      current.send(JSON.stringify({ op: 'subscribe', projects: projectIds, channels }));
    };
    current.onmessage = event => {
      if (socket !== current) return;
      let frame: WatchLiveFrame;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if (!frame || !channels.includes(frame.channel) || (frame.type !== 'tick' && frame.type !== 'snapshot')) return;
      const prev = sequences.get(frame.channel);
      if (typeof frame.seq === 'number') {
        if (prev !== undefined && frame.seq <= prev) return;
        if (prev !== undefined && frame.type === 'tick' && frame.seq > prev + 1) resync(frame.channel);
        sequences.set(frame.channel, frame.seq);
      }
      if (frame.channel === 'quotes') {
        // A paused publisher can resume with consecutive sequence numbers but skip several seconds.
        if (frame.type === 'tick' && lastPublished !== undefined && typeof frame.asOf === 'number'
          && frame.asOf - lastPublished >= silenceMs) resync('quotes');
        lastPublished = frame.asOf;
        lastFrameAt = Date.now();
        if (frame.type === 'snapshot') syncAt = null;
        if (syncAt === null) { retry = 1_000; onState('live'); }
      }
      onFrame(frame);
    };
    current.onclose = () => { if (socket === current) retryConnection(); };
    current.onerror = () => { if (socket === current) retryConnection(); };
  }

  function resume() {
    if (disposed || !navigator.onLine) return;
    if (!socket) { onState('reconnecting'); connect(); }
    else if (socket.readyState === WebSocket.OPEN) resync('quotes');
  }
  function offline() { release(); onState('offline'); }
  function visible() { if (!document.hidden) resume(); }

  onState('connecting');
  if (!projectIds.length) return () => {};
  connect();
  const watchdog = window.setInterval(() => {
    if (document.hidden || !socket) return;
    const now = Date.now();
    if (socket.readyState === WebSocket.CONNECTING) {
      if (now - lastFrameAt >= 2 * silenceMs) retryConnection();
    } else if (socket.readyState === WebSocket.OPEN) {
      if (syncAt !== null && now - syncAt >= silenceMs) retryConnection();
      else if (now - lastFrameAt >= silenceMs) resync('quotes');
    }
  }, 1_000);
  window.addEventListener('offline', offline);
  window.addEventListener('online', resume);
  document.addEventListener('visibilitychange', visible);
  return () => {
    disposed = true;
    window.clearInterval(watchdog);
    window.removeEventListener('offline', offline);
    window.removeEventListener('online', resume);
    document.removeEventListener('visibilitychange', visible);
    release();
  };
}
