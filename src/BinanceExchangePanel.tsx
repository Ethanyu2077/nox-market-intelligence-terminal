import { useEffect, useState } from "react";
import type { MarketProject } from "../shared/types";
import type { BinanceExchangeResponse } from "../shared/binance-exchange";
const value = (v: number | null) =>
  v == null
    ? "—"
    : new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 }).format(v);
export function BinanceExchangePanel({
  project,
  language,
}: {
  project: MarketProject;
  language: string;
}) {
  const zh = language === "zh",
    [data, setData] = useState<BinanceExchangeResponse | null>(null),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true,
      busy = false;
    const abort = new AbortController();
    setData(null);
    setError("");
    const load = async () => {
      if (busy) return;
      busy = true;
      setLoading(true);
      try {
        const r = await fetch(`/api/projects/${project.id}/binance`, {
          signal: abort.signal,
        });
        if (!r.ok) throw new Error();
        const result = await r.json();
        if (active) {
          setData(result);
          setError("");
        }
      } catch {
        if (active)
          setError(
            zh
              ? "Binance 交易所行情暂不可用"
              : "Binance exchange data is temporarily unavailable",
          );
      } finally {
        busy = false;
        if (active) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5_000);
    return () => {
      active = false;
      abort.abort();
      clearInterval(timer);
    };
  }, [project.id, project.updatedAt, refresh, zh]);
  return (
    <section className="ops-panel">
      <h2>
        {zh
          ? "Binance 交易所行情 · 现货 / USDT-M 永续"
          : "Binance Exchange · Spot / USDT-M Perpetual"}
      </h2>
      <p>
        {zh
          ? "公开交易所行情，无需 API Key；与下方需要开发者凭证的 Binance Web3 链上接口不同。只读取项目已选择的 Binance 交易对，不自动添加市场。"
          : "Public exchange data requires no API key, unlike Binance Web3 below. Only this project’s selected Binance pairs are queried; no markets are added automatically."}
      </p>
      <div className="ops-controls">
        <span>
          {zh
            ? "REST 每5秒刷新；原市场分析页继续使用现有 WebSocket 链路"
            : "REST refresh every 5 seconds; existing WebSocket analytics remain on the market workspace"}
        </span>
        <button disabled={loading} onClick={() => setRefresh((v) => v + 1)}>
          {zh ? "刷新交易所行情" : "Refresh exchange data"}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {!data && !error && (
        <p role="status">
          {zh
            ? "正在读取 Binance 真实行情…"
            : "Loading observed Binance market data…"}
        </p>
      )}
      {data && (
        <>
          <p>
            {zh
              ? "已选现货 / 永续 / 成功覆盖"
              : "Selected spot / perpetual / successful coverage"}
            : {data.coverage.spotSelected} / {data.coverage.perpetualSelected} /{" "}
            {data.coverage.successful} / {data.coverage.requested}
          </p>
          {!data.coverage.spotSelected && (
            <p>
              {zh
                ? "未选择 Binance 现货交易对。可在项目管理中确认并选择，系统不会假设该代币已上线现货。"
                : "No Binance spot pair selected. Confirm and select one in Project Management; spot listing is not assumed."}
            </p>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    zh ? "市场" : "Market",
                    zh ? "价格 / 24H涨跌" : "Price / 24H change",
                    zh ? "24H成交额" : "24H quote volume",
                    zh ? "买一 / 卖一 / 价差" : "Bid / ask / spread",
                    zh ? "OI 数量 / USD" : "OI base / USD",
                    zh ? "资金费率 / 下次结算" : "Funding / next settlement",
                    zh ? "来源时间 / 状态" : "Source time / state",
                  ].map((s) => (
                    <th key={s}>{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map(
                  ({ market, snapshot: s, volume24hQuote, quote }) => (
                    <tr key={market.id}>
                      <td>
                        {market.symbol}
                        <br />
                        {market.marketType === "spot"
                          ? zh
                            ? "现货"
                            : "SPOT"
                          : zh
                            ? "永续合约"
                            : "PERPETUAL"}
                      </td>
                      <td>
                        {value(s.price)} {quote}
                        <br />
                        {s.change24hPct == null
                          ? "—"
                          : `${value(s.change24hPct)}%`}
                      </td>
                      <td>
                        {value(volume24hQuote)} {quote}
                      </td>
                      <td>
                        {value(s.bid)} / {value(s.ask)}
                        <br />
                        {value(s.spreadBps)} bps
                      </td>
                      <td>
                        {market.marketType === "spot" ? (
                          zh ? (
                            "不适用"
                          ) : (
                            "N/A"
                          )
                        ) : (
                          <>
                            {value(s.oiBase)} {market.base}
                            <br />
                            {value(s.oiUsd)} USD
                          </>
                        )}
                      </td>
                      <td>
                        {market.marketType === "spot" ? (
                          zh ? (
                            "不适用"
                          ) : (
                            "N/A"
                          )
                        ) : (
                          <>
                            {s.fundingRate == null
                              ? "—"
                              : `${value(s.fundingRate * 100)}%`}
                            <br />
                            {s.nextFundingTime
                              ? new Date(s.nextFundingTime).toLocaleString()
                              : "—"}
                          </>
                        )}
                      </td>
                      <td>
                    {s.eventTime>0?new Date(s.eventTime).toLocaleTimeString():'—'}
                        <br />
                        {zh
                          ? (
                              {
                                live: "实时",
                                partial: "部分数据",
                                stale: "延迟",
                                unavailable: "不可用",
                              } as const
                            )[s.quality]
                          : s.quality}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          {data.failures.map((f) => (
            <p role="alert" key={f.marketId}>
              {f.symbol} · {f.reason}
            </p>
          ))}
          {data.coverage.requested === 0 && (
            <p>
              {zh
                ? "该项目未选择 Binance 市场，请到项目管理中添加已验证的交易对。"
                : "No Binance market selected for this project. Add a verified pair in Project Management."}
            </p>
          )}
          <p>
            {zh
              ? "盘口为买一卖一 REST 快照，不是序列校验后的完整深度；现货不具有合约 OI 或资金费率。K线、OI、CVD 继续在市场结构 / 高级订单流中查看。"
              : "Bid/ask are REST top-of-book snapshots, not sequence-verified full depth. Spot has no futures OI or funding. Candles, OI and CVD remain in Market Structure / Advanced Order Flow."}
          </p>
        </>
      )}
    </section>
  );
}
