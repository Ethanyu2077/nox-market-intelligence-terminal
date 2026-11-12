import type { LiveChannelState } from '../shared/live-channel.ts';
export type { LiveChannelState } from '../shared/live-channel.ts';

type Listener = {
  channel: string;
  retryMs: number;
  retryTimer?: number;
  params: Record<string, string>;
  data: (value: unknown) => void;
  state?: (value: LiveChannelState) => void;
};

const listeners = new Map<string, Listener>();
let nextId = 0;
let socket: WebSocket | undefined;
let timer: number | undefined;
let watchdog: number | undefined;
let retry = 1000;
let lastReceived = 0;

function sendListen(id: string, listener: Listener) {
  socket?.send(JSON.stringify({ op: 'listen', id, channel: listener.channel, params: listener.params }));
}

function notify(state: LiveChannelState) {
  for (const listener of listeners.values()) listener.state?.(state);
}

function close() {
  window.clearTimeout(timer);
  timer = undefined;
  for (const listener of listeners.values()) window.clearTimeout(listener.retryTimer);
  const previous = socket;
  socket = undefined;
  previous?.close();
}

function reconnect() {
  close();
  if (document.hidden || !listeners.size) return;
  if (!navigator.onLine) { notify('offline'); return; }
  notify('reconnecting');
  timer = window.setTimeout(connect, retry);
  retry = Math.min(15_000, retry * 2);
}

function connect() {
  if (socket || !listeners.size || document.hidden || !navigator.onLine) return;
  window.clearTimeout(timer);
  timer = undefined;
  lastReceived = Date.now();
  const current = new WebSocket((window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/ws/live');
  socket = current;
  current.onopen = () => {
    if (current !== socket) return;
    for (const [id, listener] of listeners) sendListen(id, listener);
  };
  current.onmessage = event => {
    if (current !== socket) return;
    let frame: { id?: string; type?: string; data?: unknown };
    try { frame = JSON.parse(String(event.data)); } catch { return; }
    if (!frame || typeof frame !== 'object') return;
    lastReceived = Date.now();
    retry = 1000;
    const listener = frame.id && listeners.get(frame.id);
    if (!listener) return;
    if (frame.type === 'listening') listener.state?.('open');
    else if (frame.type === 'data') {
      listener.retryMs = 1000;
      listener.data(frame.data);
    } else if (frame.type === 'unavailable') {
      listener.state?.('unavailable');
      window.clearTimeout(listener.retryTimer);
      const id = frame.id!;
      listener.retryTimer = window.setTimeout(() => {
        if (socket === current && listeners.has(id) && current.readyState === WebSocket.OPEN) sendListen(id, listener);
      }, listener.retryMs);
      listener.retryMs = Math.min(30_000, listener.retryMs * 2);
    }
  };
  current.onerror = current.onclose = () => { if (socket === current) reconnect(); };
}

function visibility() {
  if (document.hidden) close();
  else { notify(navigator.onLine ? 'connecting' : 'offline'); connect(); }
}
function offline() { close(); notify('offline'); }

/** Multiplex chart, quote, book and flow subscriptions onto one visible-tab connection. */
export function subscribeLiveChannel<T>(channel: string, params: Record<string, string>, onData: (value: T) => void, onState?: (value: LiveChannelState) => void) {
  const id = String(++nextId);
  const listener: Listener = { channel, params, retryMs: 1000, data: data => onData(data as T), state: onState };
  listeners.set(id, listener);
  onState?.(navigator.onLine ? 'connecting' : 'offline');
  if (listeners.size === 1) {
    window.addEventListener('online', connect);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visibility);
    watchdog = window.setInterval(() => {
      if (socket && Date.now() - lastReceived > (socket.readyState === WebSocket.OPEN ? 65_000 : 12_000)) reconnect();
    }, 5000);
  }
  if (socket?.readyState === WebSocket.OPEN) sendListen(id, listener);
  else if (!timer) connect();
  return () => {
    if (!listeners.delete(id)) return;
    window.clearTimeout(listener.retryTimer);
    if (listeners.size) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 'unlisten', id }));
    } else {
      close();
      retry = 1000;
      window.clearInterval(watchdog);
      window.removeEventListener('online', connect);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visibility);
    }
  };
}
