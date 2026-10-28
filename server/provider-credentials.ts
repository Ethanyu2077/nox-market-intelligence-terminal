import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {mkdir,chmod,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {Express} from 'express';
import {z} from 'zod';
import type {AuthStore} from './auth.ts';
import {CoinGlassClient} from './coinglass.ts';

export class ProviderCredentials {
  private db!:DatabaseSync;
  private key!:Buffer;
  constructor(private directory:string){}
  async init(){
    await mkdir(this.directory,{recursive:true,mode:0o700});await chmod(this.directory,0o700);
    const file=path.join(this.directory,'providers.sqlite');this.db=new DatabaseSync(file);await chmod(file,0o600);
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS credentials(provider TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    const master=path.join(this.directory,'provider-master.key');
    try{this.key=await readFile(master);}catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      if(this.db.prepare('SELECT 1 FROM credentials LIMIT 1').get())throw new Error('Provider encryption key is missing; restore the existing key before starting');
      try{await writeFile(master,randomBytes(32),{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
      this.key=await readFile(master);
    }
    if(this.key.length!==32)throw new Error('Invalid provider encryption key');await chmod(master,0o600);
  }
  get(provider:string):string|null{
    const record=this.db.prepare('SELECT payload FROM credentials WHERE provider=?').get(provider) as {payload:string}|undefined;
    if(!record)return null;
    try{const {iv,tag,value}=JSON.parse(record.payload);const decipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(iv,'base64'));decipher.setAAD(Buffer.from(provider));decipher.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(value,'base64')),decipher.final()]).toString('utf8');}
    catch{throw new Error('Cannot decrypt provider credentials');}
  }
  set(provider:string,key:string){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from(provider));
    const value=Buffer.concat([cipher.update(key,'utf8'),cipher.final()]);
    this.db.prepare('INSERT INTO credentials(provider,payload,updated_at) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(provider,JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),value:value.toString('base64')}),Date.now());
  }
  remove(provider:string){this.db.prepare('DELETE FROM credentials WHERE provider=?').run(provider);}
  status(provider:string){const record=this.db.prepare('SELECT updated_at FROM credentials WHERE provider=?').get(provider) as {updated_at:number}|undefined;return {saved:!!record,updatedAt:record?.updated_at??null};}
  close(){this.db.close();}
}
export function installProviderSettings(app:Express,auth:AuthStore,store:ProviderCredentials,onKeyChanged:(key:string)=>void,makeClient=(key:string)=>new CoinGlassClient(key),environmentKey=process.env.COINGLASS_API_KEY??''){
  let client=makeClient(store.get('coinglass')??environmentKey);
  let lastTest:{state:'verified'|'error';reason:string|null;checkedAt:number}|null=null;
  const status=()=>{const stored=store.status('coinglass');return {...stored,configured:client.configured,source:stored.saved?'saved':environmentKey?'environment':'none',lastTest};};
  app.use('/api/settings/providers',(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');const user=auth.user(req);
    if(!user){res.status(401).json({error:{message:'Sign in to configure data providers'}});return;}
    if(user.role!=='admin'){res.status(403).json({error:{message:'Requires admin role'}});return;}next();
  });
  app.get('/api/settings/providers/coinglass',(_req,res)=>res.json(status()));
  app.put('/api/settings/providers/coinglass',(req,res)=>{
    const body=z.object({apiKey:z.string().trim().min(1).max(512).regex(/^[\x21-\x7e]+$/)}).strict().safeParse(req.body);
    if(!body.success){res.status(400).json({error:{message:'Enter a valid CoinGlass API key'}});return;}
    try{store.set('coinglass',body.data.apiKey);client=makeClient(body.data.apiKey);lastTest=null;onKeyChanged(body.data.apiKey);res.json(status());}
    catch{res.status(503).json({error:{message:'Cannot save provider configuration'}});}
  });
  app.delete('/api/settings/providers/coinglass',(_req,res)=>{
    try{store.remove('coinglass');client=makeClient(environmentKey);lastTest=null;onKeyChanged(environmentKey);res.json(status());}
    catch{res.status(503).json({error:{message:'Cannot remove provider configuration'}});}
  });
  app.post('/api/settings/providers/coinglass/test',async(_req,res)=>{
    if(!client.configured){res.status(400).json({error:{message:'Configure CoinGlass API key first'}});return;}
    const testing=client;
    try{const result=await testing.request('/api/futures/supported-coins');if(!Array.isArray(result.data)||!result.data.length)throw new Error('invalid-response');if(testing===client)lastTest={state:'verified',reason:null,checkedAt:Date.now()};res.json({state:'verified',checkedAt:Date.now(),supportedCoins:result.data.length});}
    catch(error){const reason=error instanceof Error&&/^(authentication-failed|permission-or-plan-restricted|rate-limited|network-unavailable|invalid-response|upstream-rejected|upstream-\d+)$/.test(error.message)?error.message:'upstream-unavailable';if(testing===client)lastTest={state:'error',reason,checkedAt:Date.now()};res.status(502).json({error:{message:reason}});}
  });
}
