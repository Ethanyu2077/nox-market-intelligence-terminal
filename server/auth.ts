import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Express, Request } from 'express';
import { z } from 'zod';

type Role = 'viewer' | 'analyst' | 'admin';
type User = { name: string; role: Role; salt: string; hash: string };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class AuthStore {
  private users: User[] = [];
  private bootstrap = '';
  private sessions = new Map<string, { name: string; expires: number }>();
  private attempts = new Map<string, { count: number; until: number }>();
  private settingUp = false;
  constructor(private directory: string) {}
  async init() {
    await mkdir(this.directory, { recursive: true });
    try { this.users = JSON.parse(await readFile(path.join(this.directory, 'auth.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!this.users.length) {
      const file = path.join(this.directory, 'bootstrap-token.txt');
      try { this.bootstrap = (await readFile(file, 'utf8')).trim(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.bootstrap = randomBytes(32).toString('hex'); await writeFile(file, this.bootstrap, { mode: 0o600, flag: 'wx' }); }
    }
  }
  user(req: Request) {
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('nox_session='))?.slice(12);
    const session = cookie ? this.sessions.get(digest(cookie)) : undefined;
    if (!session || session.expires <= Date.now()) { if (cookie) this.sessions.delete(digest(cookie)); return null; }
    const user = this.users.find(u => u.name === session.name);
    return user ? { name: user.name, role: user.role } : null;
  }
  private issue(res: import('express').Response, name: string) {
    for (const [key, session] of this.sessions) if (session.expires <= Date.now()) this.sessions.delete(key);
    const token = randomBytes(32).toString('hex'); this.sessions.set(digest(token), { name, expires: Date.now() + 8 * 3600_000 });
    res.cookie('nox_session', token, { httpOnly: true, sameSite: 'strict', secure: process.env.NOX_SECURE_COOKIES === 'true', maxAge: 8 * 3600_000, path: '/' });
  }
  install(app: Express) {
    app.get('/api/auth/status', (req, res) => res.json({ user: this.user(req), setupRequired: !this.users.length, anonymousAccess: 'read-only' }));
    app.post('/api/auth/setup', async (req, res) => {
      if (this.users.length || this.settingUp) { res.status(409).json({ error: { message: 'Setup already completed or in progress' } }); return; }
      const body = z.object({ token: z.string(), name: z.string().trim().min(3).max(50), password: z.string().min(12).max(128) }).safeParse(req.body);
      if (!body.success || digest(body.data.token) !== digest(this.bootstrap)) { res.status(400).json({ error: { message: 'Invalid setup token or credentials (password minimum 12 characters)' } }); return; }
      this.settingUp = true;
      try {
        const salt = randomBytes(16).toString('hex');
        const user: User = { name: body.data.name, role: 'admin', salt, hash: scryptSync(body.data.password, salt, 64).toString('hex') };
        const file = path.join(this.directory, 'auth.json');
        await writeFile(`${file}.tmp`, JSON.stringify([user]), { mode: 0o600 }); await rename(`${file}.tmp`, file);
        this.users = [user]; this.bootstrap = ''; this.issue(res, user.name); res.json({ user: { name: user.name, role: user.role } });
      } catch { res.status(503).json({ error: { message: 'Cannot persist authentication settings' } }); }
      finally { this.settingUp = false; }
    });
    app.post('/api/auth/login', (req, res) => {
      const key = req.ip ?? 'unknown', now = Date.now();
      const attempt = this.attempts.get(key); if (attempt && attempt.until > now && attempt.count >= 5) { res.status(429).json({ error: { message: 'Too many attempts; retry in 15 minutes' } }); return; }
      const body = z.object({ name: z.string().max(50), password: z.string().max(128) }).safeParse(req.body);
      const user = body.success ? this.users.find(u => u.name === body.data.name) : undefined;
      const hash = scryptSync(body.success ? body.data.password : '', user?.salt ?? 'nox-invalid-user', 64);
      if (!user || !timingSafeEqual(hash, Buffer.from(user.hash, 'hex'))) {
        this.attempts.set(key, { count: attempt && attempt.until > now ? attempt.count + 1 : 1, until: now + 900_000 });
        res.status(401).json({ error: { message: 'Invalid credentials' } }); return;
      }
      this.attempts.delete(key); this.issue(res, user.name); res.json({ user: { name: user.name, role: user.role } });
    });
    app.post('/api/auth/logout', (req, res) => {
      const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('nox_session='))?.slice(12);
      if (cookie) this.sessions.delete(digest(cookie)); res.clearCookie('nox_session', { path: '/' }); res.json({ ok: true });
    });
    app.use('/api', (req, res, next) => {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/projects/discover') { next(); return; }
      const user = this.user(req);
      if (!user) { res.status(401).json({ error: { message: 'Sign in to change projects or settings' } }); return; }
      const required = req.method === 'DELETE' || req.path.startsWith('/settings') ? 'admin' : 'analyst';
      if (!canWrite(user.role, required)) { res.status(403).json({ error: { message: `Requires ${required} role` } }); return; }
      next();
    });
  }
}
export function canWrite(role: Role, required: 'analyst' | 'admin') { return role === 'admin' || (required === 'analyst' && role === 'analyst'); }
