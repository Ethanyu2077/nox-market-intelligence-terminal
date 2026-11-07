import type { AiModelId } from '../../shared/ai';

/**
 * Local credential + preference storage for browser-key mode.
 *
 * - Session storage by default (cleared when the tab closes).
 * - Local storage only when the operator explicitly opts in on a trusted machine.
 * - The key is never written into the app bundle, URLs, logs or analytics.
 */

const KEY = 'nox.ai.deepseek.key';
const MODEL = 'nox.ai.model';
const PERSIST = 'nox.ai.persist';
export const AI_KEY_EVENT = 'nox:ai-key-changed';

export interface StoredCredential {
  key: string | null;
  persisted: boolean;
}

function read(storage: Storage | null, name: string): string | null {
  try { return storage?.getItem(name) ?? null; } catch { return null; }
}

export function readCredential(): StoredCredential {
  if (typeof window === 'undefined') return { key: null, persisted: false };
  const session = read(window.sessionStorage, KEY);
  if (session) return { key: session, persisted: false };
  const local = read(window.localStorage, KEY);
  return local ? { key: local, persisted: true } : { key: null, persisted: false };
}

function emit(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AI_KEY_EVENT));
}

export function saveCredential(key: string, persist: boolean): void {
  if (typeof window === 'undefined') return;
  const value = key.trim();
  try {
    window.sessionStorage.removeItem(KEY);
    window.localStorage.removeItem(KEY);
    (persist ? window.localStorage : window.sessionStorage).setItem(KEY, value);
    window.localStorage.setItem(PERSIST, persist ? '1' : '0');
  } catch { /* storage disabled: keep the key in memory for this render only */ }
  emit();
}

export function clearCredential(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(KEY);
    window.localStorage.removeItem(KEY);
    window.localStorage.removeItem(PERSIST);
  } catch { /* ignore */ }
  emit();
}

export function readModel(): AiModelId {
  if (typeof window === 'undefined') return 'deepseek-flash';
  return read(window.localStorage, MODEL) ?? 'deepseek-flash';
}

export function saveModel(model: AiModelId): void {
  try { window.localStorage.setItem(MODEL, model); } catch { /* ignore */ }
}

/** Mask a key for display: sk-ab…9f3c. Never render the full value. */
export function maskKey(key: string): string {
  if (key.length <= 10) return '••••';
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}
