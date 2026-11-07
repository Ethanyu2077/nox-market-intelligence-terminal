# 数据可靠性与能力注册表 / Data reliability increment

本文件记录 2026-11 的可靠性增量：告警作用域与持久化、统一能力注册表、按端点族的熔断、陈旧输入抑制。

## 告警 / Alerts

- **作用域**：规则可限定 `projectId`、`venue`、`marketType`、`timeframe`；未填写表示「任意项目 / 项目聚合 / 默认永续 / 无周期限制」。
- **周期语义**：`timeframe` 是评估粒度，冷却时间不短于该周期（例如 `1h` 规则至少冷却 1 小时）。它不改变 24h 指标的窗口。
- **持久化**：`data/alerts/state.json`（v2）保存事件、每条规则的运行时（`armed`、`lastFiredAt`、`lastValue`、`lastEvaluatedAt`）与投递记录。重启后不会重复触发同一穿越。
- **幂等**：事件带 `idempotencyKey = ruleId:observedAt:value`，即使状态文件丢失，重放同一观测也不会追加第二条。
- **投递追踪**：本地事件日志是唯一投递目标（外部发布仍关闭）。每条事件有 `pending/delivered/failed`、尝试次数、最近错误；写盘失败会保留并在下一轮重试。
- **陈旧读法**：快照超过 5 分钟（或解析器显式标记 stale）→ 规则状态 `unavailable`，不会把缺失当作条件不成立。

## 能力注册表 / Capability registry

`GET /api/capabilities` 统一输出「场所 × 端点族」矩阵：

| 端点族 | 含义 |
| --- | --- |
| `discovery` | 交易对目录 |
| `snapshot` | 24h 行情快照 |
| `series` | 原生 K 线 / 成交带 |
| `depth` | REST 盘口快照（Binance / Aster） |
| `flow` | 主动成交带（Binance / Bitget / Bybit / OKX / Gate / KuCoin） |
| `liquidation` | 公开清算流（Binance / Bybit / OKX） |

每格包含 `supported`、`transport`（native/ccxt/none）与实时 `coverage`（live / degraded / unavailable / idle、冷却截止、最近成功/失败、错误）。设置页「数据能力与覆盖」直接渲染该矩阵；已实现的模块（深度、清算、flow）以注册表为准，不再各自硬编码。

## 熔断 / Breakers

断路器按 `venue × family` 独立计数：连续 3 次失败打开 60 秒（1.8× 退避，上限 10 分钟），半开仅放一个探针。盘口故障不会阻断同场所的快照，反之亦然。

## 陈旧输入 / Stale inputs

- 原生序列最后一根 K 线超过 `max(3×周期, 15 分钟)` → 返回 `signals: []`，并在 methodology 中注明「信号已因窗口陈旧而抑制」。
- 告警同样以 5 分钟为快照新鲜度上限。
- 未实现的能力一律 `unavailable` 且带原因，绝不返回零值。
