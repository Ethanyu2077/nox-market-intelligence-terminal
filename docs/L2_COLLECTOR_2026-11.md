# 项目级 L2 Collector

- 仅采集 `collectionMode === 'active'` 且开启 streaming 的项目；离开 Active 后释放 feed。
- 连续盘口复用 `server/l2/feed.ts` 的引用计数连接，页面关闭不影响采集。
- 每秒采样一次，聚合为 1s / 5s / 1m 桶；桶完成后写入现有 HistoryStore（kind `l2`，NDJSON Journal），不引入独立数据库。
- 每个桶记录：spread、bid/ask depth、imbalance、**净**深度变化、覆盖率、完整性（取桶内最差）、`verified`、序列号、缺口/重同步增量、事件时间与接收时间。
- 研究可用性：只有 `state=live`、`verified=true`、`integrity=ok`、覆盖率 ≥80% 且序列确实前进的桶才标记 `researchUsable=true`；其余桶仍写入 Journal（附 `exclusionReasons`）用于故障审计，但研究接口默认过滤。
- 深度变化标注 `attribution: net-of-fills-not-separated`：没有配对主动成交时，无法区分成交消耗与撤单，因此不会把净深度下降直接称为「撤单」。
- 查询：`GET /api/projects/:id/l2/metrics?bucket=1000|5000|60000&limit=200`。
- Timescale 镜像沿用既有迁移/可选路径；逻辑 Journal 是默认持久层。真实 Timescale 写入验收见 Task 5。
