# 「不是替代，是生态」——生态四组件在 neuro 的落地

> 对应两张架构图：LLM 居中作为「接口与先验」，七大组件共存而非互相替代。
> 本文记录其中四个此前在 neuro 缺位/薄弱的组件如何补齐（2026-11-21）。

## 生态组件 ↔ neuro 模块映射

| 生态组件 | 职能 | neuro 落地 | 状态 |
|---|---|---|---|
| 语言模型 | 接口与先验 | `agent_bridge` + LLM（prompt 承载人格先验） | 原有 |
| 世界模型 | 规划 | `cognition.py` 工作记忆 + 效用目标项 | 原有 |
| 符号引擎 | 验证 | **`backend/symbolic.py`（新）** | ✅ 本次补齐 |
| 神经形态硬件 | 实时低功耗感知 | `flybridge` 果蝇脑 MaleCNS | 原有 |
| 强化学习 | 开放环境持续适应 | **`backend/adaptation.py`（新）** | ✅ 本次补齐 |
| 搜索与进化 | 设计与发现 | **`backend/evolution.py`（新）** | ✅ 本次补齐 |
| 胶囊 / 神经场 | 表征与几何 | **`backend/capsule_field.py`（新）** | ✅ 本次补齐 |

原则：**LLM 仍是接口与先验**，四组件都不生成文本、不碰人格，只提供
几何信号 / 候选搜索 / 验证审计 / 权重漂移，作为效用决策的输入或旁路。

## 四组件设计

### 1. 胶囊 / 神经场（`capsule_field.py`）— 表征与几何
- 文本 → signed hashing 稀疏向量（含中文 bigram），胶囊 = 向量 + 强度 + 置信度 + 来源，场强按半衰期（默认 1 天）指数衰减，相似胶囊互相竞争。
- `familiarity(text)`：语义熟悉度（与 habituation 的**时间重复**互补——这里看**语义相似**：换个说法聊同一件事也算熟）。
- `field_factor(novelty, text)`：熟→压低新异（下限 0.55），生→适度抬高（上限 1.15）。
- 接入：`arbiter.utility_scores` 的 novelty 项乘 field_factor；`on_percept` 把显著观察学进场。落盘 `memory/capsules.json`，异常/消融回落中性。

### 2. 搜索与进化（`evolution.py`）— 设计与发现
- 轻量 (μ+λ) 进化：采样候选（动作 + warmth/brevity/initiative 旋钮）→ 适应度评估 → 精英保留 + 变异 → top-k，含早停与确定性 seed。
- 接入：`utility_decide` 用**已算好的 U**做适应度（不回调 utility_scores，避免递归），结果写进决策明细 `evolved_action`（review-only）。
- **为何 review-only**：与项目"建议不自动生效"的安全立场一致，也保证不破坏既有 44+ 测试。要让它接管决策需改代码并跑全量回归。

### 3. 符号引擎（`symbolic.py`）— 验证
- 真实 OPS 工具名 → config 语义类别映射（`delete_path→file_write`、`cpp_run→shell`、`open_url→network_post` …），补上 config 里 `tool_permissions`/`privacy_redlines` 长期"声明未执行"的缺口。
- **重要立场**：用户明确要求"不做路径白名单"（能力里有什么就能用什么）。故默认**只审计不拦截**（`enforce=false`），每次调用写 `memory/tool_audit.jsonl`；只有显式设 `mind.ecology.symbolic.enforce=true` 才按 deny 类别硬拦。隐私红线命中写警告。
- 接入：`agent_bridge.run_tool` 惰性调用 `guard()`，异常绝不影响工具执行。

### 4. 强化学习（`adaptation.py`）— 开放环境持续适应
- 把 reflection 的用户反应（responded/ignored/dismissed）当奖励信号，在线微调效用权重增量：老被忽略→抬阈值/抬打扰权重；常有回应→反向。
- **安全**：默认 `enabled=false`（需显式开启）；增量有上下限、单次步长极小、7 天半衰期淡忘；不改 config（真相源），增量落 `memory/adaptation.json`，删文件即回出厂权重。
- 接入：`arbiter._util_cfg` 叠加增量（关闭时增量全 0 = 零回归）。

## 配置（`config.json → mind.ecology.*`）

```jsonc
"ecology": {
  "capsule_field": { "enabled": true, "half_life_s": 86400, ... },
  "evolution":     { "enabled": true, "population": 8, "generations": 3, ... },
  "symbolic":      { "enabled": true, "enforce": false, "audit": true },
  "adaptation":    { "enabled": false, "lr": 0.015, "min_samples": 8, ... }
}
```
`mind.ablation.*` 新增四个同名开关（`capsule-field`/`evolution`/`symbolic`/`adaptation`），
`true`=关掉该组件做消融对比。删掉整个 `mind.ecology` 段即回到纯 8 层行为。

## 验收

- `tests/check_ecology.py`：16 PASS（四模块功能 + arbiter 接入零回归）。
- 既有回归：`check_utility_mind` 14、`check_ablation` 6、`check_8layers` 24、`check_arbiter` ALL PASS。
- 说明：`check_utility_mind` 原依赖本机脑服务的 speaking 状态，已加测试隔离（锁定 stale 脑状态），产品代码未改。

## 自主意图（2026-11-21 追加，evolution 真正接管决策）

用户要求"evolution 真正接管决策 + 以果蝇脑为生物基础的自主意图"。

### 能力边界（必须如实声明）
实现的是**功能性自主意图**，不是主观意识/qualia。不宣称果蝇脑产生意识
（这是项目第一轮就定下的边界）。可验证的是：行为由内部状态（果蝇脑低层轴 +
连续驱力）形成的持续目标驱动，有连续性、有偏好、可被观察，而非 LLM 每次自由发挥。

### 实现
- `backend/intent.py`（新）：果蝇脑四轴（arousal/valence/tension/satiety）+ withdraw +
  sleep_pressure + 6 驱力 → 六类意图（exploratory/social/mastery/restorative/restful/avoidant）。
  - 低唤醒 → 冻结（不形成探索意图）；高 withdraw+低效价 → 趋避意图；高睡眠压力/rest 驱力 → 休息意图。
  - 生命周期：形成 → 时间衰减 → 行为满足则下降 → 见底/超时换新。落 `memory/intent.json`，跨会话连续。
  - 两条反哺路径：① `consistency(action)` 给效用动作加一致性偏置；
    ② `veto_proactive()` 让强退出型意图（休息/趋避，强度≥0.5）**否决主动开口**。
- `backend/evolution.py`：`decide_action(U, intent_consistency)` 真正接管动作选择——
  适应度 = 效用分 + 意图一致性偏置。消融/异常回落纯效用 argmax。
- `arbiter.py`：主动链路（vision/idle）用 `decide_action` 的结果；reply 保持脑开关不变
  （"叫她可以不说话"的既有契约不动）。脑 speaking/withdraw 硬闸与意图否决叠加。
  reason 形如 `utility:evolution+intent:speak=0.404>=thr=0.27+intent=0.49`。

### 端到端实证（同一空闲时机，内部状态不同→决策不同）
| 内部状态 | 意图 | 决策 |
|---|---|---|
| 社交驱力高 | 想找你说说话 (0.54) | **speak** |
| 果蝇脑高趋避 | 想躲开一下 (0.90) | silent（withdraw 硬闸） |
| 休息驱力高 | 想歇一会儿 (0.57) | silent（intent_veto） |

### 验收
- 新增 `tests/check_intent.py`：19 PASS（意图形成/连续性/满足闭环/果蝇脑驱动/evolution 接管/否决）。
- 既有全绿：check_ecology 16 / check_utility_mind 14 / check_ablation 6 / check_8layers 24 / check_arbiter ALL PASS。

### 待用户决定
1. adaptation 在线学习（`ecology.adaptation.enabled=true`）——默认关。
2. symbolic 硬拦（`enforce=true`）——默认只审计。
3. 意图否决参数（`veto_above=0.5`）——太低会显得"总不想理人"，可在实机观察后调。
