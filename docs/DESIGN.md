# Neuro 桌宠 设计规范（DESIGN.md）

> 生成日期：2026-11-04 | 设计师：颜好看 | 基于：Phase 1 语音交互可视化需求
> 三轴刻度：Variance=4 / Motion=6 / Density=2 | 寄存器：Product | 平台：web（Electron 透明覆盖层）

本文件是**指针**。完整设计契约在 `design-system/` 目录，按 Master + Overrides 模式组织：

| 文件 | 内容 |
|---|---|
| `design-system/MASTER.md` | **9 节完整设计规范**（视觉主题 / 色彩 / 排版 / 组件 / 布局 / 深度 / 守则 / 无障碍 / 实现指南） |
| `design-system/pages/voice-states.md` | **页面级 Override**：语音交互六状态唯一实现规格 + 同类产品调研 + 字幕条微调建议 + 落地清单 |
| `design-system/design-tokens.json` | **机器可读 Token**（primitive → semantic → component），前端 `import` 引用 |
| `design-system/design-tokens.css` | CSS 变量 + `body[data-state]` 状态选择器 + `prefers-reduced-motion` 降级 |
| `design-system/pages/phone-link.md` | **页面级 Override**：手机↔电脑联动模块设计方向（调研 6 产品 + 三通道层级 + 手机/电脑交互流 + 组件状态矩阵 + 初步 Token 草案）+ `design-tokens.css/json` 新增 link/panel 条目 |

## 一句话摘要

为已成型桌宠新增**一层"生命体征"**：贴在角色胸口的**状态环** + 字幕上方的**状态胶囊** + 屏幕四角的**感知角括号**，让用户一眼看出她**在听 / 在想 / 在说 / 没听见 / 在看屏幕**，并在**打断她时**给出一次性三通道回执（环断 + 字幕闪 + 轻音）。

- **锁定 SVG 图标库**：`lucide`（stroke-width 2，尺寸 16 / 20 / 24px）
- **配色锚点**：沿用现有品牌粉 `#FF5FA2`；状态色为低饱和马卡龙（薄荷 `#5AD1C8` / 杏黄 `#FFB072` / 珊瑚 `#FF7A6B` / 雾蓝 `#6FA8DC`）
- **对标品牌**：ChatGPT 语音 orb、Microsoft Copilot Vision、小舞 DSH 桌宠 / 小米 Hachimidock

## 变更记录
| 日期 | 变更 | 原因 | 影响范围 |
|---|---|---|---|
| 2026-11-04 | 建立设计契约；新增语音状态可视化层 | Phase 1 需求 | `css/styles.css`、`index.html`、新增 `js/state-visual.js` |
