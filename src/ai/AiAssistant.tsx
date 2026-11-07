import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowUpRight, Check, Copy, KeyRound, Loader2, Maximize2, MessageSquareText, RefreshCw, Settings2, Sparkles, Square, Trash2, X } from 'lucide-react';
import type { AiBrief, AiCitation, AiErrorCode, AiModelId, AiModelInfo, AiStatus, AiStreamEvent, AiUsage } from '../../shared/ai';
import type { MarketProject } from '../../shared/types';
import { AiClientError, getAiModels, getAiStatus, requestBrief, streamAssistant } from './client';
import { AI_KEY_EVENT, clearCredential, maskKey, readCredential, readModel, saveCredential, saveModel } from './keyStore';
import { Markdown } from './Markdown';
import './ai.css';

type Language = 'en' | 'zh';

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  citations?: AiCitation[];
  usage?: AiUsage;
  error?: { code: AiErrorCode; message: string };
  /** Question that produced this assistant turn, kept for one-click retry. */
  question?: string;
  streaming?: boolean;
}

interface Props {
  project: MarketProject | null;
  language: Language;
  variant: 'drawer' | 'panel';
  onClose?: () => void;
  onExpand?: () => void;
}

const COPY: Record<string, [string, string]> = {
  title: ['DeepSeek 分析', 'DeepSeek analyst'],
  subtitle: ['回答基于服务端证据包并标注来源', 'Grounded replies with source ids'],
  chat: ['对话', 'Chat'],
  brief: ['研判简报', 'Brief'],
  newThread: ['新对话', 'New thread'],
  placeholder: ['询问当前市场结构、资金流或数据缺口…（⌘↵ 发送）', 'Ask about structure, flow or data gaps… (⌘↵ to send)'],
  send: ['发送', 'Send'],
  stop: ['停止', 'Stop'],
  empty: ['选择一个问题，或直接提问。模型只能读取服务器提供的证据。', 'Pick a prompt or ask directly. The model only reads evidence supplied by the server.'],
  serverKey: ['服务端密钥', 'Server key'],
  yourKey: ['本地密钥', 'Your key'],
  noKey: ['未配置密钥', 'No key'],
  briefCta: ['生成结构化研判', 'Generate structured brief'],
  briefHint: ['观测事实 / 推断 / 假设 / 风险 / 缺失数据，且每条都带来源编号。', 'Observed / inferred / hypotheses / risks / missing data, each with source ids.'],
  export: ['导出 Markdown', 'Export markdown'],
  copied: ['已复制', 'Copied'],
  settings: ['AI 设置', 'AI settings'],
  save: ['保存', 'Save'],
  remove: ['删除本地密钥', 'Remove local key'],
  remember: ['在此设备记住（localStorage）', 'Remember on this device (localStorage)'],
  keyNote: ['密钥仅保存在本浏览器，并通过本地 NOX 服务转发给 DeepSeek；不会写入仓库、日志或服务器存储。', 'The key stays in this browser and is forwarded to DeepSeek through your local NOX server. It is never written to the repo, logs or server storage.'],
  reasoner: ['推理过程', 'Reasoning trace'],
  unverified: ['未验证引用', 'unverified citation'],
  noProject: ['先选择一个项目，AI 才能读取该项目的证据包。', 'Select a project first so the AI can read its evidence packet.'],
  grounded: ['证据源', 'sources'],
  tokens: ['tokens', 'tokens'],
  briefEmpty: ['尚未生成研判简报。', 'No brief generated yet.'],
  warnings: ['数据警示', 'Warnings'],
  serverKeyState: ['服务端密钥', 'Server key'],
  browserKeyState: ['本浏览器密钥', 'Browser key'],
  endpointState: ['端点', 'Endpoint'],
  signedInState: ['已登录', 'Signed in'],
  configured: ['已配置', 'configured'],
  notSet: ['未配置', 'not set'],
  none: ['无', 'none'],
  yes: ['是', 'yes'],
  no: ['否', 'no'],
};

const PROMPTS: Record<Language, string[]> = {
  en: [
    'Summarise what the evidence shows and what it cannot show.',
    'Where is the coverage weakest right now?',
    'Is the funding and OI setup consistent with the price move?',
    'Draft three falsifiable hypotheses with invalidation conditions.',
  ],
  zh: [
    '总结证据能说明什么，以及不能说明什么。',
    '当前数据覆盖最薄弱的地方在哪里？',
    '资金费率与 OI 结构与价格走势是否一致？',
    '给出三个可证伪的假设及其失效条件。',
  ],
};

const ERRORS: Record<string, [string, string]> = {
  'not-configured': ['服务端未配置 DeepSeek。请在设置中填入你自己的密钥。', 'No server key. Add your own key in AI settings.'],
  'sign-in-required': ['服务端密钥需要登录后使用；也可以直接填入本地密钥。', 'Server key requires sign-in, or add a local key.'],
  'auth-failed': ['DeepSeek 拒绝了该密钥，请核对后重试。', 'DeepSeek rejected the key. Check it and retry.'],
  'insufficient-balance': ['DeepSeek 账户余额不足。', 'DeepSeek account balance is insufficient.'],
  'rate-limited': ['请求过于频繁，请稍后再试。', 'Rate limited. Retry shortly.'],
  'context-too-large': ['对话过长，请开启新对话。', 'Thread too long. Start a new one.'],
  'network-error': ['无法连接 DeepSeek，请检查网络或代理。', 'Cannot reach DeepSeek. Check network or proxy.'],
  'upstream-error': ['DeepSeek 服务异常，请稍后重试。', 'DeepSeek service error. Retry shortly.'],
  'bad-response': ['返回数据格式异常。', 'The upstream response was malformed.'],
  aborted: ['已停止。', 'Stopped.'],
};
const errorText = (code: AiErrorCode, language: Language) => (ERRORS[code] ?? ['请求失败。', 'Request failed.'])[language === 'zh' ? 0 : 1];

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function AiAssistant({ project, language, variant, onClose, onExpand }: Props) {
  const zh = language === 'zh';
  const c = (key: string) => COPY[key][zh ? 0 : 1];
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [credential, setCredential] = useState(() => readCredential());
  const [model, setModel] = useState<AiModelId>(() => readModel());
  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [tab, setTab] = useState<'chat' | 'brief'>('chat');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [brief, setBrief] = useState<AiBrief | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefError, setBriefError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [draftKey, setDraftKey] = useState('');
  const [remember, setRemember] = useState(credential.persisted);
  const [copied, setCopied] = useState('');
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);

  const usingOwnKey = Boolean(credential.key);
  const canUseServer = Boolean(status?.serverKey) && signedIn === true;

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await getAiStatus());
      setStatusError('');
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'AI status unavailable');
    }
    try {
      const auth = await fetch('/api/auth/status').then((response) => response.json());
      setSignedIn(Boolean(auth?.user));
    } catch { setSignedIn(false); }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);
  useEffect(() => {
    const refresh = () => setCredential(readCredential());
    window.addEventListener(AI_KEY_EVENT, refresh);
    window.addEventListener('nox:auth-changed', refresh);
    return () => { window.removeEventListener(AI_KEY_EVENT, refresh); window.removeEventListener('nox:auth-changed', refresh); };
  }, []);
  useEffect(() => { if (credential.key) setRemember(credential.persisted); }, [credential]);
  // Discover what this key can actually use; DeepSeek renames models between releases.
  useEffect(() => {
    let active = true;
    void getAiModels(credential.key)
      .then((result) => {
        if (!active) return;
        setModels(result.models);
        if (result.models.length && !result.models.some((item) => item.id === model)) {
          setModel(result.models[0].id);
          saveModel(result.models[0].id);
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [credential.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the newest message in view without fighting a user who scrolled up.
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (distance < 220) node.scrollTo({ top: node.scrollHeight });
  }, [turns, brief]);

  const resetThread = () => {
    abort.current?.abort();
    setTurns([]); setStreaming(false); setBrief(null); setBriefError('');
    requestAnimationFrame(() => composer.current?.focus());
  };

  const send = async (question: string) => {
    const text = question.trim();
    if (!text || streaming) return;
    if (!project) return;
    if (!usingOwnKey && !canUseServer) { setShowSettings(true); return; }

    const userTurn: Turn = { id: uid(), role: 'user', content: text };
    const assistantId = uid();
    const history = turns.filter((turn) => !turn.error && turn.content.trim()).slice(-12).map((turn) => ({ role: turn.role, content: turn.content }));
    setTurns((current) => [...current, userTurn, { id: assistantId, role: 'assistant', content: '', streaming: true, question: text }]);
    setInput(''); setStreaming(true);

    const controller = new AbortController();
    abort.current = controller;
    const patch = (update: (turn: Turn) => Turn) => setTurns((current) => current.map((turn) => (turn.id === assistantId ? update(turn) : turn)));

    try {
      await streamAssistant({
        messages: [...history, { role: 'user', content: text }],
        projectId: project.id,
        model,
        apiKey: usingOwnKey ? credential.key : null,
        signal: controller.signal,
        onEvent: (event: AiStreamEvent) => {
          if (event.type === 'meta') patch((turn) => ({ ...turn, citations: event.citations }));
          else if (event.type === 'delta') patch((turn) => ({ ...turn, content: turn.content + event.text }));
          else if (event.type === 'reasoning') patch((turn) => ({ ...turn, reasoning: (turn.reasoning ?? '') + event.text }));
          else if (event.type === 'usage') patch((turn) => ({ ...turn, usage: event.usage }));
          else if (event.type === 'error') patch((turn) => ({ ...turn, error: { code: event.code, message: event.message } }));
          else if (event.type === 'done') patch((turn) => ({ ...turn, streaming: false }));
        },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') patch((turn) => ({ ...turn, streaming: false, content: turn.content || (zh ? '_已停止。_' : '_Stopped._') }));
      else {
        const code = error instanceof AiClientError ? error.code : 'upstream-error';
        patch((turn) => ({ ...turn, streaming: false, error: { code, message: error instanceof Error ? error.message : 'Request failed' } }));
      }
    } finally {
      patch((turn) => ({ ...turn, streaming: false }));
      setStreaming(false);
      abort.current = null;
    }
  };

  const stop = () => { abort.current?.abort(); };

  const generateBrief = async () => {
    if (!project || briefBusy) return;
    if (!usingOwnKey && !canUseServer) { setShowSettings(true); return; }
    setBriefBusy(true); setBriefError(''); setTab('brief');
    try {
      setBrief(await requestBrief(project.id, usingOwnKey ? credential.key : null));
    } catch (error) {
      const code = error instanceof AiClientError ? error.code : 'upstream-error';
      setBriefError(errorText(code, language));
    } finally { setBriefBusy(false); }
  };

  const exportMarkdown = async () => {
    const lines = [`# ${project?.name ?? 'NOX'} · DeepSeek research`, ''];
    if (brief) {
      lines.push('## Brief', '', brief.summary, '');
      for (const [title, items] of [['Observed', brief.observed], ['Inferences', brief.inferences], ['Risks', brief.risks]] as const) {
        if (!items.length) continue;
        lines.push(`### ${title}`, ...items.map((item) => `- ${item.text} [${item.sources.join(', ')}]`), '');
      }
      if (brief.hypotheses.length) lines.push('### Hypotheses', ...brief.hypotheses.map((item) => `- ${item.text} [${item.sources.join(', ')}] — invalidation: ${item.invalidation}`), '');
      if (brief.missingData.length) lines.push('### Missing data', ...brief.missingData.map((item) => `- ${item}`), '');
      lines.push(`_Generated ${new Date(brief.generatedAt).toISOString()} · ${brief.model} · unverified AI output_`, '');
    }
    for (const turn of turns) {
      if (!turn.content) continue;
      lines.push(`## ${turn.role === 'user' ? 'Q' : 'A'}`, '', turn.content, '');
    }
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied('export');
      setTimeout(() => setCopied(''), 1600);
    } catch { setBriefError(zh ? '浏览器拒绝了剪贴板写入。' : 'Clipboard write was blocked.'); }
  };

  const saveKey = () => {
    const value = draftKey.trim();
    if (value.length < 16) return;
    saveCredential(value, remember);
    setDraftKey('');
    setShowSettings(false);
    setCredential(readCredential());
  };

  const keyLabel = usingOwnKey ? c('yourKey') : status?.serverKey ? c('serverKey') : c('noKey');
  const keyTone = usingOwnKey ? 'client' : status?.serverKey ? 'server' : 'none';
  const suggestions = useMemo(() => PROMPTS[zh ? 'zh' : 'en'], [zh]);

  return (
    <section className={`ai-assistant ${variant}`} aria-label={c('title')}>
      <header className="ai-head">
        <div className="ai-identity">
          <span className="ai-mark"><Sparkles size={14} /></span>
          <div>
            <strong>{c('title')}</strong>
            <small>{c('subtitle')}</small>
          </div>
        </div>
        <div className="ai-head-actions">
          <span className={`ai-key-badge ${keyTone}`} title={usingOwnKey ? 'Key stored locally' : 'Server credential'}>{keyLabel}</span>
          <select aria-label="Model" value={model} onChange={(event) => { const next = event.target.value as AiModelId; setModel(next); saveModel(next); }}>
            {(models.length ? models : status?.models ?? [{ id: 'deepseek-flash', label: 'DeepSeek Flash', reasoning: true, note: '' }]).map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
          <button className={showSettings ? 'active' : ''} onClick={() => setShowSettings((value) => !value)} aria-label={c('settings')} title={c('settings')}><Settings2 size={14} /></button>
          {variant === 'drawer' && onExpand && <button onClick={onExpand} aria-label="Open research workspace" title="Open research workspace"><Maximize2 size={14} /></button>}
          {onClose && <button onClick={onClose} aria-label="Close" title="Close"><X size={15} /></button>}
        </div>
      </header>

      {showSettings && (
        <div className="ai-settings" role="group" aria-label={c('settings')}>
          <div className="ai-settings-state">
            <span>{c('serverKeyState')}: <b>{status?.serverKey ? c('configured') : c('notSet')}</b></span>
            <span>{c('browserKeyState')}: <b>{usingOwnKey ? maskKey(credential.key ?? '') : c('none')}</b></span>
            <span>{c('endpointState')}: <b>{status?.endpointHost ?? '—'}</b></span>
            <span>{c('signedInState')}: <b>{signedIn === null ? '…' : signedIn ? c('yes') : c('no')}</b></span>
          </div>
          <label className="ai-key-field">
            <KeyRound size={13} />
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={usingOwnKey ? (zh ? '输入新密钥可替换' : 'Enter a new key to replace') : (zh ? 'DeepSeek API Key（sk-…）' : 'DeepSeek API key (sk-…)')}
              value={draftKey}
              onChange={(event) => setDraftKey(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') saveKey(); }}
            />
            <button disabled={draftKey.trim().length < 16} onClick={saveKey}>{c('save')}</button>
          </label>
          <div className="ai-settings-row">
            <label><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />{c('remember')}</label>
            {usingOwnKey && <button className="danger" onClick={() => { clearCredential(); setCredential(readCredential()); }}><Trash2 size={12} />{c('remove')}</button>}
          </div>
          <p className="ai-note">{c('keyNote')}</p>
          {statusError && <p className="ai-error-text">{statusError}</p>}
        </div>
      )}

      <div className="ai-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}><MessageSquareText size={13} />{c('chat')}{turns.length > 0 && <em>{turns.filter((turn) => turn.role === 'user').length}</em>}</button>
        <button role="tab" aria-selected={tab === 'brief'} className={tab === 'brief' ? 'active' : ''} onClick={() => setTab('brief')}><Sparkles size={13} />{c('brief')}{brief && <i className="dot" />}</button>
        <div className="ai-tabs-actions">
          <button onClick={() => void exportMarkdown()} disabled={!turns.length && !brief} title={c('export')}>{copied === 'export' ? <Check size={12} /> : <Copy size={12} />}</button>
          <button onClick={resetThread} disabled={!turns.length && !brief} title={c('newThread')}><RefreshCw size={12} /></button>
        </div>
      </div>

      {!project ? (
        <div className="ai-empty"><AlertTriangle size={18} /><p>{c('noProject')}</p></div>
      ) : tab === 'chat' ? (
        <>
          <div className="ai-thread" ref={scroller}>
            {!turns.length && (
              <div className="ai-empty">
                <p>{c('empty')}</p>
                <div className="ai-prompts">
                  {suggestions.map((prompt) => (
                    <button key={prompt} onClick={() => void send(prompt)} disabled={streaming}><ArrowUpRight size={12} />{prompt}</button>
                  ))}
                </div>
                <button className="ai-brief-cta" onClick={() => void generateBrief()}><Sparkles size={13} />{c('briefCta')}</button>
              </div>
            )}
            {turns.map((turn) => (
              <article key={turn.id} className={`ai-turn ${turn.role}`}>
                <header>
                  <span>{turn.role === 'user' ? (zh ? '你' : 'You') : 'DeepSeek'}</span>
                  {turn.citations?.length ? <em>{turn.citations.length} {c('grounded')}</em> : null}
                  {turn.usage ? <em>{turn.usage.totalTokens} {c('tokens')}</em> : null}
                </header>
                {turn.reasoning && (
                  <details className="ai-reasoning">
                    <summary>{c('reasoner')} · {turn.reasoning.length} chars</summary>
                    <pre>{turn.reasoning}</pre>
                  </details>
                )}
                {turn.content ? <Markdown text={turn.content} citations={turn.citations} /> : turn.streaming ? <div className="ai-thinking"><Loader2 size={13} className="spin" />{zh ? '检索证据包…' : 'Reading evidence packet…'}</div> : null}
                {turn.error && (
                  <div className="ai-error">
                    <AlertTriangle size={13} />
                    <div><strong>{errorText(turn.error.code, language)}</strong><small>{turn.error.message}</small></div>
                    {turn.question && <button onClick={() => void send(turn.question ?? '')} disabled={streaming}>{zh ? '重试' : 'Retry'}</button>}
                  </div>
                )}
                {turn.role === 'assistant' && !turn.streaming && turn.content && (
                  <div className="ai-turn-actions">
                    <button onClick={() => void navigator.clipboard.writeText(turn.content)} title="Copy"><Copy size={11} /></button>
                    <button onClick={() => void send(turn.question ?? '')} disabled={streaming} title={zh ? '重新生成' : 'Regenerate'}><RefreshCw size={11} /></button>
                  </div>
                )}
              </article>
            ))}
          </div>
          <div className="ai-composer">
            <textarea
              ref={composer}
              value={input}
              rows={2}
              maxLength={4000}
              placeholder={c('placeholder')}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void send(input); }
              }}
              disabled={streaming}
            />
            <div className="ai-composer-foot">
              <span>
                {input.length}/4000 · {model === 'deepseek-reasoner' ? 'reasoner' : 'chat'} ·{' '}
                {usingOwnKey ? (zh ? '本地密钥' : 'your key') : canUseServer ? (zh ? '服务端密钥' : 'server key') : status?.serverKey ? (zh ? '需登录或填入密钥' : 'sign in or add a key') : (zh ? '需要密钥' : 'key required')}
              </span>
              {streaming
                ? <button className="stop" onClick={stop}><Square size={11} />{c('stop')}</button>
                : <button className="send" disabled={!input.trim()} onClick={() => void send(input)}>{c('send')}<ArrowUpRight size={12} /></button>}
            </div>
          </div>
        </>
      ) : (
        <div className="ai-brief">
          <div className="ai-brief-head">
            <div>
              <strong>{c('briefCta')}</strong>
              <small>{c('briefHint')}</small>
            </div>
            <button disabled={briefBusy} onClick={() => void generateBrief()}>{briefBusy ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />}{briefBusy ? (zh ? '生成中…' : 'Generating…') : (zh ? '生成' : 'Generate')}</button>
          </div>
          {briefError && <div className="ai-error"><AlertTriangle size={13} /><div><strong>{briefError}</strong></div></div>}
          {!brief && !briefBusy && <p className="ai-empty-text">{c('briefEmpty')}</p>}
          {brief && (
            <div className="ai-brief-body">
              <p className="ai-brief-summary">{brief.summary || '—'}</p>
              {([
                ['Observed', zh ? '观测事实' : 'Observed', brief.observed],
                ['Inferences', zh ? '统计推断' : 'Inferences', brief.inferences],
                ['Risks', zh ? '风险与替代解释' : 'Risks', brief.risks],
              ] as const).map(([key, title, items]) => (
                <section key={key} className={`ai-brief-section ${key.toLowerCase()}`}>
                  <h4>{title}</h4>
                  {items.length ? items.map((item, index) => (
                    <p key={index}>{item.text} {item.sources.map((id) => <CitationChip key={id} id={id} citations={brief.citations} />)}</p>
                  )) : <p className="ai-muted">—</p>}
                </section>
              ))}
              {brief.hypotheses.length > 0 && (
                <section className="ai-brief-section hypotheses">
                  <h4>{zh ? '待验证假设' : 'Hypotheses'}</h4>
                  {brief.hypotheses.map((item, index) => (
                    <div key={index} className="ai-hypothesis">
                      <p>{item.text} {item.sources.map((id) => <CitationChip key={id} id={id} citations={brief.citations} />)}</p>
                      {item.invalidation && <small>{zh ? '失效条件' : 'Invalidation'}: {item.invalidation}</small>}
                    </div>
                  ))}
                </section>
              )}
              {brief.missingData.length > 0 && (
                <section className="ai-brief-section missing">
                  <h4>{zh ? '缺失或延迟数据' : 'Missing or stale data'}</h4>
                  <ul>{brief.missingData.map((item) => <li key={item}>{item}</li>)}</ul>
                </section>
              )}
              {brief.warnings.length > 0 && (
                <section className="ai-brief-section warnings">
                  <h4>{c('warnings')}</h4>
                  <ul>{brief.warnings.map((item) => <li key={item}>{item}</li>)}</ul>
                </section>
              )}
              <footer className="ai-brief-foot">
                <span>{new Date(brief.generatedAt).toLocaleString()} · {brief.model} · {brief.keySource === 'client' ? c('yourKey') : c('serverKey')}</span>
                {brief.usage && <span>{brief.usage.totalTokens} {c('tokens')}{brief.usage.cachedTokens ? ` · ${brief.usage.cachedTokens} cached` : ''}</span>}
              </footer>
              <p className="ai-disclaimer">{zh ? 'AI 输出未经事实核验；数值以上方证据包为准。不构成投资建议。' : 'AI output is not fact-checked; trust the evidence packet numbers. Not investment advice.'}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function CitationChip({ id, citations }: { id: string; citations: AiCitation[] }) {
  const citation = citations.find((item) => item.id === id);
  return (
    <span className={`ai-cite${citation ? '' : ' unknown'}`} title={citation ? `${citation.exchange} · ${citation.symbol} · ${new Date(citation.eventTime).toLocaleString()} · ${citation.quality}` : 'Unverified source id'}>
      {id}
    </span>
  );
}
