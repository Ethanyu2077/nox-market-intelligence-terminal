// Environment loading shared by every NOX entry point.
//
// The project documents a `.env` file (`.env.example`), so the runtime must load it.
// Node's `loadEnvFile` gives the same precedence as `node --env-file`: variables that
// already exist in the real environment are never overwritten, so shell/npm/CI values win.
//
// IMPORTANT: this module loads the file during its own evaluation. Entry points must
// import it first (`import './env.ts';`) so that no other module reads `process.env`
// at module scope before the file is applied.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';

export function loadLocalEnv(file = process.env.NOX_ENV_FILE ?? path.resolve(process.cwd(), '.env')): string | null {
  if (!existsSync(file)) return null;
  try {
    loadEnvFile(file);
  } catch (error) {
    throw new Error(`Cannot load environment file ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return file;
}

/** Path of the .env that was loaded for this process, or null when none existed. */
export const loadedEnvFile = loadLocalEnv();

/**
 * Origins trusted for browser mutations. The API always trusts its own port on loopback;
 * the Vite development ports (4173 is the documented `npm run dev` port, 5173 is the Vite
 * fallback) are trusted by default because `npm run dev` proxies /api from that origin and
 * every POST/PATCH/DELETE carries that Origin header. Additional origins can be supplied
 * with NOX_ALLOWED_ORIGINS. Nothing outside loopback is trusted implicitly.
 */
export const DEFAULT_DEV_ORIGINS = [
  'http://127.0.0.1:4173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'http://localhost:5173',
] as const;

export function resolveAllowedOrigins(port: number, configured = process.env.NOX_ALLOWED_ORIGINS, includeDevOrigins = process.env.NODE_ENV !== 'production'): Set<string> {
  const defaults = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(includeDevOrigins ? DEFAULT_DEV_ORIGINS : [])];
  const extra = (configured ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  return new Set([...defaults, ...extra]);
}
