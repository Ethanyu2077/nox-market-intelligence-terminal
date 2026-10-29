export type Language = 'en' | 'zh';

/** Shared relative-time formatting so locale does not leak English into the zh UI. */
export function timeAgo(timestamp: number | null | undefined, language: Language = 'en', now = Date.now()): string {
  if (timestamp == null || !Number.isFinite(timestamp) || timestamp <= 0) return language === 'zh' ? '不可用' : 'unavailable';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 4) return language === 'zh' ? '刚刚' : 'now';
  if (seconds < 60) return language === 'zh' ? `${seconds} 秒前` : `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return language === 'zh' ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return language === 'zh' ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return language === 'zh' ? `${days} 天前` : `${days}d ago`;
}
