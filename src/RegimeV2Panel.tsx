import { useEffect, useState } from "react";
import type { RegimeReport, RegimeWindow } from "../shared/regime-v2";
import type { MarketProject, ExchangeSelection } from "../shared/types";
import {ResearchReadinessPanel} from './ResearchReadinessPanel';

const labels: Record<string, string> = {
  "Insufficient evidence": "证据不足",
  "Insufficient cross-exchange evidence": "跨交易所证据不足",
  "Cross-exchange disagreement": "交易场所判断冲突",
  "Partial venue agreement": "部分场所一致（覆盖不足）",
  "Mixed / neutral": "混合 / 中性",
  "Potential long build-up": "潜在多头建仓",
  "Potential short build-up": "潜在空头建仓",
  "Potential deleveraging": "潜在去杠杆",
  "Potential short covering": "潜在空头回补",
  "Potential absorption": "潜在吸收",
  "Price window unavailable": "价格窗口不可用",
  "Base OI window unavailable": "代币数量 OI 窗口不可用",
  "Complete aligned perpetual aggressor flow unavailable":
    "完整、对齐的永续主动成交数据不可用",
  "Complete selected-spot flow": "完整的已选现货成交数据",
  "Historical flow baseline unavailable; absorption rule disabled":
    "历史主动成交基线不足；吸收规则已停用",
  "Depth / basis / verified complete liquidations are not inputs to this version":
    "此版本未纳入深度、基差与完整且已验证的清算数据",
};
export function RegimeV2Panel({
  project,
  language,
  selection,
  interval: requestedInterval,
  onInterval,
}: {
  project: MarketProject;
  language: string;
  selection: ExchangeSelection;
  interval: RegimeWindow | "1m";
  onInterval: (value: RegimeWindow) => void;
}) {
  const zh = language === "zh",
    [reports, setReports] = useState<RegimeReport[]>([]),
    [error, setError] = useState(""),
    [eventId, setEventId] = useState("");
  const interval = requestedInterval === "1m" ? "5m" : requestedInterval;
  useEffect(() => {
    let active = true;
    setReports([]);
    setEventId("");
    const load = async () => {
      try {
        const response = await fetch(
          `/api/projects/${project.id}/regimes-v2?interval=${interval}`,
        );
        if (!response.ok) throw new Error("Regime data unavailable");
        const data = await response.json();
        if (active) {
          setReports(data.items);
          setError("");
        }
      } catch (e) {
        if (active) setError(String(e));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [project.id, interval]);
  const report = reports.find((r) => r.id === eventId) ?? reports.at(-1),
    text = (s: string) => (zh ? (labels[s] ?? s) : s),
    n = (v: number | null | undefined, d = 2) =>
      v == null
        ? "—"
        : Intl.NumberFormat(zh ? "zh-CN" : "en", {
            maximumFractionDigits: d,
          }).format(v);
  const selected =
    selection === "aggregated"
      ? null
      : report?.venues.find((v) => v.input.market.exchange === selection);
  const shownVenues =
    selection === "aggregated"
      ? (report?.venues ?? [])
      : selected
        ? [selected]
        : [];
  return (
    <section className="ops-panel regime-evidence-panel">
      <h2 className="analysis-section-title">
        {zh ? "市场结构与跨场所证据" : "Market regimes & cross-venue evidence"}
      </h2>
      <div className="ops-controls">
        <label>
          {zh ? "分析窗口" : "Analysis window"}{" "}
          <select
            aria-label={zh ? "分析窗口" : "Analysis window"}
            value={interval}
            onChange={(e) => onInterval(e.target.value as RegimeWindow)}
          >
            {(["5m", "15m", "1h", "4h"] as const).map((i) => (
              <option key={i} value={i}>
                {i.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label>
          {zh ? "历史事件" : "Recorded event"}{" "}
          <select
            aria-label={zh ? "历史事件" : "Recorded event"}
            value={report?.id ?? ""}
            onChange={(e) => setEventId(e.target.value)}
          >
            {reports.length ? (
              reports
                .slice()
                .reverse()
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.windowEnd).toLocaleString(zh ? "zh-CN" : "en")}{" "}
                    · {text(r.label)}
                  </option>
                ))
            ) : (
              <option value="">
                {zh ? "等待真实采样" : "Waiting for observed samples"}
              </option>
            )}
          </select>
        </label>
      </div>
      <details className="analysis-method"><summary>{zh ? "分析口径与数据要求" : "Methodology & data requirements"}</summary>
      <p>{zh?'可靠分类需要至少30个完整历史窗口。持续订单流请在设置中启用 Active；Standard 或采集缺口可能使证据不足。':'Reliable classification requires at least 30 complete historical windows. Enable Active in Settings for continuous order flow; Standard mode or collection gaps may leave insufficient evidence.'}</p>
      <p>
        {zh
          ? "V2 规则：异常程度是历史分位，不是成功概率。证据质量表示输入覆盖；历史统计优势尚未验证。"
          : "V2 rules: anomaly scores are historical ranks, not success probabilities. Evidence quality measures coverage. Historical edge is not validated."}
      </p>
      <p>
        {zh ? "显示范围" : "Display scope"}: {selection} ·{" "}
        {zh
          ? "结构规则最小窗口为5M；全局1M模式在此使用5M。"
          : "Minimum regime window is 5M; global 1M uses 5M here."}
      </p>
      </details>
      {error && <p role="alert">{error}</p>}
      <ResearchReadinessPanel project={project} language={language} interval={interval} selection={selection}/>
      {!report ? (
        <p>
          {zh
            ? "尚无此窗口的已记录事件。不会用演示数据补齐。"
            : "No recorded event for this window. No demo data is substituted."}
        </p>
      ) : (
        <>
          <h2>
            {text(
              selection === "aggregated"
                ? report.label
                : (selected?.label ?? "Insufficient evidence"),
            )}
          </h2>
          <p>
            {new Date(report.windowStart).toLocaleString()} →{" "}
            {new Date(report.windowEnd).toLocaleString()} ·{" "}
            {zh ? "实际判断时间" : "Decision time"}{" "}
            {new Date(report.decisionTime).toLocaleString()}
          </p>
          <div className="ops-evidence">
            <article>
              <h3>{zh ? "异常程度 / 100" : "Anomaly rank / 100"}</h3>
              <p>
                {n(
                  selection === "aggregated"
                    ? report.anomalyScore
                    : selected?.anomalyScore,
                )}
              </p>
            </article>
            <article>
              <h3>{zh ? "证据质量 / 100" : "Evidence quality / 100"}</h3>
              <p>
                {selection === "aggregated"
                  ? report.evidenceQuality
                  : (selected?.evidenceQuality.score ?? "—")}{" "}
                · {report.coveredVenues}/{report.requestedVenues}{" "}
                {zh ? "场所满足全部条件" : "venues eligible"}
              </p>
            </article>
            <article>
              <h3>{zh ? "历史统计优势" : "Historical edge"}</h3>
              <p>
                {zh
                  ? "未验证 · 不提供成功概率"
                  : "Unvalidated · no success probability"}
              </p>
            </article>
          </div>
          <p>
            {zh ? "支持多数状态的场所" : "Supporting the modal state"}:{" "}
            {report.supporting.join(", ") || "—"}
            <br />
            {zh ? "相反状态的场所" : "Contradicting venues"}:{" "}
            {report.contradicting.join(", ") || "—"}
            <br />
            {zh ? "证据不足的场所" : "Insufficient venues"}:{" "}
            {report.missingVenues.join(", ") || "—"}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    zh ? "场所" : "Venue",
                    zh ? "推断" : "Inference",
                    "Price Δ %",
                    "OI Δ %",
                    zh ? "永续 Delta / USDT" : "Perp delta / USDT",
                    zh ? "异常 / 质量" : "Anomaly / quality",
                    zh ? "历史样本" : "Baseline samples",
                  ].map((s) => (
                    <th key={s}>{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownVenues.map((v) => (
                  <tr key={v.id}>
                    <td>{v.marketKey}</td>
                    <td>{text(v.label)}</td>
                    <td>{n(v.metrics.priceChangePct, 4)}</td>
                    <td>{n(v.metrics.oiChangePct, 4)}</td>
                    <td>{n(v.metrics.perpDelta)}</td>
                    <td>
                      {n(v.anomalyScore)} / {v.evidenceQuality.score}
                    </td>
                    <td>{v.evidenceQuality.baselineSamples} / 30</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>
            {zh
              ? "资金流归因（仅覆盖场所）"
              : "Flow attribution (covered venues only)"}
          </h2>
          <p>
            {zh
              ? "OI 资金流名义量 = 代币数量 OI 变化 × 窗口末价格，不包含纯价格重估。占比采用绝对量，不能解释为多空持仓归属。"
              : "OI-flow notional = token OI change × end price, excluding pure price revaluation. Absolute shares do not identify position ownership."}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    zh ? "场所" : "Venue",
                    zh ? "永续 Delta" : "Perp delta",
                    zh ? "绝对 Delta 占比" : "Absolute delta share",
                    zh ? "OI 流名义量" : "OI-flow notional",
                    zh ? "扩张 / 收缩占比" : "Expansion / contraction share",
                  ].map((s) => (
                    <th key={s}>{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.flowAttribution
                  .filter(
                    (v) =>
                      selection === "aggregated" ||
                      v.marketKey.startsWith(`${selection}:`),
                  )
                  .map((v) => (
                    <tr key={v.marketKey}>
                      <td>{v.marketKey}</td>
                      <td>{n(v.perpDelta)}</td>
                      <td>
                        {v.absoluteFlowShare == null
                          ? "—"
                          : `${n(v.absoluteFlowShare * 100)}%`}
                      </td>
                      <td>{n(v.oiFlowNotional)}</td>
                      <td>
                        {v.oiExpansionShare == null
                          ? "—"
                          : `${n(v.oiExpansionShare * 100)}%`}{" "}
                        /{" "}
                        {v.oiContractionShare == null
                          ? "—"
                          : `${n(v.oiContractionShare * 100)}%`}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p>
            {zh ? "完整覆盖永续 Delta" : "Full-coverage perpetual delta"}:{" "}
            {n(report.aggregates.perpDelta)} ·{" "}
            {zh ? "已覆盖小计" : "Covered subtotal"}:{" "}
            {n(report.aggregates.coveredPerpDelta)}
            <br />
            {zh ? "现货 Delta / 覆盖" : "Spot delta / coverage"}:{" "}
            {n(report.aggregates.spotDelta)} · {report.aggregates.spotCovered}/
            {report.aggregates.spotRequested}
            <br />
            {zh
              ? "资金流集中度 HHI（覆盖场所）"
              : "Flow concentration HHI (covered venues)"}
            : {n(report.aggregates.flowConcentration, 4)}
          </p>
          {shownVenues.map((v) => (
            <details key={v.id}>
              <summary>
                {v.marketKey} · {zh ? "输入与数据缺口" : "Inputs & data gaps"}
              </summary>
              <p>
                {zh ? "固定事件 ID" : "Stable event ID"}: {v.id}
                <br />
                {zh ? "引用快照数" : "Snapshot references"}:{" "}
                {v.inputSnapshotCount ?? v.input.snapshots.length}
                <br />
                {zh
                  ? "现货 / 永续方向冲突"
                  : "Spot / perpetual disagreement"}:{" "}
                {v.contradictions.length
                  ? zh
                    ? "是"
                    : "Yes"
                  : zh
                    ? "未观测到或数据不足"
                    : "Not observed / insufficient data"}
              </p>
              <p>
                {zh ? "已记录缺口" : "Recorded gaps"}:{" "}
                {v.missing
                  .map((s) =>
                    zh
                      ? s.startsWith("Historical baseline ")
                        ? s.replace("Historical baseline ", "历史基线 ")
                        : text(s)
                      : s,
                  )
                  .join(" · ")}
              </p>
            </details>
          ))}
          <p>
            {zh
              ? "首次观察记录不可被后续数据改写。盘口、基差和完整清算尚未纳入此规则；不推断清算瀑布，不宣称交易所具有因果领先关系。"
              : "First recorded observations are immutable. Depth, basis and complete liquidations are not inputs to this rule. No liquidation-cascade or causal venue-leadership claim."}
          </p>
          <p>
            <a
              href={`/api/projects/${project.id}/regimes-v2?interval=${interval}&eventId=${report.id}`}
              download={`nox-event-${report.id}.json`}
            >
              {zh
                ? "下载冻结输入 JSON（用于复现）"
                : "Download frozen inputs JSON (reproduction)"}
            </a>
          </p>
        </>
      )}
    </section>
  );
}
