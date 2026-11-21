# Neuro 桌宠「手机 ↔ 电脑联动」模块 — 技术架构与选型（Phase 1 · v2 修订）

> 作者：首席架构师 高见远 ｜ 日期：2026-11-06 ｜ 状态：Phase 1 调研 + 选型 + 架构草图（已按 PRD + PM 约束修订）
> 关联：`backend/neuro_server.py`(FastAPI 单进程 127.0.0.1:6006)、`backend/agent_bridge.py`(工具执行桥)、`js/command-router.js`(桌面指令路由)、`DESIGN.md`(design-tokens)、`config.json`(桌面副本优先)、`docs/PRD_phone_pc_sync.md`
> 遵守 ⛔ P0 绝对规则：本文档不含 emoji 图标、不含紫粉渐变、颜色一律走 design-tokens（不硬编码色值）。

---

## 0. 一句话结论（v2 修订要点）

1. **微信机器人 = 独立 Windows Python 进程**，不改造 `neuro_server` 内核；它通过一组**薄层 HTTP 路由**复用 Neuro 已有的命令通道与搜索能力，F1 验收依赖此复用，绝不重造命令执行。
2. **通道实现选型（封号风险从低到高）**：UI 自动化（wxauto 家族，操控真实微信 Windows 客户端收发）= 风险最低、优先；协议模拟（gewechat）= 灰产付费、次选；PC Hook（WeChatFerry/wxhelper）= 风险最高且版本锁定、谨慎。所有具体实现包在**通道抽象层 (Channel Adapter)** 后，便于切换或接 F7 LAN 直连备用通道。
3. **零云已确认**：微信消息即中继，PC 无需公网 IP、无自建云；搜索回传也是 PC 本地联网后经同一会话返回。
4. **MVP 范围 = F1 + F2 + F3 + F5 + 轻量 F6**（远程指令 / 手机触发搜索 / 桌宠本地搜索 / 授权白名单 / 轻量回执可视化）。**F4 短信同步 = P1**，需独立 Android 伴随应用，不塞进 MVP。
5. **架构韧性**：桌宠本体（语音/本地搜索/人格）与微信通道解耦；微信通道挂一个「在线/离线」状态位，离线时桌宠提示且本地功能照常。
6. **MVP 可做到零 Docker 依赖**：主通道 wxauto（纯 Python）+ 纯 Python 搜索库（如 duckduckgo-search），本地搜索无需 SearXNG 容器；SearXNG 仅作可选升级。这消除了原 OD-7（Docker 可用性）阻塞。

---

## 1. 联网方式确认（核心问题）

**结论：微信机器人本身即中继，无需独立云。**

| 通道 | 独立云/中继 | 说明 |
|---|---|---|
| 微信机器人（主通道） | 否 | 手机微信 → 微信服务器 → PC 机器人进程（wxauto 操控本机微信客户端）。PC 仅需能出网到微信服务器。 |
| 搜索回传 | 否 | PC 本地联网检索，结果经同一微信会话回传手机。 |
| F7 LAN 直连（封号兜底） | 否 | 手机伴随应用经局域网 WebSocket 直连 PC，同 WiFi。 |
| frp（出 LAN 兜底，Backlog） | 是（仅此处） | 需一台公网服务器；MVP 不做。 |

---

## 2. 技术选型对比矩阵（v2 修订）

### 2.1 微信个人号机器人「通道实现」（封号风险从低到高）

调研锚点 2026-11-06。腾讯从未开放个人号官方 Bot API，以下均非官方、均有封号风险；必须用小号。

| 方案 | 底层 | 成本 | 封号风险 | 关键约束 | 角色 |
|---|---|---|---|---|---|
| **wxauto 家族（UI 自动化）** | Windows UI Automation 操控真实微信客户端 | 免费（pip） | **最低** | 需微信 3.9.x 客户端常驻且窗口可见；**wxauto 本体已归档(2025-10-28, v39.2.1)锁 3.9.x**，用维护版 `wxauto(x)`；不能后台静默 | **主推 / 默认通道** |
| gewechat（协议模拟） | iPad 协议逆向（Docker） | 免费但灰产 | 中 | 需同省/同网 IP、≤5 条/分钟；曾付费 | 备选通道（走抽象层） |
| WeChatFerry / wxhelper（PC Hook） | DLL 注入微信进程 | 免费 | **最高**（>80%） | 强锁微信版本、需管理员、极易被检 | 高风险备选（谨慎） |
| itchat / wechat4u（网页协议） | 网页版 | 免费 | 已失效 | 2025 起扫码即封 | **排除** |
| 企业微信 Webhook（F8） | 官方 | 需企业资质 | 零 | 对方也需装企微，体验冲突 | 远景合规 |

> 证据：wxauto 官方文档声明其为独立第三方 UI 自动化库，非官方授权；DeepWiki 确认 wxauto 已于 2025-10-28 永久归档，最终版 39.2.1，硬编码仅支持微信 3.9.X，Apache-2.0 但声明禁止生产/商用。社区共识：UI 自动化封号风险最低（脚本之家、CSDN 实战指南均推荐 wxauto 为个人学习首选）。

### 2.2 联网搜索后端（功能 C，零成本导向）

| 方案 | 成本 | Docker | CN 可用性 | 角色 |
|---|---|---|---|---|
| **duckduckgo-search / bing 轻量库（纯 Python）** | 免费 | 否 | 中（DDG 有时不稳） | **MVP 主选（去 Docker）** |
| SearXNG（自托管 Docker） | 免费 | 是 | 高（开 bing+baidu） | 可选升级（质量/隐私更好） |
| 搜索引擎 API（Serper/Bing） | 按量付费 | 否 | 高 | 付费备选 |
| LLM 自带 web 工具 | 含 LLM 费 | 否 | 视模型 | 补充通道 |

### 2.3 短信/通知同步（F4 = P1，独立交付面）

| 方案 | 成本 | 云依赖 | 状态 |
|---|---|---|---|
| **Android 伴随应用（通知监听 + SMS 接收 + 转发）** | 自研/开源 | 否（同 LAN HTTP） | **P1 范围，MVP 不做** |
| 短信→微信转发 | 免费 | 否 | 过度复杂，不推荐 |

> PRD 明确：微信机器人读不到手机短信，F4 必须配独立 Android 采集端，与 A/C 本质不同，故列 P1，不阻塞 MVP。本架构仅为 P1 预留 `/v1/link/inbound/sms` 接口契约，不实现。

---

## 3. 核心功能可行性结论（按 MVP 范围）

| 功能 | 可行性 | 通道 | 复用点 |
|---|---|---|---|
| F1 远程指令（开应用/锁屏/关机） | 可行 | 微信 bot → `/v1/link/command` → 复用 `agent_bridge.run_tool` + 现有 desktop_cmd 路径 | 不重造执行 |
| F2 手机触发联网搜索 | 可行 | 微信「搜 xxx」→ `/v1/link/search` → 搜索后端 → 回传 | 复用 SearchService |
| F3 桌宠本地搜索 | 可行 | 桌宠 UI → 同 SearchService | 复用 |
| F5 授权白名单 + 限频 | 可行 | 通道抽象层拦截（私聊授权人 / 间隔≥3s / 日上限 / 禁群聊） | 通道层开关 |
| F6 回执可视化（轻量） | 可行 | WS `/v1/link/events` 推桌宠，复用 DESIGN 状态层 | 设计 Token |
| F4 短信同步 | P1（不阻塞） | 独立 Android 应用 + `/v1/link/inbound/sms` | 预留接口 |

---

## 4. 不可行 / 高风险警告

1. **微信封号（最高优先级）**：必须用**小号**；wxauto 控频、避免模板化雷同文本、禁群聊批量；约 68% 封号源于单账号短时发 >50 条相似文本。封号可连带支付/聊天记录，可能永久。
2. **wxauto 版本锁定**：仅支持微信 3.9.x 客户端；微信自动更新会使其失效 → **锁定微信客户端版本（禁止自动更新）+ 用维护版 `wxauto(x)`**。
3. **wxauto 不能后台静默**：微信窗口需可见，最小化到托盘可能失效；机器人进程与微信客户端同机同会话。
4. **命令执行安全（极高）**：复用 `agent_bridge.run_tool` 的 `ALLOWED_ROOTS` 白名单与确认机制；bot 侧只传结构化 `{op,args}`，绝不把用户原文拼 shell。
5. **桌面操作依赖 Electron 常驻**：锁屏/关机走 `command-router.js` → Electron main 的 `desktop-command` IPC；需 Neuro 桌宠进程在运行（MVP 默认常驻，可接受）。
6. **短信含敏感信息（P1）**：本地落盘、不上云、可一键清；建议关键词白名单只收指定词。
7. **合规**：个人微信自动化违反《微信软件许可及服务协议》，仅限自用；数据本地处理、不中转第三方云。

---

## 5. 推荐架构草图（v2）

```
                         [ Android Phone ]
                          |          |
        (WeChat 文本指令)   |          |  (F4 仅 P1: SMS/通知)
                          v          v
                   [ WeChat Windows 客户端 ]   [ Android 伴随应用(仅P1) ]
                          ^ 本机 UI 自动化          |
                          |                        | HTTP POST (LAN)
        ┌─────────────────┴────────────────────────┴──────────────────┐
        │  Windows PC                                                            │
        │                                                                       │
        │  ┌─ WeChat Bot 进程（独立 Python，新增，不碰 neuro_server 内核）─────┐  │
        │  │  • Channel Adapter（抽象层）                                      │  │
        │  │      wxauto_adapter (默认) / gewechat_adapter / frp_lan_adapter    │  │
        │  │  • Intent Parser：文本→结构化指令 {op,args} 或 {search,query}      │  │
        │  │  • Auth/RateLimit：私聊授权人、间隔≥3s、日上限、禁群               │  │
        │  │  • 通道健康自检：登录失效/被踢→置 offline 状态位                  │  │
        │  └───────────────┬───────────────────────────────────────────────┘  │
        │                  │ HTTP (127.0.0.1:6006)                            │
        │                  v                                                  │
        │  ┌─ neuro_server (FastAPI 单进程, 现有) ─────────────────────────┐  │
        │  │  新增薄路由（复用既有能力，不重造）：                            │  │
        │  │   POST /v1/link/command  → agent_bridge._tool_call_from_text   │  │
        │  │                             + agent_bridge.run_tool (既有执行器) │  │
        │  │   POST /v1/link/search   → SearchService(纯Python/可选SearXNG) │  │
        │  │   GET  /v1/link/status   → 通道 online/offline 状态位          │  │
        │  │   WS   /v1/link/events   → 推桌宠(F6 可视化)                    │  │
        │  │   POST /v1/link/inbound/sms (P1 预留)                           │  │
        │  │  复用：/v2/chat/completions(LLM人格回执) / desktop_cmd 机制     │  │
        │  └───────────────┬───────────────────────────────────────────────┘  │
        │                  │                                                   │
        │  ┌─ Electron 桌宠（现有）───────────────────────────────────────┐  │
        │  │  command-router.js → ipcRenderer.invoke('desktop-command')     │  │
        │  │  （锁屏/关机/开应用等桌面操作实际执行处）                       │  │
        │  │  订阅 WS /v1/link/events → 状态环/胶囊 展示联动状态            │  │
        │  └───────────────────────────────────────────────────────────────┘  │
        └───────────────────────────────────────────────────────────────────────┘
                          │
                          v  (微信文本回执 / 搜索结果)
                   [ WeChat 服务器 ] → [ Android Phone 看到结果 ]

   ── 韧性设计 ──
   • 微信通道 offline：桌宠提示「微信通道离线，本地功能仍可用」，F3 本地搜索/语音照常。
   • F7 备用：wxauto 失效时切 gewechat / frp_lan_adapter（抽象层零改动业务）。
```

### 模块边界与依赖（点名文件/接口）

| 模块 | 位置 | 输入 | 输出 | 复用/依赖 |
|---|---|---|---|---|
| `wxauto_adapter` | bot 进程 | 微信客户端窗口 | 收发文本 | `wxauto(x)` 库；微信 3.9.x 常驻 |
| `intent_parser` | bot 进程 | 用户文本 | `{op,args}` / `{search,query}` | 正则/关键词 + 可选 LLM |
| `auth_ratelimit` | bot 进程 | 发送人/消息 | 通过/拒绝 | config `link.auth` |
| `link_router`（薄路由） | neuro_server | HTTP 调用 | 执行结果 | **复用 `agent_bridge.run_tool` + `SearchService`** |
| `agent_bridge.run_tool` | 现有 | `{op,args}` | 执行结果 | `ALLOWED_ROOTS` 白名单（不重造） |
| `command-router.js` | 现有 Electron | `desktop_cmd` 事件 | PowerShell 执行 | `ipcRenderer.invoke('desktop-command')` |
| `events_ws` | neuro_server | 事件 | WS 帧 | Electron 前端订阅 |

---

## 6. 与现有代码集成方式（spec-as-contract：点名接口，不重造）

**原则：bot 是独立进程；neuro_server 只新增「薄路由」复用既有执行器与机制。**

### 6.1 必须复用的既有接口（F1 验收硬约束）
- `backend/agent_bridge.py`：
  - `run_tool(op, args)` — **唯一命令执行器**，含 `ALLOWED_ROOTS` 白名单、确认机制、回收站保护。bot 的 `/v1/link/command` 必须最终调它，**不得自行实现 `os.startfile`/`subprocess` 执行**。
  - `_tool_call_from_text(raw)` — 把自然语言/关键词解析成 `[[TOOL:{...}]]` 结构化调用；bot 可直接复用做意图→工具的归一化。
  - `DESKTOP_OPS` / `desktop_cmd` 事件机制 — 鼠标/键盘/锁屏/关机等桌面操作经 SSE `desktop_cmd` 下发，由前端 `command-router.js` → Electron main 执行。
- `js/command-router.js`：
  - `DESKTOP_OPS` 列表、`ipcRenderer.invoke('desktop-command', {op,args,id})`（约 line 644）— 桌面操作真实执行入口。bot 触发的「锁屏/关机」须走这条既有链路（即经 neuro_server 下发 `desktop_cmd`，由常驻的 Electron 执行），**不在 bot 进程里直接调系统 API**。
- `neuro_server.py`：`POST /v2/chat/completions`（line 3657）— 若需人格化回执文本，bot 可复用此 LLM 通道生成「好嘞，Chrome 开啦~」式回执，与 F1 的「桌宠人格化文本 + 微信消息双通道」一致。

### 6.2 新增（最小化）
- `backend/link_router.py`：导出 `link_router = APIRouter()`，在 `neuro_server.py` 的 `app = FastAPI(...)` 后 `app.include_router(link_router, prefix="/v1/link")`。
- 薄路由实现仅做：参数校验 → 调 `agent_bridge.run_tool`（命令）/ `SearchService`（搜索）/ 返回状态；**不含业务重造**。
- `SearchService`：纯 Python 搜索封装（默认 duckduckgo-search，可选切 SearXNG），统一返回 `{title,url,snippet}`。
- bot 进程独立启动（由现有看门狗或单独开机自启管理），通过 `127.0.0.1:6006` 调上述路由。

---

## 7. API / 模块边界初稿（v2）

### 7.1 REST 端点（`/v1/link`，由 neuro_server 暴露，bot 调用）
| Method | Path | 用途 | 请求体 | 响应 |
|---|---|---|---|---|
| POST | `/v1/link/command` | 执行白名单命令（**转发给 `agent_bridge.run_tool`**） | `{op:"open_path"|"open_url"|"desktop", args:{...}}` | `{code:0,ok,detail}` |
| POST | `/v1/link/search` | 触发联网搜索 | `{query, source?:"ddg"|"searxng"}` | `{code:0, results:[{title,url,snippet}]}` |
| GET | `/v1/link/status` | 通道 online/offline 状态位 | — | `{wechat:"up/down", search:"up/down"}` |
| POST | `/v1/link/persona_reply` | （可选）经 `/v2/chat/completions` 生成人格化回执 | `{event, result}` | `{text}` |
| POST | `/v1/link/inbound/sms` | **P1 预留**：手机伴随应用转发短信 | `{from,body,receivedAt?,device?}` | `200/202` |

> 统一响应信封：`{code:0, data:{}, message:""}`。
> 注意：`/v1/link/command` 内部只把 `op/args` 交给 `run_tool`；bot 不得直接拼 shell。桌面类 op（lock/shutdown）由 `run_tool` 走既有 `desktop_cmd` 链路。

### 7.2 WebSocket
- `WS /v1/link/events`：后端推事件给 Electron 桌宠，帧形 `{type:"command_done"|"search_done"|"bot_status", payload:{...}}`。同源（Electron 本地）免鉴；外部（frp）需 `?token=`。

### 7.3 `config.json` 新增 `link` section（草案 v2）
```json
{
  "link": {
    "channel": {
      "default": "wxauto",
      "wxauto": {"enabled": true, "wechat_version_lock": "3.9.x", "client_visible_required": true},
      "gewechat": {"enabled": false, "base": "http://localhost:2531"},
      "frp_lan": {"enabled": false}
    },
    "auth": {
      "authorized_wxids": ["<小号/授权人 wxid 列表>"],
      "private_chat_only": true,
      "min_interval_sec": 3,
      "daily_cap": 200,
      "block_group": true
    },
    "search": {"engine": "ddg", "searxng_base": "http://localhost:8080", "max_results": 10},
    "sms": {"enabled": false, "token": "<P1 用>", "keywords_allowlist": []},
    "ui": {"link_status_token": "token-status-link-active"}
  }
}
```

---

## 8. 兜底 / 韧性方案

**触发**：wxauto 登录失效/被踢/微信更新失效 → 通道自检置 `offline`。

**降级链（抽象层零改动业务）**：
1. **wxauto（默认）** 正常 → 一切照常。
2. **wxauto 失效** → 切 `gewechat_adapter`（若启用）或 `frp_lan_adapter`（F7，需手机伴随应用）；业务代码不变，仅换 adapter。
3. **全通道不可用** → `GET /v1/link/status` 显 `wechat:"down"`；桌宠提示「微信通道离线，本地功能仍可用」，F3 本地搜索/语音照常（**解耦验证点**）。

> 三条通道共用同一套 `{op,args}` 指令与 `SearchService`，仅「消息进入」入口不同。

---

## 9. 安全边界（命令执行 / 注入 / 限频）

- **复用既有执行器**：`/v1/link/command` 只传 `{op,args}` 给 `agent_bridge.run_tool`，沿用 `ALLOWED_ROOTS` 与确认机制；bot 侧绝不 `eval`、绝不 `shell=True`、绝不拼用户原文。
- **授权 + 限频（F5 产品层硬约束）**：通道层 `auth_ratelimit` 拦截——仅私聊授权人、单发送人间隔 ≥3s、单日上限、禁群聊批量；未授权直接拒回。
- **令牌校验**：`/inbound/sms`、外部 `events` 需 token，错误即 401/403。
- **最小权限**：wxauto 不需管理员；wcf 才需（故不主推）。
- **隐私**：短信（P1）本地落盘、不上云、可一键清除。

---

## 10. OPEN-DECISIONS（v2 修订，待裁决）

| # | 决策点 | 候选 | 架构师推荐 | 影响 |
|---|---|---|---|---|
| OD-1 | 微信通道默认实现 | wxauto(默认,低风) / gewechat(备选) / wcf(慎) | **wxauto 家族 + 抽象层** | 封号率、是否需 Docker |
| OD-2 | 是否用小号 | 是 / 否 | **必须小号** | 主号资产安全 |
| OD-3 | 微信客户端版本锁定 | 锁 3.9.x + 禁自动更新 / 不锁 | **锁 3.9.x** | wxauto 可用性 |
| OD-4 | 搜索后端 | 纯 Python(ddg,无Docker) / SearXNG(Docker) | **纯 Python 默认，SearXNG 可选** | 是否需 Docker |
| OD-5 | F4 短信(P1) 手机端形态 | 自研伴随应用 / 开源转发 App | **P1 单独排期** | 不阻塞 MVP |
| OD-6 | 命令白名单初始范围 | 最小集(open_path/open_url/lock/shutdown) / 更多 | **最小集起步** | 安全面 |
| OD-7（已消解） | Docker 可用性 | — | **MVP 改为零 Docker 依赖**，不再阻塞 | 见 §0.6 |

---

## 11. MVP 成本估算（学生零成本）

| 项 | 成本 | 说明 |
|---|---|---|
| wxauto(x)（pip） | ¥0 | 纯 Python |
| 纯 Python 搜索（duckduckgo-search） | ¥0 | 无 Docker |
| 微信小号 | ¥0 | 注册即得 |
| SearXNG（可选升级） | ¥0 | 仅当要更好质量/隐私时装 Docker |
| **MVP 合计** | **¥0，且零 Docker** | 符合学生零成本 |

---

## 12. 端到端验证步骤（spec-as-contract 收尾）

1. **起服务**：启动 neuro 后端（现有 `start_neuro.bat` → FastAPI:6006），启动 WeChat Bot 进程（独立 Python，wxauto adapter，微信 3.9.x 客户端可见常驻）。
2. **通道联通**：小号扫码/登录；`GET /v1/link/status` 返回 `wechat:"up"`。
3. **F1 指令流**：手机微信给小号发「打开 Chrome」→ bot 解析 → `POST /v1/link/command {op:"open_path",args:{path:"...chrome.exe"}}` → 复用 `run_tool` 执行 → 手机收到人格化回执「好嘞，Chrome 开啦~」；发「锁屏」→ 走既有 `desktop_cmd` → Electron 执行锁屏。
4. **F2 搜索流**：手机发「搜 天气」→ `POST /v1/link/search` → 纯 Python 搜索 → 回传 ≤3 条摘要；无网络时回「现在连不上网啦」。
5. **F3 本地搜索**：桌宠 UI 输入关键词 → 同 `SearchService` 返回。
6. **F5 授权/限频**：非授权人发指令 → 拒回；同人 <3s 内连发 → 限频拦截；群聊指令 → 忽略。
7. **韧性流**：退出微信客户端 → 通道自检置 `offline` → `GET /v1/link/status` 显 `down` → 桌宠提示离线且 F3 本地搜索仍可用（解耦验证）。
8. **安全流**：微信发 `; rm -rf /` 或白名单外 op → 后端拒执行（不拼 shell），验证无注入。

---

## 13. 与现有设计系统的衔接（P0 合规）

- 桌宠联动状态（收到指令/执行完/搜索完/通道 offline）**复用现有 `design-system/MASTER.md` 的 Token 体系**，新增语义 Token（如 `token-status-link-active` / `token-status-link-offline`），**不硬编码色值**、不使用紫粉渐变。
- 图标沿用 DESIGN.md 锁定的 **lucide**（stroke-width 2，16/20/24px），**不使用 emoji**。
- 沿用品牌粉 `#FF5FA2` 实色 + 低饱和马卡龙状态色（PRD §视觉），但经 Token 引用，不散落硬编码。

---

## 14. 关键证据 / 参考

- 既有命令通道：`backend/agent_bridge.py`（`run_tool` L883、`_tool_call_from_text` L106、`ALLOWED_ROOTS` L30、`desktop_cmd` 机制 L48）；`js/command-router.js`（`DESKTOP_OPS` L43、`ipcRenderer.invoke('desktop-command')` ~L644）；`neuro_server.py`（`/v2/chat/completions` L3657）。
- wxauto：官方文档 docs.wxauto.org（第三方 UI 自动化，非官方）；DeepWiki 确认 2025-10-28 归档 v39.2.1、锁微信 3.9.X、Apache-2.0 禁生产商用；社区（脚本之家/CSDN）一致推荐 wxauto 为个人学习最低风险方案，但需微信客户端可见、版本敏感。
- 封号数据：PRD R1（68% 封号源于短时>50 条相似文本；新号+自动化近必封）。
- 搜索：duckduckgo-search（PyPI，零成本无 Docker）；SearXNG（searxng-docker，CN 开 bing+baidu）。
- 零云/中继：PRD §联网方式结论（微信即中继，无公网 IP、无自建云）。
