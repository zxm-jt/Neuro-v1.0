# 页面级规格：语音交互状态层（voice-states）

> Override 文件 — 仅写与 `../MASTER.md` 不同的字段 | 设计师：颜好看 | 2026-11-04
> 本文件是「听 / 想 / 说 / 没听见 / 屏幕感知 / 打断回执」六个状态的**唯一实现规格**。

---

## A. 同类产品调研结论（≥3 个，可借鉴的视觉语言）

| # | 产品 | 它怎么表达状态 | 我们**直接借用**的视觉语言 | 我们**不采用**的 |
|---|---|---|---|---|
| 1 | **ChatGPT 语音模式 orb** | 单个"活着的圆"承载 idle→listening→thinking→speaking；聆听时随音量呼吸放大，说话时内部律动加快 | ① 用**一个**可变形的圆承载多态（省位置、不抢戏）② 聆听的"呼吸随音量"③ 说话时"内部律动加速" | 占满全屏的 orb；毛玻璃；紫→粉多层渐变 blob |
| 2 | **Microsoft Copilot Vision** | 屏幕感知激活时，**在被共享区域四角描一圈轮廓**，并常驻一个小工具栏；页面不支持时出现"划掉的眼鏡"图标 | ① **四角角括号**明示"正在看哪里"② "不可看/被禁用"要有**独立的视觉符号**（对应我们的 muted 斜杠） | 侧边栏面板（我们无边框，只能靠角括号 + 状态环） |
| 3 | **小舞 DSH 桌宠 / 小米 Hachimidock** | 把 agent 状态（idle/think/work/wait/done/oops/sleep）映射成**宠物动作 + 表情 + 头顶符号（?/!）+ 音效**；尊重 `prefers-reduced-motion`；点击穿透不挡桌面 | ① **状态 → 图标符号**（?=思考）② **状态 → 合成音效**（不依赖音频文件）③ 点击穿透、只让交互区可点 | 浏览器插件形态；全屏 overlay 注入 |
| 4 | **AI UX Playground · Voice Visualizer 规范**（设计规范，非产品） | 明确列出状态集与反模式 | ① 状态集：**idle / listening / processing / speaking**，可选 **error / muted** ② **反模式：聆听与说话用同一动画 = 状态不可辨**；**无标签/图标的纯动画对聋人/低视力不可用**；**mic 关闭时 UI 看起来还"活着"** | —— |
| 5 | **Apple（AirPods / HIG）** | 系统级反馈用**一次性短促回执**（音 + 触 + 视觉），不循环 | 打断回执 = **一次性**、短、明确，**绝不循环** | —— |

**调研得出的三条硬结论**（决定了本方案的本质）：
1. **状态必须在"形状"层面就不同**，不能只靠颜色——否则色弱/低视力用户读不出（Voice Visualizer 规范明确列为反模式）。
2. **"是否在听"必须随用户真实音量起伏**，否则"卡住了"和"在听"看起来一样——这正是用户痛点"语音识别差"的感知放大器。
3. **"没听见"必须有独立符号**（muted 的斜杠），且此时**禁止任何"在聆听"的动效**——否则用户会以为系统在听，实际没听。这是 Copilot Vision 的"划掉眼鏡"教给我们的。

---

## B. 六状态规格（唯一事实来源）

状态互斥；`body[data-state]` 只取一个值。

### B1. `idle` 待机
- **环**：细圆环，`--state-idle` @30%，4s 呼吸（scale 1↔1.04，`ease-standard`）
- **胶囊**：**不显示**（待机静默才是陪伴）
- **字幕**：无
- **可辨识度**：几乎看不见——这是刻意的。桌宠平时只是个角色，不是仪表盘。

### B2. `listening` 正在听你说话
- **环**：**实线弧**，弧长 = `volume / maxVolume × 360°`，颜色 `--state-listening` 薄荷
- **跟手**：弧长变化用 `90ms` 过渡（`--motion-instant`），做到"我的音量立刻在环上看见"
- **环体**：随音量微扩 scale 1 ↔ 1.06
- **胶囊**：`[mic 16px] 正在聆听`，`--surface` 底，出现在字幕上方 8px
- **为什么用薄荷而非品牌粉**：粉是"她在说话"的色。聆听必须是**你的**动作，用冷色（薄荷）区分归属。

### B3. `thinking` 她在思考
- **环**：**虚线弧**（`stroke-dasharray: 6 10`），1.6s 线性旋转
- **胶囊**：`[loader-circle 16px] 思考中` + 图标自身旋转
- **延迟显示**：状态进入后 **200ms** 才显形（Voice Visualizer 规范："**~200ms 内显示处理态，避免用户抢话**"）——短于 200ms 的思考不闪 UI，防抖。

### B4. `speaking` 她在说话
- **环**：实线圆环 + **向外扩散的脉冲波**（900ms `ease-out` 循环，每轮 scale 1→1.35、opacity 1→0），颜色 `--state-speaking` 品牌粉
- **胶囊**：**不显示**——"她在说话"由**字幕本身**表达，再加标签是冗余噪音
- **与 listening 的区别（关键）**：
  | | listening | speaking |
  |---|---|---|
  | 形状 | 实线**弧**（未闭合） | 实线**整圆** + 外扩脉冲 |
  | 色相 | 冷（薄荷） | 暖（粉） |
  | 驱动源 | **你的**音量 | **她的** TTS 播放进度 |
  | 运动方向 | **向内收 / 随你起伏** | **向外扩 / 脉冲** |
  > 四个维度都不同，任缺其一仍可辨。

### B5. `muted` 没听见 / 麦克风关闭
- **环**：灰色（`--state-muted`）**完整**圆环 + **一条 45° 斜杠**覆盖（呼应 Copilot 的"划掉眼鏡"）
- **动效**：**完全静止**——这是硬规则。静止本身就是"我没在听"的信号。
- **胶囊**：`[mic-off 16px] 麦克风已关闭`
- **两种触发**：① 用户主动静音；② ASR 链路故障（后端没跑/超时）——此时误识别与"没说话"无法区分，用同一个 muted 态；`voice-chat.js` 的 `onAsrError` 已显示"（msg）"字幕，我们补充环变灰。
- **字幕**：故障时保留现有"（识别链路…）"文案（**不新增空洞占位**）。

### B6. `vision` 连续屏幕感知中（叠加态，不打扰、不遮挡）
- **角括号**：屏幕四角各一个 28px、2px 粗、`--state-vision` 雾蓝、透明度 0.28 的角括号（如取景框）
- **环叠加**：状态环上叠加一道**雷达扫光**（3.2s 线性循环，一个扇形高亮扫过 360°）
- **胶囊**：`[scan-eye 16px] 正在看你的屏幕`（**仅在用户手动打开感知、或感知状态刚切换时显示 3 秒**，之后自动收起，只留角括号）——避免常驻打扰
- **不遮挡设计**：
  - 角括号只在屏幕**最外沿 10px 内**（`--bracket-inset`），桌面中央 100% 可用
  - **不用全屏遮罩、不用半透明蒙层、不用边框跑马灯**
  - `pointer-events: none`（不拦截任何点击）
  - z-index 900（**低于**字幕 1000，字幕永远在上层）
- **退出**：320ms 淡出（`--motion-slow`）

### B7. `interrupted` 打断回执（一次性，最高优先级）
用户打断她时（`1` 键 / 自动 barge-in / 唤起输入框 / 开始打字——四路已存在）：
1. **环**：实线**断成三段**，三段同时向外消散（scale 1→1.18，带旋转 8°），220ms 一次性 `--ease-receipt`（**先快后缓，收得干净**）
2. **颜色**：`--state-interrupted` 珊瑚 `#FF7A6B`——与 speaking 的粉**只在打断这一刻**短暂替换，视觉上"啪地断掉"
3. **字幕条**：边框闪珊瑚色 150ms（`box-shadow: 0 0 0 2px var(--state-interrupted)`），随后复原
4. **胶囊**：`[unlink 16px] 已打断`，显示 300ms 后淡出
5. **声音**：短促下行两音（复用 `cute-sounds.js` 的 WebAudio 合成模式，**不新增音频文件**），频率 `660Hz → 440Hz`，各 70ms，master 音量 0.12
6. **落点**：`js/app.js:showSubtitle` 里已有 `startsWith('（')` 分支识别"（你打断了她）"——**复用该现成信号触发本回执，零新业务代码**
7. **完成后**：自动回到 `idle`（或若用户继续说，转 `listening`）

> **为什么用三通道（环断 + 字幕闪 + 声音）**：用户原话痛点之一是**不确定打断是否生效**。这里多通道不是冗余装饰，是**状态确认的功能语义**——与"纯装饰动效"有本质区别，允许破例。

---

## C. 状态优先级与转换（给前端的状态机）

```
优先级（高 → 低）：
  interrupted(220ms 回执) > speaking > thinking > listening > vision(叠加) > muted > idle

转换触发源（全部已存在于现有代码）：
  interrupted ← _interruptHer()（文本输入） / asrProcessor.onBargeIn（语音 F0 判据）
  speaking    ← ttsProcessor.isPlaying()
  thinking    ← voiceChat 已发出 LLM 请求、未收到首字
  listening   ← asrProcessor 音量 > 静音阈值
  vision      ← VisionFramePump.status().running （叠加，不改主态）
  muted       ← config 静音 或 onAsrError
  idle        ← 以上全否 且 静默 > 1.5s
```

**防抖规则**：
- `thinking` 延迟 200ms 才显形；<200ms 不闪。
- `listening ↔ speaking` 直接切换（不经过 idle），切换用 `--motion-fast` 150ms 交叉淡入。
- `interrupted` 强制打断当前态，播完回执（220ms）再重新评估。

---

## D. 现有字幕条落地微调建议（不推翻，只微调）

| # | 现状 | 建议 | 理由 |
|---|---|---|---|
| 1 | `#subtitle-container { border-radius: 10px }` | → `var(--radius-md)` = 12px | 对齐 token；视觉几乎无差，消除魔法数字 |
| 2 | 字幕无状态表达 | **字幕条顶部圆点改为状态指示点**：聆听=薄荷实心、思考=杏黄脉动、说话=品牌粉 | 复用**已有**的 `#subtitle-page-dots` 位置，零新增 DOM，状态就在用户视线焦点处 |
| 3 | `#subtitle-page` 仅页码 | 保留。**不在字幕上叠更多 UI** | 字幕是她的"台词"，保持干净 |
| 4 | 分页圆点 `word-spacing: 4px` | 保持现状 | 分页机制不属本次范围 |
| 5 | 字幕描边 `#ff5fa2` 硬编码 | → `var(--accent-strong)` | 消除裸 hex |
| 6 | 输入条 `border-radius: 22px` | → `var(--radius-pill)` | 22px 是非标值 |
| 7 | 输入框字体 `'Microsoft YaHei'` | → `var(--font-ui)` | 与状态胶囊统一调性（Baloo 圆润体） |
| 8 | `#text-send` 发送按钮 | `#ff5fa2` → `var(--accent-strong)`；hover 白字对比度已达 4.5:1 保留 | 消除裸 hex |

**关于「字幕条顶部状态圆点」的详细说明**（最重要的落地建议）：
现有字幕已有 `#subtitle-page-dots`（分页圆点，在字幕**下方**、右对齐）。建议在其**左侧**新增一个 6px 的**状态点**（纯 CSS，无新依赖）：

```css
/* 状态点：颜色随 body[data-state] 变，形状/脉动区分聆听与思考 */
#state-dot {
  width: 6px; height: 6px; border-radius: var(--radius-pill);
  background: var(--state-current);
  opacity: var(--state-opacity);
  transition: background var(--motion-fast) var(--ease-standard),
              opacity var(--motion-fast) var(--ease-standard);
  margin-right: var(--space-2);
}
body[data-state="thinking"] #state-dot { animation: state-dot-pulse 1.6s ease-in-out infinite; }
body[data-state="listening"] #state-dot { transform: scale(calc(1 + var(--state-level, 0) * 0.8)); }
```
> 这样**用户盯着字幕看时，眼角就能看到"她在听还是在想"**——符合"字幕是视线焦点"的实际使用习惯（用户在等她的回答时看的是字幕区）。

---

## E. 落地清单（给前端 / 架构师）

| 文件 | 动作 | 行数估计 |
|---|---|---|
| `design-system/design-tokens.css` | 新增 | 已完成（~190 行） |
| `design-system/design-tokens.json` | 新增 | 已完成 |
| `css/styles.css` | 顶部 `@import` + 8 处微调（section D） | ~40 行改动 |
| `index.html` | 新增 `#state-ring`、`#state-chip`、`.vision-bracket`×4、`#state-dot` | ~20 行 |
| `js/state-visual.js` | **新增**：状态聚合 + `body[data-state]` 派发 | ~120 行 |
| `js/cute-sounds.js` | 新增一个 `interrupt` 音效定义（复用现有 SOUNDS 结构） | ~2 行 |
| 图标 | 内联 lucide SVG（`mic`/`loader-circle`/`scan-eye`/`mic-off`/`unlink`/`send-horizontal`） | 视使用处 |

**零业务逻辑改动**：所有状态源已存在，新模块只做"读取 + 聚合 + 写 data 属性"。
