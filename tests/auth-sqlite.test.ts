import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {scryptSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import express from 'express';
import {AuthStore} from '../server/auth.ts';
async function host(auth:AuthStore){
  const app=express();app.use(express.json());auth.install(app);
  app.post('/api/projects',(_req,res)=>res.json({ok:true}));app.delete('/api/projects/p',(_req,res)=>res.json({ok:true}));
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
