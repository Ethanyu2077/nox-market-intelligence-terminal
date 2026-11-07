# 现状审查：L2 与 Lead-Lag（2026-11）

审查基线 `c335d90`。本文件只记录**能在代码中定位的问题**，按严重度排序；修复在后续 Task 提交中完成。

## A. L2（Task 1）

### A1 Binance — 序列衔接不完整（P0）
- `server/l2/engine.ts:63` 的 `applyDelta` 从未读取 Binance futures 的 `pu`（previous final update id），因此「数值上恰好落在窗口内、但实际漏了一条」的增量无法被发现。
- 首条增量的法定条件是 `U <= lastUpdateId+1 <= u`；当前只检查了 `U > last+1` 与 `u < last`，`u === lastUpdateId` 的重复事件会被当成有效增量套用。
- `server/l2/feed.ts` 在 REST 快照期间缓冲增量，快照应用后直接重放，没有重新校验「首条增量必须跨过 lastUpdateId」，也没有用 `pu` 校验缓冲内的连续性。

### A2 Bybit — snapshot 被当作 delta（P0）
- `server/l2/feed.ts:158` 的 `parseDelta` 只判断 `topic.startsWith('orderbook.')`，Bybit 的 `type:"snapshot"` 消息会走 delta 分支；正确行为是**重建订单簿**。
- `cts`（create time）未保留；当前 `eventTime` 取 `ts`。
- 引擎对 Bybit 只做 `u` 单调校验，这符合交易所语义，但必须在文档与完整性字段里明确「无法从 u 推断缺口」。

### A3 OKX — checksum 未实现（P0）
- `server/l2/engine.ts:20` 明确写着 checksum 未重算，`integrity` 直接返回 `checksum-unchecked`；规格要求适用频道必须校验。
- 未处理 `prevSeqId === -1`（快照标记）与 `seqId` 缺失/非数值帧；`Number(undefined)` 会进入序列比较。
- `action:"snapshot"` 只在 feed 特殊处理，engine 没有对应路径/测试。

### A4 完整性模型不足（P0）
- `L2Snapshot` 只有 `state/gaps/resyncs/integrity`；没有 `verified` 或 `lastValidUpdate` 的显式语义，UI 与 API 会把 `live` 当作「可信」。
- 结论：当前无法满足「任何无法确认完整性的订单簿不得标记为可信 Live」。

### A5 测试覆盖不足
- `tests/l2-engine.test.ts` 覆盖了基本序列/缺口/指标，但缺少真实报文 fixture：Bybit snapshot 与 delta、OKX checksum 成功/失败、Binance `pu` 断裂、乱序/重复/过期快照/损坏报文、重连后完整重同步。

## B. Lead-Lag（Task 2）

### B1 Lag 语义错误（P0）
- `server/leadlag.ts` 的 `buildPairs`：`decisionTime - (lagMs > 0 ? 0 : Math.abs(lagMs))`，正 Lag 完全不移动领先市场的观测窗口，负 Lag 才移动；正 Lag 与 0 Lag 实际是同一计算。候选 Lag 之间没有不同定义，选择结果无意义。

### B2 验证划分不符合要求（P0）
- 只有单次 70/30 切分，没有 purge（训练末尾与预测持有期重叠）与 embargo，也没有 rolling walk-forward；`selectedLagMs` 选完直接在 holdout 上评估，未在多个折叠上复验。

### B3 统计可靠性不足（P1）
- Bootstrap 是 iid 重采样，不是 moving block；没有有效样本量、参数敏感性只测了窗口、没有多重假设检验提示；baseline 缺 randomized。

### B4 时间语义需显式化（P1）
- 代码区分了 `time` 与 `availableAt`，但缺 `receivedAt` 与 `decisionTime/outcomeTime` 的显式承载；`forward()` 依赖输入已按时间排序但未强制。

## C. 不在本轮范围

- `server/orderbook.ts` 的 REST 快照与连续 L2 分离是正确的，保持不变。
- TimescaleDB 与真实断网验收见 Task 5，当前环境无法完成的项目将标 `NOT VERIFIED`。
