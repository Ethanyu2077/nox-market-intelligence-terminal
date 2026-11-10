import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Database, Globe2, KeyRound, Layers3, Settings2, ShieldCheck, Sparkles } from 'lucide-react';
import type { ExchangeCapabilities } from '../shared/types';
import { api } from './api';
import { CapabilityPanel } from './CapabilityPanel';
import './settings-hub.css';
const ROOT='#/settings';
export function SettingsHub({language,panels,onManage,onOpenWeb3,hasProject}:{language:'zh'|'en';panels:Record<string,ReactNode>;onManage:()=>void;onOpenWeb3:()=>void;hasProject:boolean}){
  const zh=language==='zh',t=(cn:string,en:string)=>zh?cn:en;
  const read=()=>window.location.hash.startsWith(`${ROOT}/`)?window.location.hash.slice(ROOT.length+1):'';
  const [selected,setSelected]=useState(read),[exchanges,setExchanges]=useState<ExchangeCapabilities[]>([]),[error,setError]=useState('');
  useEffect(()=>{let active=true;api<{items:ExchangeCapabilities[]}>('/exchanges').then(value=>{if(active)setExchanges(value.items);}).catch(()=>{if(active)setError(zh?'无法读取交易所目录，请刷新重试。':'Cannot load exchange directory. Refresh to retry.');});return()=>{active=false;};},[zh]);
  useEffect(()=>{const change=()=>setSelected(read());window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  const venue=exchanges.find(item=>selected===`exchange-${item.exchange}`);
  const groups=[
    {name:t('聚合与分析','Aggregation & research'),items:[
      {id:'coinglass',name:'CoinGlass V4',tag:'API Key',description:t('跨所持仓、资金费率、清算与历史数据','Cross-venue OI, funding, liquidation and history'),icon:<KeyRound/>},
      {id:'deepseek',name:'DeepSeek',tag:t('AI 分析','AI research'),description:t('服务端与本浏览器密钥、模型连接测试','Server and browser credentials, connection test'),icon:<Sparkles/>},
      {id:'ccxt',name:'CCXT',tag:t('补充与回退','Coverage & fallback'),description:t('交易目录、启用场所与回退状态','Exchange catalogues, enabled venues and fallback status'),icon:<Layers3/>},
    ]},
    {name:t('链上数据','On-chain data'),items:[
      {id:'binance-web3',name:'Binance Web3',tag:t('服务端凭证','Server credentials'),description:t('独立开发者凭证、签名只读接入状态','Developer credentials and signed read-only connectivity'),icon:<ShieldCheck/>},
      {id:'dexpaprika',name:'DexPaprika',tag:t('公开接口','Public API'),description:t('按链与合约获取行情、流动性池和成交额','Contract-scoped prices, liquidity pools and turnover'),icon:<Globe2/>},
    ]},
    {name:t('交易所行情','Exchange market data'),items:exchanges.filter(v=>v.transport==='native').map(v=>({id:`exchange-${v.exchange}`,name:v.label,tag:t('公开接口','Public API'),description:t('市场映射、数据能力与连接覆盖','Market mapping, capabilities and endpoint coverage'),icon:<Database/>}))},
    {name:t('运行管理','Operations'),items:[
      {id:'collection',name:t('采集与存储','Collection & storage'),tag:t('项目设置','Project settings'),description:t('采集模式、任务状态与存储连接','Collection modes, jobs and storage connection'),icon:<Settings2/>},
      {id:'coverage',name:t('项目数据覆盖','Project coverage'),tag:t('诊断','Diagnostics'),description:t('已关注项目的采集完整性与时间覆盖','Collection completeness and history coverage'),icon:<Layers3/>},
      {id:'venues',name:t('市场覆盖','Market coverage'),tag:t('诊断','Diagnostics'),description:t('项目在各交易场所的市场覆盖情况','Coverage across selected trading venues'),icon:<Globe2/>},
      {id:'health',name:t('数据健康','Data health'),tag:t('诊断','Diagnostics'),description:t('数据新鲜度、异常与数据源交叉核验','Freshness, failures and provider crosschecks'),icon:<ShieldCheck/>},
      {id:'capabilities',name:t('全部数据能力','All capabilities'),tag:t('诊断','Diagnostics'),description:t('按场所与端点查看支持范围及熔断状态','Endpoint support and circuit breaker status'),icon:<Database/>},
      {id:'methodology',name:t('统计口径','Methodology'),tag:t('参考','Reference'),description:t('CVD、持仓量、成交额与新鲜度的定义','CVD, OI, volume and freshness definitions'),icon:<Layers3/>},
    ]},
  ];
  const item=groups.flatMap(g=>g.items).find(i=>i.id===selected);

  const publicSource=(isDex:boolean)=><section className="sh-public"><div className="sh-info"><ShieldCheck size={18}/><div><h2>{t('公开只读数据 · 无需 API Key','Public read-only data · No API key required')}</h2><p>{isDex?t('在项目设置中确认区块链网络与合约地址，即可按项目读取链上数据。','Confirm the chain and contract in project settings to load on-chain context.'):t('在项目设置中选择交易所和交易对。数据能力取决于所选场所，不需要交易账户密钥。','Choose the exchange and market in project settings. Coverage depends on the selected venue; trading account keys are not required.')}</p><button onClick={onManage}>{t('配置项目与市场','Configure projects & markets')}<ArrowRight size={14}/></button></div></div>{venue&&<><div className="sh-facts"><div><span>{t('接入方式','Transport')}</span><strong>{venue.transport.toUpperCase()}</strong></div><div><span>{t('服务端启用','Enabled on server')}</span><strong>{venue.enabled?t('已启用','Enabled'):t('未启用','Disabled')}</strong></div></div><CapabilityPanel language={language} venue={venue.exchange}/></>}{isDex&&<div className="sh-info"><div><h2>{t('数据范围','Data scope')}</h2><p>{t('代币价格、代币流动性、24h 成交额和返回池列表。DEX 流动性与 CEX 盘口深度分别展示。','Token price, liquidity, 24h turnover and returned pool list. DEX liquidity and CEX order-book depth remain distinct.')}</p></div></div>}</section>;
  let content=panels[selected];
  if(venue)content=publicSource(false);
  if(selected==='dexpaprika')content=publicSource(true);
  if(selected==='binance-web3')content=<>{panels[selected]}<section className="sh-info"><div><h2>{t('配置与使用','Configuration & usage')}</h2><p>{t('开发者 Key / Secret 在服务端环境中配置，与 Binance 交易所密钥不同。项目需要确认网络及合约地址。','Developer key/secret are configured on the server, separately from Binance exchange credentials. Confirm the project network and contract.')}</p><div className="sh-inline"><button onClick={onManage}>{t('配置项目与合约','Configure project & contract')}</button><button disabled={!hasProject} onClick={onOpenWeb3}>{t('打开 Web3 数据','Open Web3 data')}<ArrowRight size={14}/></button></div>{!hasProject&&<p>{t('先添加并选中一个项目后可打开数据页。','Add and select a project to open its data page.')}</p>}</div></section></>;
  if(selected==='methodology')content=<section className="sh-method"><h2>{t('统一统计口径','Calculation contract')}</h2><dl>{[['CVD',t('主动买卖方向 × 价格 × 数量，按有效覆盖累积','Aggressor-signed price × quantity, accumulated over valid coverage')],['OI USD',t('基础币持仓量 × 标记价格','Base-denominated OI × mark price')],[t('成交额','Volume'),t('各场所 24h 报价币名义金额；不同币种不直接相加','Venue 24h quote notional; different quote currencies are not summed')],[t('新鲜度','Freshness'),t('使用数据事件时间；缺失显示为不可用，不补零','Based on event time; missing observations remain unavailable, never zero')],[t('数据边界','Limitations'),t('成交聚合方式取决于场所；DEX 池流动性不等于 CEX 深度；AI 结论与原始观测分开展示','Aggregation is venue-specific; DEX liquidity is not CEX depth; AI inference stays separate from observations')]].map(([name,description])=><div key={name}><dt>{name}</dt><dd>{description}</dd></div>)}</dl></section>;
  return <div className="settings-hub">
    <header className="sh-head"><div>{selected&&<a className="sh-back" href={ROOT}><ArrowLeft size={14}/>{t('全部数据源','All data sources')}</a>}<h1>{selected?(item?.name??t('数据源不存在','Source not found')):t('设置与数据源','Settings & data sources')}</h1></div>{selected&&<span className="sh-kind">{item?.tag}</span>}</header>
    {error&&<p role="alert">{error}</p>}
    {selected?<div className="sh-detail" key={selected}>{content??(selected.startsWith('exchange-')&&!exchanges.length&&!error?<p role="status">{t('读取数据源…','Loading provider…')}</p>:<section className="sh-info"><p>{t('该入口不可用，请返回总览重新选择。','This source is unavailable. Return to the directory.')}</p><a href={ROOT}>{t('返回总览','Back to directory')}</a></section>)}</div>:groups.map(group=><section className="sh-group" key={group.name}><div className="sh-group-title"><h2>{group.name}</h2><span>{group.items.length}</span></div><div className="sh-grid">{group.items.map(source=><a className="sh-card" key={source.id} href={`${ROOT}/${source.id}`}><div className="sh-card-top"><span className="sh-icon">{source.icon}</span><span className="sh-kind">{source.tag}</span></div><h3>{source.name}</h3><p>{source.description}</p><span className="sh-card-link">{t('进入配置','Open settings')}<ArrowRight size={14}/></span></a>)}</div></section>)}
  </div>;
}
