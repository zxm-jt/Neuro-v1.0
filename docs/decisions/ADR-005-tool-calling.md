# ADR-005: 工具调用协议 —— 保留自研 [[TOOL:]] 文本协议，不迁移原生 tool_calls（本轮）

## Status
Accepted (2026-11-04)

## Background
现状：`backend/agent_bridge.py` 自研 `[[TOOL:{"op":..,"args":..}]]` 文本协议 + `TOOL_PROMPT`
（12 个文件类工具），已有「假装执行」检测与强制重问兜底（`agent_bridge.py:2360-2400`）、
失败重试/退避（`_llm_stream_once`）。上游经 6006 本地代理到 DeepSeek（`upstream_url`）。

**上游能力核实（关键）**：DeepSeek API **原生支持 tool_calls**（官方文档 api-docs.deepseek.com
`guides/tool_calls`），兼容 OpenAI 格式，非思考/思考模式均支持，并有 `strict` 模式（beta，
确保输出符合 JSON Schema）。当前 `config.json` 的 model 为 `deepseek-flash`。
注意官方文档同时注明 `deepseek-chat`/`deepseek-reasoner` 将于 **2026-07-24 弃用**，
应迁移到新版模型名（`deepseek-flash` 系列）。

方案对比：

| 方案 | 改造代价 | 收益 | 风险 |
|---|---|---|---|
| A 保留自研 `[[TOOL:]]`（本轮） | 0 | 现有兜底/重问/确认流程都可复用 | 解析脆弱（模型偶发写坏标记）；无 schema 强约束 |
| B 迁移原生 tool_calls | **中高**：改 `llm_stream`、`chat_completions`、工具结果回灌、前端流式解析；重写 12 工具为 JSON Schema | 消除文本解析；并行工具调用；strict 模式可强约束 | 流式 tool_calls 增量拼接（`agent_bridge.py` 现有 SSE 转发逻辑需改）；思考模式下需回传 `reasoning_content`（官方要求）否则 400 |
| C 混合：新增路径走原生，旧路径保留 | 中 | 渐进迁移，风险可控 | 双协议并存，维护成本 |

## Decision
**本轮保留方案 A（自研文本协议）**，把 `[[TOOL:]]` 迁到原生 tool_calls 列入 Backlog（对齐 PRD F6）。
理由：
1. 本轮 MVP 焦点是语音链路（F1~F4），工具协议与语音解耦，迁移收益不在本轮验收指标内。
2. 现有兜底（假装执行检测、破坏性操作确认、强制重问）是**经过实测修复的资产**
   （`agent_bridge.py:736,2360`），迁移时需等价保留，成本不低。
3 . 原生 tool_calls 的**流式增量拼接**是本项目 SSE 转发链路的实质改动点，风险集中。

**但立即执行的加固（低成本、必须做）**：
- 协议解析加**正则兜底**：`TOOL_RE` 已用 `re.S`；增加「标记写坏 → 静默不发」的既有行为保持
  （`agent_bridge.py:2404-2413`），避免把 `[[TOOL:...]]` 念出来。
- 工具参数解析失败 → 不发、不假装（已有），补一条埋点 `asr_error`/`tool_parse_error`。
- 在 `TOOL_PROMPT` 顶部加一句「参数必须符合下列字段，未知字段不要编造」（降低幻觉参数）。

## Consequences
- 正面：零迁移成本，聚焦语音 MVP；现有兜底资产不丢。
- 负面：文本协议解析天生脆弱（依赖模型严格遵循格式），已有强制重问兜底但会多一次 LLM 往返。
- 负面：无法用 `strict` 模式强约束参数（原生 tool_calls 独有）。
- 决策留痕：待语音主链路稳定后，按方案 B/C 迁移，届时复用本 ADR 的对比与风险清单。

## Related ADRs
- ADR-007（模型名迁移）：原生 tool_calls 与 `deepseek-flash` 模型名迁移应同批实施。
