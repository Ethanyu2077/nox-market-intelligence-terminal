import { useEffect, useState } from "react";
import type { MarketProject, ExchangeSelection } from "../shared/types";
import type { RegimeWindow } from "../shared/regime-v2";
import type { StudyResponse } from "../shared/event-study";
import { SignalLabPage } from "./Operations";
type Response = StudyResponse & {
  dataCoverage: {
    truncated: boolean;
    backend: string;
    regimeRecords: number;
    snapshotRecords: number;
  };
};
export function EventStudyPage({
  project,
  language,
  selection,
  interval,
}: {
  project: MarketProject;
  language: string;
  selection: ExchangeSelection;
  interval: RegimeWindow | "1m";
}) {
  const zh = language === "zh",
    [horizon, setHorizon] = useState(60),
    [days, setDays] = useState(7),
    [label, setLabel] = useState(""),
    [quality, setQuality] = useState(0),
    [concentration, setConcentration] = useState("all"),
    [legacy, setLegacy] = useState(false),
    [data, setData] = useState<Response | null>(null),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0),
    [loading, setLoading] = useState(false);
  const window = interval === "1m" ? "5m" : interval;
  useEffect(() => {
    let active = true;
    setLoading(true);
    setData(null);
    const query = new URLSearchParams({
      horizon: String(horizon),
      days: String(days),
      interval: window,
      minQuality: String(quality),
      concentration,
      ...(selection !== "aggregated" ? { venue: selection } : {}),
      ...(label ? { label } : {}),
    });
    void fetch(`/api/projects/${project.id}/event-study?${query}`)
      .then(async (r) => {
        if (!r.ok) throw new Error("Event Study unavailable");
        return r.json();
      })
      .then((value) => {
        if (active) {
          setData(value);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    project.id,
    window,
    horizon,
    days,
    label,
    quality,
    concentration,
    selection,
    refresh,
  ]);
  const names: Record<string, string> = {
    "Potential long build-up": "潜在多头建仓",
    "Potential short build-up": "潜在空头建仓",
    "Potential deleveraging": "潜在去杠杆",
    "Potential short covering": "潜在空头回补",
    "Potential absorption": "潜在吸收",
    "Mixed / neutral": "混合 / 中性",
    "Insufficient evidence": "证据不足",
  };
  const state: Record<string, string> = {
    suppressed: "质量门槛未满足",
    "overlap-excluded": "重叠剔除",
    pending: "尚未到期",
    "missing-entry": "判断时价格缺失",
    "incomplete-path": "后续路径不完整",
    complete: "可评估",
  };
  const n = (v: number | null | undefined) =>
    v == null ? "—" : `${v.toFixed(3)}%`;
  return (
    <section className="ops-panel event-study-page intelligence-page">
      <h1>{zh ? "历史分析" : "Historical analysis"}</h1>
      <div className="ops-controls">
        <label>
          {zh ? "前向周期" : "Forward horizon"}{" "}
          <select
            aria-label={zh ? "前向周期" : "Forward horizon"}
            value={horizon}
            onChange={(e) => setHorizon(Number(e.target.value))}
          >
            {[15, 60, 240, 1440].map((v) => (
              <option key={v} value={v}>
                {({15:'15M',60:'1H',240:'4H',1440:'24H'} as Record<number,string>)[v]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {zh ? "研究区间" : "Research range"}{" "}
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {[1, 7, 30].map((v) => (
              <option key={v} value={v}>
                {v} {zh ? "天" : v === 1 ? "day" : "days"}
              </option>
            ))}
          </select>
        </label>
        <label>
          {zh ? "状态分组" : "Regime cohort"}{" "}
          <select value={label} onChange={(e) => setLabel(e.target.value)}>
            <option value="">{zh ? "全部" : "All"}</option>
            {Object.keys(names)
              .filter((s) => s !== "Insufficient evidence")
              .map((s) => (
                <option key={s} value={s}>
                  {zh ? names[s] : s}
                </option>
              ))}
          </select>
        </label>
        <label>
          {zh ? "最低证据质量" : "Minimum evidence quality"}{" "}
          <select
            value={quality}
            onChange={(e) => setQuality(Number(e.target.value))}
          >
            {[0, 75, 100].map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          {zh ? "资金流集中度" : "Flow concentration"}{" "}
          <select
            value={concentration}
            onChange={(e) => setConcentration(e.target.value)}
          >
            <option value="all">{zh ? "全部" : "All"}</option>
            <option value="high">HHI ≥ 0.5</option>
            <option value="low">HHI &lt; 0.5</option>
          </select>
        </label>
        <button disabled={loading} onClick={() => setRefresh((v) => v + 1)}>
          {loading
            ? zh
              ? "计算中…"
              : "Calculating…"
            : zh
              ? "重新计算"
              : "Recalculate"}
        </button>
      </div>
      <details className="analysis-method"><summary>{zh ? "统计口径与研究边界" : "Methodology & research scope"}</summary>
      <p>
        {zh
          ? "描述冻结事件后的价格表现，不是可执行交易回测。使用实际判断时间；同一项目的重叠观察期会剔除，同一事件多场所结果合并成一个样本簇。"
          : "Descriptive post-event prices, not executable trading results. Actual decision times are used. Overlapping project horizons are purged and same-event venues form one cluster."}
      </p>
      </details>
      <p>
        {zh ? "分析窗口 / 场所" : "Regime window / venue"}: {window} /{" "}
        {selection}
      </p>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <p>
            {zh
              ? "候选 / 质量抑制 / 重叠剔除 / 待到期"
              : "Candidate / suppressed / overlap excluded / pending"}
            : {data.coverage.candidates} / {data.coverage.suppressed} /{" "}
            {data.coverage.overlapExcluded} / {data.coverage.pending}
            <br />
            {zh
              ? "完整场所路径 / 完整事件簇 / 总事件簇"
              : "Complete venue paths / complete event clusters / all event clusters"}
            : {data.coverage.completeVenues} /{" "}
            {data.coverage.completeEventClusters} /{" "}
            {data.coverage.eventClusters}
            <br />
            {zh ? "数据截止" : "As of"}: {new Date(data.asOf).toLocaleString()}{" "}
            · {data.dataCoverage.backend}
          </p>
          {data.dataCoverage.truncated && (
            <p role="alert">
              {zh
                ? "扫描达到上限，汇总统计已抑制。请缩小研究区间。"
                : "Scan limit reached; summary statistics suppressed. Narrow the range."}
            </p>
          )}
          <div className="ops-evidence">
            <article>
              <h3>{zh ? "有效样本簇" : "Evaluated event clusters"}</h3>
              <p>{data.statistics.sampleSize}</p>
              <small>{zh ? "不是交易次数" : "Not a trade count"}</small>
            </article>
            <article>
              <h3>
                {zh
                  ? "中位价格收益 / Q10–Q90"
                  : "Median price return / Q10–Q90"}
              </h3>
              <p>
                {n(data.statistics.medianReturnPct)}
                <br />
                {n(data.statistics.q10Pct)} / {n(data.statistics.q90Pct)}
              </p>
            </article>
            <article>
              <h3>
                {zh
                  ? "历史价格上涨频率"
                  : "Historical positive-price frequency"}
              </h3>
              <p>
                {data.statistics.positivePriceFrequency == null
                  ? "—"
                  : `${(data.statistics.positivePriceFrequency * 100).toFixed(1)}%`}
              </p>
              <small>
                {zh
                  ? "不是胜率或未来概率"
                  : "Not win rate or future probability"}
              </small>
            </article>
          </div>
          <p>
            {zh
              ? "采样 MFE / MAE（价格上行 / 下行极值）"
              : "Sampled MFE / MAE (price excursions)"}
            : {n(data.statistics.medianMfePct)} /{" "}
            {n(data.statistics.medianMaePct)} ·{" "}
            {zh ? "观测日期数" : "Observed UTC days"}:{" "}
            {data.statistics.observedUtcDays}
            <br />
            {zh
              ? "Q10–Q90 是经验分布区间，不是置信区间；剩余序列依赖未被假设为零。无费用、资金费率或滑点模拟，不据此认定统计优势。"
              : "Q10–Q90 is empirical dispersion, not a confidence interval. Remaining serial dependence is not assumed absent. No fee, funding or slippage simulation; no validated edge is claimed."}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    zh ? "实际判断时间" : "Actual decision",
                    zh ? "场所 / 状态" : "Venue / regime",
                    zh ? "评估状态" : "Outcome status",
                    zh ? "价格收益" : "Price return",
                    zh ? "采样 MFE / MAE" : "Sampled MFE / MAE",
                    zh ? "样本 / 最大缺口" : "Samples / max gap",
                  ].map((s) => (
                    <th key={s}>{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows
                  .slice(-100)
                  .reverse()
                  .map((row) => (
                    <tr key={row.id}>
                      <td>{new Date(row.decisionTime).toLocaleString()}</td>
                      <td>
                        {row.marketKey}
                        <br />
                        {zh ? (names[row.label] ?? row.label) : row.label}
                      </td>
                      <td>{zh ? state[row.status] : row.status}</td>
                      <td>{n(row.priceReturnPct)}</td>
                      <td>
                        {n(row.mfePct)} / {n(row.maePct)}
                      </td>
                      <td>
                        {row.samples} /{" "}
                        {row.largestGapMs == null
                          ? "—"
                          : `${Math.round(row.largestGapMs / 1000)}s`}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {!data.rows.length && (
            <p>
              {zh
                ? "没有符合条件的真实事件；不填入假设收益。"
                : "No matching observed events; no hypothetical returns are substituted."}
            </p>
          )}
        </>
      )}
      <p>
        <button onClick={() => setLegacy((v) => !v)}>
          {zh
            ? "展开 / 收起旧版 V1 Event Study"
            : "Show / hide legacy V1 Event Study"}
        </button>
      </p>
      {legacy && (
        <SignalLabPage project={project} language={language} historical />
      )}
    </section>
  );
}
