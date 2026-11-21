# Neuro 桌宠 · 8 层认知架构落地说明

> 2026-11-21 | 基于用户提出的 8 层桌宠架构 + 效用选择 + 果蝇脑正确用法
> 本文件是**落地映射**，记录"要求 → 代码 → 验证"的对应关系。

---

## 一、8 层映射表

| 层 | 要求 | 落地位置 | 状态 |
|---|---|---|---|
| 1 感知层 | 屏幕/摄像头/麦克风/时间/输入/工具结果 | `vision_manager.py`/`stream_asr.py`/`cognition.observe()` | 已有 |
| 2 世界模型 | 用户在哪/做什么/桌宠位置/任务/环境事件 | `cognition._WM`（turn_state/task/goal/observations）+ `body_loop`（本体感知） | 已有+增强 |
| 3 内部状态/驱力 | 好奇/社交/休息/秩序/成就/无聊，连续变量 | `cognition.py` 6 驱力状态机（0~1，指数回归+事件冲击+懒惰积分） | ✅ 新增 |
| 4 记忆分层 | 工作/情景/语义/程序 + 时间/来源/置信度/遗忘巩固 | `cognition._WM`(工作) + `memory_system.py`(情景/语义) + `memory_layers.py`(分层元数据+程序记忆) | ✅ 新增 |
| 5 快慢双系统 | 规则毫秒级 + LLM 秒级；果蝇放低层 | `arbiter.py`(毫秒裁决) + LLM(秒级) + `drive_client`(果蝇桥) + `habituation.py`(习惯化) + `body_loop.py`(闭环) | ✅ 增强 |
| 6 主动循环 | 观察→小目标→评估打扰→执行→记录→**反思** | `arbiter.decide()` + `reflection.py`（决策记录+反应回填+反思建议） | ✅ 新增 |
| 7 抑制与边界 | 打扰预算/静默时段/不确定性阈值/工具权限/隐私红线 | `cognition.can_speak_proactive` + `utility_scores` 的 intrusion/risk + `config.mind.utility` 的 quiet_hours/permissions/redlines | ✅ 增强 |
| 8 离线巩固 | 睡眠压缩记忆+更新习惯+**明天想做的事** | `flybridge/trainer.py`(脑侧) + `consolidation.py`(习惯提炼+tomorrow.json) + `memory_system.session_end` 接入 | ✅ 新增 |

---

## 二、效用选择（最关键）

**公式**（`arbiter.utility_scores()`）：

```
效用 = w_drive×驱力满足 + w_goal×目标相关 + w_novelty×新异性
     + w_social×社交价值 − w_intrusion×打扰成本 − w_risk×风险 + w_delay×延迟成本
```

三候选 `speak / ack / wait` 打分，取最高分且超过阈值（`mind.utility.threshold=0.27`）才主动行动。

**果蝇脑的正确位置**（不宣称意识）：
- 脑唤醒 `speak` 对新异性做乘性门控 + 硬闸 `arousal_gate=0.35`：低唤醒→不探索；
- 脑 withdraw 高 → 低层趋避否决；
- 脑没起 → risk 项抬高 + 回落到认知硬闸，绝不阻断主链路；
- **不接全局人格**（人格仍由 `persona.py` 的连续偏好控制表情/门槛）。

**habituation**：同类视觉刺激重复 → 反应系数 ×0.72 衰减（下限 0.15），半衰期 90s 恢复。重复画面不再反复触发好奇。

---

## 三、身体闭环（阶段5）

```
内部状态(6驱力) ──reflex()──> 动作(act)
      ▲                          │
      └── 感知回灌 <── 本体感知 ──┘   (drive_event + drive_client.stimulate + cognition.observe)
```

- `reflex()`：休息需求>0.75 → rest；无聊>0.6 → look；
- `act()`：把动作回灌成感知（look→视觉/好奇，headpat→社交满足等）；
- 实测闭环：无聊 0.9→0.68（下降）、好奇 0.35→0.53（上升）；
- 本体感知带 `[self]` 标记，不触发视觉自我强化式乱搭话。

---

## 四、验收指标对接（`reflection.py` + 日志）

| 用户要求的指标 | 数据位置 |
|---|---|
| 主动发起频率/相关性 | `reflection.jsonl` 的 decision 时间戳 + `stats().proactive_last_hour` |
| 打扰率（忽略/关闭比例） | `stats().intrusion_rate` |
| 主动相关性 | `stats().relevance_rate` |
| 记忆一致性（三天后记得偏好） | `memory_layers` 的 confidence/hits + resident facts |
| 人格稳定性 | `persona.py` 固定连续偏好（未改动） |
| 反应延迟 | 快：`arbiter` 毫秒裁决；慢：LLM 秒级（既有架构） |
| 成本 | 现有 token/工具预算 + `config.mind.utility.hourly_proactive_cap` |
| 安全 | `config.mind.utility.tool_permissions` / `privacy_redlines`（声明层，工具层需执行） |

`reflection.reflect()` 累积 ≥12 条带结果记录后产出策略微调建议到 `memory/reflection_insights.json`（**不自动生效**，供人审）。

---

## 五、配置速查（`config.json → mind`）

- `drives.base` / `tau_s`：6 驱力基线/回归时间常数
- `utility.threshold=0.27` / `weights` / `quiet_hours=[[1,7]]` / `hourly_proactive_cap=8`
- `utility.tool_permissions` / `privacy_redlines`：工具权限与隐私红线声明
- `ablation.{drives,utility,habituation,brain-gate}`：消融开关（日常全 false）
- `body_loop.enabled`：身体闭环回灌开关

删掉整个 `mind` 段 → 代码内默认值兜底，行为回落到效用核心启用前的状态。

---

## 六、验证

| 测试 | 结果 |
|---|---|
| `tests/check_utility_mind.py` | 14 PASS（驱力/效用/阈值/回落） |
| `tests/check_ablation.py` | 6 PASS（四组件消融贡献） |
| `tests/check_8layers.py` | 24 PASS（记忆分层/反思/习惯化/巩固/闭环） |
| `tests/check_arbiter.py`（旧回归） | ALL PASS（无回归） |

运行：`python tests/check_utility_mind.py && python tests/check_ablation.py && python tests/check_8layers.py && python tests/check_arbiter.py`
