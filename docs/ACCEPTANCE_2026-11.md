# 真实验收记录（2026-11）

环境：本机 macOS，Node 24（仓库要求 22+），无 TimescaleDB 实例。
判定：`PASS` 有本次会话的直接证据；`NOT VERIFIED` 表示未能在当前环境完成，**不作为通过**。

| 项目 | 结果 | 证据 / 原因 |
| --- | --- | --- |
| Binance / Bybit / OKX 公共 WS 可达 | PASS | 三个 `wss` 握手并收到首帧（depthUpdate / orderbook / books） |
| Bybit 连续 L2 同步 | PASS | `/book/stream` 实测 `state=live`、`gaps=0`、depth/spread 有值 |
| OKX 连续 L2 同步 | PASS | 同上；`integrity=checksum-unchecked`（checksum 仅在帧携带时校验） |
| Binance 连续 L2 同步 | **NOT VERIFIED** | 本机到 `fapi.binance.com` REST 间歇性阻断，快照无法完成；引擎/报文由单测覆盖，未做实机 live 验收 |
| 断网 / 重连 / 恢复 | **NOT VERIFIED** | 未在本机模拟网络中断；重连与重同步逻辑仅有单元测试 |
| TimescaleDB 写入与历史查询 | **NOT VERIFIED** | 无 `DATABASE_URL` / 测试实例；Journal（NDJSON）为默认持久层 |
| 采集服务重启后数据恢复 | **NOT VERIFIED** | 未重启进程做端到端验证；Journal 追加与告警状态有单测 |
| 盘口指标与交易所原始数据抽样核对 | **NOT VERIFIED** | 需要逐帧对照；本次仅校验序列/完整性，未做数值抽样对比 |
| Lead-Lag 历史研究可复现性 | **NOT VERIFIED** | 依赖持续增长的本地 journal；未用冻结样本集复跑 |
| 告警重启不重复触发 | PASS | `state.json` v2 运行时持久化 + 单测 |
| L2 缺口触发显式重同步 | PASS | 单测覆盖 Binance `pu`、OKX `prevSeqId`/checksum、Bybit 快照重建 |
| 研究无未来数据泄漏 | PASS | 单测覆盖 decision/outcome 时间约束与延迟剔除 |

## 结论

- 代码与单元测试层面：L2 序列、完整性、Lead-Lag 时间语义、多因子可比性门槛均有覆盖。
- 真实验收层面：仅 Bybit/OKX 的连续 L2 同步完成；其余项目按上表标记 **NOT VERIFIED**，不得宣称已验收。
- 下一步需要：可访问 Binance REST 的网络、一个可丢弃的 TimescaleDB 实例、以及冻结的样本集来复现 lead-lag。

## 2026-11 增补（正确性审计第二轮）

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| 因子单位化（相对变化 vs 差值）、零/负/跨零、MAD 异常值 | PASS | 单元测试覆盖；`oi_level` 用有保护的相对变化，`oi_delta`/`funding_basis` 用差值 |
| 全部交易所组合双向 Lead-Lag | PASS | 组合遍历 + 每个组合双向、多 lag；多重假设计数与 Bonferroni 提示 |
| Fold 审计（含每折独立 Selected Lag） | PASS | `FoldResult` 记录 trainStart/trainEnd/purgedTrain/selectedLagMs |
| Book Epoch 与跨 Epoch 序列保护 | PASS | 快照重建递增 epoch；collector 按 epoch 比较序列，跨 epoch 桶标记 `epoch-change` |
| 关闭/暂停时桶处理 | PASS | `flush()` 将未完成桶写入审计记录（`incomplete-bucket`） |
| 真实历史冻结样本复现 | **NOT VERIFIED** | 本机没有可授权的真实历史导出；现有回归全部为确定性合成 fixture，不得冒充真实复现 |
| Cross-Exchange Evidence Panel UI | **NOT IMPLEMENTED** | 本轮只完成分析层；面板仍待开发 |


## Phase D — 2026-11 增补（研究验证轮）

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| Fold Outcome Boundary | PASS | Pair 记录 eventTime/availableAt/decisionTime/outcomeTime；FoldResult 记录 outcomeCutoff/censored/purgedTrain/每折基线；交叉测试边界的样本被剔除 |
| 多因子历史输入（OI/D.A/Basis/Depth） | PASS | 统一 1m/5m/15m/1h；Depth 仅取 researchUsable 的 L2 桶；缺失因子返回 unavailable |
| Spot VD / Perp VD / CVD | **NOT VERIFIED** | Journal 没有逐所可比的 spot/perp 主动成交与 CVD 序列；未用其他指标推算冒充 |
| Collector 生命周期与 Health | PASS | Active↔Paused、删除/切换释放 feed、写入失败重试、未完成桶审计、/api/operations.l2Collection |
| Cross-Exchange Evidence Panel | PASS（UI） | 真实接口、无 mock；OOS 恒为 NOT VERIFIED |
| 真实历史冻结样本 + SHA256 | **NOT VERIFIED** | 无可授权的真实导出；合成 fixture 不作为复现证据 |
| Binance 连续 L2 实机 | **NOT VERIFIED** | 本机到 fapi REST 间歇阻断 |
| 断网/重连、Timescale 写入查询、进程重启恢复、盘口抽样核对 | **NOT VERIFIED** | 需要可中断网络、Timescale 实例与冻结样本集 |

### 未能完成项所需环境

- Binance L2：可访问 `fapi.binance.com` 的稳定网络。
- 断网重连：可控网络中断（或 tc/netem）。
- Timescale：一个可丢弃的 PostgreSQL+Timescale 实例与 `DATABASE_URL`。
- 冻结复现：经授权的真实历史导出（含 event/received/available 时间）+ SHA256 清单。

## 2026-11 增补（研究完整性轮）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| Outcome 可用时间（outcomeAvailableAt / censoredLate） | TESTED | 单元测试覆盖；延迟数据不进入训练/OOS |
| Fold 边界与 embargo（horizon + maxDelay） | TESTED | 每折审计字段与 censored 计数 |
| 历史覆盖率（quality × density） | TESTED | 不再强制 100；L2 桶用真实 coverage |
| 历史分页参数（start/end/asOf/limit、partial、cursor） | IMPLEMENTED | API 返回 partial/cursor/dataWindow；route 级未做集成测试 |
| Evidence Panel V2（筛选/排序/覆盖/数据窗口） | IMPLEMENTED | 使用真实 API；OOS 显示 NOT VERIFIED |
| Evidence Panel 专项 E2E（切换/错误/移动端） | **NOT VERIFIED** | 本轮未扩展 e2e.mjs 的面板交互断言 |
| 真实历史冻结样本 + SHA256 | **NOT VERIFIED** | 无授权真实导出 |
| Spot VD / Perp VD / CVD 完整覆盖 | **NOT VERIFIED** | Journal 无逐所历史序列 |
| Binance L2 实机、断网重连、Timescale、重启恢复、抽样核对 | **NOT VERIFIED** | 缺相应环境 |

## 2026-11 增补（研究数据完整性轮）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| Snapshot/L2 双 Cursor 分页 | TESTED | `scanHistory` 单测（多页、去重、恢复、max-pages/max-records/timeout） |
| 查询完整性字段 | IMPLEMENTED | `snapshotCursor/l2Cursor/scannedRecords/excludedRecords/truncated/truncationReason/researchComplete` |
| 不完整历史降级 | TESTED | `truncated` 时 verdict 强制 `insufficient`，不输出完整区间结论 |
| 覆盖率核算 | TESTED | expected/observed/valid/excluded/missing/timeCoverage/validCoverage/sourceQuality；验收示例 60/35/30/5/25 → 58.33%/50% |
| 执行情景分离 | TESTED | 入场必须为决策后首个报价；无独立报价 → unavailable；成本仅含手续费假设 |
| Evidence Panel 专项 E2E | **NOT VERIFIED** | 本轮未扩展 `e2e.mjs` 的面板交互断言 |
| 真实历史冻结样本/SHA256 | **NOT VERIFIED** | 无授权真实导出 |
| Binance L2 实机、断网重连、Timescale、重启恢复、抽样核对 | **NOT VERIFIED** | 缺相应环境 |
| Spot VD / Perp VD / CVD 完整历史 | **NOT VERIFIED** | Journal 无逐所历史序列 |

## 2026-11 增补（最终可靠性轮）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| Cursor 恢复不丢页内记录 | TESTED | maxRecords 命中后先消费整页；快照/L2 独立 cursor；同时间戳稳定顺序 |
| 分批扫描 == 一次性扫描 | TESTED | 多轮 cursor 恢复后事件 ID 集合与顺序一致 |
| 执行报价可用性 | TESTED | 入场必须在决策后、非同一报价、未超时；出场需在 horizon+delay 内 |
| 执行成本账本 | TESTED | fees 记录；spread/slippage/funding/latency 为 null 且标 assumption |
| 可执行验收脚本 | IMPLEMENTED | `scripts/acceptance/l2-live.mjs`、`timescale.mjs`、`docs/PRODUCTION_ACCEPTANCE.md` |
| 脚本真实执行结果 | **NOT VERIFIED** | 本轮未在可控网络/Timescale 实例上执行，脚本输出不作为通过 |
| Evidence Panel 专项 E2E | **NOT IMPLEMENTED** | 未扩展 `scripts/e2e.mjs` 的面板交互断言 |
| 真实历史冻结样本/SHA256 | **NOT VERIFIED** | 无授权真实导出 |
| Binance L2 实机、断网重连、Timescale 写入查询、重启恢复、抽样核对 | **NOT VERIFIED** | 缺相应环境 |
| Spot VD / Perp VD / CVD 完整历史 | **NOT VERIFIED** | Journal 无逐所历史序列 |

## 2026-11 增补（验收工具轮）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| L2 探针 V2（超时/连续性/逐所报告） | IMPLEMENTED | 需要 ≥2 次有效更新、序列前进、单 epoch、spread/depth>0、无新增缺口、延迟≤15s |
| L2 探针真实执行 | **NOT VERIFIED** | 本轮未在可控网络上运行；Binance REST 仍不可达 |
| Timescale READ/WRITE/RECOVERY 脚本 | IMPLEMENTED | 仅允许可丢弃测试库写入；三态独立；重启命令可选 |
| Timescale 真实执行 | **NOT VERIFIED** | 无测试实例，未执行 |
| Evidence Panel 专项 E2E | **NOT IMPLEMENTED** | 本轮未新增浏览器交互套件 |
| 冻结历史样本/SHA256、断网重连、重启恢复、抽样核对 | **NOT VERIFIED** | 缺环境/授权 |


## 2026-11 增补（最终 E2E/验收工具轮）

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| Evidence Panel 专项 E2E | **TESTED（本地）** | Chrome 157.0.8103.38，19 项断言 PASS，报告 `artifacts/e2e-evidence/report.json` |
| 专项 E2E 进入 CI | IMPLEMENTED | workflow 新增 `Evidence Panel E2E` 步骤；本轮 CI 结果见运行链接 |
| Timescale 状态拆分 | TESTED（脚本逻辑） | read/write/connectionRecovery/processRestartRecovery 独立；未连接实例 |
| L2 连续性指标 | IMPLEMENTED | 探针未取得真实 PASS；本轮在 API 上执行结果为 NOT VERIFIED |
| 冻结真实历史样本/SHA256 | **NOT VERIFIED** | 无授权导出 |
| Binance/Bybit/OKX L2 实机 | **NOT VERIFIED** | 探针本轮未达到连续性门槛 |
| 断网重连、进程重启恢复、盘口抽样 | **NOT VERIFIED** | 未执行 |
| Spot VD / Perp VD / CVD 完整历史 | **NOT VERIFIED** | 无逐所历史序列 |
