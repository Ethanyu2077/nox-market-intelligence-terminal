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


## 2026-11 增补（验收完整性轮）

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| 进程重启判定（身份变化 + API 读回） | TESTED | 8 个确定性测试；`evaluateRestart` 纯函数 |
| 进程重启真实执行 | **NOT VERIFIED** | 无 Timescale 实例与可控 API 重启环境 |
| L2 连续性统计（最长连续/去重/心跳/Epoch） | TESTED | 5 个 Fixture 测试；`l2-analysis.mjs` |
| L2 实机连续性 | **NOT VERIFIED** | 探针未取得两帧以上有效更新 |
| 验收证据字段（时间/commit/环境/参数/证据路径） | IMPLEMENTED | runbook 记录要求 |
| 冻结真实历史样本/SHA256、断网重连、抽样核对 | **NOT VERIFIED** | 缺授权/环境 |
| Spot VD / Perp VD / CVD 完整历史 | **NOT VERIFIED** | 无逐所历史序列 |

## 2026-11 增补（安全与时间线轮）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 验收接口环境隔离 | TESTED | 仅 `NOX_ACCEPTANCE_MODE=1` 且非 production 注册；否则 404 |
| 验收接口访问控制 | TESTED | 复用 AuthStore，仅 admin；严格 `acceptance:<ns>`，100 行上限，只读 |
| L2 完整状态时间线 | TESTED | stale/resyncing/checksum/gap/epoch 均打断连续区间；心跳与重复序列不计更新 |
| 覆盖率分母 | TESTED | 使用完整请求窗口，而非有效帧首尾 |
| Timescale 实库验收 | **NOT VERIFIED** | 无测试实例；验收接口还需 admin 会话 |
| L2 实机连续性 | **NOT VERIFIED** | 未取得连续有效数据 |
| 断网重连、冻结样本/SHA256、抽样核对、Spot/Perp VD/CVD | **NOT VERIFIED** | 缺环境/授权 |

## 2026-11 增补（最终安全与 Gap 轮）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 验收接口环境白名单 | TESTED | 仅 `NOX_ACCEPTANCE_MODE=1` 且 `NODE_ENV=test`；缺失/development/production 均 404 |
| 验收接口路由级测试 | TESTED | 404×4、401、403×2、admin 200、非法 namespace 400、只读 acceptance 项目 |
| L2 Gap 中断连续区间 | TESTED | gap 增加、live→resync、checksum failure 都立即打断；同 epoch 的 live 不能恢复 |
| L2 Recovery 审计 | TESTED | 需新 Book Epoch + 连续更新；gapDetected/gapRecovered/resyncStarted/resyncCompleted 输出 |
| Integrity 字段语义 | TESTED | integrity 来自盘口完整性，绝不复用 state；checksum-unchecked 不算 live |
| Timescale 实库验收 | **NOT VERIFIED** | 无测试实例；脚本尚未携带 admin 会话 |
| L2 实机连续性 | **NOT VERIFIED** | 未取得连续有效数据 |
| 断网重连、冻结样本/SHA256、抽样核对、Spot/Perp VD/CVD | **NOT VERIFIED** | 缺环境/授权 |

## 2026-11 增补（验收集成轮）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| Timescale 管理员认证接入 | TESTED | 仅环境变量凭据；复用 /api/auth/login；重启后强制重新登录；缺凭据/401/403 → NOT VERIFIED |
| L2 Recovery 报告一致性 | TESTED | 探针直接使用 metrics.recoveryCompleted 与 evaluateL2 状态；12 个 L2 测试 |
| 测试库身份校验 | TESTED | 需 ACCEPTANCE_ALLOW_WRITES=1 + ACCEPTANCE_TEST_DB_NAME 与实际 current_database() 一致且可丢弃 |
| Timescale 实库执行 | **NOT VERIFIED** | 无测试实例，未执行；脚本未在真实库上跑过 |
| Binance / Bybit / OKX 连续 L2 | **NOT VERIFIED** | 未取得连续有效数据 |
| 断网重连、冻结样本/SHA256、抽样核对、Spot/Perp VD/CVD | **NOT VERIFIED** | 缺环境/授权 |

## 2026-11 增补（真实数据基础设施轮）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 401 重新认证一次重试 | TESTED | authorizedGet：401→重登一次→重试；二次 401 NOT VERIFIED；403 不重试；无凭据不出网 |
| Docker Timescale 测试环境 | IMPLEMENTED | deploy/test compose + .env.example + TEST_ENVIRONMENT.md；未启动实例 |
| Timescale READ/WRITE/CONNECTION/PROCESS RESTART | **NOT VERIFIED** | 无实例、无管理员会话执行 |
| 30 分钟 L2 soak 工具 | IMPLEMENTED | 三所并发、共享分析器、输出 JSON；本轮未运行 |
| 三所真实 L2 采集 | **NOT VERIFIED** | 未执行 30 分钟采集 |
| 24 小时稳定性 | **NOT IMPLEMENTED** | 需在 30 分钟通过后启动 |
| 故障恢复（断线/REST 失败/DB 不可写/进程重启） | **NOT VERIFIED** | 未执行 |
| 真实历史持久化与 Journal/Timescale 一致性 | **NOT VERIFIED** | 无真实采集数据 |
| 冻结数据集 + SHA256 + 两次复现 | **NOT IMPLEMENTED** | 依赖真实采集与实例 |

## 2026-11 增补（部署验证轮）

执行环境：本机 macOS，未安装 Docker（`docker` 不存在），无 TimescaleDB 实例。

| 项目 | 状态 | 证据/原因 |
| --- | --- | --- |
| Soak 提前结束/无数据判定 | TESTED | 提前结束与 15s 无数据 → FAIL；单次读取超时；每所独立 AbortController |
| 管理员会话复用 | TESTED | 单 Cookie 复用；401 重认证一次；403 停止；reset 后重登 |
| Docker Timescale 部署 | **NOT VERIFIED** | `docker` 命令不存在，未启动实例 |
| Timescale READ/WRITE/CONNECTION/PROCESS RESTART | **NOT VERIFIED** | 无实例 |
| Binance/Bybit/OKX 30 分钟采集 | **NOT VERIFIED** | 未执行；不得缩短冒充 |
| 真实持久化 / Journal-Timescale 一致 | **NOT VERIFIED** | 无采集与实例 |
| 冻结数据集 + SHA256 | **NOT IMPLEMENTED** | 依赖真实采集 |
| 两次研究复现 | **NOT IMPLEMENTED** | 同上 |
| 24 小时 soak | **NOT VERIFIED** | 30 分钟尚未通过 |

## 2026-11 增补（研究查询可靠性轮）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 历史扫描中断分类 | TESTED | timeout / query-error / invalid-cursor / cancelled / max-pages / max-records；任何中断 truncated=true，保留已扫描数据 |
| 异常不泄露 | TESTED | query-error 仅返回分类，不含 SQL/连接信息 |
| 异步完整研究任务 | TESTED | 独立 Snapshot/L2 cursor、按 id 去重、固定 asOf、页级超时 |
| 任务状态与取消 | TESTED | QUEUED/RUNNING/COMPLETED/PARTIAL/FAILED/CANCELLED；取消后无报告 |
| 资源限制 | TESTED | 并发上限、maxRecords、maxRuntime 可配置（NOX_RESEARCH_*） |
| 大历史扫描 | TESTED | 12,500 事件完成；Snapshot/L2 独立分页 |
| Evidence Panel 集成 | IMPLEMENTED | Full research 按钮、轮询进度、取消、显式 Load report、PARTIAL 标记 |
| 真正取消 DB 查询 | **NOT IMPLEMENTED** | HistoryStore 不支持 AbortSignal，只能页间取消；已记录为限制 |
| 真实 TimescaleDB 性能/恢复 | **NOT VERIFIED** | 无实例 |
| 三所真实 L2 | **NOT VERIFIED** | 未执行 |

## 2026-11 增补（任务可靠性轮）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| AbortSignal → DB 查询 | IMPLEMENTED | 独占连接 + statement_timeout；abort 时 `pg_cancel_backend(processID)` |
| 取消状态区分 | TESTED | cancelled / query-error / timeout / max-records / report-too-large 分开 |
| 查询取消回归 | TESTED | 信号传播、扫描取消、错误分类；真实 PostgreSQL 取消 **NOT VERIFIED** |
| 完整参数指纹 | TESTED | project+factor+timeframe+start+end+asOf；不同窗口/AsOf 不复用 |
| 任务持久化 | TESTED | `<data>/research-jobs.json` 原子写；重启恢复报告 |
| 重启语义 | TESTED | 持久化的 RUNNING/QUEUED → INTERRUPTED，不伪装运行 |
| TTL / 保留上限 / 报告大小 | TESTED | 终态任务按 TTL 与数量清理；运行中不清理；超大报告 PARTIAL |
| Evidence Panel 恢复 | IMPLEMENTED | 重新加载持久化任务，展示 INTERRUPTED，需显式载入报告 |
| 真实 TimescaleDB 取消/恢复 | **NOT VERIFIED** | 无实例，未做数据库级验证 |

## 2026-11 Phase III 增补（数据可靠性 / 证据链）

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| `/api/version` 只读版本接口 | TESTED | commit/build/API version/startedAt/node；无环境或路径泄露 |
| Data Health 统一模型 | TESTED | LIVE/PARTIAL/STALE/UNAVAILABLE/NOT VERIFIED；200 但指标全空 = UNAVAILABLE |
| `/api/data-health/center` | TESTED | venues、coverage、breakers、collectors、L2、storage 聚合；10s 缓存只读 |
| Data Health UI | IMPLEMENTED | Settings 内子区域；摘要、项目覆盖、来源、诊断；30s 刷新 |
| Journal→Timescale 迁移工具 | TESTED（逻辑） | dry-run、SHA256、重复检测、幂等插入、checkpoint 绑定文件哈希 |
| 迁移真实执行 | **NOT VERIFIED** | 生产未执行；本地 dry-run 仅验证工具 |
| Evidence Manifest / 冻结数据集 / 两次复现 | **NOT IMPLEMENTED** | 尚未开发 |
| 研究质量门槛（E） | PARTIAL | 已有 partial/insufficient/truncated 语义；未形成独立可配置质量门 |
| 真实 L2 / 30 分钟 / 24 小时 | **NOT VERIFIED** | L2 collector 仍空闲 |
