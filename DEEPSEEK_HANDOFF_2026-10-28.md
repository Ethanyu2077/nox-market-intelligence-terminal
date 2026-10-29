# NOX Market Intelligence Terminal — 完整需求与优化交接

日期：2026-10-28。此文件是归并后的需求与当前状态，不是历史聊天逐字稿。历史附件或分享链接中未能读取的内容不声称已经包含；源码内既有设计文档作为补充，冲突时优先本文件的数据真实性和安全约束。

## 可直接发给 DeepSeek 的任务

你是本项目的资深全栈与量化数据工程师。请先完整阅读此交接说明及随附源码，检查实际实现，再对 NOX Market Intelligence Terminal 做增量优化。不要从零重写，不要只给计划或静态界面，不要用模拟值冒充实时数据。先输出简短的问题清单和优先级，然后实现第一批高优先级修复，提供完整可运行代码、测试结果、启动命令、变更清单与剩余事项。如果你没有文件编辑、联网、运行或测试能力，明确说明，给出逐文件补丁，不要编造已运行或已验证。

第一批优先：数据源实际可用性和语义正确性 → 权限与密钥安全 → 历史采集与缺口恢复 → 同步图表和项目切换 → UI/i18n/性能。任何外部发布、自动交易、私钥操作、生产部署、数据库破坏性迁移都须另外获得用户授权。不要要求用户在聊天上传 API Secret。

## 1. 产品定位

NOX 是独立的、以自定义外部代币项目为中心的加密衍生品研究终端，与 NOX Active MM Dashboard 分离。不是默认 BTC/ETH 扫描器，不包含自动下单或私有账户交易。仅对用户选择的市场采集高频数据。

## 2. 当前技术与目录

复用 React 18、TypeScript、Vite 6、Express、ws、Zod、原生分析图表、react-mosaic-component 研究工作区、TradingView 公共图表组件。已有本地文件历史存储、可选 PostgreSQL/Timescale 路径，以及基于 node:sqlite 的独立认证与供应商凭证存储。不要把可选数据库代码当作已部署生产设施。

- src/：现有 NOX UI、图表、研究面板、登录弹窗和数据源设置。
- server/：交易所适配、采集、分析、认证、历史、信号、供应商 API。
- shared/：统一类型及语义。
- db/migrations/：数据库结构迁移。
- tests/：计算、适配、权限、存储和供应商测试。
- .env.example：只有配置模板，不含真实凭证。
- .github/：CI、PR 模板；CONTRIBUTING.md 为协作规范。

Node 最低 22.13；建议 Node 24 LTS，因为当前启动器的代理支持需要较新 Node。不要降级到 Node 20，node:sqlite 不兼容。使用 npm ci、npm run lint、npm test、npm run build；开发 npm run dev，生产构建后 PORT=4173 npm start。默认只绑定 127.0.0.1，不应擅自公开。

## 3. 项目管理和工作区

持久化项目观察列表：符号/合约地址查找、确认正确 token 身份、发现真实上市的现货和 USDT 永续、用户选择交易所及交易对、编辑/排序/归档/移除。不得硬编码默认币种或自动添加不相关市场。全局项目切换需同时更新所有图表、指标、提醒和分析；取消旧请求/订阅，避免竞态串数据。

每项目具备：市场概览、Price/Volume/OI/CVD、市​​场结构、交易所贡献、跨所分析、Position Flow/OI Delta、高级订单流、资金费率与爆仓、订单簿/流动性、信号提醒、历史分析、研究工作区。

## 4. 数据源范围

核心永续交易所：Binance、Bitget、Bybit、OKX、Gate、KuCoin、MEXC。以 USDT 永续为主、现货辅助。新增 Upbit/Bithumb 仅 KRW 现货，不能假装支持衍生品或与 USDT 价格直接混算。

每交易所应有模块化统一适配接口、能力检查、REST 目录发现/历史回补/快照、WebSocket 成交/ticker/订单簿（以实际能力为准）。确认当前官方 API、权限、区域限制和频率上限；不绕过限制。处理心跳、重连、退避、429、序列缺口、事件去重、时间规范化和新鲜度。多用户监控相同市场应复用连接。无法支持的字段明确 unavailable/null，不填 0。

Binance Web3 是独立的认证链上数据源，不等于 Binance 交易所行情：价格、OHLC、池流动性、持币分布、标签，以及匹配链和合约的 Earn/LiquidityPool 信息。标签只是供应商分类，不是经独立证明的主体身份。类别可重叠，不累加。没有交易对手、操纵或主力行为的确定性证据时不得作断言。

CoinGlass V4 是独立第三方数据源：OI、资金费率、爆仓、taker 买卖及部分历史。符号匹配不能消除同名币歧义。用户需验证身份和套餐权限。不能把 CoinGlass All 行和各交易所行重复求和，也不能重复叠加到 native 交易所指标。

## 5. 核心计算约束

- 价格/标记价格、成交量、主动买卖量、Volume Delta、CVD、OI 基础币数量及 USD 名义值、OI Delta、资金费率/下一结算时间、spread、深度、可靠来源爆仓。
- 合约乘数、数量、币本位/稳定币本位、时间戳单位先归一化。OI USD 变动可能由价格重估导致，不能等同持仓数量变化。
- Volume Delta 来自真实 aggressor-side 成交；CVD 是按明确时间基准累积的 Delta，不是 OI Delta。滚动买卖窗口不能重叠累加成 CVD。
- 不求和价格/资金费率；明确价格成交量加权、资金费率 OI 权重及各交易所结算周期。不能混用不兼容窗口或陈旧数据。
- 聚合 CVD 只有来源单位一致、时间对齐、去重且覆盖有效时才显示；展示参与交易所、覆盖时间、缺口和数据年龄。缺失不当零。
- REST best bid/ask 不等于序列正确的完整 L2；DEX TVL/池流动性也不是 CEX 深度。
- KRW 报价保持 KRW，未实现可靠 FX 时不能并入 USD 总量或计算溢价。
- 记录来源事件时间与抓取时间，未来/陈旧时间明确质量降级，不用抓取时间冒充事件时间。

## 6. Position Flow Intelligence

同步价格蜡烛、OI 绝对值和 Delta、主动买卖量、Volume Delta、CVD；1M/5M/15M/1H/4H；OI Delta 和 Volume Delta 正负柱；指标开关、原值及百分比 tooltip、共享时间轴和 crosshair。

检测价格+OI Delta+Volume Delta、价格/CVD 背离、成交量尖峰+OI 扩张、异常 OI 增减、潜在多头/空头建立、去杠杆、潜在爆仓级联、空头回补、多头清算及吸收/流动性恢复。它们是带证据、置信度、严重性和数据新鲜度的概率推断，不是直接观察到谁开多开空。置信分数若是规则启发值，不能叫经校准胜率。

历史信号回放和回测需无未来数据泄漏；保留当时可知/已入库时间；入场、成本、滑点、样本量、未到期样本、窗口覆盖和样本外验证透明。描述性事件研究不等于经验证策略。

## 7. 图表和视觉

现有 NOX 设计是视觉事实来源：黑白灰、专业简洁、Bloomberg/Nansen 信息密度、TradingView 风格分析图，紧凑但不拥挤。保留中英文和浅/深色切换及持久化。重点修复顶栏间距、响应式、溢出、表格层级、长文案和 i18n 残留；不要装饰性卡片堆砌或重做品牌。

保持 native/TradingView 混合结构。公共 TradingView iframe 无法注入 NOX 私有指标，不能保证与 native crosshair 同步；要明确边界。完整同步在 native 可控图表内实现，不许假称 iframe 同步完成。

研究工作区可拖动、缩放、布局持久化；命令面板/快捷键、时间线、来源和 freshness、历史回放与告警继续增量优化。参考仓库须实际读许可证、标注复用来源，不复制整个产品或引入股票、财报、期权、账户组合模块。

参考：https://github.com/Hitheshkaranth/OpenTerminalUI 、https://github.com/6551Team/newsliquid-signal-skill 、https://github.com/coinpaprika/dexpaprika-mcp 、https://github.com/Nayshins/mcp-server-ccxt 、https://github.com/hugoguerrap/crypto-claude-desk 。未读取内容不能声称已评估。

## 8. AI 与信号架构

Market Adapters → Normalization → NOX Analytics → 独立 NOX Signal Engine → Signal Registry → 内部提醒 / 可选发布适配器。

AI 研究只读，明确区分 Observed Facts / Statistical Inferences / Hypotheses / Missing or Stale Data；解释须引用真实 evidence。内部信号 schema 应供应商中立，含事件 ID、时间、symbol 身份、venue、metrics、evidence、confidence、severity。

NewsLiquid 发布默认关闭，凭证仅服务端；可选签名、test mode、重试、去重、审计和安全字段投影。不得默认发送私人仓位、钱包地址、执行策略、研究私密内容。未获单独授权不得启用发布或自动交易。

## 9. 安全与协作

凭证在服务端；禁止 VITE_ 密钥、源码硬编码或响应回显。CoinGlass 已有管理员保存/替换/删除/测试接口，需审计服务端权限而不只是隐藏 UI。SQLite 凭证 AES-GCM 加密但主密钥同机，仍需文件权限/备份；不是硬件密钥库。Binance Web3 Key/Secret 目前用服务端环境变量。

匿名当前可读，分析员/管理员修改，删除和设置管理员限定；核对 direct API 401/403、会话过期、CSRF/Origin、密码哈希、节流、迁移、登出。不得自动创建默认账号或重置用户密码。不要擅自把匿名读取改成多租户隔离已完成。

使用小批次变更、feature branch/PR、测试与迁移说明；保留现有数据和配置。API keys、.data、var/auth、SQLite、master key、.env、依赖缓存不得进提交或返还给聊天。只使用 .env.example。未经同意不改变 GitHub 权限或公开仓库。

## 10. 当前实测状态与缺口（不是目标完成声明）

本地基于 fe53e58（2026-10-28 bangcoo 提交）同步启动，Node 24.22.1。lint/build 通过，119 测试中 116 通过、3 跳过（凭证/外部数据库相关）。这是此前一次检查记录，不替代你的重测。

页面看到了所选项目的 Binance/Bitget 价格、成交量、OI 和资金费率；不能据此宣称全部 9 个 venue 均实测或全部字段可用。聚合 CVD 显示覆盖不可用。CoinGlass 和 Binance Web3 capability 当前 configured=false，因此接入代码存在，但本机凭证实测未完成。密钥未随包提供。Upbit/Bithumb REST 适配已有代码，其文档记录的历史实测不代表当前全部市场仍上市。

生产 Timescale/Redis、长期稳定服务、全 venue 序列正确 L2、对齐多所 CVD、Web3/第三方长期历史、真实套餐验证、回测可靠性与生产部署仍需逐项审计。不要只看 README 勾选功能；查代码、测试及实际响应。CoinGlass capability 的 liveVerified 当前硬编码 false，需区分“配置存在”“最近认证通过”“每项目 endpoint 通过”，不要简单改为 true。

本包排除了业务运行数据和认证库，因此解压后没有本机项目列表或登录账号，空列表是正常状态。请用用户明确选择的项目验证，不内置默认 BTC/ETH。用户需自行生成一次性初始化码并创建管理员，不把 setup token 发到聊天。启动器与 npm scripts 的 .env 加载行为应先核实，不能仅创建 .env 就宣称凭证已加载。

## 11. 分阶段交付和验收

P1：项目管理+Binance+Price/Volume/OI/CVD+原生同步图表。P2：Position Flow、Funding、Liquidity、Signals/Alerts、多所正确聚合。P3：历史回放、更多 source、advanced analytics、样本外研究。现有实现跨阶段，不删掉已完成模块，但优先补正确性缺口。

每批验收：列变更文件/原因；lint/typecheck/tests/build；单元归一化/去重/CVD/OI/聚合；真实只读响应验证（缺凭证明确 blocked）；主页面和新增面板 HTTP/浏览器控制台；中文/英文、浅/深、桌面/窄屏、长标题、空/加载/错误/陈旧状态；项目切换取消旧流；权限直接 API 拒绝；迁移备份/回退；最终报告已实现/实测/未测/剩余。

先交付一个可验证的小增量，再推进下一批，不要把庞大目标一次性宣称完成。请优先给出你发现的前三个真实缺陷及证据，而不是未经验证地美化界面。
