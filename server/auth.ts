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
type StoredUser = User & {is_super_admin:number};
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
    try { await this.migrateLegacy(); this.initSuperAdministrator(); } catch (error) { this.db.close(); throw error; }
    if (process.env.NOX_BOOTSTRAP_TOKEN && this.setupRequired()) this.setSetupToken(process.env.NOX_BOOTSTRAP_TOKEN);
    this.db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
    this.db.prepare('DELETE FROM attempts WHERE until_time <= ?').run(Date.now());
  }
  private initSuperAdministrator() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(!this.db.prepare('PRAGMA table_info(users)').all().some(column=>column.name==='is_super_admin')){
        this.db.exec("ALTER TABLE users ADD COLUMN is_super_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_super_admin IN (0,1) AND (is_super_admin=0 OR role='admin'))");
      }
      this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS single_super_administrator ON users(is_super_admin) WHERE is_super_admin=1');
      if(!this.db.prepare('SELECT 1 FROM migrations WHERE name=?').get('single-super-administrator')){
        // Existing administrators were protected from deletion; the earliest row is the setup owner.
        if(!this.db.prepare('SELECT 1 FROM users WHERE is_super_admin=1').get()){
          const first=this.db.prepare("SELECT name FROM users WHERE role='admin' ORDER BY rowid LIMIT 1").get();
          if(first)this.db.prepare('UPDATE users SET is_super_admin=1 WHERE name=?').run(first.name);
        }
        this.db.prepare('INSERT INTO migrations(name) VALUES(?)').run('single-super-administrator');
      }
      if(!this.setupRequired()&&!this.db.prepare('SELECT 1 FROM users WHERE is_super_admin=1').get())throw new Error('Super administrator is missing; restore authentication data');
      this.db.exec(`CREATE TRIGGER IF NOT EXISTS protect_super_administrator_delete BEFORE DELETE ON users WHEN OLD.is_super_admin=1 BEGIN SELECT RAISE(ABORT,'Super administrator cannot be deleted'); END;
        CREATE TRIGGER IF NOT EXISTS protect_super_administrator_update BEFORE UPDATE OF role,is_super_admin ON users WHEN OLD.is_super_admin=1 AND (NEW.is_super_admin<>1 OR NEW.role<>'admin') BEGIN SELECT RAISE(ABORT,'Super administrator cannot be demoted'); END;`);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
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
    const user = this.db.prepare('SELECT u.name,u.role,u.is_super_admin FROM sessions s JOIN users u ON u.name=s.name WHERE s.token_hash=? AND s.expires>?').get(digest(cookie),Date.now()) as {name:string;role:Role;is_super_admin:number}|undefined;
    return user ? {name:user.name,role:user.role,isSuperAdmin:user.is_super_admin===1} : null;
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
          this.db.prepare('INSERT INTO users(name,role,salt,hash,is_super_admin) VALUES(?,?,?,?,1)').run(body.data.name,'admin',salt,hash);
          this.db.exec('DELETE FROM setup');
          this.issue(res,body.data.name);
          this.db.exec('COMMIT');
        } catch(error) {this.db.exec('ROLLBACK');throw error;}
        this.db.prepare('DELETE FROM attempts WHERE address=?').run(digest(req.ip??'unknown'));
        res.json({user:{name:body.data.name,role:'admin',isSuperAdmin:true}});
      } catch {res.status(503).json({error:{message:'Cannot persist authentication settings'}});}
    });
    app.post('/api/auth/login',async(req,res)=>{
      if(this.throttled(req)){res.status(429).json({error:{message:'Too many attempts; retry in 15 minutes'}});return;}
      const body=z.object({name:z.string().trim().max(50),password:z.string().max(128)}).safeParse(req.body);
      const user=body.success?this.db.prepare('SELECT * FROM users WHERE name=?').get(body.data.name) as StoredUser|undefined:undefined;
      try {
        const hash=await derive(body.success?body.data.password:'',user?.salt??'nox-invalid-user',64) as Buffer;
        if(!user||!timingSafeEqual(hash,Buffer.from(user.hash,'hex'))){this.failed(req);res.status(401).json({error:{message:'Invalid credentials'}});return;}
        this.db.prepare('DELETE FROM attempts WHERE address=?').run(digest(req.ip??'unknown'));
        this.issue(res,user.name);res.json({user:{name:user.name,role:user.role,isSuperAdmin:user.is_super_admin===1}});
      } catch {res.status(503).json({error:{message:'Authentication temporarily unavailable'}});}
    });
    app.post('/api/auth/logout',(req,res)=>{const cookie=this.cookie(req);if(cookie)this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(cookie));res.clearCookie('nox_session',{path:'/'});res.json({ok:true});});
    app.use('/api/auth/users',(req,res,next)=>{
      const user=this.user(req);
      if(!user){res.status(401).json({error:{message:'Sign in to manage accounts'}});return;}
      if(user.role!=='admin'){res.status(403).json({error:{message:'Requires admin role'}});return;}
      next();
    });
    app.get('/api/auth/users',(req,res)=>{
      res.json({items:this.db.prepare('SELECT name,role,is_super_admin FROM users ORDER BY name').all().map(user=>({name:user.name,role:user.role,isSuperAdmin:user.is_super_admin===1})),canManageAdministrators:this.user(req)!.isSuperAdmin});
    });
    app.post('/api/auth/users',async(req,res)=>{
      const body=z.object({name:z.string().trim().min(3).max(50),password:z.string().min(8).max(128),role:z.enum(['admin','analyst','viewer']).default('analyst')}).strict().safeParse(req.body);
      if(!body.success){res.status(400).json({error:{message:'Invalid account details'}});return;}
      if(body.data.role==='admin'&&!this.user(req)!.isSuperAdmin){res.status(403).json({error:{message:'Requires super administrator'}});return;}
      try {
        const salt=randomBytes(16).toString('hex'),hash=(await derive(body.data.password,salt,64) as Buffer).toString('hex');
        // A logout during hashing must not authorize a subsequent account creation.
        const actor=this.user(req);
        if(actor?.role!=='admin'){res.status(401).json({error:{message:'Sign in to manage accounts'}});return;}
        if(body.data.role==='admin'&&!actor.isSuperAdmin){res.status(403).json({error:{message:'Requires super administrator'}});return;}
        const result=this.db.prepare('INSERT INTO users(name,role,salt,hash) VALUES(?,?,?,?) ON CONFLICT(name) DO NOTHING').run(body.data.name,body.data.role,salt,hash);
        if(!result.changes){res.status(409).json({error:{message:'Username already exists'}});return;}
        res.status(201).json({user:{name:body.data.name,role:body.data.role,isSuperAdmin:false}});
      } catch {res.status(503).json({error:{message:'Cannot create account'}});}
    });
    app.delete('/api/auth/users/:name',(req,res)=>{
      const target=this.db.prepare('SELECT role,is_super_admin FROM users WHERE name=?').get(req.params.name);
      if(!target){res.status(404).json({error:{message:'Account not found'}});return;}
      if(target.is_super_admin===1){res.status(403).json({error:{message:'Super administrator cannot be deleted'}});return;}
      if(target.role==='admin'&&!this.user(req)!.isSuperAdmin){res.status(403).json({error:{message:'Requires super administrator'}});return;}
      // Foreign-key cascade revokes every session belonging to this account.
      this.db.prepare('DELETE FROM users WHERE name=? AND is_super_admin=0').run(req.params.name);
      res.status(204).end();
    });
    app.use('/api',(req,res,next)=>{
      // AI routes authenticate themselves: a browser-supplied key may be used anonymously
      // (the caller pays), while the server key requires a session. See server/ai/routes.ts.
      if(req.path.startsWith('/ai/')){next();return;}
      if(['GET','HEAD','OPTIONS'].includes(req.method)||(req.method==='POST'&&req.path==='/projects/discover')){next();return;}
      const user=this.user(req);if(!user){res.status(401).json({error:{message:'Sign in to change projects or settings'}});return;}
      const required=req.method==='DELETE'||req.path.startsWith('/settings')?'admin':'analyst';
      if(!canWrite(user.role,required)){res.status(403).json({error:{message:`Requires ${required} role`}});return;}next();
    });
  }
}
export function canWrite(role: Role, required: 'analyst'|'admin') {return role==='admin'||(required==='analyst'&&role==='analyst');}
