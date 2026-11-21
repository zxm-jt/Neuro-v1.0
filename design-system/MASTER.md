# Neuro 桌宠 · 语音交互状态可视化 — 设计系统 MASTER

> 生成日期：2026-11-04 | 设计师：颜好看 | 基于：Phase 1 需求（3 句核心诉求）
> 三轴刻度：**Variance=4 / Motion=6 / Density=2**
> 寄存器：**Product**（设计服务产品本身——桌宠的交互状态，不做营销页）

---

## 0. 范围声明（重要，避免被误读为整页重做）

这是一个**已成型的桌宠**，不是从零的新产品。设计**不推翻现有视觉**：

- [保留]：Live2D 角色本身、右下角贴底字幕条（含分页圆点）、粉描边手写字幕、`Ctrl+T` 文本条、表情/情绪/可爱音效系统。
- [新增]：一套**语音交互状态可视层**——让用户"一眼看出"她此刻在 **听 / 想 / 说 / 没听见 / 在连续看屏幕**，以及**打断成功的即时回执**。
- [不做]：换主题、换字体家族、改角色、改布局骨架。

由此可见本设计的核心矛盾是：**既要在桌面上"看得见"，又不能盖住桌面、不能抢角色的戏**。所有决策服从这一点。

---

## 1. Visual Theme & Atmosphere（视觉主题与氛围）

**视觉主题关键词**：`温柔的呼吸感` · `桌面上的一盏小灯` · `像人的即时反馈` · `不打扰`

**氛围描述**：整个状态系统是**贴在角色身上的一层"生命体征"**，不是浮在桌面上的 UI 面板。它读起来像呼吸和心跳——平时几乎看不见（待机环 30% 透明度、缓慢呼吸），一旦她开始听/想/说，才从角色胸口位置亮起一圈光，用**颜色 + 形状 + 运动**同时传达状态。所有元素都遵守"**离开角色的脸和手**"的避让原则。

**对标品牌（状态语言来源，非视觉抄袭）**：
| 对标 | 借鉴什么 | 不借鉴什么 |
|---|---|---|
| **ChatGPT 语音模式 orb** | 单一"活着的圆"承载 listen/think/speak 三态；聆听随音量呼吸、说话时内部律动加速 | orb 占据全屏——我们只借它的**状态→形状**映射，尺寸缩到贴角色 |
| **Copilot Vision** | 屏幕感知激活时在**被共享区域四角描一圈轮廓**，用户始终知道"它在看哪里" | 它的侧边栏面板——我们是无边框覆盖层，只能靠角括号 |
| **小米 Hachimidock / 小舞 DSH 桌宠** | 把 agent 状态映射成**宠物表情+动作+声音**，且"等待确认/完成"有独立视觉 | 它需要独立硬件/浏览器插件；我们只取其**状态机分层**思路 |
| **AirPods Pro 怒音反馈 / Apple 触感** | "打断成功"给一个**短促、明确、一次性**的回执（不循环） | —— |

**为什么是这个调性**：用户是学生，桌宠是长时间陪伴物，不是办公工具。视觉必须**低攻击性、可爱、温柔**——所以主色沿用她已有的粉（`#FF5FA2`），状态色选**低饱和的马卡龙色**（薄荷/杏黄/珊瑚/雾蓝），绝不使用高对比饱和色。

---

## 2. Color Palette & Roles（色彩与角色）

### A1-identity
| Token | 值 | 用途 |
|---|---|---|
| `--bg` | `transparent` | **必须透明**——透明无边框窗口，任何底色都会挡住用户桌面 |
| `--surface` | `#14141C` | 悬浮控件底（输入条/状态胶囊），与现有 `rgba(20,20,28,.72)` 同源取不透明等价 |
| `--fg` | `#FFFFFF` | 字幕与胶囊文字 |
| `--muted` | `#8A8F98` | 页码/次要说明 |
| `--accent` | `#FF6FA8` | 品牌粉（比现有 `#FF5FA2` 略降饱和，叠在任意壁纸上不刺眼） |
| `--border` | `rgba(255,255,255,0.18)` | 控件描边（沿用现有输入条） |

### A2-semantic
`--success #16A34A` · `--warn #D97706` · `--danger #DC2626` · `--accent-strong #FF5FA2`（字幕描边沿用）· `--accent-hover #FFB3D1`

### 状态语义色（本设计的核心新增 — 互斥）
| Token | 值 | 状态 |
|---|---|---|
| `--state-idle` | `#FFB3D1` 30% | 待机（呼吸环，几乎不可见） |
| `--state-listening` | `#5AD1C8` 薄荷 | **正在听你说话** |
| `--state-thinking` | `#FFB072` 杏黄 | **她在思考** |
| `--state-speaking` | `#FF6FA8` 品牌粉 | **她在说话** |
| `--state-interrupted` | `#FF7A6B` 珊瑚 | **你刚打断了她**（回执） |
| `--state-muted` | `#8A8F98` 灰 | **没听见 / 被静音** |
| `--state-vision` | `#6FA8DC` 雾蓝 | **连续屏幕感知中** |

### B-slot 别名
`--fg-2 rgba(255,255,255,.72)` · `--surface-soft #1E1E28` · `--meta #62666D` · `--border-soft rgba(255,255,255,.08)`

### 每屏强调色 ≤2 处
状态环是**互斥**的——同一时刻屏幕上只有一个状态环，颜色随状态切换。加上字幕描边（`--accent-strong`），屏幕上的强调色始终 ≤2 处。**不新增任何常驻彩色装饰**。

### 配色来源
`references/design-systems/color-palettes.md` 语义色集 + 现有品牌粉锚定；未经改造沿用项目既有 `#FF5FA2`，避免"换皮"。

---

## 3. Typography（排版）

**字体锁死（不新增字体文件，全部复用 `fonts/` 已有资源）**：

| 用途 | 字体栈 | 说明 |
|---|---|---|
| 字幕正文 | `'NeuroSub', 'NeuroSubCJK', ...` | Shantell Sans 700 手写体 + 华文幼圆 CJK 子集（**保留现状**） |
| UI 标签/胶囊/设置项 | `'NeuroSubBaloo', 'NeuroSubCJK', 'Microsoft YaHei'` | Baloo 2 圆润几何体，比手写体更清晰可读，与角色调性统一 |
| 数字（页码/计时） | `ui-monospace, 'Cascadia Mono', Consolas` + `tabular-nums` | 等宽保证数字不跳动（**保留现状**） |

> 字体项目已在仓库内（`fonts/*.woff2`），不引入 CDN 依赖。品牌声音词：**"柔软、黏手、睡眼惺忪"**——故用粗圆手写/几何体，拒绝任何锐利无衬线。

**字号阶梯**（8 级，含用途）：
| Token | px | 行高 | 用途 |
|---|---|---|---|
| `--text-xs` | 11px | 1.0 | 状态胶囊文字（配 `letter-spacing: 0.06em`） |
| `--text-sm` | 12px | 1.5 | 页码指示 |
| `--text-md` | 14px | 1.5 | 输入框 / 按钮 |
| `--text-lg` | 18px | **1.05** | 字幕正文（**保持现有值**，用户要求行距小） |
| `--text-xl` | 22px | 1.3 | （备用） |
| `--text-2xl` | 28px | 1.2 | （备用） |

**字距规则**：ALL CAPS 状态标签 ≥ `0.06em`（现有 `#subtitle-page` 已符合）；字幕大字 `-0.02em`（现有，保留）；正文 `0`。

**字重**：400 正文 / 510 次标题 / 590 主标题（现有字幕用 700，因手写体需更重才醒目，保留）。

---

## 4. Components（组件规范）

### 4.1 状态环 `StateRing`（新增核心组件）
锚定在角色**胸口下方**（`--ring-anchor-y: -6vh`），外径 180px，描边 3px。**这不是一个独立面板，是贴在角色身上的一圈光**——因此永远不与字幕抢位置。

| 状态 | 形状语言 | 运动 | 颜色 |
|---|---|---|---|
| idle | 细圆环 | 4s 缓慢呼吸（scale 1↔1.04） | `--state-idle` @30% |
| **listening** | **实线弧，弧长随你的音量增长**（0→360°） | 弧尾 90ms 跟手；环体随音量微扩 | `--state-listening` 薄荷 |
| **thinking** | **虚线弧**（`stroke-dasharray: 6 10`） | 1.6s 线性旋转 | `--state-thinking` 杏黄 |
| **speaking** | 实线圆环 + **向外扩散的脉冲波** | 脉冲 900ms ease-out 循环 | `--state-speaking` 品牌粉 |
| **interrupted** | 弧**断成三段**向外消散 | 220ms 一次性（**不循环**） | `--state-interrupted` 珊瑚 |
| **muted** | 灰色环轨道 + **斜杠覆盖** | 静止（禁脉冲，防"看起来在听"） | `--state-muted` 灰 |
| **vision** | 环体静态 + **雷达扫光**（扇形高亮扫过） | 3.2s 线性循环 | `--state-vision` 雾蓝 |

> **关键设计原则（来自 AI UX Playground 的 voice-visualizer 规范）**："聆听与说话用同一套动画 = 状态不可辨"。本方案保证 **listen / think / speak 三态在"形状"层面就不同**（实线弧 vs 虚线弧 vs 双环脉冲），不依赖颜色辨识（色弱无障碍），也不依赖运动（reduced-motion 下静止仍可区分）。

### 4.2 状态胶囊 `StateChip`
仅在**非 idle 且非 speaking** 时出现（说话靠字幕表达，不需额外标签），位置在字幕条**上方 8px**。
- 结构：`[16px lucide 图标] + [11px 大写标签]`
- 底：`--surface`，描边 `--border`，圆角 `--radius-pill`，内距 `12px × 4px`
- 进入：`--motion-fast` 上滑淡入；退出：`--motion-base` 淡出
- 状态 → 图标映射（lucide，stroke-width 2）：
  | 状态 | lucide 图标 | 标签文案 |
  |---|---|---|
  | listening | `mic` | `正在聆听` |
  | thinking | `loader-circle` | `思考中` |
  | vision | `scan-eye` | `正在看你的屏幕` |
  | muted | `mic-off` | `麦克风已关闭` |
  | interrupted | `unlink` | `已打断` |

### 4.3 屏幕感知角括号 `VisionBracket`（新增）
连续屏幕感知激活时，在**屏幕四角**各画一个 2px 的 28px 角括号（`--state-vision`，透明度 0.28），像取景框。**不遮挡桌面中央内容**，只在边缘留痕。退出时 320ms 淡出。

### 4.4 打断回执 `InterruptReceipt`（新增，一次性）
用户打断她时：
1. **状态环**弧线在 220ms 内断成三段向外消散（珊瑚色）。
2. 字幕条**闪一下珊瑚色描边**（150ms）+ 出现 `已打断` 胶囊 300ms。
3. 一个 **60ms 的短促轻音**（复用 `cute-sounds.js` 的 WebAudio 合成思路，下行两音、音量 0.12）——听觉 + 视觉双通道确认"打断成功了"。

> 三条通道同时给反馈，是因为用户痛点之一是"**不确定打断是否生效**"。多通道冗余在这里是**正确**的（不像装饰动效那样是噪音），因为它承担"状态确认"的功能语义。

### 4.5 保留组件（微调，不重做）
- 字幕容器：`border-radius` 10px → `--radius-md` (12px)（对齐 token，视觉几乎无感）
- 输入条：`border-radius: 22px` → `--radius-pill`；其余保持
- 发送按钮：`#ff5fa2` → `var(--accent-strong)`

---

## 5. Layout & Spacing（布局与间距）

- **间距基准**：4px 网格（4/8/12/16/24/32/48）
- **圆角阶梯**：sm(8) / md(12) / lg(16) / pill(9999)；**卡片类上限 16px**，禁止 ≥24px 的"AI 过度圆滑"
- **安全边距**：距屏幕右/下 24px（`--safe-gutter`，沿用现有）
- **字幕宽度**：`44vw`（现有），最大高度 `62vh`（现有，防盖脸）
- **布局分区**（自下而上）：
  ```
  ┌─────────────────── 屏幕 ───────────────────┐
  │                                            │
  │            Live2D 角色                      │
  │         ┌── 状态环（贴胸口） ──┐             │
  │         └──────────────────────┘             │
  │                        [状态胶囊] ← 字幕上方 │
  │            右下角字幕条（贴底）              │
  └────────────────────────────────────────────┘
   屏幕四角：屏幕感知角括号（仅在 vision 态）
  ```
- **避让原则**：状态环在角色胸口；胶囊锚定字幕条顶部；角括号在屏幕边缘。**三者都不进入桌面中央**，用户可以正常办公。

---

## 6. Depth & Elevation（深度与阴影）

| Token | 值 | 用途 |
|---|---|---|
| `--elev-flat` | `none` | 字幕（透明，无阴影） |
| `--elev-ring` | `0 0 0 1px rgba(255,255,255,.10)` | 胶囊描边 |
| `--elev-raised` | `0 4px 18px rgba(0,0,0,.45)` | 输入条（沿用现有） |

**层级 z-index**：字幕 1000 / 状态胶囊 1010 / 输入条 1100 / 角括号 900

**毛玻璃规则**：**仅允许输入条使用 `backdrop-filter: blur(8px)`**（它有明确功能理由：输入时让用户聚焦文字，且用户主动唤出）。状态环、胶囊、字幕**一律不用毛玻璃**——装饰性模糊是 AI 模板味，且在桌面上会糊掉壁纸。字幕已有 `backdrop-filter: none`（保留）。

**为什么状态环用描边而非填充阴影**：发光边框 + 毛玻璃 + 渐变是 AI 模板三位一体套路（P0 红线）。本设计用**纯色描边环 + 暗色底衬**（`--state-ring-underlay`）保证在浅色壁纸上仍可辨识，不靠发光。

---

## 7. Do's & Don'ts（设计守则）

### 应该做（Do）
1. 状态用**形状 + 颜色 + 运动**三重编码，任缺其一仍可辨（色弱/静音/减动效无障碍）。
2. 状态环锚定**角色胸口**，永远不进入桌面中央，不遮挡用户工作区。
3. 打断反馈用**一次性短动效 + 听觉回执**，让用户明确"生效了"。
4. 状态色**互斥**——同一时刻只亮一个环。
5. 屏幕感知用**四角轮廓**而非全屏遮罩，明示"在看哪"（学 Copilot Vision）。
6. 待机态几乎不可见（30% 透明度呼吸），陪伴感来自角色本身而非 UI。
7. 所有颜色走 `var(--...)`，禁止裸 hex（唯一例外 `#fff`/`#000`）。
8. 尊重 `prefers-reduced-motion`：停循环动画，保留静态形状差异。

### 不应该做（Do not）
1. 禁止 **用 emoji 当状态图标**（用彩色圆点字符或扩音器图形字符代替图标）——统一用 lucide SVG，16/20/24px。
2. 禁止 **聆听与说话用同一套动画**——这是 voice UI 最常见错误，用户无法分辨状态。
3. 禁止 紫色→粉色渐变、发光边框、毛玻璃三位一体（P0 红线）。
4. 禁止 状态胶囊常驻显示"待机中"——待机不需要标签，静默才是陪伴。
5. 禁止 用整屏遮罩或大幅横幅提示"屏幕感知中"——会打扰用户。
6. 禁止 状态环 ≥24px 圆角的大填充色块 / 彩色左边框卡片（AI 模板特征）。
7. 禁止 打断反馈用循环动画——打断是瞬时事件，循环动画会让用户以为卡住了。
8. 禁止 硬编码颜色 / 用「欢迎使用」「Let's get started」类空洞文案。

---

## 8. Responsive & Accessibility（响应式与无障碍）

**响应式**（Electron 覆盖层，随窗口缩放）：
| 视口 | 状态环 | 字幕 | 角括号 |
|---|---|---|---|
| ≥1024px | 180px | 44vw / 18px | 28px |
| 640–1024px | 150px | 44vw / 16px | 24px |
| <640px | 120px | 60vw / 15px | 20px |

**无障碍**：
- 对比度：字幕白字 + 黑描边发光（已有四向 1px + 7px/15px 模糊），在任何壁纸上 ≥7:1
- 状态色**不单独承载信息**（配形状 + 文字标签），色弱用户可读
- `prefers-reduced-motion`：循环动画全部停止，静态形状仍区分状态
- 键盘：现有 `Ctrl+T` 文本条已可用（旧的 `1` 键打断已废弃删除，语音打断改为 F0 音调自动判定）；新增状态胶囊需可 `Tab` 聚焦且 `:focus-visible` 显示 `--focus-ring`
- 触摸目标：可交互元素 ≥44×44px（输入条按钮补齐内距）
- 屏幕阅读器：状态变化通过 `aria-live="polite"` + `aria-label`（如 `aria-label="正在聆听"`）播报，而非仅视觉

**5 态覆盖**（状态环组件）：
| 态 | 表现 |
|---|---|
| Loading | thinking（虚线旋转） |
| Empty | idle（呼吸环，30%） |
| Error | muted（灰环 + 斜杠）——识别故障即"没听见" |
| Populated | listening / speaking（实线弧/脉冲） |
| Edge | interrupted（断弧消散）；超长字幕走现有分页（62vh 上限） |

---

## 9. Agent Implementation Guide（实现指南）

### 状态机契约（给前端）
现有代码已有全部状态源，**只需新增一个统一状态派发器**，无需改业务逻辑：

```js
// 新增 js/state-visual.js —— 唯一职责：把已有状态源聚合成一个 UI 状态
// 数据源（全部已存在）：
//   ttsProcessor.isPlaying()          → speaking
//   asrProcessor 音量/liveness        → listening
//   voiceChat 请求进行中              → thinking
//   config.ui.allow_barge_in===false / mute → muted
//   VisionFramePump.status().running  → vision 叠加层
//   _interruptState.phase==='interrupted' → interrupted（220ms 回执）
//
// 优先级（高→低）：interrupted > speaking > thinking > listening > vision > muted > idle
// 用法：setState('listening') → document.body.dataset.state = 'listening'
```

**关键：状态切换只写 `body[data-state]` 一个属性**，全部视觉由 CSS 变量 + `[data-state]` 选择器驱动（见 `design-tokens.css`）。零 JS 样式逻辑，便于单测。

### CSS 变量定义
见 `design-system/design-tokens.css`（完整 `:root` + 状态选择器 + reduced-motion 降级）。

### 现有代码的落点（3 处微调 + 1 处新增）
1. `css/styles.css` 顶部 `@import url('./design-tokens.css')`（或 link 引入）。
2. `#subtitle-container` 的 `border-radius: 10px` → `var(--radius-md)`；`#text-input-bar` 的 `22px` → `var(--radius-pill)`；`#text-send` 的 `#ff5fa2` → `var(--accent-strong)`。
3. 新增 `js/state-visual.js` + `#state-ring` / `#state-chip` / `.vision-bracket` 三个 DOM 节点到 `index.html`。
4. `js/app.js` 的 `showSubtitle()` 里已有 `startsWith('（')` 分支——"（你打断了她）"正好可触发 `interrupted` 回执（**复用现成信号，零新代码**）。

### 已知坑提醒
- 注意：**透明窗口下 `backdrop-filter` 失效/异常**：Chromium 在 `transparent:true` 窗口里模糊的是"窗口下方"而非桌面。输入条现有的 blur 效果在部分环境会退化为纯色底——所以状态环**不要依赖 blur**，用描边 + 暗衬。
- 注意：**`setIgnoreMouseEvents(true, {forward:true})`**（js/main.js:564）：新增节点**默认不可点**，状态环必须 `pointer-events: none`（它本就不可点）；状态胶囊若需点击（如点击关闭麦克风），须在 js/main.js 的鼠标穿透判定里加入其区域。
- 注意：**角色位置随窗口大小变化**：状态环锚点用 `vh` 百分比而非固定 px，否则换屏幕会飘。
- 注意：状态环绘在 DOM 层（非 canvas），避免与 Live2D 渲染循环抢帧；用 `transform`/`opacity` 动画（GPU 合成），不碰 `width`/`height`/`top`。

### Tailwind 配置（若后续引入 Tailwind）
```js
module.exports = {
  theme: {
    extend: {
      colors: {
        surface: 'var(--surface)', fg: 'var(--fg)', muted: 'var(--muted)',
        accent: { DEFAULT: 'var(--accent)', strong: 'var(--accent-strong)' },
        state: {
          idle: 'var(--state-idle)', listening: 'var(--state-listening)',
          thinking: 'var(--state-thinking)', speaking: 'var(--state-speaking)',
          interrupted: 'var(--state-interrupted)', muted: 'var(--state-muted)',
          vision: 'var(--state-vision)'
        }
      },
      fontFamily: {
        display: ['NeuroSub', 'NeuroSubCJK', 'Microsoft YaHei', 'sans-serif'],
        ui: ['NeuroSubBaloo', 'NeuroSubCJK', 'Microsoft YaHei', 'sans-serif'],
        mono: ['ui-monospace', 'Cascadia Mono', 'monospace']
      },
      borderRadius: { sm: '8px', md: '12px', lg: '16px', pill: '9999px' },
      transitionDuration: { instant: '90ms', fast: '150ms', base: '220ms', slow: '320ms' }
    }
  }
};
```

---

## 10. 手机↔电脑联动模块（Phase 2 扩展 · 颜好看 2026-11-06）

> 完整规格见 `pages/phone-link.md`（调研 6 产品 + 三通道层级 + 交互流 + 组件状态矩阵）。本节能独立成立；详细内容在页面文件。

### 10.1 范围
扩展，不改既有视觉。新增「手机通道」一类信息，**三通道层级**分流：
1. **字幕 / 连接胶囊**（最轻，瞬态）：手机连接态 / 同步中 / 执行中。
2. **桌宠气泡**（人格脸面，短反馈 ≤80 字）：姐姐语气确认 / 播报。
3. **同步面板 LinkPanel**（右侧停靠，结构化持久）：同步短信卡 / 指令回执卡 / 搜索结果卡，全部 actionable。

### 10.2 新增 Token（C-extension，全部 token-derived，无新色相）
`--link`(=雾蓝 skygray) · `--link-soft` · `--panel-surface`(ink-800) · `--panel-surface-raised`(ink-700) · `--panel-width`(320px) · `--panel-width-collapsed`(56px)。见 `design-tokens.css` + `design-tokens.json` 的 `semantic.color.link*` 与 `component.linkPanel/linkCapsule`。

### 10.3 新增组件
- **LinkPanel（同步面板）**：右边缘停靠，收起为 56px 细轨（仅未读角标），展开 320px。实心 `--panel-surface` 底（不毛玻璃）。分区用 1px `divide-y`，卡片圆角 `--radius-md`(12px)、上限 16px（禁 ≥24px）。图标 lucide 16px。
- **LinkCapsule（连接胶囊）**：复用 StateChip 形态，通道色用 `--link`(雾蓝)；`connected`(link) / `syncing`(link + refresh-cw) / `disconnected`(muted 灰)。

### 10.4 图标扩展（lucide，已锁）
`qr-code`(绑定) · `link`(已连) · `wifi-off`(断开) · `refresh-cw`(同步中) · `message-square-text`(同步消息) · `terminal`(远程指令) · `search`(联网搜索) · `file-down`(文件回传) · `check-check`(已读) · `corner-down-left`(回复) · `copy`(复制) · `external-link`(打开来源)。

### 10.5 增补 Do / Don't
- **Do**：结构化通知走 LinkPanel（actionable，可标记已读/回复/复制/打开）；气泡只承载短人格反馈；通道色统一用雾蓝，与状态环粉/杏黄互斥。
- **Don't**：禁止把短信列表/搜索结果塞进气泡（破坏短反馈低打断）；禁止面板用毛玻璃（透明窗口失效）；禁止新色相（坚持复用马卡龙家族）。

### 10.6 状态派发（前端）
后端 127.0.0.1:6006 微信通道健康度 + WS `/v1/link/events` → 写 `body[data-link="online|syncing|offline"]`（连接胶囊/字幕）与 `body[data-state]`（状态环，复用语音层），CSS 变量驱动，零 JS 样式逻辑（沿用 §9 的 setState 思路）。指令三态复用 `thinking→speaking→failed`。

### 10.7 边界同步补充（架构师 §7/§13 + PM PRD，2026-11-06）
- WS 四类事件 `sms_received`/`command_done`/`search_done`/`bot_status` → 视觉映射见 `pages/phone-link.md` §11.1。
- 新增语义 Token（全部 token-derived，无新色相、无渐变）：`--link-active`/`--link-idle`/`--link-syncing`（对应架构师约定的 `token-status-link-*`）+ `--state-failed`（F6 失败态，复用 danger）。已写入 `design-tokens.css` + `design-tokens.json`，并加 `body[data-link]` / `body[data-state="failed"]` 选择器。
- 兜底 PWA 面板（`/pwa`）走同一 Token 体系，独立不透明 web 页，不出现第二套风格（详见 §11.5）。
- 手机指令日志面板去隐私（不显示原文），与实时回执卡分离（§11.4）。
- 图标实名对齐 PM 示例：Search/Power/MessageSquare/Smartphone/Terminal/WifiOff/RefreshCw/ExternalLink（lucide，禁 emoji）。

## 变更记录
| 日期 | 变更 | 原因 | 影响范围 |
|---|---|---|---|
| 2026-11-04 | 建立 MASTER；新增状态可视化层（环/胶囊/角括号/回执） | Phase 1 语音交互可视化需求 | `css/styles.css`、`index.html`、新增 `js/state-visual.js` |
| 2026-11-06 | 扩展手机↔电脑联动模块（三通道层级 + LinkPanel/LinkCapsule + 通道色 token + 图标扩展） | Phase 2 手机遥控/消息同步/联网搜索需求 | 新增 `pages/phone-link.md`、`design-tokens.css/json` 的 link/panel 条目、新增 `#link-panel`/`#link-capsule` DOM + `js/link-panel.js` |
| 2026-11-06 | 边界同步：WS 事件契约 → 视觉映射 + 链接状态 Token（link-active/idle/syncing）+ 指令失败态（state.failed）+ PWA/日志/离线视觉约束 | 架构师 §7/§13 事件契约 + PM PRD 设计约束 | `design-tokens.css/json` 新增 4 个语义 Token + `body[data-link]`/`body[data-state="failed"]` 选择器；`pages/phone-link.md` 新增 §11；本文件 §10.6 改名 + §10.7 |
