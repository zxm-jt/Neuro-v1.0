# ADR-007: 模型名迁移 —— 清除残留旧别名 deepseek-chat，统一以 env 覆盖

## Status
Accepted (2026-11-04)

## Background

**上游事实（已联网核实，2026-11-04）**：

- DeepSeek 官方已退休旧模型名 `deepseek-chat` 与 `deepseek-reasoner`，
  停用时间 **2026-07-24 15:59 UTC**；过渡期内二者分别映射到 V4-Flash 的
  **非思考 / 思考**模式。停用后这两个名字**不再可用**。
- 当前官方模型名为 **`deepseek-flash`**（服务 DeepSeek-V4.1-Flash-1017）与 `deepseek-v4-pro`。
- 官方注：**thinking 现默认开启**；原先依赖 `deepseek-chat`（非思考）行为的代码，
  需显式传 `{"thinking": {"type": "disabled"}}`。
- 关键点：**不支持的模型名可能被静默映射到 `deepseek-flash`** ——
  迁移「看起来成功」但实际路由到默认模型，必须靠 provider 侧用量核对。

**本项目现状核查**：

| 位置 | 内容 | 判断 |
|---|---|---|
| `config.json:6,7,8,15,51,104,105` | `deepseek-flash` | ✅ 已是新名 |
| `backend/memory_distill.py:71` | `cfg.get("llm",{}).get("model","deepseek-chat")` | ❌ **fallback 仍是退休名** |
| `backend/memory_system.py:350` | `llm.get("model","deepseek-chat")` | ❌ 同上 |
| `backend/memory_system.py:682` | `llm.get("model","deepseek-chat")` | ❌ 同上 |
| `backend/neuro_server.py:3294` | `body.get("model","deepseek-chat")` | ❌ 请求体缺省仍是退休名 |
| `backend/agent_bridge.py:1099` | `cfg.get("llm",{}).get("model","kimi-k2.7-code")` | ⚠️ fallback 是 Kimi 名，与 DeepSeek 上游不符（脏回退） |
| `backend/agent_bridge.py:1167-1177` | 已实现 `thinking_mode` / `reasoning_effort` / `payload["thinking"]` | ✅ 与新模型语义**已对齐**，无需改 |
| `tests/probe_ds_vision_truth.py:98` | 仍在探 `deepseek-flash` / `deepseek-chat` | ⚠️ 测试脚本含退休名，需清理 |

**重要澄清**：`agent_bridge.py` 的 thinking 处理（`:1167-1185`）**不是问题、而是已做对的部分**——
它已按官方「thinking disabled 才发 temperature/top_p」的规则实现，正好适配「thinking 默认开启」的新行为
（即：想关思考就得显式 disabled，本项目默认就是 disabled → 默认拿到快路径）。
故本 ADR **不改运行语义**，只清「会 400 / 会静默误路由」的旧名残留。

## Decision

**统一模型名解析：env 优先 → config → 代码常量 `"deepseek-flash"`，删除一切 `deepseek-chat` 残留。**

1. 三处 fallback 字符串 `"deepseek-chat"` → `"deepseek-flash"`：
   `memory_distill.py:71`、`memory_system.py:350,682`、`neuro_server.py:3294`。
2. `agent_bridge.py:1099` 的 `"kimi-k2.7-code"` 脏回退 → 与其余一致，改 `"deepseek-flash"`；
   并要求该处 key/model 一并走 **ADR-006 的 env 优先**读取。
3. 新增模型名 env 覆盖（与 `neuro_server.py` 现有 `NEURO_LLM_MODEL` 对齐）：
   `agent_bridge` / `memory_*` 读 `NEURO_LLM_MODEL` 优先于 config。
4. `tests/probe_ds_vision_truth.py:98` 移除 `deepseek-chat`，避免测试脚本继续打退休名。
5. **迁移后验证**（`agent_bridge.py` 已有的用法不得回退）：
   - 非思考路径：`thinking_mode=disabled` 时**不发送** temperature/top_p（现状保持）。
   - 若将来开思考：发 `thinking={"type":"enabled"}` + `reasoning_effort`，
     并在多轮工具链回传 `reasoning_content`（官方要求，否则 400）——与 ADR-005 方案 B 同批。
   - 到 provider 控制台核对用量确实记在 `deepseek-flash` 上（防「静默映射」假成功）。

三方案对比：

| 方案 | 改动面 | 风险 |
|---|---|---|
| A 不动（靠 `config.json` 已是 `deepseek-flash` 兜着） | 0 | **高**：任何 fallback 命中就打到退休名；缺省路径已含 3 处旧名 |
| B 清残留 + env 统一（**选中**） | 小（4 个文件、字符串级） | 低：纯常量替换 + 已验证的 thinking 逻辑不改 |
| C 大改：引入模型路由表 / 多模型编排 | 大 | 中高：超出 MVP，且当前只有单上游 |

选 **方案 B** —— 这是「线上随时会 400」的正确性修复，不是优化项，**建议本轮就做**。

## Consequences
- 正面：消除旧别名触发 400 / 静默误路由的隐患；模型名有了 env 单一覆盖点。
- 正面：与 ADR-006 的 env 治理同批完成，config.json 变成「无密、无版本硬编码」的干净契约。
- 负面：`memory_*` 模块若原本依赖 config 里其它字段，改读取时须回归一次提炼/摘要功能。
- 负面：`config.json` 的 `system_prompt` 体积很大（含情绪协议），
  未来若也想 env 化会很长——本 ADR 不处理，仅倡议保持 config 为「可读配置」而非「密钥仓库」。

## Related ADRs
- ADR-006（密钥治理）：同批执行，二者共同把 `config.json` 收敛为无密配置。
- ADR-005（工具调用）：原生 tool_calls 迁移与此同批，因两者都要动 `agent_bridge.py` 的请求构造。
