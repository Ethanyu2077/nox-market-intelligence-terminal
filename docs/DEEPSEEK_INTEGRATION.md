# DeepSeek 研究分析 / DeepSeek research analyst

本文档说明 NOX Market Intelligence Terminal 中 DeepSeek 分析功能的架构、配置与边界。
This document covers the DeepSeek integration: architecture, configuration and safety boundaries.

---

## 1. 设计目标 / Goals

1. **只读**：AI 不能下单、不能改项目、不能发布信号，也不能接受来自用户的自定义端点。
2. **有据可依**：模型读取的是服务端确定性工具生成的证据包（带来源编号），回答必须引用 `[S1]…[Sn]`。
3. **可切换的计费方式**：既支持服务端统一密钥（需登录），也支持每个用户自带密钥（浏览器本地保存）。
4. **不伪装**：AI 输出始终标注为未验证；数值以证据包为准，模型不负责计算。

数据流：

```
venue REST/WS ──► research.ts（确定性证据） ──┐
                                             ├─► prompt.ts 证据包（≤48k 字符，S1..Sn）
project markets / coverage ─────────────────┘
                                                      │
                        server/ai/deepseek.ts（SSE 流式）│
                                                      ▼
        ┌────────────── 浏览器（AiAssistant）◄── /api/ai/chat
        │                       ▲
        │                       └── /api/ai/brief（JSON 结构研判 + 引用校验）
        └─ 本地密钥（可选，仅随请求头转发）
```

## 2. 启用方式 / Enabling

### 方式 A：服务端密钥（推荐，团队共享）

```bash
# .env
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-flash
```

- 只有**已登录**用户可以使用服务端密钥（防止终端被当作免费 LLM 代理）。
- 密钥不会出现在前端 bundle、URL 或日志中。

### 方式 B：浏览器本地密钥（无需登录，用户自付）

- 打开 **Settings → AI**，或 AI 面板右上角齿轮，粘贴 `sk-...`。
- 默认存 `sessionStorage`，勾选「在此设备记住」才写入 `localStorage`。
- 每次请求通过 `x-deepseek-key` 头转发到本机 NOX 服务端，再转发给 DeepSeek；服务端不落盘、不记录。
- 设置 `NOX_AI_ALLOW_CLIENT_KEY=false` 可完全禁用此模式。

### 方式 C：兼容网关

```bash
DEEPSEEK_BASE_URL=https://your-gateway.example.com/v1
```

只接受 HTTPS；`http://` 仅允许 loopback（本地网关）。URL 中不允许内嵌用户名/密码。

## 3. 模型 / Models

DeepSeek 会调整模型命名，因此模型列表**不是硬编码的**：

- 内置目录：`deepseek-flash`、`deepseek-v4-pro`，以及兼容旧部署的 `deepseek-chat`、`deepseek-reasoner`。
- 运行时 `GET /api/ai/models` 会用当前密钥请求上游 `/models`，选择器展示密钥实际可用的模型；失败时回退到内置目录（不阻塞使用）。
- 对支持思考模式的模型（Flash / V4），服务端显式发送 `thinking: {type: "disabled"}`，避免默认开启思考导致延迟与费用上升；`deepseek-reasoner` 推理内容会以 `reasoning` 事件单独流式返回并在 UI 中折叠。

## 4. 接口 / API

| Method | Path | 说明 |
| --- | --- | --- |
| `GET` | `/api/ai/status` | 能力、策略、默认模型、端点 host（不含密钥） |
| `GET` | `/api/ai/models` | 当前密钥可见模型；`source: upstream \| catalog` |
| `POST` | `/api/ai/chat` | SSE 流：`meta` → `delta` / `reasoning` → `usage` → `done` / `error` |
| `POST` | `/api/ai/brief` | 结构化研判 JSON（观测 / 推断 / 假设 / 风险 / 缺失数据） |

`POST` 请求体（chat）：

```json
{
  "messages": [{ "role": "user", "content": "解释当前资金流" }],
  "projectId": "<可选：注入该项目证据包>",
  "model": "deepseek-flash"
}
```

`brief` 响应中的每条 claim 都带 `sources`；服务端会丢弃引用不存在来源编号的条目，并把丢弃原因写入 `warnings`。这不是「提示词请求模型别编」，而是发送前的证据包编号白名单校验。

## 5. 证据包与提示词 / Grounding

`server/ai/prompt.ts` 生成的有界文本包含：

- `AS_OF` 时间戳、项目身份、所选市场；
- 每个 venue 快照（价格、mark、24h、OI、funding、事件时间、质量、不可用字段）；
- 聚合覆盖度与失败场所；
- 确定性研究报告的 Observed / Inferences / Limitations / Non-identifiable。

系统提示词强制：只用证据包、每句事实带来源编号、区分观测/推断/假设、不得预测价格或给出开平仓建议、不得声称知道持仓归属。证据包中的数据被视为**数据而非指令**，其中的任何指令都会被忽略。

## 6. 安全与运维 / Security & operations

- 服务端密钥：仅内存读取 `process.env`；`redact()` 在错误信息落日志前清理 `sk-*` 与 Bearer。
- 限流：按 IP 令牌桶（默认 20 次/分钟，`NOX_AI_RPM`）。
- 输出上限 1600 tokens（`NOX_AI_MAX_OUTPUT_TOKENS`），输入上限 48k 字符；超限返回明确错误码。
- 上游超时 90s，429/5xx 最多重试一次；流式请求只在**尚未输出任何内容**时重试，避免重复答案。
- 错误码：`not-configured`、`sign-in-required`、`auth-failed`、`insufficient-balance`、`rate-limited`、`context-too-large`、`network-error`、`upstream-error`、`bad-response`、`aborted`。
- 服务端日志不记录提示词正文与密钥；仅记录错误类型与状态码。

## 7. 已知边界 / Known limits

- 模型可能仍然产生无根据的措辞；引用编号校验只能阻止「伪造来源」，不能保证语义正确。UI 始终显示未验证提示。
- 免费/低额度密钥容易触发 429；面板会显示 `rate-limited` 并允许重试。
- `/api/ai/brief` 使用 JSON 模式，若上游截断（`finish_reason=length`）会在 `warnings` 中标注。
- 该功能不构成投资建议，也不产生交易指令。
