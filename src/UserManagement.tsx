import {useCallback,useEffect,useRef,useState} from 'react';
import {api} from './api';
import './user-management.css';

type Account={name:string;role:'admin'|'analyst'|'viewer';isSuperAdmin:boolean};
const errors:Record<string,[string,string]>={
  'Username already exists':['用户名已存在','Username already exists'],
  'Invalid account details':['请填写3–50位用户名、8–128位密码，并选择账号权限','Enter a username of 3–50 characters, password of 8–128 characters and an account role'],
  'Account not found':['账号已不存在，请刷新列表','Account no longer exists; refresh the list'],
  'Super administrator cannot be deleted':['不能删除唯一的超级管理员','The unique super administrator cannot be deleted'],
  'Requires super administrator':['仅超级管理员可创建或删除管理员','Only the super administrator can create or delete administrators'],
  'Requires admin role':['仅管理员可管理账号','Only administrators can manage accounts'],
  'Sign in to manage accounts':['请重新使用管理员账号登录','Sign in again as administrator'],
};

export function UserManagement({language}:{language:string}){
  const zh=language==='zh';
  const [users,setUsers]=useState<Account[]>([]),[loaded,setLoaded]=useState(false),[busy,setBusy]=useState(false);
  const [name,setName]=useState(''),[password,setPassword]=useState(''),[role,setRole]=useState<Account['role']>('analyst');
  const [canManageAdmins,setCanManageAdmins]=useState(false);
  const [remove,setRemove]=useState<string|null>(null),[message,setMessage]=useState(''),[error,setError]=useState('');
  const generation=useRef(0);
  const explain=useCallback((e:unknown)=>errors[e instanceof Error?e.message:'']?.[zh?0:1]??(zh?'操作失败，请稍后重试':'Request failed; please retry'),[zh]);
  const load=useCallback(async()=>{
    const current=++generation.current;
    try{
      const result=await api<{items:Account[];canManageAdministrators:boolean}>('/auth/users');
      if(current===generation.current){setUsers(result.items);setCanManageAdmins(result.canManageAdministrators);if(!result.canManageAdministrators)setRole(value=>value==='admin'?'analyst':value);setLoaded(true);}
    }catch(e){if(current===generation.current){setUsers([]);setCanManageAdmins(false);setLoaded(false);setError(explain(e));}}
  },[explain]);
  useEffect(()=>{const requests=generation;void load();return()=>{requests.current++;};},[load]);
  const create=async(e:React.FormEvent)=>{
    e.preventDefault();setBusy(true);setError('');setMessage('');
    try{
      await api('/auth/users',{method:'POST',body:JSON.stringify({name,password,role})});
      setPassword('');setName('');setMessage(zh?'账号已创建，可使用所设密码登录。':'Account created. The user can sign in with the assigned password.');await load();
    }catch(e){setError(explain(e));}finally{setBusy(false);}
  };
  const deleteAccount=async()=>{
    if(remove===null)return;setBusy(true);setError('');setMessage('');
    try{
      await api(`/auth/users/${encodeURIComponent(remove)}`,{method:'DELETE'});
      setRemove(null);setMessage(zh?'账号已删除，所有登录会话已失效。':'Account deleted. All its sign-in sessions have been revoked.');await load();
    }catch(e){setError(explain(e));}finally{setBusy(false);}
  };
  const roleLabel=(value:Account['role'])=>value==='admin'?(zh?'管理员':'Administrator'):value==='analyst'?(zh?'分析员 · 可编辑':'Analyst · can edit'):(zh?'只读用户':'Viewer · read-only');
  return <section className="ops-panel provider-settings user-management">
    <h1>{zh?'账号管理':'Account management'}</h1>
    <p>{zh?'超级管理员只有一个，由首次初始化账号担任，可创建、删除管理员及普通账号。管理员可管理普通账号。分析员可创建和修改项目；只读用户可浏览。':'There is one super administrator: the first setup account. It can create and delete administrators and standard accounts. Administrators manage standard accounts; analysts edit projects and viewers browse.'}</p>
    <section className="panel source-card">
      <h3>{zh?'创建账号':'Create account'}</h3>
      <form className="provider-key-form" onSubmit={e=>void create(e)}>
        <label>{zh?'用户名':'Username'}<input name="accountName" autoComplete="off" required minLength={3} maxLength={50} value={name} onChange={e=>setName(e.target.value)} disabled={busy}/></label>
        <label>{zh?'密码（至少8位）':'Password (minimum 8 characters)'}<input name="accountPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></label>
        <label>{zh?'权限':'Role'}<select value={role} onChange={e=>setRole(e.target.value as Account['role'])} disabled={busy}>{canManageAdmins&&<option value="admin">{roleLabel('admin')}</option>}<option value="analyst">{roleLabel('analyst')}</option><option value="viewer">{roleLabel('viewer')}</option></select></label>
        <div className="ops-controls"><button type="submit" disabled={busy||!loaded||name.trim().length<3||password.length<8}>{busy?(zh?'处理中…':'Please wait…'):(zh?'创建账号':'Create account')}</button></div>
      </form>
      {!canManageAdmins&&<p>{zh?'仅超级管理员可创建或删除管理员账号。':'Only the super administrator can create or delete administrator accounts.'}</p>}
    </section>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    <section className="panel source-card">
      <h3>{zh?'账号列表':'Accounts'}</h3>
      <div className="table-wrap"><table><thead><tr><th>{zh?'用户名':'Username'}</th><th>{zh?'权限':'Role'}</th><th>{zh?'操作':'Actions'}</th></tr></thead><tbody>
        {users.map(user=><tr key={user.name}><td>{user.name}</td><td>{user.isSuperAdmin?(zh?'超级管理员':'Super administrator'):roleLabel(user.role)}</td><td>{user.isSuperAdmin?<span>{zh?'唯一 · 受保护':'Unique · protected'}</span>:user.role==='admin'&&!canManageAdmins?<span>{zh?'仅超级管理员可删除':'Super administrator only'}</span>:<button type="button" disabled={busy} onClick={()=>setRemove(user.name)} aria-label={`${zh?'删除':'Delete'} ${user.name}`}>{zh?'删除':'Delete'}</button>}</td></tr>)}
        {!users.length&&<tr><td colSpan={3}>{loaded?(zh?'暂无账号':'No accounts'):(zh?'正在读取账号…':'Loading accounts…')}</td></tr>}
      </tbody></table></div>
      <div className="ops-controls"><button type="button" disabled={busy} onClick={()=>{setError('');void load();}}>{zh?'刷新列表':'Refresh accounts'}</button></div>
      {remove!==null&&<div className="account-delete-confirm" role="group" aria-label={zh?'确认删除账号':'Confirm account deletion'}><p>{zh?`删除「${remove}」？该账号将无法登录，现有会话立即失效。`:`Delete “${remove}”? The account will lose access and all its sessions will be revoked.`}</p><button type="button" disabled={busy} onClick={()=>void deleteAccount()}>{zh?'确认删除':'Confirm delete'}</button><button type="button" disabled={busy} onClick={()=>setRemove(null)}>{zh?'取消':'Cancel'}</button></div>}
    </section>
  </section>;
}
