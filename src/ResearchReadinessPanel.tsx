import { useEffect, useState } from "react";
import type { MarketProject, ExchangeSelection } from "../shared/types";
import type { RegimeWindow } from "../shared/regime-v2";
import type {
  signalReadiness,
  weightedConsensus,
} from "../server/research-readiness";
type Readiness = ReturnType<typeof signalReadiness> & {
  weighted: ReturnType<typeof weightedConsensus> | null;
  backend: string;
};
const states: Record<string, string> = {
  ready: "数据条件具备",
  warming: "历史 / 订单流待积累",
  stale: "快照延迟或缺失",
  unsupported: "订单流不支持",
  paused: "采集已暂停",
};
export function ResearchReadinessPanel({
  project,
  language,
  interval,
  selection,
}: {
  project: MarketProject;
  language: string;
  interval: RegimeWindow;
  selection: ExchangeSelection;
}) {
  const zh = language === "zh",
    [data, setData] = useState<Readiness | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setData(null);
    const load = async () => {
      try {
        const response = await fetch(
          `/api/projects/${project.id}/readiness?interval=${interval}`,
        );
        if (!response.ok) throw new Error("Readiness unavailable");
        const value = await response.json();
        if (active) {
          setData(value);
          setError("");
        }
      } catch (e) {
        if (active) setError(String(e));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [project.id, interval]);
  const venues =
    data?.venues.filter(
      (v) =>
        selection === "aggregated" || v.marketKey.startsWith(`${selection}:`),
    ) ?? [];
  const label = (value: string) =>
    zh
      ? ((
          {
            "Potential long build-up": "潜在多头建仓",
            "Potential short build-up": "潜在空头建仓",
            "Potential deleveraging": "潜在去杠杆",
            "Potential short covering": "潜在空头回补",
            "Potential absorption": "潜在吸收",
            "Mixed / neutral": "混合 / 中性",
            "Insufficient evidence": "证据不足",
            "Cross-exchange disagreement": "场所冲突",
            "Insufficient cross-exchange evidence": "跨场所证据不足",
            "Partial venue agreement": "部分场所一致",
          } as Record<string, string>
        )[value] ?? value)
      : value;
  const reason = (value: string) => zh ? ({
    'Price window unavailable':'价格窗口缺失',
    'Base OI window unavailable':'代币数量 OI 窗口缺失',
    'Complete aligned perpetual aggressor flow unavailable':'完整且对齐的永续主动成交数据缺失',
    'Complete selected-spot flow':'所选现货完整订单流缺失',
    'Historical flow baseline unavailable; absorption rule disabled':'历史订单流基线不足；吸收规则未启用',
    'Depth / basis / verified complete liquidations are not inputs to this version':'本版规则尚未纳入深度、基差和已验证完整清算',
    'Latest snapshot is stale or missing':'最新快照已延迟或缺失',
    'Current aggressor feed is not fresh':'当前主动成交数据尚未保持新鲜',
    'Collection is paused':'采集已暂停',
  } as Record<string,string>)[value] ?? value.replace('Historical baseline','历史基线') : value;
  return (
    <section className="ops-panel">
      <h2>
        {zh
          ? "信号就绪度 · 当前采集状态"
          : "Signal readiness · current collection"}
      </h2>
      <p>
        {zh
          ? "就绪仅表示数据门槛满足，不代表将出现信号或具备盈利优势。缺数不会降低门槛。"
          : "Ready means input gates are met, not that a signal or profitable edge exists. Missing data does not lower the gates."}
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {[
                zh ? "场所" : "Venue",
                zh ? "状态" : "State",
                zh ? "基线 / 还缺" : "Baseline / remaining",
                zh ? "快照年龄" : "Snapshot age",
                zh ? "窗口订单流" : "Window flow",
                zh ? "价格 / OI / Funding" : "Price / OI / funding",
              ].map((s) => (
                <th key={s}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {venues.map((v) => (
              <tr key={v.marketKey}>
                <td>{v.marketKey}</td>
                <td>{zh ? (states[v.state] ?? v.state) : v.state}</td>
                <td>
                  {v.baselineSamples}/{v.requiredSamples} · {v.remainingSamples}
                </td>
                <td>
                  {v.snapshotAgeMs == null
                    ? "—"
                    : `${Math.round(v.snapshotAgeMs / 1000)}s`}
                </td>
                <td>
                  {v.flowContinuous
                    ? zh
                      ? "完整"
                      : "Complete"
                    : zh
                      ? "不完整"
                      : "Incomplete"}{" "}
                  · {zh ? ({connecting:'连接中',live:'实时',stale:'延迟',unavailable:'不可用',warming:'积累中'} as Record<string,string>)[v.flowState]??v.flowState : v.flowState} · {zh ? "缺口" : "gaps"} {v.gapCount ?? "—"}
                </td>
                <td>
                  {[
                    v.availableAnalysis.price,
                    v.availableAnalysis.oi,
                    v.availableAnalysis.funding,
                  ]
                    .map((b) => (b ? "✓" : "—"))
                    .join(" / ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!data && <p>{zh ? "正在检查真实数据…" : "Checking observed data…"}</p>}
      {venues.map((v) => (
        <details key={v.marketKey}>
          <summary>
            {v.marketKey} ·{" "}
            {zh ? "为何未就绪 / 数据能力" : "Readiness gaps / capabilities"}
          </summary>
          <p>
            {zh ? "订单流支持" : "Flow supported"}:{" "}
            {v.flowSupported ? (zh ? "是" : "Yes") : zh ? "否" : "No"} ·{" "}
            {v.supportedReason}
          </p>
          <p>
            {v.suppressionReasons.map(reason).join(" · ") ||
              (zh ? "当前必需条件满足" : "Essential gates met")}
          </p>
        </details>
      ))}
      <h2>
        {zh
          ? "最新冻结事件的加权分布（不替代场所数量共识）"
          : "Latest frozen-event weighted distributions (count consensus preserved)"}
      </h2>
      {data?.weighted ? (
        <>
          <p>
            {zh ? "冻结判断时间" : "Frozen decision time"}:{" "}
            {new Date(data.weighted.decisionTime).toLocaleString()} ·{" "}
            {zh ? "数量共识" : "Count consensus"}:{" "}
            {label(data.weighted.countBased)}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    zh ? "权重口径" : "Weight basis",
                    zh ? "已知 / 请求场所" : "Known / requested",
                    zh ? "证据覆盖" : "Evidence coverage",
                    zh
                      ? "状态份额（仅已知权重）"
                      : "State shares (known weights only)",
                    zh ? "缺失权重场所" : "Missing weights",
                  ].map((s) => (
                    <th key={s}>{s}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[data.weighted.oi, data.weighted.volume].map((w) => (
                  <tr key={w.metric}>
                    <td>
                      {w.metric === "oiUsd"
                        ? "OI / USDT"
                        : zh
                          ? "滚动24H成交额"
                          : "Rolling 24H volume"}
                    </td>
                    <td>
                      {w.known}/{w.requested}
                    </td>
                    <td>
                      {w.complete
                        ? zh
                          ? "完整"
                          : "Complete"
                        : zh
                          ? "不完整 / 分母不足"
                          : "Partial / insufficient denominator"}
                    </td>
                    <td>
                      {w.distribution
                        .map(
                          (d) =>
                            `${label(d.label)}: ${d.weightShare == null ? "—" : `${(d.weightShare * 100).toFixed(1)}%`}`,
                        )
                        .join(" · ") || "—"}
                    </td>
                    <td>{w.missing.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            {zh
              ? "缺失权重不是0；仅在已知权重内归一化。24H成交额不是分析窗口成交额。份额不代表成功概率，也不证明交易所领先关系。"
              : "Missing weight is not zero; shares normalize over known weights only. 24H volume is not the regime-window volume. Shares are not success probabilities or proof of venue leadership."}
          </p>
        </>
      ) : (
        <p>
          {zh
            ? "尚无此周期的冻结事件权重。"
            : "No frozen-event weights for this interval yet."}
        </p>
      )}
    </section>
  );
}
