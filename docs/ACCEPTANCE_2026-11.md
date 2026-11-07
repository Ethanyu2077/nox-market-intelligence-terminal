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
