import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';

const derive = promisify(scrypt);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const legacyUser = z.object({ name: z.string().trim().min(3).max(50), role: z.enum(['viewer','analyst','admin']), salt: z.string().regex(/^[a-f0-9]{32}$/), hash: z.string().regex(/^[a-f0-9]{128}$/) });
type Role = 'viewer' | 'analyst' | 'admin';
type User = z.infer<typeof legacyUser>;
export const defaultAuthDirectory = () => path.resolve(process.env.NOX_AUTH_DIR ?? 'var/auth');
export class AuthStore {
  private db!: DatabaseSync;
  constructor(private directory: string, private legacyDirectory?: string) {}
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const file = path.join(this.directory, 'auth.sqlite');
    this.db = new DatabaseSync(file);
    await chmod(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(name TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('admin','analyst','viewer')), salt TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, name TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
      CREATE TABLE IF NOT EXISTS attempts(address TEXT PRIMARY KEY, count INTEGER NOT NULL, until_time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS setup(singleton INTEGER PRIMARY KEY CHECK(singleton=1), token_hash TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY);`);
    try { await this.migrateLegacy(); } catch (error) { this.db.close(); throw error; }
    if (process.env.NOX_BOOTSTRAP_TOKEN && this.setupRequired()) this.setSetupToken(process.env.NOX_BOOTSTRAP_TOKEN);
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    this.db.prepare('DELETE FROM attempts WHERE until_time <= ?').run(Date.now());
  }
  private async migrateLegacy() {
    if (!this.legacyDirectory) return;
    if (!this.db.prepare('SELECT 1 FROM migrations WHERE name=?').get('legacy-json')) {
      let users: User[] = [];
      try { users = z.array(legacyUser).parse(JSON.parse(await readFile(path.join(this.legacyDirectory, 'auth.json'), 'utf8'))); }
      catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Legacy authentication is invalid; migration aborted without changing accounts'); }
      if (users.length && !users.some(u => u.role === 'admin')) throw new Error('Legacy authentication has no admin; migration aborted');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (users.length && !this.setupRequired()) throw new Error('Both legacy and SQLite accounts exist; migration requires explicit reconciliation');
        for (const user of users) this.db.prepare('INSERT INTO users(name,role,salt,hash) VALUES(?,?,?,?)').run(user.name,user.role,user.salt,user.hash);
        this.db.prepare('INSERT INTO migrations(name) VALUES(?)').run('legacy-json');
        this.db.exec('COMMIT');
      } catch(error) { this.db.exec('ROLLBACK'); throw error; }
    }
    // Remove only obsolete authentication files after a successful durable migration.
    for (const file of ['auth.json','bootstrap-token.txt']) {
      try { await unlink(path.join(this.legacyDirectory, file)); }
      catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private setupRequired() { return !this.db.prepare('SELECT 1 FROM users LIMIT 1').get(); }
  setSetupToken(token = randomBytes(32).toString('hex')) {
    if (!this.setupRequired()) throw new Error('Administrator already exists');
    if (token.length < 24 || token.length > 256) throw new Error('Setup token must contain 24–256 characters');
    this.db.prepare('INSERT INTO setup(singleton,token_hash,expires) VALUES(1,?,?) ON CONFLICT(singleton) DO UPDATE SET token_hash=excluded.token_hash,expires=excluded.expires').run(digest(token),Date.now()+15*60_000);
    return token;
  }
  close() { this.db.close(); }
  private cookie(req: Request) { return req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('nox_session='))?.slice(12); }
  user(req: Request) {
    const cookie = this.cookie(req); if (!cookie) return null;
    const user = this.db.prepare('SELECT u.name,u.role FROM sessions s JOIN users u ON u.name=s.name WHERE s.token_hash=? AND s.expires>?').get(digest(cookie),Date.now()) as {name:string;role:Role}|undefined;
    return user ? {name:user.name,role:user.role} : null;
  }
  private issue(res: Response, name: string) {
    const token = randomBytes(32).toString('hex');
    this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
    this.db.prepare('INSERT INTO sessions(token_hash,name,expires) VALUES(?,?,?)').run(digest(token),name,Date.now()+8*3600_000);
    res.cookie('nox_session', token, {httpOnly:true,sameSite:'strict',secure:process.env.NOX_SECURE_COOKIES==='true',maxAge:8*3600_000,path:'/'});
  }
  private throttled(req: Request) {
    const key = digest(req.ip ?? 'unknown'), now=Date.now();
    const attempt=this.db.prepare('SELECT count,until_time FROM attempts WHERE address=?').get(key) as {count:number;until_time:number}|undefined;
    return !!attempt && attempt.until_time>now && attempt.count>=5;
  }
  private failed(req: Request) {
    const now=Date.now();
    this.db.prepare('DELETE FROM attempts WHERE until_time<=?').run(now);
    this.db.prepare(`INSERT INTO attempts(address,count,until_time) VALUES(?,1,?) ON CONFLICT(address) DO UPDATE SET count=attempts.count+1`).run(digest(req.ip??'unknown'),now+900_000);
  }
  install(app: Express) {
    app.use('/api/auth', (_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
    app.get('/api/auth/status',(req,res)=>res.json({user:this.user(req),setupRequired:this.setupRequired(),anonymousAccess:'read-only',storage:'sqlite'}));
    app.post('/api/auth/setup',async(req,res)=>{
      if (!this.setupRequired()) {res.status(409).json({error:{message:'Setup already completed'}});return;}
      if (this.throttled(req)) {res.status(429).json({error:{message:'Too many attempts; retry in 15 minutes'}});return;}
      const body=z.object({token:z.string().min(24).max(256),name:z.string().trim().min(3).max(50),password:z.string().min(8).max(128)}).safeParse(req.body);
      const validToken=()=>this.db.prepare('SELECT 1 FROM setup WHERE singleton=1 AND token_hash=? AND expires>?').get(body.success?digest(body.data.token):'',Date.now());
      if(!body.success||!validToken()){this.failed(req);res.status(400).json({error:{message:'Invalid or expired setup code, username or password (minimum 8 characters)'}});return;}
      try {
        const salt=randomBytes(16).toString('hex'),hash=(await derive(body.data.password,salt,64) as Buffer).toString('hex');
        // Recheck under a write transaction after asynchronous password hashing.
        this.db.exec('BEGIN IMMEDIATE');
        try {
          if(!this.setupRequired()||!validToken()) {this.db.exec('ROLLBACK');res.status(409).json({error:{message:'Setup already completed or code expired'}});return;}
          this.db.prepare('INSERT INTO users(name,role,salt,hash) VALUES(?,?,?,?)').run(body.data.name,'admin',salt,hash);
          this.db.exec('DELETE FROM setup');
          this.issue(res,body.data.name);
          this.db.exec('COMMIT');
        } catch(error) {this.db.exec('ROLLBACK');throw error;}
        this.db.prepare('DELETE FROM attempts WHERE address=?').run(digest(req.ip??'unknown'));
        res.json({user:{name:body.data.name,role:'admin'}});
      } catch {res.status(503).json({error:{message:'Cannot persist authentication settings'}});}
    });
    app.post('/api/auth/login',async(req,res)=>{
      if(this.throttled(req)){res.status(429).json({error:{message:'Too many attempts; retry in 15 minutes'}});return;}
      const body=z.object({name:z.string().trim().max(50),password:z.string().max(128)}).safeParse(req.body);
      const user=body.success?this.db.prepare('SELECT * FROM users WHERE name=?').get(body.data.name) as User|undefined:undefined;
      try {
        const hash=await derive(body.success?body.data.password:'',user?.salt??'nox-invalid-user',64) as Buffer;
        if(!user||!timingSafeEqual(hash,Buffer.from(user.hash,'hex'))){this.failed(req);res.status(401).json({error:{message:'Invalid credentials'}});return;}
        this.db.prepare('DELETE FROM attempts WHERE address=?').run(digest(req.ip??'unknown'));
        this.issue(res,user.name);res.json({user:{name:user.name,role:user.role}});
      } catch {res.status(503).json({error:{message:'Authentication temporarily unavailable'}});}
    });
    app.post('/api/auth/logout',(req,res)=>{const cookie=this.cookie(req);if(cookie)this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(cookie));res.clearCookie('nox_session',{path:'/'});res.json({ok:true});});
    app.use('/api',(req,res,next)=>{
      if(['GET','HEAD','OPTIONS'].includes(req.method)||req.path==='/projects/discover'){next();return;}
      const user=this.user(req);if(!user){res.status(401).json({error:{message:'Sign in to change projects or settings'}});return;}
      const required=req.method==='DELETE'||req.path.startsWith('/settings')?'admin':'analyst';
      if(!canWrite(user.role,required)){res.status(403).json({error:{message:`Requires ${required} role`}});return;}next();
    });
  }
}
export function canWrite(role: Role, required: 'analyst'|'admin') {return role==='admin'||(required==='analyst'&&role==='analyst');}
