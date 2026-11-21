# ADR-001: 语音端点判定升级为「双阈值迟滞 VAD + 语义末段判定 + 三段式时间窗」

## Status
Accepted (2026-11-04)

## Background
现状：`backend/stream_asr.py:97 END_SILENCE_MS=1200`（固定静音 1.2s 收口），
`SPEECH_THRESH=0.85`（单阈值无迟滞），前端 `js/asr-processor.js:1886 _looksIncomplete()`
纯本地正则启发式 + `MERGE_HOLD_MS=5000` 等待窗口。用户原话「不等我说完就开始说（抢话）」。
根因：固定静音阈值无法区分「句中思考停顿」与「说完了」；单阈值 VAD 在阈值附近抖动会产生
碎片切分（已在 `stream_asr.py:107-140` 记录实测：0.3~0.8s 碎片送 SenseVoice 必出垃圾）。

本机约束（已核实）：Windows x86_64 笔记本、**无独显**、Python 3.13.14、
已装 `faster-whisper 1.2.1`（自带 `silero_vad_v6.onnx`，`backend` 直接用它拿 session）。

## Decision
采用「三层端点判定」，全部在 CPU 上、无需 GPU：

1. **声学层（已有，升级为双阈值迟滞）**：保留 Silero VAD（faster-whisper 1.2.1 内置 v6）。
   引入 `neg_threshold = SPEECH_THRESH - 0.15 = 0.70`（进入语音用 0.85，退出语音用 0.70），
   这是 Silero 官方 `get_speech_timestamps` 的 `neg_threshold` 语义（默认 `threshold-0.15`）。
   作用：消除阈值抖动导致的碎片切分。
2. **静音层（改造 `END_SILENCE_MS`）**：由固定 1200ms 改为**三段式自适应时间窗**：
   - **下限 `MIN_ENDPOINT_SILENCE_MS = 320`**（低于此不判停，防句中换气被切）
   - **基准 `BASE_ENDPOINT_SILENCE_MS = 700`**（默认判停静音）
   - **硬上限 `MAX_ENDPOINT_SILENCE_MS = 2500`**（累计静音到此必提交，绝不悬挂）
   - 自适应：按用户近 `N=20` 轮「判停后又续说」的比例动态在 [320, 1000] 内调整基准。
3. **语义层（新增，替代 `_looksIncomplete` 的最终裁决）**：引入 **Smart Turn v3**
   （`pipecat-ai/smart-turn-v3`，ONNX，约 8.76MB，CPU 推理 ~12ms；本机实测可接受）。
   输入最近 ≤8s 音频（16kHz mono float32，零填充/截断到 8s），输出「是否说完」概率。
   **中文无官方语义 EOU 模型是已知限制**（Smart Turn v3 覆盖 23 语含 Chinese，
   但以英文语料为主训；LiveKit turn-detector 仅英文）→ 故语义层只做**加时**不做**减时**：
   判「没说完」→ 在基准静音上加 400ms 再确认（最多加到硬上限）；
   判「说完」→ 立即提交（不再等满基准）。

整合方式（与原代码的对接点，不改 ASR 识别本身）：
- 后端 `stream_asr.py`：`_frame_step()` 的静音计数改用双阈值 + 三段式上限；
  `END_SILENCE_FRAMES` 由常量改为运行时可变的 3 个阈值。
- 前端 `js/asr-processor.js`：`_looksIncomplete()` 保留为**零延迟快速路径**（句末标点即提交），
  仅在「疑似未说完」时调用后端 `/v7/endpoint` 语义确认（新增轻量端点，返回 0~1 概率），
  并把 `MERGE_HOLD_MS=5000` 降到 `MAX_ENDPOINT_SILENCE_MS`（2500）一致。
- 语气词（"嗯/mm-hmm"，<300ms 或命中反馈词表）→ 视为「继续聆听」，不判停、不打断（对齐 PRD EARS-V5）。

## Consequences
- 正面：句子说完即提交（≤ 基准静音），句中停顿不再抢话；双阈值消除碎片（间接修复 SenseVoice 垃圾输出）。
- 正面：全部 CPU、离线可用、无新增云依赖；模型仅 8.76MB。
- 负面：中文语义准确率不及英文（故只做加时，不做激进减时，规避误判风险）。
- 负面：语义层引入一次 ~12ms ONNX 调用（可忽略）；需新增 `/v7/endpoint` 端点与模型文件下载步骤。
- 负面：自适应窗口需要埋点统计（`turn_committed` + 续说比例），首版可先固定基准 700ms。

## Related ADRs
- ADR-003（ASR 引擎）：端点判定与 ASR 引擎解耦，可与 SenseVoice/Paraformer 任一搭配。
- ADR-002（barge-in）：端点判定决定「何时算说完」，barge-in 决定「她说话时何时让位」。
