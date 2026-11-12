import type { ConnectionState, WatchPriceTick } from '../shared/watchlist.ts';

export type WatchLiveState = 'connecting' | 'live' | 'syncing' | 'offline' | 'reconnecting';
type Channel = 'quotes' | 'edge' | 'flow';
type Flow = { projectId: string; buy: number; sell: number; delta: number; cvd: number; spotDelta: number; perpDelta: number };
export type WatchLiveFrame = {
  type: 'tick' | 'snapshot';
  channel: Channel;
  asOf?: number;
  seq?: number;
  ticks?: WatchPriceTick[];
  flows?: Flow[];
  replay?: readonly unknown[];
};

const channels: Channel[] = ['quotes', 'edge', 'flow'];
const silenceMs = 6_000;

interface WatchLiveOptions {
  mode?: 'board';
  marketKeys?: ReadonlyMap<string, string>;
  onConnectionChange?: (state: ConnectionState) => void;
}

/** A socket heartbeat or historical replay does not certify the current market price. */
export function watchQuoteStatus(transport: WatchLiveState, markets: ReadonlyMap<string, string>, ticks: readonly WatchPriceTick[], now: number): ConnectionState {
  if (!markets.size) return 'polling';
  if (transport === 'connecting') return 'connecting';
  if (transport === 'offline') return 'stale';
  if (transport !== 'live') return 'degraded';
  const fresh = new Set<string>();
  for (const tick of ticks) {
    if (typeof tick?.marketKey !== 'string' || markets.get(tick.projectId) !== tick.marketKey || tick.stale) continue;
    if (tick.price == null || !Number.isFinite(tick.price) || tick.price <= 0) continue;
    const at = tick.priceAt;
    if (at != null && Number.isFinite(at) && at > 0 && Math.abs(now - at) <= 5_000) fresh.add(tick.projectId);
  }
  if (!fresh.size) return 'stale';
  return fresh.size === markets.size ? 'live' : 'degraded';
}

/** Tracks the quote channel heartbeat independently of how often each market actually trades. */
export function connectWatchLive(
  projectIds: readonly string[],
  onFrame: (frame: WatchLiveFrame) => void,
  onState: (state: WatchLiveState) => void,
  options: WatchLiveOptions = {},
) {
  const { mode, marketKeys, onConnectionChange } = options;
  const subscribedChannels: Channel[] = mode === 'board' ? ['quotes'] : channels;
  let socket: WebSocket | null = null;
  let disposed = false;
  let retry = 1_000;
  let timer: number | undefined;
  let lastFrameAt = 0;
  let syncAt: number | null = null;

  let ticks: readonly WatchPriceTick[] = [];
  let transport: WatchLiveState = 'connecting';
  let reported: ConnectionState | undefined;
  function updateHealth() {
    if (!onConnectionChange || !marketKeys) return;
    const status = watchQuoteStatus(transport, marketKeys, ticks, Date.now());
    if (status !== reported) { reported = status; onConnectionChange(status); }
  }
  function announce(state: WatchLiveState) {
    transport = state;
    updateHealth();
    onState(state);
  }

  function release() {
    ticks = [];
    window.clearTimeout(timer);
    const previous = socket;
    socket = null;
    previous?.close();
  }

  function retryConnection() {
    release();
    if (disposed) return;
    if (!navigator.onLine) { announce('offline'); return; }
    announce('reconnecting');
    timer = window.setTimeout(connect, retry);
    retry = Math.min(15_000, retry * 2);
  }

  function resync(channel: Channel) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (channel === 'quotes') {
      if (syncAt !== null) return;
      syncAt = Date.now();
      announce('syncing');
    }
    socket.send(JSON.stringify({ op: 'resync', channel }));
  }

  function connect() {
    window.clearTimeout(timer);
    if (disposed || socket) return;
    if (!navigator.onLine) { announce('offline'); return; }
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
      current.send(JSON.stringify({ op: 'subscribe', projects: projectIds, channels: subscribedChannels, transient: mode === 'board' || undefined }));
    };
    current.onmessage = event => {
      if (socket !== current) return;
      let frame: WatchLiveFrame;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if (!frame || !subscribedChannels.includes(frame.channel) || (frame.type !== 'tick' && frame.type !== 'snapshot')) return;
      const prev = sequences.get(frame.channel);
      if (typeof frame.seq === 'number') {
        if (prev !== undefined && frame.seq <= prev) return;
        if (prev !== undefined && frame.type === 'tick' && frame.seq > prev + 1) resync(frame.channel);
        sequences.set(frame.channel, frame.seq);
      }
      if (frame.channel === 'quotes') {
        ticks = Array.isArray(frame.ticks) ? frame.ticks : [];
        // A paused publisher can resume with consecutive sequence numbers but skip several seconds.
        if (frame.type === 'tick' && lastPublished !== undefined && typeof frame.asOf === 'number'
          && frame.asOf - lastPublished >= silenceMs) resync('quotes');
        lastPublished = frame.asOf;
        lastFrameAt = Date.now();
        if (frame.type === 'snapshot') syncAt = null;
        if (syncAt === null) { retry = 1_000; announce('live'); }
      }
      onFrame(frame);
    };
    current.onclose = () => { if (socket === current) retryConnection(); };
    current.onerror = () => { if (socket === current) retryConnection(); };
  }

  function resume() {
    if (disposed || !navigator.onLine) return;
    if (!socket) { announce('reconnecting'); connect(); }
    else if (socket.readyState === WebSocket.OPEN) resync('quotes');
  }
  function offline() { release(); announce('offline'); }
  function visible() { if (!document.hidden) resume(); }

  announce('connecting');
  if (!projectIds.length) return () => {};
  connect();
  const watchdog = window.setInterval(() => {
    if (document.hidden || !socket) return;
    updateHealth();
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
    onConnectionChange?.('connecting');
  };
}
