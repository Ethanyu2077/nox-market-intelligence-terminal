import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {scryptSync,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import express from 'express';
import {AuthStore} from '../server/auth.ts';
async function host(auth:AuthStore){
  const app=express();app.use(express.json());auth.install(app);
  app.post('/api/projects',(_req,res)=>res.json({ok:true}));app.delete('/api/projects/p',(_req,res)=>res.json({ok:true}));app.post('/api/projects/discover',(_req,res)=>res.json({ok:true}));app.patch('/api/projects/:id',(_req,res)=>res.json({ok:true}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/api`;
  const post=(route:string,body:unknown={},cookie='')=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',cookie},body:JSON.stringify(body)});
  return {post,base,close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));auth.close();}};
}
test('SQLite migrates existing password hashes and roles; read-only policy and write authorization stay intact',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'nox-sqlite-')),legacy=await mkdtemp(path.join(tmpdir(),'nox-legacy-'));
  const password='fixture-password-123',salt='a'.repeat(32),hash=scryptSync(password,salt,64).toString('hex');
  await writeFile(path.join(legacy,'auth.json'),JSON.stringify(['admin','analyst','viewer'].map(role=>({name:role,role,salt,hash}))));
  await writeFile(path.join(legacy,'bootstrap-token.txt'),'old-unused-code');
  const auth=new AuthStore(directory,legacy);await auth.init();const app=await host(auth);
  try {
    assert.equal((await fetch(app.base+'/auth/status')).status,200);
    assert.equal((await app.post('/projects')).status,401);
    assert.equal((await fetch(app.base+'/projects/p',{method:'DELETE'})).status,401);
    // The anonymous discovery exemption is POST-only; other methods must not reach :id handlers.
    assert.equal((await app.post('/projects/discover',{query:'ARB'})).status,200);
    assert.equal((await fetch(app.base+'/projects/discover',{method:'PATCH',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
    assert.equal((await fetch(app.base+'/projects/discover',{method:'DELETE'})).status,401);
    for(const role of ['admin','analyst','viewer']){
      const r=await app.post('/auth/login',{name:role,password});assert.equal(r.status,200);
      const cookie=r.headers.get('set-cookie')!.split(';')[0];
      assert.equal((await app.post('/projects',{},cookie)).status,role==='viewer'?403:200);
      assert.equal((await fetch(app.base+'/projects/p',{method:'DELETE',headers:{cookie}})).status,role==='admin'?200:403);
    }
    await assert.rejects(access(path.join(legacy,'auth.json')));await assert.rejects(access(path.join(legacy,'bootstrap-token.txt')));
    assert.equal((await stat(directory)).mode&0o777,0o700);assert.equal((await stat(path.join(directory,'auth.sqlite'))).mode&0o777,0o600);
    assert.ok(!(await readFile(path.join(directory,'auth.sqlite'))).includes(Buffer.from(password)));
  }finally{await app.close();}
});
test('SQLite preserves session expiration and login throttling across restart; logout invalidates the session',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'nox-auth-restart-'));
  let auth=new AuthStore(directory);await auth.init();let app=await host(auth);
  const token=auth.setSetupToken(),password='nox-1234';
  assert.equal((await app.post('/auth/setup',{token,name:'admin',password:'1234567'})).status,400);
  const setup=await app.post('/auth/setup',{token,name:'admin',password});assert.equal(setup.status,200);
  const cookie=setup.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await app.post('/auth/setup',{token,name:'other',password})).status,409);
  for(let i=0;i<5;i++)assert.equal((await app.post('/auth/login',{name:'admin',password:'wrong'})).status,401);
  await app.close();auth=new AuthStore(directory);await auth.init();app=await host(auth);
  try{
    assert.equal((await app.post('/projects',{},cookie)).status,200);
    assert.equal((await app.post('/auth/login',{name:'admin',password})).status,429);
    await app.post('/auth/logout',{},cookie);assert.equal((await app.post('/projects',{},cookie)).status,401);
    const db=new DatabaseSync(path.join(directory,'auth.sqlite'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM setup').get()?.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get()?.n,0);db.close();
    assert.ok(!(await readFile(path.join(directory,'auth.sqlite'))).includes(Buffer.from(token)));
  }finally{await app.close();}
});
test('invalid legacy credentials abort migration without removing the original; one-time code expires',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'nox-auth-invalid-')),legacy=await mkdtemp(path.join(tmpdir(),'nox-auth-source-'));
  await writeFile(path.join(legacy,'auth.json'),'invalid-json');
  await assert.rejects(new AuthStore(directory,legacy).init(),/migration aborted/);assert.equal(await readFile(path.join(legacy,'auth.json'),'utf8'),'invalid-json');
  const auth=new AuthStore(directory);await auth.init();const code=auth.setSetupToken();
  const db=new DatabaseSync(path.join(directory,'auth.sqlite'));db.exec('UPDATE setup SET expires=1');db.close();
  const app=await host(auth);try{assert.equal((await app.post('/auth/setup',{name:'admin',password:'fixture-password-123',token:code})).status,400);}finally{await app.close();}
});

test('only administrators can manage accounts; callers cannot grant themselves super administrator access',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'nox-accounts-'));
  const auth=new AuthStore(directory);await auth.init();const token=auth.setSetupToken(),app=await host(auth);
  const password='8charpwd';
  try{
    // Creating ordinary users never bypasses the first-administrator setup code.
    assert.equal((await app.post('/auth/users',{name:'outsider',password})).status,401);
    const setup=await app.post('/auth/setup',{token,name:'admin',password});assert.equal(setup.status,200);
    const admin=setup.headers.get('set-cookie')!.split(';')[0];
    assert.throws(()=>auth.setSetupToken(),/Administrator already exists/);
    for(const body of [{name:'short',password:'1234567'},{name:'ab',password},{name:'root',password,role:'superadmin'},{name:'extra',password,role:'admin',isSuperAdmin:true}]){
      assert.equal((await app.post('/auth/users',body,admin)).status,400);
    }
    for(const role of ['analyst','viewer']){
      const created=await app.post('/auth/users',{name:role,password,role},admin);
      assert.equal(created.status,201);assert.deepEqual(await created.json(),{user:{name:role,role,isSuperAdmin:false}});
      assert.equal((await app.post('/auth/users',{name:role,password},admin)).status,409);
    }
    for(const cookie of ['',...(await Promise.all(['analyst','viewer'].map(async name=>{
      const login=await app.post('/auth/login',{name,password});assert.equal(login.status,200);return login.headers.get('set-cookie')!.split(';')[0];
    })))]){
      const expected=cookie?403:401;
      assert.equal((await fetch(app.base+'/auth/users',{headers:{cookie}})).status,expected);
      assert.equal((await app.post('/auth/users',{name:'intruder',password},cookie)).status,expected);
      assert.equal((await fetch(app.base+'/auth/users/viewer',{method:'DELETE',headers:{cookie}})).status,expected);
    }
    const listing=await fetch(app.base+'/auth/users',{headers:{cookie:admin}});assert.equal(listing.status,200);
    assert.equal(listing.headers.get('cache-control'),'no-store');
    assert.deepEqual(await listing.json(),{items:[{name:'admin',role:'admin',isSuperAdmin:true},{name:'analyst',role:'analyst',isSuperAdmin:false},{name:'viewer',role:'viewer',isSuperAdmin:false}],canManageAdministrators:true});
    assert.equal((await fetch(app.base+'/auth/users/admin',{method:'DELETE',headers:{cookie:admin}})).status,403);
    assert.equal((await fetch(app.base+'/auth/users/missing',{method:'DELETE',headers:{cookie:admin}})).status,404);
    assert.equal((await app.post('/auth/setup',{token,name:'new-admin',password})).status,409);
    assert.equal((await app.post('/projects',{},admin)).status,200);
    assert.ok(!(await readFile(path.join(directory,'auth.sqlite'))).includes(Buffer.from(password)));
  }finally{await app.close();}
});

test('the super administrator creates and deletes administrators; ordinary administrators cannot manage peers or the owner',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'nox-admin-hierarchy-'));
  const auth=new AuthStore(directory);await auth.init();const app=await host(auth),password='8charpwd';
  try{
    const setup=await app.post('/auth/setup',{name:'owner',password,token:auth.setSetupToken()});assert.equal(setup.status,200);
    assert.deepEqual(await setup.json(),{user:{name:'owner',role:'admin',isSuperAdmin:true}});
    const owner=setup.headers.get('set-cookie')!.split(';')[0];
    for(const name of ['manager','other-admin']){
      const created=await app.post('/auth/users',{name,password,role:'admin'},owner);assert.equal(created.status,201);
      assert.deepEqual(await created.json(),{user:{name,role:'admin',isSuperAdmin:false}});
    }
    const login=await app.post('/auth/login',{name:'manager',password});assert.equal(login.status,200);
    assert.deepEqual(await login.json(),{user:{name:'manager',role:'admin',isSuperAdmin:false}});
    const manager=login.headers.get('set-cookie')!.split(';')[0];
    const second=await app.post('/auth/login',{name:'manager',password}),secondSession=second.headers.get('set-cookie')!.split(';')[0];
    const list=await fetch(app.base+'/auth/users',{headers:{cookie:manager}});assert.equal((await list.json()).canManageAdministrators,false);
    assert.equal((await app.post('/auth/users',{name:'third-admin',password,role:'admin'},manager)).status,403);
    assert.equal((await app.post('/auth/users',{name:'forged',password,role:'analyst',isSuperAdmin:true},manager)).status,400);
    assert.equal((await app.post('/auth/users',{name:'super',password,role:'superadmin'},owner)).status,400);
    for(const name of ['owner','manager','other-admin'])assert.equal((await fetch(app.base+'/auth/users/'+name,{method:'DELETE',headers:{cookie:manager}})).status,403);
    // Ordinary administrator permissions for projects, settings and standard accounts are unchanged.
    assert.equal((await app.post('/projects',{},manager)).status,200);
    assert.equal((await fetch(app.base+'/projects/p',{method:'DELETE',headers:{cookie:manager}})).status,200);
    assert.equal((await app.post('/auth/users',{name:'analyst',password},manager)).status,201);
    assert.equal((await fetch(app.base+'/auth/users/analyst',{method:'DELETE',headers:{cookie:manager}})).status,204);
    assert.equal((await fetch(app.base+'/auth/users/owner',{method:'DELETE',headers:{cookie:owner}})).status,403);
    assert.equal((await fetch(app.base+'/auth/users/manager',{method:'DELETE',headers:{cookie:owner}})).status,204);
    for(const cookie of [manager,secondSession]){
      assert.equal((await fetch(app.base+'/auth/users',{headers:{cookie}})).status,401);
      assert.equal((await app.post('/projects',{},cookie)).status,401);
    }
    assert.equal((await app.post('/auth/login',{name:'manager',password})).status,401);
    assert.equal((await fetch(app.base+'/auth/users',{headers:{cookie:owner}})).status,200);
    const db=new DatabaseSync(path.join(directory,'auth.sqlite'));
    try{
      assert.equal(db.prepare('SELECT count(*) AS n FROM users WHERE is_super_admin=1').get()?.n,1);
      assert.throws(()=>db.prepare('UPDATE users SET is_super_admin=1 WHERE name=?').run('other-admin'),/UNIQUE/);
      assert.throws(()=>db.prepare('DELETE FROM users WHERE name=?').run('owner'),/cannot be deleted/);
      assert.throws(()=>db.prepare('UPDATE users SET is_super_admin=0 WHERE name=?').run('owner'),/cannot be demoted/);
      assert.throws(()=>db.prepare("UPDATE users SET role='viewer' WHERE name=?").run('owner'),/cannot be demoted/);
    }finally{db.close();}
  }finally{await app.close();}
});

test('existing SQLite promotes only the first administrator once, preserving all hashes and active sessions across restart',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'nox-super-migration-')),file=path.join(directory,'auth.sqlite');
  const old=new DatabaseSync(file),password='8charpwd',salt='a'.repeat(32),hash=scryptSync(password,salt,64).toString('hex');
  old.exec("CREATE TABLE users(name TEXT PRIMARY KEY,role TEXT NOT NULL CHECK(role IN ('admin','analyst','viewer')),salt TEXT NOT NULL,hash TEXT NOT NULL); CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,name TEXT NOT NULL REFERENCES users(name) ON DELETE CASCADE,expires INTEGER NOT NULL)");
  for(const [name,role] of [['zzz-first','admin'],['aaa-second','admin'],['viewer','viewer']])old.prepare('INSERT INTO users VALUES(?,?,?,?)').run(name,role,salt,hash);
  const session='existing-owner-session';old.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(session).digest('hex'),'zzz-first',Date.now()+3600_000);old.close();
  for(let restart=0;restart<2;restart++){
    const auth=new AuthStore(directory);await auth.init();const app=await host(auth);
    try{
      const status=await fetch(app.base+'/auth/status',{headers:{cookie:'nox_session='+session}}).then(r=>r.json());
      assert.deepEqual(status.user,{name:'zzz-first',role:'admin',isSuperAdmin:true});assert.equal(status.setupRequired,false);
      assert.throws(()=>auth.setSetupToken(),/Administrator already exists/);
      const second=await app.post('/auth/login',{name:'aaa-second',password});assert.equal(second.status,200);assert.equal((await second.json()).user.isSuperAdmin,false);
      const db=new DatabaseSync(file);
      try{
        assert.equal(db.prepare('SELECT count(*) AS n FROM users WHERE is_super_admin=1').get()?.n,1);
        assert.deepEqual(db.prepare('SELECT name,role,salt,hash FROM users ORDER BY name').all().map(row=>({...row})),[
          {name:'aaa-second',role:'admin',salt,hash},{name:'viewer',role:'viewer',salt,hash},{name:'zzz-first',role:'admin',salt,hash}
        ]);
      }finally{db.close();}
    }finally{await app.close();}
  }
});

test('standard accounts persist across restart; deletion revokes all sessions and cannot affect the administrator',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'nox-account-revoke-'));
  let auth=new AuthStore(directory);await auth.init();let app=await host(auth);
  const password='8charpwd',token=auth.setSetupToken();
  const setup=await app.post('/auth/setup',{token,name:'admin',password}),admin=setup.headers.get('set-cookie')!.split(';')[0];
  const created=await Promise.all([app.post('/auth/users',{name:'operator',password},admin),app.post('/auth/users',{name:'operator',password},admin)]);
  assert.deepEqual(created.map(r=>r.status).sort(),[201,409]);
  await app.close();auth=new AuthStore(directory);await auth.init();app=await host(auth);
  try{
    assert.equal((await fetch(app.base+'/auth/status')).status,200);
    assert.equal((await (await fetch(app.base+'/auth/status')).json()).setupRequired,false);
    const cookies=[];
    for(let i=0;i<2;i++){
      const login=await app.post('/auth/login',{name:'operator',password});assert.equal(login.status,200);
      const cookie=login.headers.get('set-cookie')!.split(';')[0];cookies.push(cookie);
      assert.equal((await app.post('/projects',{},cookie)).status,200);
      assert.equal((await fetch(app.base+'/projects/p',{method:'DELETE',headers:{cookie}})).status,403);
    }
    assert.equal((await fetch(app.base+'/auth/users/operator',{method:'DELETE',headers:{cookie:admin}})).status,204);
    for(const cookie of cookies){
      assert.equal((await app.post('/projects',{},cookie)).status,401);
      assert.equal((await (await fetch(app.base+'/auth/status',{headers:{cookie}})).json()).user,null);
    }
    assert.equal((await app.post('/auth/login',{name:'operator',password})).status,401);
    assert.equal((await app.post('/projects',{},admin)).status,200);
    const db=new DatabaseSync(path.join(directory,'auth.sqlite'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM sessions WHERE name=?').get('operator')?.n,0);db.close();
    // Reusing a deleted username must never restore its previous sessions.
    assert.equal((await app.post('/auth/users',{name:'operator',password},admin)).status,201);
    assert.equal((await app.post('/projects',{},cookies[0])).status,401);
  }finally{await app.close();}
});

