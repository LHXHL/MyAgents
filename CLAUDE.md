# MyAgents — Desktop AI Agent

基于 Claude Agent SDK 的桌面端通用 Agent 产品。开源（Apache-2.0），Conventional Commits，不提交敏感信息。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 19 + TypeScript + Vite + TailwindCSS |
| 后端 | Node.js v24 + Claude Agent SDK 0.3.199（多实例 Sidecar） |
| 通信 | Rust HTTP/SSE Proxy (reqwest via `local_http` 模块) |
| 运行时 | 单一 Node.js v24（Sidecar / Plugin Bridge / MCP Server / CLI），内置于应用包 |

## 项目布局

- `src/renderer/` — React 前端（api/、context/、hooks/、components/、pages/）
- `src/server/` — Node.js 后端 Sidecar（esbuild 打包成 `server-dist.js`）
- `src/server/plugin-bridge/` — OpenClaw Plugin Bridge（独立 Node 进程）
- `src/cli/` — `myagents` CLI（同步到 `~/.myagents/bin/`）
- `src/shared/` — 前后端共享类型
- `src-tauri/` — Tauri Rust 层
- `specs/` — 设计文档（ARCHITECTURE.md / DESIGN.md / tech_docs/ / guides/）
- `bundled-agents/myagents_helper/` — 内置 MA 小助理

---

## 文档体系（必读）

本项目文档分四层。**每次会话只自动加载本 CLAUDE.md**，其它按需读取。

| 层 | 文档 | 加载方式 |
|----|------|---------|
| L1 | 本 CLAUDE.md | 每次自动加载，红线 + 元认知 + 文档导航 |
| L2 | `specs/ARCHITECTURE.md` | **不自动加载**。任务匹配下方触发条件时 MUST 主动 Read |
| L3 | `specs/tech_docs/*.md` | 改特定模块时 MUST 主动 Read 对应文档 |
| L4 | `specs/DESIGN.md` | 前端开发 MUST 主动 Read |

### MUST 主动 Read `specs/ARCHITECTURE.md` 的触发条件

- 任何"设计 / 评估 / 规划 / 重构"层面的请求
- 修改 Sidecar 生命周期、Session 切换、Owner 模型、Pre-warm
- 跨模块 / 跨进程 / 新通信模式的功能
- 涉及 SSE / HTTP 代理 / Tab 隔离 / SDK 交互的改动
- 新增 IM 适配器、Runtime、MCP server、Channel 类型
- 你不确定某个功能"应该走哪条已有路径"

### MUST 主动 Read 对应 `tech_docs/` 的触发条件

| 改动范围 | 必读 |
|---------|------|
| Pit-of-Success helper 细节 / 新增 helper | `tech_docs/pit_of_success.md` |
| Sidecar 启动性能 / 冷启动退化排查 | `tech_docs/sidecar_cold_start.md` |
| 任务中心 / Task Store / Thought Store | `tech_docs/task_center.md` |
| Cloud Space / Space Issue / Space Skill / registered agent（开发中） | `tech_docs/space_cloud.md` |
| IM Bot / Telegram / Dingtalk / 飞书 | `tech_docs/im_integration_architecture.md` |
| Plugin Bridge / OpenClaw / SDK shim | `tech_docs/plugin_bridge_architecture.md` |
| Claude Code / Codex / Gemini Runtime | `tech_docs/multi_agent_runtime.md` |
| Session ID / 存储 / 状态同步 | `tech_docs/session_architecture.md` |
| Task / Cron provider routing 三层架构 | `tech_docs/task_provider_routing.md` |
| 全文搜索（Tantivy / jieba） | `tech_docs/search_architecture.md` |
| 内置 Node.js / SDK native binary / PATH 注入 | `tech_docs/bundled_node.md` |
| `myagents` CLI / Admin API | `tech_docs/cli_architecture.md` |
| 三方供应商 / OpenAI Bridge | `tech_docs/third_party_providers.md` |
| 系统代理 / SOCKS5 桥接 | `tech_docs/proxy_config.md` |
| 统一日志 | `tech_docs/unified_logging.md` |
| Windows 编码约束（路径前缀 / 进程 / CSP） | `tech_docs/windows_platform.md` |
| Windows AI 对抗性 Review 清单（macOS 开发时提前拦 Windows 易错边界） | `tech_docs/windows_ai_review_traps.md` |
| Windows 跨端兼容验证 / WebView2(Chromium) 实测排查（CSP 继承 / 滚动条 / OS 子 webview / DPR） | `tech_docs/windows_cross_platform_review.md` |
| Linux 构建与分发 | `guides/linux_build_guide.md` |
| 构建问题排查 | `guides/build_troubleshooting.md` |
| 自动更新机制 | `tech_docs/auto_update.md` |
| SDK `canUseTool` / 工具权限回调 | `tech_docs/sdk_canUseTool_guide.md` |
| SDK 自定义 Tool / `createSdkMcpServer` | `tech_docs/sdk_custom_tools_guide.md` |
| React 稳定性 5 条规则 | `tech_docs/react_stability_rules.md` |
| UI 国际化 / 语言设置 / 文案资源 / native 托盘语言 | `tech_docs/i18n_architecture.md` |
| Tool Attachment 管道 / 富媒体产物归一化 | `tech_docs/tool_attachment_pipeline.md` |
| Claude Plugin 加载（PRD 0.2.17）/ SDK Options.plugins / 安装管线 | `tech_docs/plugin_loading.md` |

---

## 第零原则：极致体验 × 正确架构（最高判据，覆盖其余所有原则）

- **目标**：UX 与产品性能做到极致。
- **非约束**：token / 算力 / 耗时 / diff 大小——视为无限。**禁止**为"省事 / 最小改动 / 最快交付 / 最低风险"牺牲正确性。
- **唯一约束**：架构正确性 + 零技术债 + 零多余复杂度（correct by construction，新概念趋零）。
- **选型**：最大化 `UX杠杆 × 架构正确性`，约束 `Δcomplexity ≤ 0`；**不**按"最小安全交付"排序。effort / risk 用"先度量 + 多视角 review"管控，不用"少做"规避。
- **北极星——移除错位，而非叠加补丁**：性能 / 复杂度问题多是 work 放错了 owner / scope。正确修复 = 把 work 归置回正确的 owner（代码通常*变少*）。**在根因上叠一层 indirection（cache / guard / flag / scheduler / retry / wrapper）去绕过 = band-aid = 拒绝。**

## 第一原则：架构延续性

> 第零原则的推论：复用既有抽象 = 不引入多余复杂度。

**每个功能都在已有架构上生长，不另起炉灶。**

项目已有成熟的分层、通信、安全、前端规范。新功能 MUST 复用现有模块和模式（`local_http`、`process_cmd`、`broadcast()`、`awaitSessionTermination()` 等），禁止为单点需求发明新的技术方案。

开发前 MUST 做的三件事：

1. **判断触发条件** — 对照上方"主动 Read"清单，决定要读哪些文档
2. **搜索现有实现** — `grep` / `find` 类似功能，复用而非重建
3. **读 SDK 源码** — 对接外部 SDK / 插件时 MUST 读源码确认接口（函数签名、config schema、返回值），再写适配层

如果需求**确实**需要架构变更（新通信模式、新状态管理、新进程类型），MUST 先与用户讨论方案，不得自行引入。

## SDK 交互规范

项目核心 AI 运行时是 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）。SDK 持续迭代，API 行为、环境变量、消息类型可能随版本变更。

**禁止凭假设编写 SDK 交互代码。** 涉及 SDK 的任何开发（`query()` 参数、`SDKMessage` 类型处理、环境变量、Hook 注册、MCP 集成等），MUST 先查阅官方文档确认实际行为：

- **SDK 文档**：https://platform.claude.com/docs/zh-CN/agent-sdk/overview
- **SDK 类型定义**：`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`（当前版本 0.3.199）
- **SDK 工具类型**：`node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`

典型错误：臆测 `seedReadState` 调用时机导致"先读后改"语义被绕过、臆测环境变量名导致模型别名不生效。这类问题的根因都是没有查文档就动手写代码。

---

## 核心架构骨架（细节见 ARCHITECTURE.md）

理解以下抽象是改任何功能的前置认知。每条只列名字 + 关键约束。

### Sidecar Owner 模型
Sidecar 进程 = Claude Agent SDK 实例；Session : Sidecar = 1 : 1；Tab / CronTask / BackgroundCompletion / Agent 四种 Owner 共享 Sidecar，全部释放才停止。详见 ARCHITECTURE「核心抽象 / 资源管理」。

### Tab-Scoped 隔离
每个 Chat Tab 独立 Sidecar。Tab 内 MUST 用 `useTabState()` 的 `apiGet` / `apiPost`，**禁止**使用全局 `apiPostJson` / `apiGetJson`（会发到 Global Sidecar）。详见 ARCHITECTURE「核心抽象」。

### Rust 代理层
所有前端 HTTP / SSE MUST 经 Rust（`invoke` → reqwest → Sidecar）。**禁止** WebView 直发 HTTP。详见 ARCHITECTURE「通信模式」。

### 持久 Session
`messageGenerator()` 使用 `while(true)` 永远 yield，SDK subprocess 全程存活。
- 所有中止 MUST 用 `abortPersistentSession()`，**禁止**直接设置 `shouldAbortSession = true`（generator 会永久阻塞）
- 配置变更时 MUST 先设 `resumeSessionId` 再 abort，否则 AI "失忆"
- 两种重启不要混淆：直接 abort（立即 + interrupt）vs `scheduleDeferredRestart('mcp' | 'agents')`（防抖 + 下次 pre-warm 柔性重启）

详见 ARCHITECTURE「核心抽象 / Session 切换」。

### Pre-warm 机制
MCP / Agents 同步触发 `schedulePreWarm()`（500ms 防抖），Model 同步**不**触发。持久 Session 中 pre-warm 即最终 session，用户消息通过 `wakeGenerator()` 注入。**任何 `!preWarm` 守卫都可能在持久模式下永远不执行。**

**MCP 配置权威来源分离**：Tab 由前端 `/api/mcp/set` 配，IM/Cron 由 self-resolve 从磁盘读。混用会导致 fingerprint 差异 → abort → 30s 重启循环。

### Multi-Agent Runtime
内置 SDK（builtin）+ 外部 Runtime（Claude Code CLI / Codex CLI / Gemini CLI）。功能门控 `config.multiAgentRuntime`（默认关闭）。**新增"config 同步"、"注入 user 消息"、"等待 turn 完成"、"session 读/操作"的 sidecar 端点 MUST 走 `src/server/session-engine/` facade**，由 `selector.ts` 统一选择 builtin/external adapter；禁止在 `index.ts` 或新 route module 里手写 `shouldUseExternalRuntime()` 分支。漏分流会让 builtin SDK 去 resume 一个外部 runtime 从没创建的会话 → `No conversation found` → `num_turns:0` 静默空转 + 假成功（#2145eddd memory-update 实战：夜间记忆更新对 Codex 会话 0 turn、孤儿气泡）。同步/注入类 endpoint 的 `completed` 必须 gate 在真·turn 成功上（external=`didLastTurnSucceed`，builtin=`!getAndClearLastAgentError()`），由 Engine adapter 封装，别只凭 `waitForSessionIdle`。详见 `tech_docs/multi_agent_runtime.md`。

`agent-session.ts` / `runtimes/external-session.ts` 都是 public facade，不是新 owner state 的落点。Builtin 内核状态与行为在 `src/server/builtin-session/*`；external runtime 内核状态与行为在 `src/server/runtimes/external-session/*`（lifecycle / runtime-config / operation-queue / turn-lifecycle / content-blocks / transcript-persistence / interactive）。改 terminal、transcript、queue、interactive、content 相关问题时先找对应 owner API，禁止把 `saveSessionMessages()`、IM registry、terminal classification、mutable content/transcript refs 重新写回 facade。

### 定时任务系统
Rust `CronTaskManager` 统一管理所有定时任务（Chat 定时 / 独立创建 / AI 工具 / IM Cron / Heartbeat）。Cron Tool（`im-cron` MCP）已泛化为**所有 Session 可用**，始终信任。新增 `CronTask` 字段 MUST 带 `#[serde(default)]`。详见 ARCHITECTURE「定时任务系统」。

### Config 持久化（disk-first）
`AppConfig` 同时存在于磁盘（`config.json`）和 React 状态，可能不同步。写盘 MUST 以磁盘为准（`await loadAppConfig()` 读最新再合并），**禁止**直接用 React `config` 状态写盘。Agent 配置走 Rust `cmd_update_agent_config`，写盘后 MUST 调 `refreshConfig()` 同步 React。

### Builtin MCP 懒加载
6 个 in-process 内置 MCP 采用 META / INSTANCE 两层懒加载。`src/server/tools/*.ts` **禁止顶层 value-import** SDK / zod（结构性 ESLint 规则封禁）。MUST 在 `createXxxServer()` 内部 `await import(...)`。详见 `tech_docs/pit_of_success.md` 的「Builtin MCP 懒加载」节。

### Plugin Bridge
独立 Node.js 进程加载 OpenClaw Channel Plugin。MUST 与 Sidecar 同等待遇（环境变量、日志宏、config 范围）。修改 SDK shim MUST 三处同步 bump 版本（`sdk-shim/package.json` / `compat-runtime.ts` / `bridge.rs::SHIM_COMPAT_VERSION`）。详见 `tech_docs/plugin_bridge_architecture.md`。

### 工作区文件 IO（两层模型）
"OS 文件操作" 与 "AI runtime 容器" 解耦：所有工作区文件操作走 Tauri invoke（`cmd_workspace_*`，`src-tauri/src/workspace_files/`），**禁止**走 Sidecar HTTP。Launcher 没 Sidecar 也能用文件能力；云端协作时客户端可拆。前端唯一入口 `useWorkspaceFileService(workspacePath)`。
- **读侧**用 `path_safety::resolve_existing_inside_workspace`（canonicalize + prefix-check 防 `evil_link → /etc/passwd` symlink 逃逸）
- **写侧**用 `path_safety::resolve_inside_workspace`（lexical，因 `fs::canonicalize` 在不存在路径上失败）
- **绝对路径揭示**（Skill/Command 详情）走 `cmd_open_path_external`，挡 home/tmp prefix + credential 黑名单
- **fs watcher** 用 token-based handle：`watch_start` 返回 `{token, eventKey}`，`watch_stop({token})` 索引；进程 nonce 防跨重启 token 碰撞

详见 ARCHITECTURE「工作区文件 IO」。

---

## Pit-of-Success 红线总表

每条：禁止 / 后果 / 正确做法 / Lint。**违反任意一条都会引入难诊断的生产事故**。详细 rationale 与 helper API 见 `tech_docs/pit_of_success.md`。

**Lint 列含义** — 工具自动拦截违规的就在这里标记：
- `clippy` — `src-tauri/clippy.toml` 的 `disallowed-methods` / `disallowed-macros`，违规时 `cargo clippy` 报错（CI 强制）。
- `eslint` — `eslint.config.js` 的 `no-restricted-imports` / `no-restricted-syntax`，违规时 `npm run lint` 报错（CI 强制）。
- `depcruise` — `.dependency-cruiser.cjs` 的架构边界规则，违规时 `npm run lint:deps` 报错（已串入 `npm run lint`）。
- `—` — 没有自动 lint，仍是文档约束。靠 review / `tech_docs/` 兜底。**不是不重要**，是因为规则形态（路径作用域 / 跨多语句模式 / 设计原则）静态分析做不准。

**LLM 读 lint 报错时的注意事项**：每条 lint message MUST 解释"违规会发生什么 + 正确做法是什么"两件事——不要只读"用什么 helper"就照搬，先核对这条规则的 *症状* 是不是你的场景。新加 lint 时也按这个格式写，不要省 WHY，因为 LLM 是主要读者。

| 禁止 | 后果 | 正确做法 | Lint |
|------|------|---------|------|
| 裸 `reqwest::Client::new()` 连 localhost | 系统代理拦 localhost → 502 | `crate::local_http::builder()` / `json_client()` / `sse_client()` | clippy |
| 裸 `std::process::Command::new()` | Windows GUI 弹黑色控制台窗口 | `crate::process_cmd::new()` | clippy |
| 裸 `tokio::spawn` / `tokio::task::spawn` | macOS startup-abort（panic 跨 FFI 不能 unwind） | `tauri::async_runtime::spawn` | clippy |
| 同步 `#[tauri::command] pub fn` 里做会阻塞 >1 帧的工作（等 sidecar 就绪 / 轮询 / 网络 / 大量文件 copy / kill+wait） | **同步 Tauri 命令跑在主线程 = macOS 上 WKWebView 的 UI 线程 → 命令执行期间整个 WebView 冻结、画不出任何东西**（React 提交了 DOM 也绘制不出）。#0.2.31 实战：`cmd_ensure_session_sidecar` 同步等 sidecar 冷启动 ~800ms → 点工作区卡后整个 UI 卡死 ~800ms 才翻页；所有前端补丁（flushSync / deferred-mount）都没用，因为冻结在 Rust 主线程。**排查信号**：点击后页面不变但 React 已 commit → 用 double-rAF `chat_painted` 量*真实绘制*（不是 commit），若绘制时刻 ≈ 某同步命令返回时刻，即是它 | 改 `pub async fn` + 把阻塞部分丢进 `tauri::async_runtime::spawn_blocking`（先把 `State` 里的 Arc clone 出来，**别跨 `.await` 持 State guard**）。快速查表 / getter 类同步命令不受影响，无需改 | — (静态判不出某命令是否阻塞，靠 review；改阻塞命令时必查) |
| 子进程 spawn 不调 `apply_to_subprocess`；或 provider-owned 子进程不用 provider-aware proxy helper | Node fetch 读继承的 HTTP_PROXY → localhost 通信被代理 → 502；provider custom scope 被绕过，未选 provider 可能错误使用 MyAgents proxy 或丢失原始系统 proxy baseline | 无 provider owner 的子进程用 `crate::proxy_config::apply_to_subprocess(&mut cmd)`；provider-owned 子进程用 `apply_to_subprocess_for_provider(&mut cmd, provider_id)`；Node provider-owned 请求用 `applyProviderProxyPolicyToEnv(env, providerId)` / `getProxyForProviderUrl(providerId, url)`。Rust 注入 MyAgents proxy 时必须带 `MYAGENTS_PROXY_INHERITED_ENV_JSON`，供 excluded provider 恢复注入前 env | — (语义检查难自动化) |
| Chat 新增"mount 期把配置推给 sidecar"的 effect 不门控 `sidecarConfigDisposition`；或 instant-flip 到 chat 时用 pre-ensure 检查（`getSessionPort`）预测 push-vs-adopt | config-stomp TOCTOU（#300/#301）：并发 Rust creator（cron / IM / 崩溃重启）在"检查"与"ensure"之间起 sidecar → ensure 接管活 sidecar 而 Chat 仍推配置 → 冲掉 + MCP 指纹 abort + 30s 重启循环。即时进入（flip 先于 ensure）放大了这条 | 唯一裁决者 = `ensureSessionSidecar` 后的 `result.isNew`（Rust 锁内）；flip 前不确定就置 `'pending'`（Chat 既不推也不采纳）；配置推 effect 门控 `disposition==='push'` 且依赖布尔 `configPending`（pending→push 重跑、adopt→push 不重放），采纳 effect 依赖 `isAdopt`；用户主动改走 defer-while-pending；catch 把 pending tab 重置为终态 `push`。详见 `tech_docs/session_architecture.md`「Sidecar 配置归置」 | — (effect 门控漏项 AST 抓不出，靠 review) |
| 裸 `which::which()` 查系统工具 | Finder 启动时 PATH 缺失 | `crate::system_binary::find()` | clippy |
| Tauri `resource_dir()` / `current_exe()` 路径直接喂 Node / npm / URL / 子进程 | Windows `\\?\` 长路径前缀让 `fileURLToPath` / spawn 报 `ERR_INVALID_FILE_URL_PATH` 或静默挂 | `crate::sidecar::normalize_external_path(p)`，在路径"出 Rust 边界"前剥前缀 | — (路径来源动态) |
| `~/.myagents/config.json` 裸 `tmp + rename` | 多写者 race，密钥静默丢失 | Node `withConfigLock` / Rust `with_config_lock` / renderer `withConfigLock` | — (路径作用域，banning all `fs::rename` 噪音过大) |
| 单写者文件裸 append / read-modify-write | 应用内多 owner race | `withFileLock` / `with_file_lock` / `with_file_lock_blocking` | — (writer-pattern 依赖) |
| Runtime 子进程 stop 用裸 `SIGTERM + waitForExit` | 进程拒收 SIGTERM 时永久卡死 | `killWithEscalation` | — (跨多语句模式，false-positive 高) |
| 工具 / bridge 裸 `fetch()` 无 AbortSignal | 下游卡住 → tool turn / IM 消息处理永久 hang 直到 OS TCP 超时（分钟级） | `cancellableFetch` / `withAbortSignal`（`@/server/utils/cancellation`，默认 30s 超时 + parentSignal 传递） | eslint (`src/server/tools/**` + `plugin-bridge/**`) |
| 大 payload（>256KB）直接进 SSE / IPC JSON | OOM / UI 卡死 / 慢 client 拖死 sidecar | `maybeSpill` + `/refs/:id` + SSE 优先级队列 | — (运行时 size 判定) |
| Sidecar 路由直接给 WebView fetch 使用却不带 `Access-Control-Allow-Origin` | 渲染器 native `fetch('http://127.0.0.1:<port>/...')` 拿到 opaque 响应，被 WebKit 拒绝可读，JS 侧报 `TypeError: Load failed`（#109 实战出现）。绝大部分 sidecar 接口走 Tauri invoke proxy 不走原生 fetch，所以这条只对**渲染器直连 sidecar HTTP 端口**的接口生效（比如 `>1MB` 溢出回 ref-url 的 `/refs/:id`、附件 `/attachment/*`） | 这类接口必须返回 `Access-Control-Allow-Origin: '*'`。已有惯例：`fileResponse(path, { headers: { 'Access-Control-Allow-Origin': '*' } })`。CSP 同步——渲染器直连的 `http(s)://...` 端口要在 `connect-src` 里列出（管 fetch/XHR/WS 的标准指令就是 `connect-src`；曾经配的非标准 `fetch-src` 引擎一律忽略，已移除，别再加回来） | — (handler 内部行为，AST 抓不出意图) |
| 同步 busy-wait（`Atomics.wait` / spin / `while Date.now()`） | 阻塞 event loop / Sidecar 停止 drain SDK 消息 / pegs CPU | 异步 polling / 现成 helper（`setTimeout` / `withFileLock`） | eslint (`Atomics.wait`) |
| readiness 等同 liveness | renderer 假就绪 | `/health/{live,ready,functional}` 三分；renderer 挂 `/health/ready` | — (语义检查) |
| `src/server/tools/*.ts` 顶层 import SDK / zod | builtin MCP 懒加载失效，冷启动每次税 ~500–1000ms（6 tools = ~3–6s） | factory 内部 `await import(...)` | eslint |
| 直接设置 `shouldAbortSession = true` | 跳过 abort cleanup 链（pending 救援、IM bus 通知、generator 唤醒）→ pending IM 回复永久 hang | `abortPersistentSession()` | eslint |
| 给 SDK 传 `allowDangerouslySkipPermissions:true` 后假设 `permissionMode:'plan'` 仍拦写；或用 per-agent `permissionMode` / `canUseTool` 去拦 `run_in_background` 子 Agent | **SDK 在多条路径下根本不调 `canUseTool`**：(1) plan 被降级 allow-all——原生解析器 `plan && bypassAvailable → "allow"`，只有 `"ask"` 分支才发 `can_use_tool`，弱模型 `rm -rf`/`Edit` 直接执行、`permission_denials` 空（#295）；(2) 后台子 Agent 的工具调用从不进 canUseTool，无 hook 放行 → SDK 自动拒绝、委派失败（#264）。注：MyAgents `auto→acceptEdits`，per-agent `permissionMode` 在此默认下被 SDK 跳过 | 用 **hook** 硬闸（跑在原生解析器之前，`deny` 无条件采纳）：plan 用 `PreToolUse` hook（`plan-mode-gate.ts`，**fail-closed 同时看 SDK 传入的 `permission_mode` 和本地 live 镜像，任一为 `plan` 即拦**，覆盖 AI 中途 `EnterPlanMode`）；后台 Agent 用 `PermissionRequest` hook（`background-agent-permission.ts`，按 `task_started.task_id===agent_id` 关联后台性） | — |
| 函数参数用 `undefined` / `null` 表特定动作 | 内部调用方误触发 | 自解释字面量（如 `'subscription'`） | — (设计原则) |
| 新增 SSE 事件不注册白名单 | 前端静默丢弃 | 在 `SseConnection.ts::JSON_EVENTS` 注册 | — (跨文件分析复杂) |
| Sidecar 用 `__dirname` | esbuild 硬编码路径到源文件位置 → 运行时落到不存在/陈旧的 dist/ 路径 | `fileURLToPath(import.meta.url)` / `getScriptDir()`（`@/server/utils/runtime`） | eslint (`src/server/**`) |
| Sidecar 用 `readFileSync(path.join(__dirname, ...))` 读 bundled 资源 | 同上 | 内联常量 / `fileURLToPath(import.meta.url)` 算路径 | — (`__dirname` 已 lint，`readFileSync` 本身有大量合法用途) |
| 日志日期用 UTC `toISOString().split('T')[0]` | UTC 与本地日期在 UTC+8 有 1/3 时间不匹配 → 日志写错文件，按"今天的日期" grep 找不到 | `localDate()`（`@/shared/logTime`） | eslint |
| Rust 日志用 `log::info!` / `warn!` / `error!` / `debug!` / `trace!` | 不进统一日志（`~/.myagents/logs/unified-{date}.log`），renderer 日志面板和"读 unified log"的红线全失效 | `ulog_info!` / `ulog_warn!` / `ulog_error!` / `ulog_debug!` | clippy |
| 前端 `@tauri-apps/plugin-fs` 读写工作区 | Tauri fs scope 仅覆盖 `~/.myagents/**`，工作区路径会失败 | `invoke('cmd_read_workspace_file')` / `cmd_write_workspace_file` | — (路径作用域，import 维度判不准) |
| 工作区文件 IO 走 sidecar HTTP（`/api/files/*`、`/api/commands`、`/api/git/branch`、`/api/claude-md`、`/agent/{dir,dir/expand,file,download,import,new-file,new-folder,rename,delete,move,open-in-finder,open-with-default,open-path,search-files,check-paths,save-file}` 共 18 个端点） | 启动页没有 Sidecar，这些路径在 launcher 直接死掉（PRD 0.2.7 实战：`'API 未就绪'` toast、空斜杠菜单）；把"AI runtime 容器"和"OS 文件操作"耦合，云端协作时分不开 | 走 Rust invoke：`cmd_workspace_*`（见 `src-tauri/src/workspace_files/`）。前端入口 `useWorkspaceFileService(workspacePath)`；绝对路径揭示用 `cmd_open_path_external`（Skill/Command 详情面板）；CLAUDE.md 编辑用 `cmd_workspace_read_claude_md` / `cmd_workspace_write_claude_md`。**18 个 sidecar 端点已全部下线（v0.2.7 Phase E）** | eslint (字面量封禁) |
| Chat / Launcher 各自实现"选项变更持久化" | 字段集合 / 分支条件漂移（v0.2.7 之前 Chat 把 external runtime 的 permission mode 写到 `Agent.permissionMode` 而不是 `runtimeConfig.permissionMode`，launcher 是对的；cross-protocol guard 仅 Chat 有；MCP 写盘字段也不同） | 调统一 `persistInputOptionChange(...)`（`src/renderer/api/persistInputOption.ts`）。helper 接 `sessionId` / `isExternalRuntime` / `currentRuntimeConfig`，分支由它处理。新增字段只改这一个文件 | — (设计层模式) |
| 依赖用户系统安装的运行时 | 用户未装 → 功能不可用 | 内置 Node.js（`runtime.ts::getBundledNodePath()`） | — (设计决策) |
| 用 `existsSync` / `Path::exists()` 当"路径上有没有东西"探针，紧接着 `cpSync({recursive:true})` / `fs::create_dir_all` / `fs::remove_dir_all` 跑过去 | 跟随 symlink 语义 → **断链 symlink 返回 false** → 代码以为不存在 → Node v24 `cpSync` 走进 `std::filesystem::equivalent` 抛**未捕获 C++ 异常**（`libc++abi: filesystem error: in equivalent: Operation not supported`），JS try/catch 接不住，整个 sidecar abort，Tauri 健康检查重启 → 死循环（v0.2.5 实战：`~/.myagents/skills/docx` 是断链让全局 sidecar 起不来）。注意 async `fs.cp` 不崩，**只有 sync `cpSync` 崩** | 在跑写操作之前 MUST 用**不跟随 symlink** 的 API 探：Node 用 `lstatSync` + `existsSync` 双探（`isSymbolicLink && !existsSync` ⇒ 断链，先 `unlinkSync`），Rust **MUST 用 `fs::symlink_metadata`，不要用 `fs::metadata()`**（后者跟随 symlink 与 `Path::exists()` 同病）；拿到 `Metadata` 后 `is_symlink() \|\| is_file()` → `remove_file`，是目录 → `remove_dir_all`。修复样板见 `src/server/index.ts::seedBundledSkills` 与 `src-tauri/src/commands.rs::cmd_sync_system_skills` | — (跨语句模式) |
| 新增 overlay / 可关闭面板不调 `useCloseLayer` | Cmd+W 跳过该面板直接关 Tab | `useCloseLayer(handler, zIndex)`，zIndex 与 CSS 一致 | — (语义识别) |
| Overlay 遮罩用裸 `<div>` + `onClick` / `onMouseDown` | 选中文字拖到面板外松手会误关 | `<OverlayBackdrop>` 组件 | — (语义识别) |
| onClick 里 `requestAnimationFrame(() => otherEl.focus())` 抢焦点 | macOS WebKit 触摸板 tap 会被吞掉 | `onMouseDown={retainFocusOnMouseDown}`（`@/utils/focusRetention`） | — (语义识别) |
| 前端硬编码颜色（`#fff`、`bg-blue-500`） | 破坏设计系统一致性 | CSS Token `var(--xxx)`，参考 DESIGN.md | — (Tailwind class 形态太多，false positive 炸裂) |
| 前端任意 px 字号（`text-[13px]`）或已删档位类名（`text-2xs/2sm/md`） | 字阶漂移：幽灵字阶曾长到 ~700 处 → 跨场景"字号大小不一"（用户投诉根因，PRD 0.2.34 三阶段清零）；死类名无 @theme token，写了编译不报错但字号**静默失效** | 终局七档 utility：`text-xs`(12 meta)/`text-sm`(14 UI/表格)/`text-base`(16 正文)/`text-lg`(18 弹窗标题)/`text-xl`(20)/`text-2xl`(22)/`text-3xl`(28)，定义在 index.css `@theme`。xs/sm/base/lg/xl 与 Tailwind 官方一致，**唯 text-2xl=22px（官方 24）与 text-3xl=28px（官方 30）**。离阶展示型字号（品牌字）先在 DESIGN.md 立档再单行 disable | eslint (`src/renderer/**`) |
| 表单原生 `<select>` | 系统下拉框跨平台不一致 + 不可主题化 → 破坏 DESIGN.md 视觉一致性 | `<CustomSelect>` 组件 | eslint |
| 新增手写 SDK shim 不加入 `_handwritten.json` | `generate:sdk-shims` 下次覆盖手写 | 同步加入 `sdk-shim/plugin-sdk/_handwritten.json` | — (协调性变更) |
| 把 model id 直接喂给 SDK ingress（`query({ model })`、`query({ agents: { ...{ model } } })`、`querySession.setModel()`、`ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU}_MODEL` env）不过 `applyContextWindowSuffix` | 1M 窗口模型（claude-opus-4-7 / claude-opus-4-6 / deepseek-v4-pro / gemini-2.5-pro / gpt-5.4 ……）退回 SDK 200K fallback，`/context` 显 200K，auto-compact 在 ~187K 触发，附件按 200K 截。`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 只能 `Math.min` 下调不能上调，对 >200K 模型彻底无效。**200K–1M 中间档（minimax-m3 512K / doubao 262K / kimi-k2.5 262K）同病**（#335）：wrap 策略为 registry contextLength **>200K 即加 `[1m]`**（不是只 ≥1M），SDK 窗口解锁到 1M 后由 env cap 收回真实值（有效压缩窗口 = min(1M, registry) − ~33K）；SDK `/context` 头条会显 1M（已知装饰性偏差，MyAgents 自己的圆环显 registry 真值）。注意 `claude-sonnet-4-6` 不在此列：Anthropic Sonnet 4.6 wire-default 200K，1M 需要 `context-1m-2025-08-07` beta header + Tier-4 配额或"extra usage"付费开关，订阅默认开 1M 会触发 `Extra usage is required for 1M context` 报错（v0.2.11 修复，预设 contextLength 已降回 200K） | `applyContextWindowSuffix(model)`（`@/server/utils/model-capabilities`）。注意反向：bridge `modelOverride`、`*_MODEL_NAME` env、cron / persisted state、所有用户可见处必须用未 wrap 的原始 model id。SDK `normalizeModelStringForAPI` 在 wire 上剥 `[1m]`，所以上游 API 不会看到后缀 | — (DOM 层级注入位置无固定 AST 形态，靠 review 兜底) |
| 工具产物的图片 / 音频 / PDF 等富媒体走 `tool_result.content` 字符串或为单点工具写专门 React 组件 | (1) 用户切到 Codex Runtime 调 OpenAI 官方 `image_generation` → 工具卡显示但**图片完全不渲染**（v0.2.15 实战）；(2) 大 base64 直接进 SSE → 撞 256KB 红线；(3) 每个产图工具都要写一个 React 组件——v0.2.15 之前 `mcp__gemini-image__` 是唯一支持的，Codex 官方工具名不匹配走不到分支 | 走协议层一等公民 `tool_result.attachments: ToolAttachment[]`：sidecar 用 `saveToolAttachment(...)`（`src/server/runtimes/tool-attachments.ts`）落盘到 `~/.myagents/generated/tool-attachments/<sid>/<tid>/<file>` 或零拷贝引用外部路径，前端用单一 `ToolAttachmentGallery` 渲染。详见 `tech_docs/tool_attachment_pipeline.md` | — (设计层模式) |
| 攻击者控制的绝对路径直接进 `validateExternalReadPathNode(path)`（`canonicalizeSymlinks: false`）后引用为 attachment | symlink 逃逸：`~/.codex/sessions/evil_link.png` → `/etc/passwd` lexical 检查通过 → endpoint 流回敏感字节 | 读侧 MUST 用 `canonicalizeSymlinks: true`（默认），`fs.realpath` 解析后再过 blacklist；并 `lstatSync.isSymbolicLink()` 拒绝 symlink leaf；外部路径还要过 `isAllowedExternalAttachmentPrefix` positive allow-list（仅允许 `~/.codex/` `~/.myagents/` `~/Documents/` 等）。详见 `tech_docs/tool_attachment_pipeline.md` 第 4 节 | — (语义检查，靠 review) |
| URL 下载（`dynamicToolCall.imageUrl` 等 prompt 可控的 URL）直接走 `cancellableFetch(url)` 不限 scheme / 不挡私网 | SSRF：恶意 MCP 工具用 `http://169.254.169.254/...`（AWS metadata）或 `http://127.0.0.1:.../` 让 sidecar 当跳板 | `tool-attachments.ts::downloadAndSaveUrl` 已限定 `https:` + 拒绝 loopback / RFC1918 / 169.254/16 / IPv6 ULA + `redirect: 'error'`。新增"prompt 可控的 URL 下载"路径 MUST 同样校验 | — (调用方语义) |
| Node 端 path-safety 黑名单（`src/server/utils/path-safety.ts`）与 Rust `commands::validate_file_path` 不同步 | 两侧任何一边新增 credential dir 后，另一边静默放行 → 攻击面 | 改一处 MUST 同步另一处。后续 PR 会加 cross-check test（PRD 0.2.15 §7.2 TODO） | — (跨语言同步) |
| 会话历史恢复让 SSE `chat:message-replay`（sidecar 内存）与 REST 并存为双历史源；或按"已恢复"统一 skip 该事件 | REST（磁盘·权威·分页有序）与内存 replay（可能传输截断）互相覆盖 → 恢复丢最新消息（#0608）；且 `chat:message-replay` **重载**：SSE-connect 冷历史 backfill **＋ 新发 user/command 气泡的 live echo**（前端不本地 append，靠它显示气泡）→ 统一 skip 会吞掉 user 气泡 | 会话历史恢复**唯一权威 = REST `/sessions/:id`**（active session 已 merge 内存未持久化消息），SSE replay 让位：用**同步**标志 `restoredSessionIdRef` 决策，**禁止**用异步滞后的 `historyMessagesRef.length` 做同步 clear 判断；冷历史 backfill 打 `replayKind:'cold-history'`，live echo 不打，**只 skip 冷历史**（纯核心 `sessionRestoreGuards.ts`）。诊断"恢复只显示一部分"：磁盘 `~/.myagents/refs/<id>` spilled body = 后端实发 JSON（node 直接 parse），先把"后端发了什么"与"前端显示什么"一刀切开 | — (语义，靠 review) |
| 比较工作区路径（`Project.path` ↔ cron/task `workspacePath` / session `agentDir` / config `defaultWorkspacePath`）用 raw `===` 或 inline `.replace(/\\/g,'/')` | Win 上 `projects.json` 存反斜杠、cron/session 存正斜杠 → 永不相等且**静默**：#320 定时任务"升级为新版任务"全报"找不到工作区"，连带 task 卡掉工作区名 / Recent 会话空白 / 工作区过滤全"(已失效)" | `workspacePathsEqual(a,b)` 谓词 / `normalizeWorkspacePathIdentity(p)` 做 Set·Map 键（`src/shared/workspacePath.ts`，Rust `cron_task/validation.rs::normalize_path` 的逐行 TS 端口；键 build+lookup 两侧都要过）。详见 `pit_of_success.md`「workspacePath」 | — (语义，靠 review) |

### 架构边界（dependency-cruiser 强制）

`.dependency-cruiser.cjs` 把模块图边界变成 lint。`npm run lint` 串入了 `lint:deps`，违规 CI 直接 fail。

| 禁止 | 后果 | 正确做法 |
|------|------|---------|
| `src/server/tools/*` import `agent-session.ts` | 重新触发 builtin MCP 懒加载架构想避免的 cold-start 单例税；或者形成循环（agent-session 反过来调 tools 注册 MCP） | 把 tool 需要的数据通过 `createXxxServer()` 工厂参数传入，不要顶层 import |
| `src/server/tools/*` 互相 import（除 `builtin-mcp-registry.ts` / `builtin-mcp-meta.ts`） | 耦合各自的懒加载生命周期，可能复活每个 tool ~500–1000ms 的 eager-load 税 | 共享 surface 通过 registry / meta 文件 |
| `src/renderer/**` import `src/server/**` | 进程边界混淆：renderer 是 WebView (Vite-bundled)，sidecar 是 Node (esbuild-bundled)，runtime / globals / module resolution 全不一样。bundle 时崩或者把 server 代码静默 inline 进 renderer | 共享类型放 `src/shared/`；通信走 Tauri invoke 或 SSE |
| `src/server/**` import `src/renderer/**` | 反向同上：renderer 用 DOM / React API，Node 没有；esbuild 要么报错要么拉 polyfill | 共享放 `src/shared/`；事件通信走 SSE |
| `src/shared/**` import renderer / sidecar / cli | shared 被两边消费，必须保持纯净。如果引入 process-specific dep，要么另一边 bundle 时崩，要么把错误 runtime 代码塞进错误 bundle（React 进 sidecar / fs 进 renderer） | 进程特定的代码放 `src/renderer/shared` 或 `src/server/shared` |
| 静态循环依赖（不经 `lazy(() => import(...))` 打破） | 模块 init 顺序不确定（一边在 module-eval 时看到 `undefined` 而非 export，第一次调用时才崩）+ bundle 膨胀 | 抽出共享接口到第三个 leaf 模块；React 重组件用 `lazy()` 是 OK 的 |

---

## 开发命令

```bash
npm install                       # 依赖安装（v0.2.0+ 统一 npm）
./start_dev.sh                    # 浏览器开发模式（快速迭代）
npm run tauri:dev                 # Tauri 开发模式（完整桌面体验）
./build_dev.sh                    # Debug 构建（含 DevTools）
./build_macos.sh                  # 生产构建
./publish_release.sh              # 发布到 R2
./publish_managed_codex_runtime.sh -y      # 发布 Managed Codex runtime macOS 资源
powershell -ExecutionPolicy Bypass -File ./publish_managed_codex_runtime.ps1 -Yes  # 发布 Managed Codex runtime Windows 资源
npm run typecheck && npm run lint # 代码质量检查
npm run test:classification       # server 测试后缀/分层 guard
npm run test:unit                 # 快池（纯逻辑，并行，秒级）— 开发回合中频繁跑
npm run test:dom                  # jsdom 池（*.test.tsx 组件/安全不变量，秒级）
npm run test:integration          # CI-safe 后端集成池（串行、no-egress、无真实密钥）
npm run test:credentialed         # 真实 Provider/SDK/network smoke，显式本地跑，不进默认 CI
npm run test:changed              # 受未提交改动影响的 deterministic 测试（不跑 credentialed）
npm test                          # classification + unit + dom + integration，不跑 credentialed
npm run coverage                  # 非 credentialed 覆盖率报告（不设硬阈值，看改动文件 ratchet）
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check  # Rust 格式检查（使用 rust-toolchain.toml pin 的 rustfmt）
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D clippy::disallowed_methods -D clippy::disallowed_macros
```

## Managed Codex Runtime 资源发布

Managed Codex Runtime 是桌面 App 之外的独立可执行资源。它不随 `publish_release.sh` / `publish_windows.ps1` 上传；只有客户端代码锁定了新的 `REQUIRED_RUNTIME_SET` / `REQUIRED_VERSION`，或需要补发缺失平台资源时，才单独发布。细节见 `specs/guides/build_and_release_guide.md`。

底层脚本入口：

```bash
./publish_managed_codex_runtime.sh -y
```

```powershell
powershell -ExecutionPolicy Bypass -File ./publish_managed_codex_runtime.ps1 -Yes
```

`package.json` 里的 `npm run publish:managed-codex -- -y` 和 `npm run publish:managed-codex:win -- -Yes` 只是上述脚本的快捷别名，便于 AI / CI 统一调用；真正维护和审查的入口是根目录这两个 publish 脚本。

发布脚本默认从 `src-tauri/src/managed_codex.rs` 读取 `REQUIRED_RUNTIME_SET` 与 `REQUIRED_VERSION`，不要手动从桌面 App 版本推导。macOS 脚本默认发布 `darwin-arm64,darwin-x64`；Windows 脚本默认发布 `win32-x64`。两边上传到同一个 R2 前缀：`runtimes/codex/sets/<runtime-set>/...`。

非交互发布必须显式带 `-y` / `-Yes`。默认禁止覆盖已存在的同平台 manifest；除非确认远端内容错误，否则不要使用 `--force-republish` / `-ForceRepublish`。

Windows 资源必须在 Windows 发布端验证 OpenAI `codex.exe` 的 Authenticode 签名；不要在 macOS 上绕过这一步上传 Windows 正式资源。

## Rust 工具链纪律

Rust 工具链由仓库根目录 `rust-toolchain.toml` 固定，开发机和 CI MUST 使用同一版本的 `rustc` / `rustfmt` / `clippy`。安装 Rust 时用 `rustup`，不要用系统包管理器的浮动 Rust；进入仓库后 `rustup` 会自动切到 pinned toolchain。

- 不要把浮动 `stable` 的 `rustfmt` 输出混进功能提交。
- 升级 Rust 版本时，先改 `rust-toolchain.toml` 和 CI toolchain，再单独跑 `cargo fmt --manifest-path src-tauri/Cargo.toml`，并用独立 `chore(rust): format sources with pinned rustfmt` 提交承接机械 diff。
- `src-tauri/Cargo.toml` 的 `rust-version` 是 MSRV（最低可编译版本），不是格式化/CI 的实际版本来源；实际版本以 `rust-toolchain.toml` 为准。

## 测试纪律（回归护栏）

测试不是为了追覆盖率，而是把重要行为、历史事故和架构边界变成可执行契约；AI 开发时 MUST 把它当成开发回合内的护栏，主动跑、即时修。

当前 Vitest 四池（见 `vitest.config.ts`）：`unit` = 纯逻辑快池（`src/shared/**` / `src/renderer/**` 的 `*.test.ts` + server 侧 `*.unit.test.ts`，并行、秒级）；`dom` = `*.test.tsx` 组件 / hook / 安全不变量（jsdom，秒级）；`integration` = CI-safe 后端集成池（`*.integration.test.ts`，singleFork，允许 module globals / loopback / 临时 HOME / SessionStore）；`credentialed` = 真实 Provider / SDK / network smoke（`*.credentialed.test.ts`，显式本地跑，不被 `npm test` / public CI 执行）。`unit` / `integration` 都加载 `src/test/setup-no-egress.ts`，禁止非 loopback 出站；Rust 测试走 `cargo test`，`npm test` 不覆盖 Rust。

- **操作速查**：组件测试的 `*.test.tsx` 只进 `dom`，不会被 `test:unit` 覆盖；旧 `stateful` 池已拆成 `integration`（stateful but deterministic，进 CI）和 `credentialed`（真实密钥/真实网络，显式本地跑）；`test:changed` 只适合本地快速回归，改测试分层、CI、runtime/session 边界时仍要跑 `test:classification` + 对应全池。
- **何时补测试**：修 bug MUST 补能复现该 bug 的回归测试；新增红线 helper / 纯函数 MUST 配单测；改 pure policy / parser / queue / config 判断，优先进 `unit`；改 session / runtime / turn / transcript / IO / security 边界时，补 integration / boundary guard，能静态拦的用 lint / depcruise / clippy。
- **何时可不补**：纯文档、copy、样式微调、机械搬文件且已有等价覆盖时可以不加，但不能用这个理由跳过高风险行为变化。
- **怎么写**：把决策逻辑抽成纯函数（Functional Core / Imperative Shell），副作用留薄外壳；server 测试文件名必须显式分层：`*.unit.test.ts` / `*.integration.test.ts` / `*.credentialed.test.ts`，不允许裸 `src/server/**/*.test.ts`；涉及时间 MUST 注入时钟 / `vi.useFakeTimers`，涉及本地日期 MUST pin `process.env.TZ`。
- **稳定性红线**：默认测试必须 deterministic，不依赖真实网络、真实密钥、真实 HOME；需要真实 Provider / SDK / upstream 的测试只能进 `credentialed`，无 secret 时 self-skip；测试失败不许靠弱化断言或 `skip` 糊过去，先判断是产品 bug 还是测试契约漂移，订正不变量必须有理由。
- **命令纪律**：改纯逻辑后跑 `npm run test:unit`；改组件 / `.test.tsx` 后跑 `npm run test:dom`；改后端 session / runtime / persistence / IO / security 后跑 `npm run test:integration` 和 `npm run test:classification`；需要本地 deterministic 全量 Vitest 才跑 `npm test`；真实供应商链路才手动跑 `npm run test:credentialed`。
- **CI gate**：PR + push 到 `dev/**` / `main` 跑 typecheck + lint + `test:classification` + `test:unit` + `test:dom` + `test:integration` + `build:server` / `build:bridge` / `build:cli` / `build:web` + `cargo test` + Clippy redline；credentialed 与完整 `tauri build` 不进普通 CI。

## Git 与工作流

- **提交前 MUST**：`npm run typecheck` + `npm run test:unit`（秒级；若动了 `.test.tsx`/组件再加 `npm run test:dom`；若动了后端 session/runtime/IO/security 再加 `npm run test:classification` + `npm run test:integration`），检查当前分支（`git branch --show-current`）
- **并发 writer 纪律（本仓库常态）**：working tree 可能被并行 session / 用户同时改，会话开始的 git 快照是**冻结的**、不反映实时树。提交前 MUST 重跑 `git status`；**禁止 `git add -A` / `git add .`**——显式列出只属于你的文件；对改过的文件用 `git diff -- <file>` 确认没混入别人的 hunk（混了就别整文件 stage，隔离自己的 hunk 或先协调）；验证后**尽快提交**（拖延会被并发 `commit -a` 把混合文件卷走）。**禁止** `checkout HEAD -- <file>` / amend 共享 commit 去"清理"——会毁掉对方未提交工作，改用追加 commit。whole-tree `npm run lint` / `typecheck` 可能因别人未提交代码报错，用 `npx eslint <你的文件>` 自查
- **发布前验"已提交态"而非工作树**：并发 writer 可能提交了组件改动、却把配套测试 fix 留在工作区 → **已提交分支是红的，但你本地 `npm test` 因工作区 fix 而绿**（0.2.29 实战：`SimpleChatInput` 的 `useConfigData` 改动已提交、其测试 mock 未提交 → 已提交态 `useConfigData must be used within <ConfigProvider>`）。合 main / 打 tag 前 MUST 先 `git stash` 掉无关工作区文件（或确认 `git status` 干净）再跑易红测试；load-bearing 的未提交 fix 就显式提交进发布准备，别 ship 红分支
- **分支策略**：`dev/x.x.x` 开发 → 合并到 `main`。MUST NOT 在 main 直接提交
- **合并到 main**：需 typecheck + lint 通过 + 用户明确确认
- **Commit 格式**：Conventional Commits（`feat:` / `fix:` / `refactor:`）。**只有 prefix 不算合格**：`fix: harden X` / `fix: update Y` 这种只复述 diff 的 subject 仍然是不合格 message。
- **Commit message 写什么**：diff 已经说清「改了什么」，message 别重复它，专心写「为什么」——为什么要改、为什么这么改而不用那个更显然的办法、有哪些后人不能踩的坑。它是写给半年后来翻这段历史的人（或 AI）看的，不是写给此刻的自己。内容必须和真正提交的代码一致，别写没做、或后来又改掉的事。长短随改动而定：错别字一行就够，微妙的 bug、架构取舍值得写一段。别写 `fix`、`update`、`wip` 这种等于没写的，也别一次提交里混进好几件不相干的事。
- **Commit 命令前硬闸**：在输入 `git commit` 前，先用“看不到 diff 的半年后维护者”视角检查 message：① 是否说明了触发 bug / 需求的真实故障模式或产品动机；② 是否说明了关键取舍（为什么不是更显然的 move/delete/cache/guard 等方案）；③ 是否标出副作用、残留风险或后人不能踩的坑。任一回答为“没有”，就不要提交，先重写 message。除错别字 / 纯机械小改外，非平凡 bugfix / refactor / 架构相关改动 MUST 用多段 message（`git commit -m "<subject>" -m "<body>"` 或 `git commit -F <file>`），禁止只写一行 subject。
- **发布流程**：先更新 CHANGELOG.md → `npm version` → 若本客户端锁定了新的 Managed Codex runtime set，先用独立脚本确认对应平台资源已上传 → `./build_macos.sh` → `./publish_release.sh` → push tag

## 日志与排查

日志来自三层（React / Node.js Sidecar / Rust），汇入统一日志 `~/.myagents/logs/unified-{YYYY-MM-DD}.log`。**用户报告问题时 MUST 主动读日志，不等用户粘贴。**

- **IM Bot 问题**：搜 `[feishu]` `[im]` `[telegram]` `[dingtalk]` `[bridge]` `[openclaw]`
- **AI / Agent 异常**：搜 `[agent]` `pre-warm` `timeout`
- **定时任务**：搜 `[CronTask]`
- **终端**：搜 `[terminal]`
- **前端整页崩溃（「界面渲染出错」/ 白屏）**：搜 `[AppErrorBoundary]`（`componentDidCatch` 把 error + componentStack 经 console.error 写进统一日志）+ `[REACT] [ERROR]`。`AppErrorBoundary` 在 React 根（main.tsx，所有 provider 外，无 per-tab/per-message 边界）→ **任意组件 render 抛错 = 整页崩**。先看 `error.message`（保真、是定位线索）+ 时间线（崩前用户在做什么）。componentStack 只在 dev / 有 sourcemap 时能定位组件，release 包被 minify。
- **Rust 层**：额外查 `~/Library/Logs/com.myagents.app/MyAgents.log`

详见 `tech_docs/unified_logging.md`。

---

## 内置 MA 小助理（修改约束）

应用内置 AI 助手运行在 `~/.myagents/`，通过 `/myagents-cli` system skill 调用 `myagents` CLI **直接执行**用户管理操作（不是输出操作步骤）。该 skill 是全局的——所有 session（Chat / IM Bot / Cron / Helper）都能用它驱动 MyAgents 的产品能力。

- 修改 `bundled-agents/myagents_helper/` 的 CLAUDE.md 或 Skills → MUST bump `ADMIN_AGENT_VERSION`（`src-tauri/src/commands.rs`）
- 修改 `src/cli/myagents.ts` 或 `src/cli/myagents.cmd` → MUST bump `CLI_VERSION`，并同步更新 `bundled-skills/myagents-cli/SKILL.md`（CLI surface 变化必须在 skill 文档里反映出来）+ bump `SYSTEM_SKILLS_VERSION`
- 修改 `bundled-skills/` 中 system skill（清单见 `SYSTEM_SKILLS`） → MUST bump `SYSTEM_SKILLS_VERSION`
- 新增 system skill：(1) 放入 `bundled-skills/<name>/`；(2) 加入 Rust `SYSTEM_SKILLS` 和 Node `src/server/index.ts::SYSTEM_SKILLS` 两个清单；(3) bump 版本
- **utility skill vs system skill**：清单内 = system（强制更新）；其它 = utility（首次 seed 后归用户）

---

## 求助 / 反馈

- `/help` — Claude Code 用法
- 反馈：https://github.com/anthropics/claude-code/issues
