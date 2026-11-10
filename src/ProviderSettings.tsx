import {useCallback,useEffect,useState} from 'react';
type Config={configured:boolean;saved:boolean;source:'saved'|'environment'|'none';updatedAt:number|null;lastTest:{state:string;reason:string|null;checkedAt:number}|null};
const messages:Record<string,[string,string]>={
  'authentication-failed':['Key 鉴权失败，请核对密钥','API key authentication failed'],
  'permission-or-plan-restricted':['接口权限或套餐受限','Permission or subscription restriction'],
  'rate-limited':['已触发限频，请稍后重试','Rate limited; retry later'],
  'network-unavailable':['无法连接 CoinGlass','Cannot connect to CoinGlass'],
};
export function ProviderSettings({language,hasProject,onOpenCoinGlass}:{language:string;hasProject:boolean;onOpenCoinGlass:()=>void}){
  const zh=language==='zh',[config,setConfig]=useState<Config|null>(null),[role,setRole]=useState<string|null>(null),[apiKey,setKey]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[loaded,setLoaded]=useState(false);
  const load=useCallback(async()=>{
    try{
      const response=await fetch('/api/auth/status');if(!response.ok)throw new Error();const auth=await response.json();setRole(auth.user?.role??null);if(auth.user?.role!=='admin')setKey('');
      const r=await fetch(auth.user?.role==='admin'?'/api/settings/providers/coinglass':'/api/coinglass/capabilities');if(!r.ok)throw new Error();setConfig(await r.json());setLoaded(true);
    }catch{setMessage(zh?'无法读取数据源配置':'Cannot load provider configuration');setLoaded(true);}
  },[zh]);
  useEffect(()=>{void load();const refresh=()=>void load();window.addEventListener('nox:auth-changed',refresh);return()=>window.removeEventListener('nox:auth-changed',refresh);},[load]);
  const action=async(kind:'save'|'test'|'remove')=>{
    if(role!=='admin'){window.dispatchEvent(new Event('nox:auth-required'));return;}
    setBusy(true);setMessage('');
    try{
      const r=await fetch(`/api/settings/providers/coinglass${kind==='test'?'/test':''}`,{method:kind==='save'?'PUT':kind==='test'?'POST':'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(kind==='save'?{apiKey}:{})});
      const body=await r.json();if(r.status===401)window.dispatchEvent(new Event('nox:auth-required'));
      if(!r.ok){const reason=body.error?.message;setMessage(messages[reason]?.[zh?0:1]??(zh?'操作失败，请核对密钥、权限与网络后重试':'Request failed; check credentials, access and network'));return;}
      if(kind==='save')setKey('');
      setMessage(kind==='save'?(zh?'已保存，立即生效；可点击测试连接。':'Saved and active. Test the connection to verify access.'):kind==='remove'?(zh?'已删除网页保存的 Key；如配置了环境变量则回退使用。':'Saved key removed. Environment configuration is used if present.'):(zh?`连接成功，支持 ${body.supportedCoins} 个币种；各指标权限由套餐决定。`:`Connected: ${body.supportedCoins} supported coins. Individual metrics depend on your plan.`));
      await load();window.dispatchEvent(new Event('nox:providers-changed'));
    }catch{setMessage(zh?'连接失败，请稍后重试':'Connection failed; retry later');}finally{setBusy(false);}
  };
  return <section className="ops-panel provider-settings">
    <h2>{zh?'密钥与连接':'Credentials & connection'}</h2>
    <section className="panel source-card">
      <h3>CoinGlass V4</h3>
      <p>{zh?'配置一次 Key，即可在「跨交易所分析」查看 OI、资金费率、主动买卖与清算，并按需加载历史 OI 和加权资金费率。':'Configure one key for OI, funding, taker flow and liquidations in Cross-Exchange Analysis, plus on-demand OI and weighted-funding history.'}</p>
      <p>{!loaded?(zh?'读取状态…':'Loading…'):config?.configured?(zh?'Key 已配置':'Key configured'):(zh?'尚未配置 Key':'No key configured')}{config?.source==='environment'?(zh?' · 环境变量':' · Environment'):config?.source==='saved'?(zh?' · 服务端已保存':' · Saved on server'):''}</p>
      {role==='admin'?<form className="provider-key-form" onSubmit={e=>{e.preventDefault();void action('save');}}>
        <label>CoinGlass API Key<input type="password" aria-label="CoinGlass API Key" value={apiKey} onChange={e=>setKey(e.target.value)} maxLength={512} autoComplete="off" spellCheck={false} placeholder={config?.configured?(zh?'输入新 Key 可替换；已保存 Key 不回显':'Enter a new key to replace; saved keys are never shown'):(zh?'输入 CoinGlass API Key':'Enter CoinGlass API key')}/></label>
        <div className="ops-controls"><button type="submit" disabled={busy||!apiKey.trim()}>{zh?'保存 Key':'Save key'}</button><button type="button" disabled={busy||!config?.configured} onClick={()=>void action('test')}>{zh?'测试连接':'Test connection'}</button>{config?.saved&&<button type="button" disabled={busy} onClick={()=>void action('remove')}>{zh?'删除已保存 Key':'Remove saved key'}</button>}</div>
      </form>:<p>{zh?'管理员登录后可配置密钥，其他用户继续只读浏览。':'Sign in as administrator to configure credentials. Other users retain read-only access.'}{!role&&<button onClick={()=>window.dispatchEvent(new Event('nox:auth-required'))}>{zh?'登录配置':'Sign in to configure'}</button>}</p>}
      {message&&<p role="status">{message}</p>}
      {config?.lastTest&&<p>{zh?'最近测试':'Last test'}: {config.lastTest.state==='verified'?(zh?'成功':'Passed'):(zh?'失败':'Failed')} · {new Date(config.lastTest.checkedAt).toLocaleString()}</p>}
      <p>{zh?'Key 仅保存在服务端加密存储，不写入浏览器持久化；保存后无需重启。保存不等于已通过真实接口验证。':'Keys use encrypted server-side storage and are never persisted in the browser. Changes apply immediately; saving alone does not verify API access.'}</p>
      <button disabled={!hasProject} onClick={onOpenCoinGlass}>{zh?'前往 CoinGlass 指标':'Open CoinGlass metrics'}</button>{!hasProject&&<p>{zh?'请先添加并选中一个项目。':'Add and select a project first.'}</p>}
    </section>
  </section>;
}

