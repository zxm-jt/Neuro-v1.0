# Neuro

一个基于 **Electron + Python 后端 + 真实果蝇脑连接组（LIF 模型）** 的桌面 AI 桌宠。

## 三步启动

```bat
tools\install_deps.bat                          :: 1. 装依赖（只需一次）
copy docs\config\secrets.json.example secrets.json   :: 2. 填 API 密钥
start_neuro.bat                                 :: 3. 启动
```

关闭请用 `tools\exit_and_save.bat`，**不要直接杀进程**（会丢这一轮记忆）。

> 详细步骤、配置项、常见错误、测试方法：**[docs/指南.md](docs/指南.md)**

她会说话（edge-tts 音色）、有表情（Live2D）、有情绪与自主意图，底层由一个**真实的果蝇大脑连接组**（约 16.7 万神经元）做低层唤醒/趋避/情绪驱动，上层由 LLM 做语言与推理。整个系统强调"效用选择"而非 LLM 自由发挥——决策由效用打分 + 果蝇脑唤醒门控仲裁。

---

## 一、架构总览（8 层认知）

| 层 | 实现 | 位置 |
|---|---|---|
| 感知层 | 视觉截图识别 + 麦克风 ASR + 鼠标触摸 | `js/vision-pump.js`、`backend/stream_asr.py` |
| 世界模型 | 情境胶囊场、语义向量场 | `backend/capsule_field.py` |
| 内部驱力 | 6 连续驱力（好奇/社交/休息/秩序/成就/无聊） | `backend/cognition.py` |
| 分层记忆 | 情景/语义/程序 + 常驻层 | `memory/`、`backend/memory_layers.py` |
| 快慢双系统 | 规则/效用/arbiter 毫秒级 + LLM 秒级 | `backend/arbiter.py` |
| 主动循环 | 效用决策 + 意图 + 进化搜索 | `backend/evolution.py`、`backend/intent.py` |
| 抑制边界 | 工具审计、隐私红线 | `backend/symbolic.py` |
| 离线巩固 | 习惯提炼、反思、明日话题 | `backend/consolidation.py`、`backend/reflection.py` |
---

## 二、目录说明

| 目录/文件 | 作用 |
|---|---|
| `index.html` | 渲染进程页面（根目录只保留 6 个文件，其余都归了目录） |
| `start_neuro.bat` | 启动入口（唯一需要双击的文件） |
| `config.json` | 全局配置：模型、TTS、记忆、驱力、效用阈值、音效开关等 |
| `backend/` | Python FastAPI 后端（6006 端口）：LLM 上游、TTS、ASR、记忆、认知、arbiter |
| `flybridge/` | 果蝇脑桥（6007 端口）：连接组 LIF 模型 + 状态机 + 情绪簇 |
| `flybridge/data/` | 连接组数据**不在仓库内**：首次运行自动下载到 `~/fly-data`（约 260MB） |
| `js/` | 前端：`app.js` / `main.js` + TTS、表情、音效、字幕、命令路由 |
| `memory/` | **记忆存储**（见下文"记忆说明"，开源版已清空） |
| `docs/` | 使用指南、架构文档、设计规范；密钥模板在 `docs/config/` |
| `tools/` | 辅助脚本：装依赖、退出并保存、看对话日志 |
| `tests/` | 各类自检测试 |

---

## 三、如何运行

环境：Windows 10/11、Python 3.10+、Node.js 18+、首次联网约 260MB 脑数据。

```powershell
# 只跑果蝇脑桥自检（约 25s，期望最后一行 ALL PASS）
<你的Python> -m flybridge.selftest
```

完整安装步骤、启动日志怎么读、出错怎么办，见 **[docs/指南.md](docs/指南.md)**。

---

## 四、人格设定在哪填

**位置**：`config.json` → `llm.system_prompt` 和 `llm.persona_examples`。

- `system_prompt`：写下"她是谁"——名字、性格、说话方式、行为规则、语言、长短等。**已随包附一份完整人格**（约 1.1 万字符，含写作/表情/幽默/边界/情绪支持/节奏/接话/打断/记忆/单话题/人格锚点等 16 段），开箱即用；想改性格直接改这里。
- `persona_examples`：教模型学回复的**形状**（语气/长度/风格），而非逐字背诵。**已随包附 17 组示例**。格式：
  ```
  {user_name}: <用户说的话>
  Neuro: <回复>
  ```

**称呼变量**：提示词和示例里统一写 `{user_name}`，运行时自动替换成 `memory/user_name.txt`（唯一真源）里的名字，取不到则用 `config.json → user.name`，都没有就是 `user`。所以换名字不用改提示词。

---

## 五、记忆目录说明（已清空）

`memory/` 是她的记忆库（外部存储、按需检索、平时沉默），**开源版已清空所有数据**，只保留空结构和格式说明：

| 文件 | 作用 |
|---|---|---|
| `resident.json` | 常驻层：稳定身份/偏好 + 记忆规则（启动时注入 prompt） |
| `memories.json` | 情景片段：短文本 + 标签 + 向量 + 时间戳（语义检索） | 
| `speaker_profile.json` | 声纹特征（语音模块用，非记忆） | 
| `procedural.json` | 程序记忆（学会的"怎么做"规则） |
| `reflection.jsonl` | 决策/反应反思日志 |
| `vision_journal.jsonl` | 视觉观察记录 | 
| `consolidation.jsonl` | 习惯提炼记录 | 
| `tomorrow.json` | 离线巩固出的"明日话题" | 
| `capsules.json` | 情境胶囊 |

> 这些文件会在运行时**自动重新生成**。
---

## 六、API 密钥

 在 `docs\config\secrets.json.example` 基础上填入你自己的 `llm_api_key` / `deepseek_api_key` / `zhipu_api_key`，另存为根目录的 `secrets.json`。

`config.json` 里对应的 `api_key` 字段留空即可，运行时从 `secrets.json` 读取。

---

## 七、果蝇脑数据

`flybridge/data/brain.npz`（53MB）和 `weights.npz`（205MB）是**果蝇脑连接组数据本体**。

数据来源：成年果蝇中央脑连接组（FlyWire / Dorkenwald et al., Nature 2024），模型方法参考 Shiu et al., *A Drosophila computational brain model reveals sensorimotor processing*, Nature 634:210-219 (2024)，DOI 10.1038/s41586-024-07763-9。

> 运行时产生的膜电位/情绪簇/训练权重在 `flybridge/state/`（已清空），会自动重新生成。

---

## 八、关于"自主意识"的诚实边界

本项目**不宣称**实现了主观意识或"真实自我"。果蝇脑层只做低层唤醒、趋避、习惯化、情绪驱动；"自主意图"是功能性的——由效用选择 + 驱力 + 意图形成机制产生**自主行为观感**，而非现象学意义上的意识。
---

## 九、许可与致谢

本项目采用 **MIT License**（详见根目录 `LICENSE` 文件）。你可以自由使用、修改、分发本软件，包括用于商业用途，只需保留版权声明与许可声明。

连接组数据与 LIF 建模方法分别承自 FlyWire 项目与 Shiu et al. (2024) 的开放研究。
## 关于测试素材

`tests/audio/` 下的 wav 是开发者本机的语音样本（含个人声音），**已从本仓库移除**；依赖它们的 ASR 音质/风扇噪声/声纹类脚本（`check_e2e_asr_quality.py`、`check_queue_size_bug.py`、`check_stream_vad.py`、`diag_*.py`、`bench_*.py` 等共 30 个）也一并移除。其余测试不需要任何音频素材。
