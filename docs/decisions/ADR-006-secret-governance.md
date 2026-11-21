# ADR-006: 密钥治理 —— config.json 明文 key 迁移到环境变量，config 只留占位符

## Status
Accepted (2026-11-04)

## Background

P0 规则明确「禁止硬编码密钥」。现状核查（本轮逐行确认）：

**明文泄露点（3 处，同一把 key 重复写）**

| 位置 | 字段 | 值 |
|---|---|---|
| `config.json:3` | `llm.api_key` | `<REDACTED_API_KEY>` |
| `config.json:50` | `vision.api_key` | 同上（重复） |
| `config.json:102` | `deepseek.api_key` | 同上（重复） |

**读取点的两种模式（关键差异，决定了治理成本）**

- ✅ **已支持 env 覆盖（env 优先）**：`backend/neuro_server.py:272-292`
  ```python
  _LLM_KEY   = os.environ.get("NEURO_LLM_KEY",   _cfg_llm("api_key", ""))
  _VISION_KEY= os.environ.get("NEURO_VISION_KEY",_cfg_vision("api_key", ""))
  # 【2026-11-05】原 MOSS_API_KEY（backend/moss_vision.py）已随付费方案一并删除。
  # 现行免费视觉通道：vision_manager.py 读 config vision.free.api_key，
  # 环境变量兜底 ZHIPUAI_API_KEY / NEURO_VISION_FREE_KEY（apply_key property）。
  ```
- ❌ **直读 config、无 env 兜底**：`backend/agent_bridge.py:1096`
  ```python
  key = cfg.get("llm", {}).get("api_key", "")
  ```
  以及 `backend/memory_distill.py:69`、`backend/memory_system.py:348/667`
  （同款 `cfg.get("llm", {}).get("api_key", "")`）。

即：**同一条语音/对话主链路里，一半走 env、一半直读明文**，治理不一致。

## Decision

**统一为「环境变量唯一真源，config.json 只留空字符串占位」**，分两步落地：

1. **收口（本轮必做，低成本）**：把 `agent_bridge.py` / `memory_distill.py` / `memory_system.py`
   的 key 读取改成与 `neuro_server.py` 一致的 **env 优先** 模式：
   ```python
   key = _os.environ.get("NEURO_LLM_KEY") or cfg.get("llm", {}).get("api_key", "")
   ```
   保留 config 回退是为了**不破坏现有运行**（渐进式，不需要一次性改所有部署）。
2. **清空（本轮必做）**：`config.json` 三处 `api_key` 改为 `""`；
   真实 key 只放 `.env`（或进程环境），`.env` 加入 `.gitignore`。
   同步提供 `.env.example`（占位符，不含真值）。

三方案对比：

| 方案 | 改动面 | 安全性 | 风险 |
|---|---|---|---|
| A 只清空 config，不加 env 兜底 | 小 | **破坏运行**（未设 env 时 key 为空） | 高：一上线就 401 |
| B env 优先 + config 回退，再渐进清空（**选中**） | 中 | 高：真源在 env，config 不再含真值 | 低：先改读取点→验证→再清空 |
| C 引入 keyring / 系统凭据库加密存储 | 大 | 最高（本地加密） | 中高：Electron+Python 跨进程取密复杂，MVP 过度设计 |

选 **方案 B**：满足 P0「不硬编码」且**不引入新依赖**（不装 python-dotenv 也能用系统环境变量；
若用 `.env` 则由启动脚本注入，或轻量引 `python-dotenv`——本项目已有 venv，可选）。

**附带（同一决策批次）**：
- 立即**吊销并轮换** `<REDACTED_API_KEY>` 这把 key ——它已明文落在 git 工作区，
  按「已泄露」处理，换新 key 后再进 env。（这一步由项目总监执行，非代码改动。）
- `.gitignore` 补 `.env`；若 `config.json` 已在历史提交里，轮换是唯一有效补救（改历史不彻底）。

## Consequences
- 正面：满足 P0 硬规则；一条语音链路不再「一半明文一半 env」；key 轮换只需改环境，不动代码。
- 正面：`.env.example` 给出部署契约，新机器照抄即可起。
- 负面：需保证启动方式（Electron 主进程 spawn Python 时）把 env 透传下去——
  实现时须核对 `js/main.js` / 启动脚本是否 `env` 透传（**实现阶段验证点**）。
- 负面：config 回退若长期保留，仍有「有人把 key 写回 config」的口子 →
  在 config 注释/示例中标注「此字段留空，用 NEURO_LLM_KEY」，并在代码审查清单加一条。

## Related ADRs
- ADR-007（模型名迁移）：同属 config.json 治理，建议同批执行。
- ADR-005（工具调用）：工具链同样读取该 key，收口后自动受益。
