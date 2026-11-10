import type {Express,Request} from 'express';
import type {AuthStore} from './auth.ts';

export function installCoinGlassAccess(app:Express,auth:AuthStore){
  app.use(['/api/coinglass','/api/projects/:id/coinglass','/api/projects/:id/provider-crosscheck','/api/settings/providers/coinglass'],(req,res,next)=>{
    res.setHeader('Cache-Control','no-store');res.vary('Cookie');
    const user=auth.user(req);
    if(!user){res.status(401).json({error:{message:'Sign in as administrator to use CoinGlass'}});return;}
    if(user.role!=='admin'){res.status(403).json({error:{message:'CoinGlass requires admin role'}});return;}
    next();
  });
  // These mixed responses can include private provider data for administrators only.
  app.use(['/api/projects/:id/research-context','/api/data-health/center'],(_req,res,next)=>{res.setHeader('Cache-Control','no-store');res.vary('Cookie');next();});
}

export async function coinGlassResearchContext<T>(auth:AuthStore,req:Request,load:()=>Promise<T>):Promise<T|undefined>{
  if(auth.user(req)?.role!=='admin')return undefined;
  return load();
}
