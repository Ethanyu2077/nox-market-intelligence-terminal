import { useEffect, useState } from "react";
import type { MarketProject } from "../shared/types";
import type {
  Web3Candle,
  Web3Interval,
  Web3ProjectResponse,
  Web3Section,
} from "../shared/binance-web3";
const messages: Record<string, [string, string]> = {
  "not-configured": [
    "未配置 Binance Web3 开发者凭证",
    "Binance Web3 developer credentials are not configured",
  ],
  "identity-required": [
    "需要先确认项目的合约地址与链",
    "Confirm the project contract address and chain first",
  ],
  "unsupported-chain": [
    "行情接口当前不支持该链",
    "The market API does not currently support this chain",
  ],
  "defi-chain-unsupported": [
    "DeFi 投资品接口不支持该链（与行情支持范围不同）",
    "DeFi product discovery does not support this chain (market coverage differs)",
  ],
  "authentication-failed": [
    "鉴权失败：请检查服务端 Web3 凭证、权限和系统时钟",
    "Authentication failed: check server Web3 credentials, permissions and clock",
  ],
  "permission-or-region-restricted": [
    "权限或地区限制；不会尝试绕过",
    "Permission or region restriction; no bypass attempted",
  ],
  "rate-limited": [
    "已限频，服务端正在按 Retry-After 冷却",
    "Rate limited; server is respecting the retry cooldown",
  ],
  "network-unavailable": ["上游网络暂不可用", "Upstream network unavailable"],
};
const fmt = (v: number | null | undefined) =>
  v == null
    ? "—"
    : new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 }).format(v);
export function Web3ConnectionStatus({language}:{language:string}){
  const zh=language==='zh',[state,setState]=useState<{configured:boolean;scope?:string}|null>(null);
  useEffect(()=>{let active=true;void fetch('/api/web3/capabilities').then(async r=>{if(!r.ok)throw new Error();return r.json();}).then(value=>{if(active)setState({configured:value.configured===true,scope:value.scope});}).catch(()=>{if(active)setState({configured:false});});return()=>{active=false;};},[]);
  const configured=state?.configured;
  return <section className="ops-panel web3-settings">
    <div className="web3-settings-head"><div><span>DATA SOURCE</span><h2>{zh?'Binance Spot Alpha':'Binance Spot Alpha'}</h2></div><span className={`web3-badge ${configured?'ok':'off'}`}>{configured==null?(zh?'检测中':'Checking'):configured?(zh?'已配置':'Configured'):(zh?'未配置':'Not configured')}</span></div>
    <dl className="web3-facts">
      <div><dt>{zh?'数据范围':'Scope'}</dt><dd>{zh?'仅 Spot Alpha 现货行情':'Spot Alpha spot market data only'}</dd></div>
      <div><dt>{zh?'接入方式':'Access'}</dt><dd>{zh?'服务端只读':'Server-side read-only'}</dd></div>
      <div><dt>{zh?'不包含':'Excluded'}</dt><dd>{zh?'DeFi 池子、Earn、链上聚合':'DeFi pools, Earn, on-chain aggregation'}</dd></div>
      <div><dt>{zh?'密钥位置':'Credential'}</dt><dd><code>BINANCE_WEB3_API_KEY</code></dd></div>
    </dl>
    <p className="web3-note">{configured==null?(zh?'正在读取服务端状态…':'Reading server status…'):configured?(zh?'密钥已在服务端配置；是否可用仍以实际请求结果为准。':'Key is configured server-side; live availability still depends on real requests.'):(zh?'在服务端环境配置 BINANCE_WEB3_API_KEY 后重启生效。此页面不接收密钥。':'Set BINANCE_WEB3_API_KEY in the server environment and restart. This page never accepts the key.')}</p>
    <p className="web3-note">{zh?'Spot Alpha 使用交易对/代币符号，不需要项目合约或链配置。':'Spot Alpha is symbol-based; no project contract or chain configuration is required.'}</p>
  </section>;
}
function PriceCandles({ points, zh }: { points: Web3Candle[]; zh: boolean }) {
  const [index, setIndex] = useState<number | null>(null);
  const selected =
    index == null ? null : points[Math.min(index, points.length - 1)];
  if (!points.length) return null;
  const width = 1000,
    height = 230,
    min = Math.min(...points.map((p) => p.low)),
    max = Math.max(...points.map((p) => p.high));
  const x = (i: number) => 24 + (i * 952) / Math.max(1, points.length - 1),
    y = (v: number) =>
      15 + ((max - v) / Math.max(max - min, max * 1e-9, 1e-15)) * 180;
  return (
    <div>
      <div
        className="chart"
        onMouseLeave={() => setIndex(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setIndex(
            Math.max(
              0,
              Math.min(
                points.length - 1,
                Math.round(
                  ((((e.clientX - r.left) / r.width) * width - 24) / 952) *
                    (points.length - 1),
                ),
              ),
            ),
          );
        }}
      >
        <svg
          role="img"
          aria-label={
            zh
              ? "合约地址对应的链上价格K线"
              : "Contract-scoped on-chain price candles"
          }
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
        >
          <g className="grid-lines">
            {[0.25, 0.5, 0.75].map((v) => (
              <line key={v} x1="0" x2={width} y1={height * v} y2={height * v} />
            ))}
          </g>
          {points.map((p, i) => (
            <g
              key={p.time}
              className={p.close >= p.open ? "candle-up" : "candle-down"}
            >
              <line x1={x(i)} x2={x(i)} y1={y(p.high)} y2={y(p.low)} />
              <rect
                x={x(i) - Math.max(1, Math.min(4, 450 / points.length))}
                y={Math.min(y(p.open), y(p.close))}
                width={Math.max(2, Math.min(8, 900 / points.length))}
                height={Math.max(1, Math.abs(y(p.open) - y(p.close)))}
              />
            </g>
          ))}
          {index != null && (
            <line
              className="crosshair"
              x1={x(Math.min(index,points.length-1))}
              x2={x(Math.min(index,points.length-1))}
              y1="0"
              y2={height}
            />
          )}
        </svg>
      </div>
      <label>
        {zh
          ? "逐根查看（可用方向键）"
          : "Inspect candle (arrow keys supported)"}{" "}
        <input
          aria-label={zh ? "查看链上K线" : "Inspect on-chain candle"}
          type="range"
          min="0"
          max={points.length - 1}
          value={index ?? points.length - 1}
          onChange={(e) => setIndex(Number(e.target.value))}
        />
      </label>
      <p>
        {selected ? (
          <>
            {new Date(selected.time).toLocaleString()} · O {fmt(selected.open)}{" "}
            / H {fmt(selected.high)} / L {fmt(selected.low)} / C{" "}
            {fmt(selected.close)} ·{" "}
            {zh ? "原始成交量（单位未核实）" : "Raw volume (unit unverified)"}{" "}
            {fmt(selected.volume)}
          </>
        ) : (
          <>
            {new Date(points[0].time).toLocaleString()} →{" "}
            {new Date(points.at(-1)!.time).toLocaleString()} · {points.length}{" "}
            {zh ? "根K线；最新一根可能未收盘" : "candles; latest may be open"}
          </>
        )}
      </p>
    </div>
  );
}
export function BinanceWeb3Panel({
  project,
  language,
  interval,
}: {
  project: MarketProject;
  language: string;
  interval: Web3Interval;
}) {
  const zh = language === "zh",
    [data, setData] = useState<Web3ProjectResponse | null>(null),
    [page, setPage] = useState(1),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    setPage(1);
  }, [project.id]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setData(null);
    setError("");
    const load = async () => {
      setLoading(true);
      try {
        const r = await fetch(
          `/api/projects/${project.id}/web3?interval=${interval}&page=${page}`,
          { signal: controller.signal },
        );
        if (!r.ok) throw new Error();
        const value = await r.json();
        if (active) {
          setData(value);
          setError("");
        }
      } catch {
        if (active)
          setError(
            zh
              ? "无法读取 Binance Web3 接入状态"
              : "Unable to read Binance Web3 status",
          );
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [
    project.id,
    project.contractAddress,
    project.identityNetwork,
    interval,
    page,
    refresh,
    zh,
  ]);
  const message = (reason: string | null) =>
    reason
      ? (messages[reason]?.[zh ? 0 : 1] ??
        (zh ? "上游数据暂不可用" : "Upstream data unavailable"))
      : "";
  const status = (section: Web3Section<unknown>) => (
    <p>
      {section.reason
        ? message(section.reason)
        : section.state === "empty"
          ? zh
            ? "该接口没有返回匹配记录，不代表全市场为零"
            : "No matching records returned; not a global zero"
          : zh
            ? "接口已返回数据"
            : "Observed response available"}{" "}
      · {zh ? "源时间" : "Source time"}:{" "}
      {section.sourceTime ? new Date(section.sourceTime).toLocaleString() : "—"}{" "}
      · {zh ? "时效" : "Freshness"}:{" "}
      {zh
        ? ({ fresh: "新鲜", stale: "延迟", unknown: "未知" } as const)[
            section.freshness
          ]
        : section.freshness}
    </p>
  );
  return (
    <section className="ops-panel web3-research" id="binance-web3-panel">
      <h2>
        Binance Web3 · {zh ? "链上行情与 DeFi" : "On-chain markets & DeFi"}
      </h2>
      <p>
        {zh
          ? "按已确认的链 + 合约地址查询；与下方 DexPaprika、CEX 合约价格和 OI 分开，不混合汇总。"
          : "Queries the confirmed chain + contract. Separate from DexPaprika below and CEX futures prices/OI; no mixed aggregation."}
      </p>
      <div className="ops-controls">
        <span>
          {project.identityNetwork ?? "—"} ·{" "}
          {project.contractAddress ??
            (zh ? "合约未确认" : "Contract unconfirmed")}{" "}
          · {interval.toUpperCase()}
        </span>
        <button disabled={loading} onClick={() => setRefresh((v) => v + 1)}>
          {loading
            ? zh
              ? "读取中…"
              : "Loading…"
            : zh
              ? "刷新 Web3"
              : "Refresh Web3"}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!data && loading && (
        <p role="status">
          {zh ? "正在检查接入状态…" : "Checking connection status…"}
        </p>
      )}
      {data && !data.configured && (
        <>
          <p role="status">{message("not-configured")}</p>
          <p>
            {zh
              ? "在服务端配置 BINANCE_WEB3_API_KEY 和 BINANCE_WEB3_SECRET_KEY 后重启。需要 Binance Web3 开发者平台凭证，不是合约交易 API Key。不要把密钥贴入聊天或前端。"
              : "Set BINANCE_WEB3_API_KEY and BINANCE_WEB3_SECRET_KEY on the server and restart. Use Binance Web3 developer credentials, not exchange trading keys. Do not paste secrets into chat or frontend code."}
          </p>
          <p>
            {zh
              ? "已实现只读查询：价格 / 多窗口成交、K线、主要流动性池、Earn / LP 产品。未完成真实凭证联调，不显示模拟数据。"
              : "Read-only queries implemented: price/windowed volume, candles, top liquidity pools, Earn/LP products. Live credential acceptance is pending; no mock values are displayed."}
          </p>
        </>
      )}
      {data?.configured && (
        <>
          <h3>{zh ? "链上价格与成交" : "On-chain price & activity"}</h3>
          {status(data.market)}
          {data.market.data && (
            <>
              <p>
                {zh
                  ? "代币价格 / 市值 / 池流动性 / 持有人数"
                  : "Token price / market cap / pool liquidity / holders"}
                : ${fmt(data.market.data.priceUsd)} / $
                {fmt(data.market.data.marketCapUsd)} / $
                {fmt(data.market.data.liquidityUsd)} /{" "}
                {fmt(data.market.data.holders)}
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {[
                        zh ? "窗口" : "Window",
                        zh ? "价格变化" : "Price change",
                        zh ? "成交额 USD" : "Volume USD",
                        zh ? "买入 USD" : "Buy USD",
                        zh ? "卖出 USD" : "Sell USD",
                        zh ? "净额 USD（非CVD）" : "Net USD (not CVD)",
                      ].map((s) => (
                        <th key={s}>{s}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.market.data.windows.map((w) => (
                      <tr key={w.window}>
                        <td>{w.window}</td>
                        <td>
                          {w.changePct == null ? "—" : `${fmt(w.changePct)}%`}
                        </td>
                        <td>{fmt(w.volumeUsd)}</td>
                        <td>{fmt(w.buyUsd)}</td>
                        <td>{fmt(w.sellUsd)}</td>
                        <td>{fmt(w.deltaUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <h3>
            {zh
              ? "链上K线 · 跟随全局周期"
              : "On-chain candles · global timeframe"}
          </h3>
          {status(data.candles)}
          {data.candles.data && (
            <PriceCandles points={data.candles.data} zh={zh} />
          )}
          <h3>
            {zh
              ? "主要 DEX 流动性池（返回子集）"
              : "Top DEX liquidity pools (returned subset)"}
          </h3>
          {status(data.pools)}
          {data.pools.data?.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{zh ? "池 / 协议" : "Pool / protocol"}</th>
                    <th>{zh ? "流动性 USD" : "Liquidity USD"}</th>
                    <th>{zh ? "合约" : "Contract"}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pools.data.map((p) => (
                    <tr key={p.address}>
                      <td>
                        {p.name} / {p.protocol ?? "—"}
                      </td>
                      <td>{p.liquidityUsd ?? "—"}</td>
                      <td>{p.address}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          <h3>{zh ? "项目相关 DeFi 产品" : "Project-related DeFi products"}</h3>
          <p>
            {zh
              ? "按链 + 代币地址过滤；APY / APR 直接使用上游展示值，不保证收益，不合并 TVL 与池流动性。"
              : "Filtered by chain + token. APY/APR display values come directly from the provider, are not guaranteed returns, and TVL is not added to pool liquidity."}
          </p>
          {(
            [
              ["Earn", data.earn],
              ["LiquidityPool", data.liquidity],
            ] as const
          ).map(([name, section]) => (
            <div key={name}>
              <h4>
                {name === "Earn"
                  ? zh
                    ? "收益产品"
                    : "Earn"
                  : zh
                    ? "流动性产品"
                    : "Liquidity products"}
              </h4>
              {status(section)}
              {section.data?.items.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {[
                          zh ? "产品 / 协议" : "Product / protocol",
                          "APY / APR",
                          "TVL · USD",
                        ].map((s) => (
                          <th key={s}>{s}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {section.data.items.map((p) => (
                        <tr key={p.id}>
                          <td>
                            {p.name ?? p.id} / {p.protocolName ?? p.protocolId}
                          </td>
                          <td>
                            {p.apyType ?? "—"} {p.apyDisplay ?? "—"}
                          </td>
                          <td>{p.tvlUsd ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ))}
          <div className="ops-controls">
            <button
              disabled={page === 1 || loading}
              onClick={() => setPage((v) => v - 1)}
            >
              {zh ? "上一页" : "Previous"}
            </button>
            <span>
              {zh ? "产品页" : "Product page"} {page} · 20{" "}
              {zh ? "条 / 类别" : "per type"}
            </span>
            <button
              disabled={
                loading ||
                page >= 1000 ||
                ![data.earn, data.liquidity].some(
                  (s) =>
                    s.data != null &&
                    (s.data.total != null
                      ? page * 20 < s.data.total
                      : s.data.items.length === 20),
                )
              }
              onClick={() => setPage((v) => v + 1)}
            >
              {zh ? "下一页" : "Next"}
            </button>
          </div>
        </>
      )}
      <details>
        <summary>
          {zh ? "数据与安全边界" : "Data & security boundaries"}
        </summary>
        <p>
          {zh
            ? "只读取公开代币/产品数据，不查询钱包持仓，不接入兑换、授权、存取款或交易广播。CEX OI、资金费率、清算和 CVD 不由该链上接口推导。滚动买卖净额不可累加成 CVD；K线成交量的美元单位尚未核实。"
            : "Only public token/product data is read. No wallet positions, swaps, approvals, deposits, withdrawals or broadcasts. CEX OI/funding/liquidations/CVD are not inferred from this source. Rolling buy/sell net values cannot be accumulated into CVD; candle USD volume units are unverified."}
        </p>
        <a
          href="https://web3.binance.com/zh-CN/dev-docs/products/defi-api/introduction"
          target="_blank"
          rel="noreferrer"
        >
          {zh ? "Binance 官方文档" : "Binance documentation"}
        </a>
      </details>
    </section>
  );
}
