/** A missing, zero or malformed setting must never turn a storage limit off. */
export function storageLimit(name: string, fallback: number): number {
  const setting = process.env[name]?.trim();
  if (!setting || !/^\d+$/.test(setting)) return fallback;
  const value = Number(setting);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  // Keep UTC cutoffs, PostgreSQL intervals and millisecond conversions representable.
  if (name.endsWith('_DAYS') && value > 36_500) return fallback;
  return value;
}

export function storageReserveBytes(): number {
  return storageLimit('NOX_STORAGE_MIN_FREE_BYTES', 512 * 1024 ** 2);
}
