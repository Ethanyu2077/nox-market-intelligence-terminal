// Apply the user's existing proxy to this app process; never change OS settings.
import {execFileSync,spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,URL} from 'node:url';
import process from 'node:process';
// Load the documented .env before proxy detection and before spawning the API child.
// process.loadEnvFile gives real environment variables (shell/npm/CI) higher precedence.
const envFile=path.resolve(process.cwd(),process.env.NOX_ENV_FILE??'.env');
if(existsSync(envFile)){
  if(typeof process.loadEnvFile!=='function'){
    process.stderr.write(`This Node runtime cannot load ${envFile}; export the variables manually.\n`);
    process.exit(1);
  }
  try{process.loadEnvFile(envFile);}catch(error){process.stderr.write(`Cannot load ${envFile}: ${error instanceof Error?error.message:String(error)}\n`);process.exit(1);}
}
const env={...process.env};
if(process.platform==='darwin'&&!env.HTTPS_PROXY&&!env.https_proxy&&!env.HTTP_PROXY&&!env.http_proxy){
  try{
    const configuration=execFileSync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8',timeout:2000});
    const value=key=>configuration.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`,'m'))?.[1].trim();
    const host=value('HTTPSProxy'),port=value('HTTPSPort');
    if(value('HTTPSEnable')==='1'&&host&&/^\d+$/.test(port??'')){
      const proxy=new URL('http://localhost');proxy.hostname=host;proxy.port=port;
      env.HTTPS_PROXY=proxy.origin;env.HTTP_PROXY=proxy.origin;
    }
  }catch{/* No system proxy available; preserve normal network behavior. */}
}
if(env.HTTPS_PROXY||env.https_proxy||env.HTTP_PROXY||env.http_proxy){
  if(!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')){
    throw new Error('This Node runtime does not support environment proxies. Use a current Node.js 24 LTS runtime.');
  }
  env.NODE_USE_ENV_PROXY??='1';
  const local=['localhost','127.0.0.1','::1'];
  env.NO_PROXY=[env.NO_PROXY??env.no_proxy??'',...local].filter(Boolean).join(',');
}
const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./index.ts',import.meta.url))],{env,stdio:'inherit'});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
child.on('error',()=>{process.stderr.write('Could not start NOX server\n');process.exitCode=1;});
child.on('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});

