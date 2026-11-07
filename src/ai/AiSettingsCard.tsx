import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, Sparkles, Trash2, XCircle } from 'lucide-react';
import type { AiStatus } from '../../shared/ai';
import { AiClientError, getAiStatus, streamAssistant } from './client';
import { AI_KEY_EVENT, clearCredential, maskKey, readCredential, saveCredential } from './keyStore';

/**
 * Settings-page credential card. Mirrors the assistant's own panel so an operator can
 * configure DeepSeek without opening a conversation first.
 */
export function AiSettingsCard({ language }: { language: 'en' | 'zh' }) {
  const zh = language === 'zh';
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState('');
  const [credential, setCredential] = useState(() => readCredential());
  const [draft, setDraft] = useState('');
  const [remember, setRemember] = useState(credential.persisted);
  const [test, setTest] = useState<'idle' | 'running' | 'ok' | 'fail'>('idle');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try { setStatus(await getAiStatus()); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'AI status unavailable'); }
  }, []);

  useEffect(() => { void load(); const refresh = () => setCredential(readCredential()); window.addEventListener(AI_KEY_EVENT, refresh); return () => window.removeEventListener(AI_KEY_EVENT, refresh); }, [load]);

  const save = () => {
    if (draft.trim().length < 16) return;
    saveCredential(draft.trim(), remember);
    setCredential(readCredential());
    setDraft('');
    setMessage(zh ? '已保存到本浏览器。' : 'Saved to this browser.');
  };

  const runTest = async () => {
    setTest('running'); setMessage('');
    const controller = new AbortController();
    let sawDelta = false;
    try {
      await streamAssistant({
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        model: 'deepseek-chat',
        apiKey: credential.key,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'delta' && !sawDelta) { sawDelta = true; controller.abort(); }
          if (event.type === 'error') throw new AiClientError(event.code, event.message);
        },
      });
      setTest(sawDelta ? 'ok' : 'fail');
      setMessage(sawDelta ? (zh ? '连接成功，密钥可用。' : 'Connected; the key works.') : (zh ? '未收到响应。' : 'No response received.'));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError' && sawDelta) { setTest('ok'); return; }
      setTest('fail');
      setMessage(cause instanceof Error ? cause.message : 'Test failed');
    }
  };

  const active = credential.key ? 'client' : status?.serverKey ? 'server' : 'none';

  return (
    <section className="ops-panel ai-settings-card">
      <h2>{zh ? 'DeepSeek · AI 分析' : 'DeepSeek · AI research'}</h2>
      <p>{zh
        ? 'AI 分析只读取服务端生成的确定性证据包，回答必须标注来源编号，不提供交易建议。你可以使用服务端密钥（需登录），或仅在本浏览器保存自己的密钥。'
        : 'The analyst only reads the deterministic evidence packet produced by the server, must cite source ids, and never gives trade advice. Use the server key (requires sign-in) or keep your own key in this browser.'}</p>
      <div className="ai-settings-state">
        <span>{zh ? '服务端密钥' : 'Server key'}: <b>{status?.serverKey ? (zh ? '已配置' : 'configured') : (zh ? '未配置' : 'not set')}</b></span>
        <span>{zh ? '本浏览器密钥' : 'Browser key'}: <b>{credential.key ? maskKey(credential.key) : (zh ? '无' : 'none')}</b></span>
        <span>{zh ? '端点' : 'Endpoint'}: <b>{status?.endpointHost ?? '—'}</b></span>
        <span>{zh ? '限流' : 'Rate limit'}: <b>{status ? `${status.policy.requestsPerMinute}/min` : '—'}</b></span>
      </div>
      <form className="provider-key-form" onSubmit={(event) => { event.preventDefault(); save(); }}>
        <label>{zh ? 'DeepSeek API Key' : 'DeepSeek API key'}
          <input type="password" autoComplete="off" spellCheck={false} value={draft} maxLength={512} onChange={(event) => setDraft(event.target.value)} placeholder={credential.key ? (zh ? '输入新密钥可替换' : 'Enter a new key to replace') : 'sk-…'} />
        </label>
        <div className="ops-controls">
          <button type="submit" disabled={draft.trim().length < 16}><KeyRound size={12} />{zh ? '保存' : 'Save'}</button>
          <button type="button" disabled={test === 'running' || active === 'none'} onClick={() => void runTest()}>
            {test === 'running' ? <Loader2 size={12} className="spin" /> : test === 'ok' ? <CheckCircle2 size={12} /> : test === 'fail' ? <XCircle size={12} /> : <Sparkles size={12} />}
            {zh ? '测试连接' : 'Test'}
          </button>
          {credential.key && <button type="button" onClick={() => { clearCredential(); setCredential(readCredential()); setMessage(zh ? '已删除本地密钥。' : 'Local key removed.'); }}><Trash2 size={12} />{zh ? '删除本地密钥' : 'Remove local key'}</button>}
        </div>
      </form>
      <label className="ai-settings-row" style={{ justifyContent: 'flex-start' }}>
        <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        {zh ? '在此设备记住（localStorage）；否则仅保留到标签页关闭' : 'Remember on this device (localStorage); otherwise kept until the tab closes'}
      </label>
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      <p>{zh
        ? '密钥通过本地 NOX 服务转发给 DeepSeek，不会写入服务端存储、日志或仓库。服务端密钥只对已登录用户开放，避免终端被当作免费代理。'
        : 'Keys are forwarded to DeepSeek through your local NOX server and are never written to server storage, logs or the repo. The server key is only spendable by signed-in users, so the terminal cannot be used as an open proxy.'}</p>
    </section>
  );
}
