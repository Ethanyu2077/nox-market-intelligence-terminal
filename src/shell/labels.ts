export type ConnectionState = 'connecting' | 'live' | 'polling' | 'stale' | 'degraded';

/** One vocabulary for transport health across the top bar, sidebar and status bar. */
export function connectionLabel(state: ConnectionState, zh: boolean): string {
  switch (state) {
    case 'live': return zh ? '实时' : 'LIVE';
    case 'polling': return zh ? '轮询' : '60S POLL';
    case 'connecting': return zh ? '连接中' : 'CONNECTING';
    case 'stale': return zh ? '延迟' : 'STALE';
    case 'degraded': return zh ? '降级' : 'DEGRADED';
  }
}

export function connectionTone(state: ConnectionState): 'live' | 'warn' | 'bad' {
  if (state === 'live') return 'live';
  if (state === 'polling') return 'live';
  if (state === 'connecting' || state === 'stale' || state === 'degraded') return 'warn';
  return 'bad';
}
