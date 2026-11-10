import {useEffect,useRef,useState} from 'react';
type Status={user:{name:string;role:string}|null;setupRequired:boolean};
export default function AuthDialog({language,onClose,onSuccess}:{language:string;onClose:()=>void;onSuccess:()=>void}){
  const zh=language==='zh';
  const dialog=useRef<HTMLElement>(null), close=useRef(onClose);close.current=onClose;
  useEffect(()=>{const focused=document.activeElement as HTMLElement|null, previous=document.body.style.overflow;document.body.style.overflow='hidden';dialog.current?.focus();const key=(event:KeyboardEvent)=>{if(event.key==='Escape')close.current();if(event.key!=='Tab')return;const controls=dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');if(!controls?.length)return;const first=controls[0],last=controls[controls.length-1];if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last.focus();}else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===dialog.current)){event.preventDefault();first.focus();}};document.addEventListener('keydown',key);return()=>{document.body.style.overflow=previous;document.removeEventListener('keydown',key);focused?.focus();};},[]);
  const [status,setStatus]=useState<Status|null>(null),[name,setName]=useState(''),[password,setPassword]=useState(''),[confirm,setConfirm]=useState(''),[token,setToken]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');

  useEffect(()=>{let active=true;const abort=new AbortController();void fetch('/api/auth/status',{signal:abort.signal}).then(async r=>{if(!r.ok)throw new Error();return r.json();}).then((s:Status)=>{if(active)setStatus(s);}).catch(()=>{if(active)setError(zh?'无法读取登录状态，请刷新重试。':'Cannot load authentication status. Refresh to retry.');});return()=>{active=false;abort.abort();};},[zh]);
  const submit=async(event:React.FormEvent)=>{
    event.preventDefault();if(!status)return;
    if(status.setupRequired&&password!==confirm){setError(zh?'两次输入的密码不一致。':'Passwords do not match.');return;}
    setBusy(true);setError('');
    try{
      const r=await fetch(status.setupRequired?'/api/auth/setup':'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,password,...(status.setupRequired?{token}:{})})});
      if(!r.ok){setError(r.status===429?(zh?'尝试次数过多，请15分钟后重试。':'Too many attempts. Retry in 15 minutes.'):r.status===503?(zh?'认证服务暂不可用。':'Authentication temporarily unavailable.'):status.setupRequired?(zh?'初始化码无效或已过期，请核对用户名和至少8位的密码。':'Invalid or expired setup code, username or password (minimum 8 characters).'):(zh?'用户名或密码不正确。':'Invalid username or password.'));return;}
      setPassword('');setConfirm('');setToken('');onSuccess();onClose();
    }catch{setError(zh?'连接失败，请稍后重试。':'Connection failed. Please retry.');}finally{setBusy(false);}
  };
  return <div className="auth-dialog-backdrop"><section className="auth-card panel" role="dialog" aria-modal="true" aria-label={zh?'登录':'Sign in'} ref={dialog} tabIndex={-1}>
    <div className="auth-brand"><img src="/nox.png" alt="NOX Ventures"/><div><strong>NOX Ventures</strong><span>MARKET INTELLIGENCE</span></div><button type="button" aria-label={zh?'关闭登录':'Close sign in'} onClick={onClose}>×</button></div>
    <h1>{status?.setupRequired?(zh?'创建超级管理员账号':'Create super administrator account'):(zh?'登录':'Sign in')}</h1>
    <p>{zh?'登录后可创建项目、编辑监控和管理采集设置。':'Sign in to create projects and manage monitoring settings.'}</p>
    {status?.user?<><p>{zh?'当前已登录':'Signed in as'}: {status.user.name}</p><button className="primary-button auth-submit" onClick={onClose}>{zh?'返回工作区':'Return to workspace'}</button></>:
    <form onSubmit={event=>void submit(event)}>
      {status?.setupRequired&&<><p>{zh?'首次使用：在本机终端进入项目目录，运行下方命令获取一次性初始化码（15分钟有效）。':'First use: run the following command in the project directory on this machine to obtain a setup code (valid for 15 minutes).'}</p><code>npm run auth:setup-token</code><label>{zh?'一次性初始化码':'One-time setup code'}<input type="password" value={token} onChange={e=>setToken(e.target.value)} required minLength={24} maxLength={256} autoComplete="off"/></label></>}
      <label>{zh?'用户名':'Username'}<input name="username" value={name} onChange={e=>setName(e.target.value)} required minLength={status?.setupRequired?3:1} maxLength={50} autoComplete="username"/></label>
      <label>{zh?'密码':'Password'}<input name="password" type="password" value={password} onChange={e=>setPassword(e.target.value)} required minLength={status?.setupRequired?8:1} maxLength={128} autoComplete={status?.setupRequired?'new-password':'current-password'}/></label>
      {status?.setupRequired&&<label>{zh?'确认密码':'Confirm password'}<input name="confirmPassword" type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} required minLength={8} maxLength={128} autoComplete="new-password"/></label>}
      {error&&<p className="auth-error" role="alert">{error}</p>}
      <button className="primary-button auth-submit" type="submit" disabled={!status||busy}>{busy?(zh?'处理中…':'Please wait…'):status?.setupRequired?(zh?'创建账号并登录':'Create account & sign in'):(zh?'登录':'Sign in')}</button>
    </form>}
    <button className="auth-back" type="button" onClick={onClose}>{zh?'取消，继续只读浏览':'Cancel and continue read-only'}</button>
  </section></div>;
}

