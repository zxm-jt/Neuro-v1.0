# ADR-003: ASR 引擎选型 —— 保留 SenseVoice 为主，Paraformer 流式为短碎片兜底

## Status
Accepted (2026-11-04)

## Background
现状：`backend/asr_sensevoice.py` 用 sherpa-onnx `OfflineRecognizer.from_sense_voice`
（`model.int8.onnx` ≈234MB，纯 CPU）。已装 `sherpa_onnx 1.13.8` / `onnxruntime 1.30.0` /
`faster-whisper 1.2.1`（模型目录 `backend/models/sensevoice/` 仅此一个）。
实测问题（`stream_asr.py:117-122` 记录）：SenseVoice 在 0.3~0.8s 碎片上输出 '。'/'に。'/'Nro.'
并乱判语种（冒日文假名）。用户已知曾 bench faster-whisper（`tests/bench_*`）。
本机无独显，全部 CPU 推理。

## Decision
**主引擎保留 SenseVoice（int8）**，**不整体更换**；针对短碎片新增 Paraformer 流式兜底（可选相位）。

三方案对比（CPU、本机 x86_64、16kHz mono）：

| 维度 | SenseVoice-small (sherpa-onnx, int8) | Paraformer 流式 (sherpa-onnx) | faster-whisper (small / large-v3-turbo, int8) |
|---|---|---|---|
| 模型体积 | ~234MB | ~140MB（轻量）/ 双语版 | small ~500MB；large-v3-turbo ~800MB |
| 中文准确率 | 94.2%（官方） | 7.5% WER 量级（官方对比表） | large-v3 中文强但 CPU 慢 |
| 中英混说 | 90.8%（官方） | 官方提供 zh-en 双语流式版 | 强（多语种训练） |
| 语种自动检测 | 有（zh/en/yue/ja/ko） | 双语版弱 | 有 |
| 短碎片(<0.8s) | **差**（出垃圾、乱判语种） | 流式按帧增量，**天然不产生"整段碎片"** | 对极短音频同样不稳 |
| CPU 延迟 | 70~200ms（1s 音频） | 流式 ~100ms/chunk 级 | small: ~1.2x 实时；large-v3 CPU 4~8x 慢于实时（**不可接受**） |
| 内存 | <1GB | <1GB | large-v3 int8 ~2~3GB RAM（无独显吃紧） |
| 结论 | **保留为主** | **作为短碎片/流式兜底候选** | **不采用 large-v3**；small 可作去噪对比基线 |

关键判断：
- **faster-whisper large-v3 在本机不可行**：CPU int8 下单机 RTF 远大于 1（需 4~8x 音频时长），
  实时对话场景延迟不可接受。distil/large-v3-turbo 亦在 CPU 上难以做到 <1s 判定。
- **SenseVoice 输在碎片、不输在识别质量**：真实问题是「送进去的是 0.3~0.8s 碎片」，
  修法在 **ADR-001 端点判定 + 现有 `SHORTCUT_MIN_S=0.8` 合并**，而不是换引擎。
- **Paraformer 流式**优势是「边收边出、不产生碎片」，可作为第二阶段增强：
  当 VAD 切出的段 <0.8s 且无法合并时，用 `sherpa_onnx.OnlineRecognizer.from_paraformer`
  （需 `encoder/decoder/tokens`，本机 sherpa_onnx 1.13.8 已含 `OnlineRecognizer` 类，已核实）走流式，
  避免离线整段解码出垃圾。**首版可选，不阻塞 MVP。**

引擎 API 已在本机核实：`sherpa_onnx 1.13.8` 暴露 `OfflineRecognizer` / `OnlineRecognizer` /
`VoiceActivityDetector` / `OfflineParaformerModelConfig`；`sherpa_onnx.__version__ == "1.13.8"`。

## Consequences
- 正面：不更换主引擎 = 零迁移成本、零重下大模型；先修「碎片」根因，性价比最高。
- 正面：明确排除 large-v3 上 CPU 的幻觉性方案（避免"看起来更强其实跑不动"）。
- 负面：SenseVoice 对 <0.8s 碎片仍需靠合并规避；若第二阶段上 Paraformer 流式，
  需额外下载模型（~140MB）并写新解码分支。
- 负面：`backend/models/` 若同时放 SenseVoice + Paraformer，注意磁盘与加载内存。

## Related ADRs
- ADR-001（端点判定）：碎片治理主要在端点层，本 ADR 只定引擎边界。
