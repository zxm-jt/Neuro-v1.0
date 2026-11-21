# ADR-004: 连续屏幕感知以「本地抽帧 + 变化检测 + 免费视觉理解」为主链路

## Status
Accepted (2026-11-04) ；**Amended (2026-11-05)：弃用 MOSS 付费方案，改免费 GLM-4V-Flash。**

## Background
现状：`js/vision-pump.js` 已实现主进程 desktopCapturer 抽帧 + 变化检测 + WS 推流，
但 `js/main.js` **零引用（孤儿模块，已核实 `grep vision-pump js/main.js` 无结果）**。
后端 `backend/vision_manager.py`（观察管理、去重、主动开口）已实现。
现有单次截图路径：`/v4/check` 判定 → 截图 → 注入 DeepSeek 多模态（`_vision_chat`）。
已有端点：`/v1/vision_frames`（上行帧 WS）、`/v1/vision_speak`（下行台词 WS）、
`/v1/vision/ask|start|stop|status|observations`。

## Amendment (2026-11-05) —— 为什么改
原设计的视觉理解后端是 **MOSS-VL-Realtime（`moss-vl-realtime-1.0`，第三方实时视觉服务）**。
经核实该服务**按在线时长计费**，而本项目要求「从打开的那一瞬间就持续注视屏幕」——
在线时长计费模型下，常开注视等于持续扣费，成本不可接受。
用户明确要求**彻底放弃 MOSS 并删除全部相关代码**。

**替代方案：智谱 GLM-4V-Flash**（官方标注**完全免费**，OpenAI 兼容接口，
`https://open.bigmodel.cn/api/paas/v4/chat/completions`，model `glm-4v-flash`）。
备选通道（代码里留接口位，默认不启用）：SiliconFlow `Qwen/Qwen3-VL-8B-Instruct`（付费但极便宜）。

**架构不变，只换底层供应商**：`backend/moss_vision.py` 已删除；
`backend/vision_manager.py` 重写为基于免费 HTTP 视觉 API 的视觉管理器，
对外接口（`active/status/start/stop/push_frame/ask/observation_context/
observations/clear_observations/mark_start`）保持不变，
`neuro_server.py` 的调用点与 `/v1/vision*` 端点全部保留。

## Decision
**本地抽帧 + 本地变化检测 + 免费云端视觉理解** 为主链路。

方案对比（含已废弃方案）：

| 方案 | 隐私/离线 | 成本 | 主动开口能力 | 本机可行性 |
|---|---|---|---|---|
| A 仅本地抽帧（vision-pump 接线） | 最好（不出本机） | 0（本地 CPU） | 需自建「变化→主动开口」 | **高**（模块已写好，只差接线） |
| ~~B 仅 MOSS-VL-Realtime~~ | 差（帧上传云端） | **按在线时长计费** | 模型原生 proactive | **已废弃** |
| **C 本地抽帧 + 变化检测 + 免费视觉理解（现行架构）** | 可控（本地上报显式可关） | **0（免费额度）** | 本地触发 + 云端确认 | **高** |

现行架构（帧如何变成她的感知与主动开口）：
1. **抓帧（主进程）**：`js/main.js` 接线 `VisionFramePump`（`js/vision-pump.js`）——
   `desktopCapturer` 1fps、最长边 1280、JPEG q62、缩略图变化检测（阈值 0.06）。
2. **上行**：帧 WS 推到后端 `/v1/vision_frames`。
3. **本地感知（后端本地判断，不发云）**：`vision_manager.push_frame` 三道闸
   - ① 变化检测：帧像素差比例 < `vision.free.change_threshold`（默认 0.06）→ 不联网。
   - ② 最小调用间隔：距上次真正调用不足 `vision.free.min_interval_s`（默认 6s）→ 不调用。
   - ③ 观察去重：相似观察合并计数（Jaccard ≥ `observation_dup_similarity`），
     只留最近 `max_observations` 条。
4. **视觉理解（免费）**：通过全部闸门的帧 → GLM-4V-Flash → 一段客观英文描述。
   模型回 `nothing notable` 时**不入队、不触发台词**（避免静止画面反复废话）。
5. **主动开口**：观察 → 经 DeepSeek 按 Neuro 人设组织成一句 → TTS + Live2D 表情
   （沿用 `vision_manager.on_speech` → `/v1/vision_speak` 下行 → 前端播报）。
6. **用户提问**：`/v1/vision/ask` 基于最近一帧作答（精度要求更高的场景）；
   `/v4/check` 在**已有实时观察**时直接返回「不需截图」并附上观察文本（省一次多模态往返）。

## Consequences
- 正面：**零成本**常开注视（免费视觉额度 + 本地变化检测过滤掉绝大部分帧）。
- 正面：接口契约未变，`neuro_server` / `vision_persona` / 前端调用点无需大改。
- 正面：隐私可控（帧只在显著变化时才上传，且上传目标为免费服务；可整体关闭）。
- 负面：免费额度仍有 QPS/日限额，观察的触发质量取决于 `change_threshold` 与
  `min_interval_s` 调参；`fps=1` 对快速操作有漏看可能。
- 负面：视觉描述质量受免费模型能力限制（复杂 UI / 小字可能读不准），
  需要精确读数时走 `/v1/vision/ask` 或保留的单次截图路径。

## Related ADRs
- ADR-006（密钥治理）：`vision.free.api_key` 与 DeepSeek Key 同属需治理的明文密钥，
  配置中一律留空由用户填写，代码不写死占位密钥。
