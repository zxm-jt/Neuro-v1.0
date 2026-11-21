# ADR-002: 打断（barge-in）升级为「前端声学层即时停播 + 后端音色/回声双门控」

## Status
Accepted (2026-11-04)

## Background
现状：打断要走「识别出文本 → 前端 `abortCurrentReply()`」文本层链路（`js/voice-chat.js:569`），
延迟 = 端点判定 + ASR 解码 + 网络往返，实测数百 ms~秒级。
另有 `config.json:71 suspend_mic_while_tts: true`（TTS 期间挂起麦克风）+ `tts=1` 期间
`stream_asr._frame_step()` 只认「男声帧（基频≤160Hz）」才切段（`stream_asr.py:612`）。
前端已有 `js/interrupt-manager.js:109 classifyInterruption`（语气词不打断/有效打断续接）。
AEC 现状：`js/asr-processor.js:128 MIC_ECHO_CANCELLATION = false`（实测开启后把她的话
也当回声消掉 → 用户声音 VAD 概率从 0.9+ 掉到 0.61~0.89 → 识别不上，故关掉）。

## Decision
采用**双路并行**：本地声学层「先停播」，后端音色层「精确确认」。

1. **前端声学层（新增，先停播）**：麦克风常开 + 环形缓冲（已有 `RING_MS=1000`）。
   在 TTS 播放期间监听麦克风电平/基频，检测到「持续人声」（已有 `_handleBarge`，
   `BARGE_HOLD_MS=90`）**立即本地 `ttsProcessor.reset()` 停播**（≤150ms），
   **不等**识别文本、不等网络。这是 PRD EARS-B2 的核心。
2. **AEC 取舍**：保持 `MIC_ECHO_CANCELLATION = false`（沿用实测结论），
   回声改由**后端音色门控**拦截（见下）。理由：浏览器 AEC 对外放场景收敛慢
   （2~5s 训练期，实测首段回声泄漏），且会损伤男声基频；本项目已有可用的
   基频音色判据，比 AEC 更可控。
3. **后端音色/回声双门控（强化现有）**：
   - 她说话期间（`tts=1`）：只认男声帧（用户）→ 累积打断段；女声/持续声（她的 TTS 回声、风扇）
     → 忽略。现有的 `_estimate_f0` + `_voice_band`（`stream_asr.py:187,258`）已实现，
     保持并加**声纹兜底**：复用 `backend/voiceprint.py`（阈值 0.72）拒绝与她声纹高度相似的输入，
     避免无耳机外放时自激（对齐 PRD EARS-B4）。
   - `_resume_frames`（她说完后 ~0.8s 余音保护）保持，但**不得清掉已开的用户语音段**（现有注释已修）。
4. **续接（已有）**：`InterruptState` + `ttsProcessor.getBoundaryState()` 已实现「已播/未播」边界，
   续接时不重复已播内容（对齐 PRD EARS-B5）。
5. **打断取消上游**：DeepSeek 上游 SSE 无服务端取消语义 → 保持客户端 `abort()`（只保证本地停止读取，
   上游是否停止计费本端无法验证，`agent_bridge.py:1435-1441` 已注明）。多次打断用 `_gen` 自增
   让旧流自行退出（已有），不下发第二次请求（对齐 PRD EARS-B6「尽力」）。

## Consequences
- 正面：打断延迟从「等识别」降到「检测到人声」（≤150ms 停播），体验对齐 Neuro-sama 300~500ms 档。
- 正面：不依赖 AEC 收敛，规避「AEC 吃掉男声基频」的既有踩坑。
- 负面：外放无耳机时，她的 TTS 回声仍可能触发「男声」误判（低频女声被八度错误估低）。
  缓解：`_estimate_f0` 已有窗口填充度检查 + 八度错误消除（`stream_asr.py:200-232`）+ 声纹兜底。
- 负面：声纹档案需用户先 enroll（`/v1/voiceprint/enroll`）；无档案时**不得误拒**用户（放行）。

## Related ADRs
- ADR-001（端点判定）：二者共享双阈值 VAD 与音色判据。
- ADR-006（密钥治理）：声纹档案与 API Key 同属本地敏感数据，统一按 ADR-006 处理。
