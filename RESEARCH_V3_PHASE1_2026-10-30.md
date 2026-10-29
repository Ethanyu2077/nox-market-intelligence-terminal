# NOX Research V3 — Phase 1 delivery

日期：2026-10-30（Asia/Shanghai）。基于 R23 + 朋友 signal-rules + Impeccable UI。此文件优先于旧 START_HERE、UI_UPDATE 和历史研究报告的状态声明。

## 已完成

1. 吸收异常改用同长度、完整覆盖的历史 flow 窗口基准；稳定单桶成交差不再因累计窗口变长而成为异常。
2. 自适应证据逐项报告价格/OI阈值及是否通过；吸收、背离不再被统一描述成双阈值突破。
3. shared/research-window.ts 统一研究窗口边界：按入场/退出闭合时间检查、拒绝缺口、拒绝尚未完成的结果、支持可用时间及延迟入场。离线 train 退出不得越过 split；test 退出不得越过 end，基准同步处理。
4. 生产链路 Binance marketSeries → backtestPositionSignals → computeLedger → positionFlow.backtest.execution → 仓位资金流研究页面，已接通统一账本。仅 hypothesis 进入收益计算，withheld 单独计数。
5. 生产账本场景使用固定基础币数量、每边5bps假设手续费及1bps假设滑点。输出为成本后、资金费前的名义金额收益，不是账户收益；资金费明确 unavailable。配置尚未开放给用户。
6. 修复账本费用/滑点/资金费 NaN/Infinity、非法side、负成交价/极端滑点、算术溢出、资本分配 NaN杠杆/错误时间等边界。平局计入胜率分母；零笔仍为null。quantity与乘数语义已明确。
7. 页面分别呈现 gross direction 与 ledger cost scenario，保留NOX UI，中英文账本说明及版本号；不以缺失数据补零。

## 测试与实际验证

- Node24.22.1：完整202项测试，199通过、0失败、3跳过（显式opt-in外部源/数据库）。新增6项V3测试，覆盖跨界、缺口、未完成K线、可用时间、账本接通、同尺度吸收和证据文案；既有默认规则文案断言相应更新。
- lint、TypeScript/Vite build通过；主chunk约511kB的体积提示仍在。
- 28天五币、18种规则已实际重跑。每币8352根5m K线及8352条OI；检查无K线间隔缺口、无重复OI时间戳、无非法价格/成交量和买量超过总量。
- 独立本地预览4180返回HTTP200；真实选定ARIA项目的仓位资金流页显示新版场景。历史成交覆盖不足时为0可用样本、收益为—，withheld仍展示，不为UI捏造有效样本。检查中文/英文、桌面展示及无整页横向溢出；本次没有完整跨浏览器/所有页面回归。

## 修正研究结果

输出 research/signal-rules-2026-10-29/results/walkforward-v3.json，旧结果不覆盖。

训练期选择仍为 w60m q90 imb0。60m测试非重叠64样本，方向命中48.4%，固定扣10bps后平均-0.135%，t约-0.10；延迟一根K线为-0.893%。这是描述性模式研究，不是可执行账户回测。差异来自边界、门控与同尺度基准等组合修正，不能全部归因于某一个修复。

离线研究继续沿用原始固定10bps扣减以便对照，不含生产账本1bps/边滑点场景；两种口径明确分开，不能互相当作相同净收益。训练/测试按时间隔离已修正，但这批数据以前已被查看，并非真正新鲜、未见样本；18参数及五个相关小币也不足证明稳定优势。未做分块bootstrap或统计校准。

## 复现

```sh
npm ci
npm run lint
npm run build
npm test
node --import tsx research/signal-rules-2026-10-29/walkforward.mjs server/calculations.ts IDOLUSDT DOSUSDT JCTUSDT DOODUSDT EVAAUSDT
```

使用Node24。运行研究会重写 walkforward-v3.json；保留原始数据，不重新fetch才可对照本次结果。历史HTML、backtest/subsets/regress和旧结果是上游版本资料，未按V3更新，不作为本次新结果或默认完全兼容声明。

## 未完成/下一批

- 动态cash/equity/freeMargin、按时间资金费、重叠持仓、逐时mark-to-market回撤仍需Phase2；allocateByCapital只是静态占用预算，未包装成账户模拟器。
- 新账本目前只接仓位资金流研究入口；alignment/event study及其他离线脚本尚未统一。
- 历史信号可用时间目前为理论边界；未获得真实历史ingest/处理延迟时，不应声称可按边界开盘成交。延迟敏感性不能替代实际延迟记录。
- 需要持续积累数据覆盖、冻结规则/输入快照、严格滚动新样本验证、跨项目/市场状态验证、相关性稳健区间和更多成本敏感性。
- 未引入GS Quant或高盛服务，无新Python服务；借鉴的是职责分离方法。未启用自动交易、外部信号发布或公开部署。

## 启动与回退

先build；`PORT=4180 npm start`启动生产式本地服务，端口占用时换空闲端口。开发用npm run dev。运行数据仍为DATA_DIR，认证NOX_AUTH_DIR；本次预览用独立.preview-v3/.preview-v3-auth，仅复制用户已有选定项目元数据，未复制凭证。交付包排除所有运行目录、依赖和构建产物。

没有数据库迁移；新增execution字段兼容旧响应。回退到上一份 NOX-R23-UI-Impeccable-2026-10-29.zip 即可，保留自己的运行数据，不覆盖或删除账号和项目数据。4179旧服务未改动；4180是本轮独立预览。
