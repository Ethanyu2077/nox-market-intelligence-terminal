import type { LiveSource } from '../shared/live-channel.ts';

type Request = { op?: unknown; channel?: unknown; params?: unknown; id?: unknown };

/** Per-connection handles for independently replaceable feeds on the same WebSocket. */
export function liveSubscriptions(sources: Record<string, LiveSource>, send: (data: unknown) => void) {
  const active = new Map<string, { release?: () => void }>();
  function remove(id: string) {
    const slot = active.get(id);
    active.delete(id);
    slot?.release?.();
  }
  return {
    accept(request: Request) {
      if (request.op !== 'listen' && request.op !== 'unlisten') return false;
      const { id, channel, params } = request;
      if (typeof id !== 'string' || !/^[\w-]{1,48}$/.test(id)) return true;
      remove(id);
      if (request.op === 'unlisten') return true;
      if (typeof channel !== 'string' || !Object.hasOwn(sources, channel) || active.size >= 12 ||
          !params || typeof params !== 'object' || Array.isArray(params) ||
          !Object.values(params).every(value => typeof value === 'string' && value.length <= 256)) {
        send({ type: 'unavailable', id });
        return true;
      }
      const slot: { release?: () => void } = {};
      active.set(id, slot);
      const unavailable = () => {
        if (active.get(id) !== slot) return;
        remove(id);
        send({ type: 'unavailable', id });
      };
      send({ type: 'listening', id });
      try {
        const release = sources[channel](params as Record<string, string>, data => {
          if (active.get(id) === slot) send({ type: 'data', id, data });
        }, unavailable);
        if (active.get(id) === slot) slot.release = release;
        else release(); // A source may report unavailable during its first sample.
      } catch { unavailable(); }
      return true;
    },
    close() { for (const id of active.keys()) remove(id); },
  };
}
