---
type: prd
status: in-progress
created: 2026-09-19
updated: 2026-09-21
scope: "收敛 0.4.21 外部 CLI 已提交实现的端到端契约：保留正确的 Rust policy、Node admission、Launcher 与既有业务 owner；修复 Session mutation 回执歧义、Session owner-hop、文本投影泄漏、公开命令 help/flags、Task canonical route 与 workspace selector。不得新增请求 Store、自动 mutation retry、第二套 CLI framework、逐 workspace ACL 或第二份业务状态。"
issue: "0.4.21 外部 CLI 真实端到端验收与提交后架构复核"
research: ""
review: "accepted by user on 2026-09-21；development in progress"
---

# PRD 0.4.21：外部 CLI 端到端正确性与契约收敛

## 执行须知

本文是 [PRD 0.4.21：MyAgents 本机外部 CLI 调用与 Workspace Agent 创建](./prd_0.4.21_external-cli-host.md) 的同版本纠偏交付。它不重做外部 Host，也不建立新的权限系统；它负责把当前分支已经提交、但尚未通过真实安装包验收的外部 CLI 能力修到可发布状态。

开发前读取与实际改动匹配的文档：

- [架构总览](../ARCHITECTURE.md)：authority、Session/Sidecar owner、generation 与持久化边界。
- [CLI 架构](../tech_docs/cli_architecture.md)：launcher、Admin API、外部准入与公开命令面。
- [Session 架构](../tech_docs/session_architecture.md) 与 [Session Transcript V2](../tech_docs/session_transcript_v2.md)：admission、live overlay、generation fence 与持久历史。
- [Task Center](../tech_docs/task_center.md)：TaskStore、TaskApplication、Scheduler 与 Cron 兼容边界。
- [Pit-of-Success](../tech_docs/pit_of_success.md)：本机 HTTP、结构化错误、timeout 与测试分层。

本 PRD 是一次原子交付。实现可以分批 review/commit，但不能把其中任一修复单独当作“外部 CLI 已完成”。

## 1. 背景与复核结论

当前分支 `e845a4e3..ff5a6419` 的总体架构方向正确：

- Rust App owner 持有外部访问开关、token 与内部进程 capability。
- Node 在所有 `/api/admin/*` 业务副作用前统一区分 internal 与 external caller，并对外默认拒绝。
- Agent 注册复用 Project/config authority 与既有锁，没有第二份 Workspace/Agent registry。
- Session start/send/get 仍进入既有 Inbox、SidecarManager 与 SessionEngine；Task/Record 仍进入 TaskStore/RecordStore。
- 外部调用没有获得内部 Session identity；设置页和普通 AppConfig 投影没有无意泄漏 token。
- 没有新增 daemon、持久 request/result Store、重试 worker、逐 token ACL 或 Runtime 分支。

因此本次不推翻 Host 架构。需要修复的是以下五类贯穿边界的契约缺口：

| 问题 | 可达结果 | 当前根因 |
|---|---|---|
| Session mutation 回执歧义丢失 | `session start/send` 可能已执行，却被报成 App 不可用或明确失败，并建议重发 | CLI 全路由固定 10 秒；Node/Rust 中间 hop 把 timeout、断连或无效 ACK 压成 `delivery_failed`，部分无效 body 甚至被当作 delivered |
| `session get` owner-hop 不完整 | active→inactive 或 generation 切换附近读失败；错误类别被抹平 | CLI、Node、Rust 都使用 10 秒级同层预算；Rust 没有重新解析 owner 的一次纯读恢复；Node 覆盖 Rust 精确 code |
| Session 文本投影 fail-open | 已解析但结构损坏的 assistant block 数组可能把 tool/thinking JSON 原样返回给外部调用者 | `strictAssistantText` 对“不完全合法的 block 数组”回退成普通字符串 |
| 公开命令契约不完整 | Task leaf 离线 help 只有 `[options]`；未知 flag 被接受后静默丢弃；未声明 alias 可借 canonical route 执行 | 公开声明只有 `command + route`，help、alias 与 external grammar 没有同一份可验证的轻量元数据 |
| Task route/workspace authority 错位 | `task start/stop/runs` 依赖 Global Sidecar 临时目录；外部 `cron` 被意外开放；list/create 同时过松和过严 | Task 命令在准入前折叠到 `cron/*`；list 可使用 ambient default，create 又强制重复提交 id+path |

这些问题均由当前公开能力直接引入或实质暴露，属于 0.4.21 发布范围，不是另开权限系统或可靠性平台的理由。

### 1.1 必赢场景

一个没有 MyAgents 先验知识的本机外部 Agent，只拿到设置页复制的 Prompt 后，可以：

1. 读取版本化外部指南，并在 Host 未运行时通过顶层、group、exact leaf `--help` 得到真实用法；
2. 注册既有目录为 Workspace Agent，发现 Runtime，并 start/send/get 一个 Product Session；
3. 对 `session start/send` 明确区分“确定成功、明确拒绝、请求未送达、可能已执行但回执未确认”，不会被引导重复 mutation；
4. 从 `session get` 读取 live 或 durable 文本；owner 切换时要么恢复成功，要么返回精确错误；工具、思考和损坏的结构化内容不泄漏；
5. 用 `workspaceId` 或 `workspacePath` 任一个显式 selector 创建/list Task，再仅凭稳定 Task ID 完成 get/run/start/stop/runs；
6. 无法通过外部 token 调用 `cron/*` 或其它未公开内部能力。

## 2. 产品契约

### 2.1 公开命令与离线帮助

- `myagents --help`、公开 group help、每个公开 exact leaf help 都随 CLI bundle 静态提供，不依赖 Host、token 或网络。
- leaf help 必须足以正确调用：至少给出准确 usage、必填/可选输入、关键上下文、会否写状态或启动 AI、输出/异步语义与失败恢复。无需为每条命令机械复制固定章节。
- 公开命令、公开 alias、canonical route、允许的 positionals/flags 与静态 help 使用一份轻量 public command metadata；外部 allowlist、离线 help 和 parity tests 从中派生或与其精确核对。
- 现有 parser、`buildRequestBody` 与业务 handler 继续拥有解析和业务校验，不从 metadata 生成一套声明式 CLI DSL。
- 当 CLI 没有有效 internal capability、走 external/unauthenticated public 路径时，未声明 flags、positionals 或 aliases 必须在发请求前失败；internal CLI 保持既有兼容性。
- alias 只有两种合法状态：在 metadata 中显式公开并拥有同等级 help，或被外部路径明确拒绝。canonical route 相同不能自动扩大公开命令面。
- 保留已发布的 `task remove` 作为 `task delete` 的显式公开 alias；它不增加业务能力，但必须进入 metadata、离线 help 与同一参数校验。其它 alias 不因映射到公开 route 而自动开放。
- 外部指南只负责产品心智模型、组合工作流、launcher/token 与 help-first 方法，不复制完整 leaf 手册。

### 2.2 Session start/send：成功边界与 transport 语义

`session start` 的确定成功仍是目标 Runtime 的 dispatch acceptance；`session send` 的确定成功仍是既有 delivery/admission receipt。两者都不代表 AI turn 已完成。

| 结果 | 对外语义 |
|---|---|
| Host 在请求送达前不可发现或连接被明确拒绝 | `MYAGENTS_UNAVAILABLE`；可提示启动 App 后重试 |
| 参数、认证、目标、生命周期或 Runtime 明确拒绝 | 保留原业务错误；不得改写成 transport failure |
| owner 在既有成功边界确认接纳 | success；保留已有稳定 receipt/ID |
| mutation 已开始发送，但任一 hop 在有效 ACK 前 timeout、断开或收到不可解析 ACK | `admission_unconfirmed`（或同一稳定 unconfirmed code），退出码 2；保留已知 ID；不得自动重发或提示“retry the same command” |

实现只需要一个小型 route/operation timeout classifier 与少量具名常量：

- 普通快速读命令保持短预算。
- fresh start 的 CLI 外层预算覆盖 Node 的合法 Sidecar 启动与 admission 预算；Node 外层覆盖 Rust/目标 owner 内层并留出响应余量。
- resumed send 的 Rust、Node、CLI 预算有明确内外顺序，不能在同一时刻竞争超时。
- 每个 mutation 只发送一次；AbortSignal 只终止当前等待，不拥有 Product Session、Sidecar、Runtime turn 或 BackgroundCompletion 的取消权。
- JSON 与 human 输出使用同一分类和退出码；stdout 的 JSON 仍恰好一份，诊断不得包含 token、prompt 或 transcript 正文。

不要求 operation ledger、exactly-once、自动 mutation retry 或跨重启查询某次请求结果。

### 2.3 Session get：owner-hop 与文本投影

- Rust `SidecarManager` 是当前 Session live owner 与 generation 的唯一 authority。
- active Session 从当前 Session Sidecar 读取 live projection；inactive Session 由 Global Sidecar 从 SessionStore 读取 durable snapshot。
- 现有 exact-generation dispatch lease 已覆盖 HTTP status 与 body 消费；除非回归测试证明不成立，不改造该 lease 或另建 fence。
- live owner transport/body decode 失败时，只允许 Rust owner-selection boundary 做一次纯读恢复：释放旧 dispatch，重新查询当前 generation，再决定重试当前 owner、读取新 owner，或在 owner 已退出时返回 `active:false` 走 durable snapshot。
- 若第二次仍失败，返回精确结构化错误；不得无限重试、轮询、sleep、创建 owner，或用 durable 文件冒充仍 active 的最新 live 内容。
- Rust 内层单次读取预算、Rust 整体最多两次尝试预算、Node 与 CLI 外层预算必须有余量；不需要通用 deadline framework。
- Node 只投影 Rust verdict，可以规范化 envelope，但必须保留 `owner unavailable`、`owner invalid response`、`session content unreadable`、`session not found` 等稳定类别。
- assistant content 一旦被识别为结构化 transcript blocks，就只能投影合法顶层 text block。解析失败、数组元素缺少合法 block shape、text block 类型错误等损坏必须返回 `SESSION_CONTENT_UNREADABLE`；不得回退输出原始 JSON。普通 user 自己发送的 JSON 仍按用户文本保留。
- `session get` 仍是一次快照读取，不创建 turn、不唤醒 Runtime、不等待 terminal，也不根据最后一条文本推断某次 send 是否成功。

新增 Rust 诊断只记录 Session ID、generation、读取阶段、HTTP status、可用的 content type/length 和错误类别；不记录正文、token、Authorization 或完整响应体。

### 2.4 Task route 与 workspace 规则

Task surface 按 selector 分四类：

| 操作类型 | 规则 |
|---|---|
| workspace discovery/creation：`task list`、`task create-direct` | external 必须显式给 `workspaceId` 或 `workspacePath` 至少一个；Host 使用既有 Project registry 解析 canonical id/path；两者都给时校验一致；禁止 ambient default |
| exact-id：`task get/comments/update/update-status/run/rerun/run-now/start/stop/runs/check-now/reset-checkpoint/append-session/archive/delete` | TaskStore 按稳定 Task ID 解析目标与 workspace；canonical `task/*` 对 internal/external caller 使用同一 selector 语义；不叠加 current-workspace guard 或额外 workspace flags |
| ad-hoc trigger：`task trigger test --spec-file` | 只要求真实执行所需的显式 `workspacePath`；不要求注册 Project pair，不创建/修改 Task；脚本自身副作用仍不会回滚 |
| pure/static：`task trigger validate`、`task readme` | 不要求 workspace；`task trigger test <taskId>` 归入 exact-id 规则 |

外部 token 是用户主动开启的本机用户级 authority，本版没有逐 workspace ACL。稳定 Task ID 已由 TaskStore 绑定 workspace；再要求 Global/Session Sidecar 的 ambient workspace 不增加正确性或权限隔离。

`task start/stop/runs` 必须拥有 canonical `task/start|stop|runs` Admin route。它们复用现有 TaskApplication、TaskStore、scheduler control 与 `cron_runs` reader，不复制 Task 状态机或 run-history Store。

legacy `cron/*` 继续保留既有 current-workspace compatibility guard，但不进入 external allowlist。不要给 shared Task core 增加 caller-kind policy；差异只存在于 transport route 与 legacy wrapper。

### 2.5 跨平台发布证据

- 当前主发布平台使用实际 App bundle、真实设置页 launcher/token 与已配置 Runtime 跑完整 Agent → Session → Task → Record 链。
- 其它发布平台在各自 release gate 使用实际 bundle 验 launcher、Host discovery、token、离线 help、route isolation、JSON/exit code、空格/Unicode 路径等真实平台边界。
- Session/Task/Record 业务语义集中使用隔离 Store、loopback fake Host/Runtime 的确定性测试覆盖；不要求每个平台重复一遍真实 Provider 全业务链。
- 未完成的平台 gate 必须明确记录为未验证，不能宣称整份 PRD 已发布完成。

## 3. 技术架构与复杂度边界

### 3.1 Owner 与复用路径

| 事实/决策 | owner / 正确入口 |
|---|---|
| 外部访问 enabled/token/createdAt | Rust App owner + `config.json` 锁内修改 |
| internal/external caller 准入 | Node unified Admin admission；external token 最终由 Rust policy 校验 |
| 公开命令 metadata | shared 纯静态数据；不含 token、运行状态或业务 validator |
| CLI timeout 与最外层错误投影 | CLI 的小型 route classifier |
| Session admission/delivery | 既有 Rust Inbox + SessionEngine facade + Runtime adapter |
| Session live owner/generation | Rust `SidecarManager` |
| live/durable transcript | Session Sidecar/SessionEngine 与 SessionStore |
| Task identity/state/workspace/outcome | TaskStore / TaskApplication |
| Task run history | 既有 `cron_runs` 查询/审计投影 |
| Workspace identity | Project registry；`workspacePathsEqual` 负责路径一致性 |

### 3.2 允许新增或调整

- 把现有 `EXTERNAL_CLI_PUBLIC_CAPABILITIES` 扩成轻量 public command metadata：canonical command/route、显式 aliases、允许的 flags/positionals、静态 help。
- 在 CLI 增加简单的 public invocation grammar check 与 route-specific timeout 分类。
- 新增 `task/start`、`task/stop`、`task/runs` canonical Node route wrapper，直接复用既有 Task core。
- 在现有 send wire outcome 中增加/贯通 unconfirmed 分类；不得建立请求记录系统。
- 在 Rust `session_text_page_handler` 现有 owner boundary 内增加一次 bounded read retry，并保留错误 code。
- 收紧现有 assistant text projection 对损坏 block array 的处理。

### 3.3 明确禁止

- 新进程、daemon、第二个 Host、请求/结果 Store、operation ledger、幂等 replay service、后台 retry worker 或 polling waiter。
- 新 Task/Session authority、TaskRun domain Store、workspace cache、Global Sidecar current-workspace 状态或逐 token/workspace ACL。
- 从 public metadata 生成 parser、业务 validator、handler 或完整 CLI framework。
- mutation 自动 retry、无限 retry、固定 sleep、吞错、把 stale durable 内容包装成 active latest。
- 为 canonical exact-id Task 操作新增 internal/external caller policy 或 ambient workspace guard。
- 为每个平台复制完整业务 E2E，只为满足形式上的“跨平台”。

如果修复必须改变 SessionEngine admission 成功边界、引入持久请求状态、增加新的权限模型或进程类型，停止实现并回到产品/架构讨论。

## 4. 关键决策与理由

### D1：保留现有 Host 架构，只修跨 hop 契约

Rust policy、Node admission、受管内部 capability 和既有业务 owner 的放置是正确的。问题发生在 route、timeout、错误与投影信息跨边界时丢失；重做 Host 或引入 middleware/platform 只会扩大状态面。

### D2：延长 timeout 必须与 unconfirmed 语义一起做

更大的数字能覆盖正常冷启动，但任何有限 deadline 最终都可能丢 ACK。只有“有序预算 + 每跳保留 unconfirmed + 不诱导重发”才能避免重复 mutation。

### D3：一次纯读 retry 留在 Rust owner boundary

这里只有 SidecarManager 能重新判断 generation；CLI/Node 重试会缓存错误端口或错误地把 durable 文件当最新 live 内容。纯读最多一次足够，不需要重试系统。

### D4：public metadata 只收敛会漂移的事实

本次需要同源的是公开命令、route、alias、允许输入和离线 help。`task remove` 明确复用 `task delete`，其它 alias 默认不公开。业务语义继续由现有 builder/handler 拥有，transport timeout 继续由 CLI 拥有，避免把一张元数据表升级成第二套框架。

### D5：Task selector 以已有稳定 identity 为准

list/create 没有目标 ID，所以必须显式选择 workspace，但任一 selector 已足够让 Project registry 给出 canonical pair。exact-id 已有 TaskStore authority，再叠加 ambient workspace 既没有 ACL 依据，也会把承载进程目录误当业务事实。

### D6：Cron 只保留兼容，不承担公开 Task identity

复用 TaskStore core 与复用 `cron/*` transport route 是两回事。canonical Task route 保留产品身份；legacy Cron wrapper 保留旧 guard；external token 不开放 Cron。

### D7：平台验收只覆盖真实平台差异

launcher、路径、打包和 Host discovery 会按 OS 变化，必须逐平台 smoke；TaskStore/SessionEngine 等业务状态机不按 OS 分叉，集中确定性测试提供更高价值证据。

## 5. 确定性验收

| 验收面 | 必须证明的结果 |
|---|---|
| delayed `session start` | 超过旧 10 秒但在合法 admission budget 内时只发送一次、只创建一个 Product Session并返回 success/IDs |
| mutation ACK 丢失 | start/send 在 CLI、Node→Rust、Rust→target 任一 hop 丢 ACK 都返回 unconfirmed/退出码 2；已知 ID 保留；不自动重发、不建议重发 |
| 真不可用 | 请求送达前的 Host 连接失败仍为 `MYAGENTS_UNAVAILABLE`；JSON/human 分类和退出码一致 |
| read budget | 单次 Rust read、最多两次尝试、Node、CLI 的预算关系有测试约束，外层不会抢先覆盖精确 verdict |
| owner re-resolution | 同 generation 或新 generation 最多 retry 一次；owner 已退出时走 inactive durable；持续错误返回精确 code |
| dispatch lease | 证明现有 lease 持有到 body 消费完成；若测试通过，不修改 lease 实现 |
| text privacy | 合法 text blocks 正确拼接；tool/thinking-only 返回空；语法损坏与语义损坏 block arrays fail closed；普通 user JSON 保留 |
| public help | 每个公开 canonical leaf/alias 在 Host down、无 token 时均有准确 exact help，无 `[options]` fallback |
| public grammar | external/unauthenticated public invocation 的未知 flags/positionals/aliases 在请求前失败；internal CLI 兼容回归通过 |
| canonical routes | `task start/stop/runs` 使用 `task/*`；外部直调 `cron start/stop/runs` 返回 `EXTERNAL_CLI_CAPABILITY_NOT_OPEN` |
| workspace selectors | list/create 覆盖 id-only、path-only、matching pair、mismatched pair、missing selector；只有最后两类失败 |
| exact-id Task | internal/external canonical task 操作均只按 Task ID 进入 TaskStore；不读取 Global Sidecar `agentDir`；managed/deleted/非法状态规则不变 |
| trigger 分类 | validate/readme 无 workspace；spec-file 只要显式 path；taskId test 由 TaskStore 解析 |
| 历史兼容 | 新 Task、迁移 Task、已有 run-history 都可由 canonical `task runs` 查询；不新增 TaskRun Store |
| 安全/日志 | token、Authorization、prompt、tool input、thinking、transcript 正文不进入新增日志、错误或测试快照 |

默认测试只使用隔离目录、临时 Store、loopback fake Host/Runtime，不依赖真实用户目录、凭据或外网。真实 Runtime smoke 进入显式 credentialed/安装包验收，不替代确定性测试。

## 6. 安装包端到端验收

主平台实际 bundle 使用设置页复制的 launcher 与 token，在清空内部身份变量、不传 `--port` 的普通终端中完成：

```text
status/version
→ agent create/list/show
→ runtime list/describe
→ session start/send/get
→ task list/create-direct/run/get/start/stop/runs
→ task trigger validate/test
→ record create/list
```

同时验证：

- Host down 的顶层、group、所有公开 canonical leaf 与公开 alias help；
- token 缺失、错误、重置、关闭后的准入；
- 清单外命令、未公开 alias 与 `cron start/stop/runs` 被拒绝；
- start 冷启动超过旧 10 秒、send ACK 丢失、生成中和 owner 释放附近的 `session get`；
- Task selector 四类规则与 stable-ID 后续操作；
- JSON stdout、human stderr、退出码一致；
- 日志、Session、Task 文档中搜索 token 与被过滤 tool/thinking 内容，结果为空。

其它发布平台只重复第 2.5 节定义的平台 smoke。测试数据必须使用专用标识和明确的测试目录；清理不得删除用户已有 Agent、Session、Task、Record 或 workspace 内容。

## 7. 当前代码入口与已确认事实

- `src/shared/externalCliCapabilities.ts`：目前只有 `command + route`；`task start/stop/runs` 错映射到 `cron/*`。
- `src/cli/myagents.ts`
  - `publicCliHelp`：Task leaf 回退 `[options]`。
  - `parseArgs` / `buildRequestBody`：external 未知 flags 可被静默丢弃；task list 不转发 `workspacePath`。
  - `callApi`：所有 route 共用 10 秒，并把 mutation timeout 与连接失败合并。
  - `buildRoute`：Task start/stop/runs 在 admission 前折叠为 Cron。
- `src/server/external-cli-admission.ts`：默认拒绝和 Rust token policy 路径正确，继续复用。
- `src/server/index.ts`：external create-direct 当前强制 id+path；task list 没有 explicit-selector guard。
- `src/server/admin-api.ts`
  - `resolveTaskWorkspace` 已能按 id 或 path 任一 selector 解析 Project，并校验同时提供的 pair；继续复用。
  - `verifyCronTaskOwnership` 只属于 legacy Cron compatibility；不得扩到 canonical Task。
- `src/server/inbox/start-admin-handler.ts`：fresh start Node 预算长于 CLI，但 management transport 不确定仍投影为明确失败。
- `src/server/inbox/admin-handler.ts` 与 `src-tauri/src/inbox/deliver.rs`：send 的 unconfirmed outcome 没有逐 hop 保留；部分无效成功 body 被当作 delivered。
- `src/server/session-text-projection.ts`
  - `readSessionTextPage` 覆盖 Rust 精确错误。
  - `strictAssistantText` 对语义损坏 block array fail-open。
- `src/server/utils/management-api-client.ts`、`src-tauri/src/management_api.rs`：owner read 内外预算相同且没有一次 re-resolution。
- `src-tauri/src/sidecar/manager.rs`：现有 dispatch lease 已覆盖 response body；先用并发测试证明，不预设需要重构。

真实日志证据来自本机 `~/.myagents/logs/unified-2026-09-19.log` 对应 Session/Task 链路，只用于核实现状，不得复制用户路径、token、prompt 或正文进仓库 fixture。

## 8. 文档与完成定义

实现完成后同步：

- `specs/tech_docs/cli_architecture.md`：public metadata、external grammar、canonical Task/legacy Cron、selector 规则。
- `specs/tech_docs/session_architecture.md`：mutation unconfirmed、budget 顺序与一次 owner read retry。
- `specs/tech_docs/task_center.md`：canonical exact-id 全局 TaskStore 语义与 list/create explicit selector。
- 外部指南、CHANGELOG 与发布说明：只描述已经验证的行为。

以下全部成立后才能把本 PRD 标记完成：

1. 五类缺口均有根因级回归测试，错误旧断言已删除而不是加旁路兼容。
2. requirements/adversarial/architecture 三视角 review 对最终代码通过。
3. 主平台完整安装包链路与其它发布平台 smoke 通过；未验证平台不被表述为完成。
4. token 与 Session 私密结构内容无泄漏，CLI JSON/exit code 稳定。
5. 工作区只有本交付相关改动，技术文档与当前实现一致。

## 9. PRD 自检

- 现有 Rust/Node/Session/Task owner 均保留，没有为了修 bug 新造 authority。
- 新机制限定为轻量 public metadata、简单 timeout classifier、canonical Task wrapper、现有 wire outcome 扩展、一次纯读 retry 和更严格文本投影。
- 没有 exactly-once、自动 mutation retry、operation Store、逐 workspace ACL、第二套 parser/validator 或全平台重复业务 E2E。
- Task 限制已放松到真正的不变量：无 ID 的操作显式选 workspace；有稳定 ID 的操作信任 TaskStore。
- 未知 body decode 原因保持为可诊断事实，不虚构 teardown race。
- 产品与架构岔路已关闭，用户已接受本 PRD 并授权开始开发。

## 执行台账

### 开发契约（动第一行代码前写完）

- 必赢场景：普通本机外部进程只凭设置页 launcher/token 与离线 help，可靠完成 Agent → Session start/send/get → Task → Record；mutation ACK 不明不被误报为明确失败，Session 文本不泄漏 tool/thinking，Task canonical route 不依赖 Global Sidecar cwd，也不开放 legacy Cron。
- 原子交付：整份纠偏 PRD 使用一个开发批次完成并统一验收；真实兼容责任包括既有 internal CLI、已发布的 `task remove` alias、legacy `cron/*` 内部/脚本入口、历史 Task/run 文件和现有 Agent/Session 数据。
- 必须保证：public 命令/help/grammar 可离线且同源；start/send 的 unconfirmed 分类逐 hop 保真；session get 在 Rust owner boundary 最多一次纯读重解析并保留精确错误；损坏 structured assistant content fail closed；list/create 显式给任一 workspace selector；canonical exact-id Task 只由 TaskStore 解析；外部 Cron 关闭。
- 明确不做 / 不保证：不建设 exactly-once、自动 mutation retry、operation ledger、请求结果 Store、polling waiter、第二个 Host、第二套 parser/validator、逐 workspace ACL、TaskRun Store或全平台重复真实 Provider 业务 E2E。
- 本次负责的问题：PRD 第 1 节五类缺口以及同根 alias、JSON/exit-code、budget、workspace selector 与文本隐私路径；不广审无关历史功能。
- 状态来源与生命周期：外部 enabled/token 由 Rust App owner 锁内读写 `config.json`；caller admission 由 Node 统一入口裁决并调用 Rust policy；公开 metadata 是 bundle 静态事实；Session admission/delivery 属于 Inbox + SessionEngine；live owner/generation 属于 Rust SidecarManager；durable/live transcript 分属 SessionStore 与当前 Session Sidecar；Task identity/state/workspace 属于 TaskStore/TaskApplication；Project registry 只解析无 Task ID 时的 workspace selector。
- 复用的既有抽象：`EXTERNAL_CLI_PUBLIC_CAPABILITIES`、`admitAdminRequest`、`cancellableFetch`、`managementApi`、`DeliverOutcome`、`SidecarManager.acquire_session_dispatch` / `SidecarHttpDispatch`、`readSessionTextPage` / `strictAssistantText`、`resolveTaskWorkspace`、`handleCronStart/Stop/Runs` 背后的 TaskStore/TaskApplication 与 run-history reader、`workspacePathsEqual`。
- 新增架构机制：无新 owner/store/process；只扩展轻量 public metadata、增加 CLI route timeout 分类、现有 send outcome 的 unconfirmed variant、三个 canonical Task route wrapper、一次 Rust 纯读 owner retry。
- 适用的架构不变量：owner/source-of-truth 优先；Runtime 只经 SessionEngine；Rust SidecarManager 裁决 generation；TaskStore 是新 Task 唯一 authority，Cron 仅兼容；控制面经既有 Node/Rust loopback 路径；错误分类跨 hop 保真；可静态判定的公开 grammar 由测试固化。

### 验收与结束条件（动第一行代码前写完）

- 验收标准：PRD 第 5 节全部有确定性证据；主平台构建产物至少完成 bundle/launcher/fake-Host smoke；无法在当前机器覆盖的其它发行平台实际 launcher smoke 明确列为 mandatory 发布门槛。
- 事实依据：TypeScript/Rust 单测证明 metadata parity、grammar、selector、错误投影、文本隐私和 owner retry；typecheck/lint/cargo check 证明跨语言接线；全栈 build 证明打包；隔离 loopback smoke 证明真实 CLI bundle 的 help、route、JSON/exit code 与 timeout；实际 App/真实 Runtime 链路作为发布真机证据。
- 改动与检查的对应关系：shared/CLI/Node 改动重跑 CLI、admission、admin、Inbox、projection 单测及 typecheck/lint；Rust Inbox/Management 改动重跑定向 Rust tests 与 cargo check；文档/guide 改动重跑 guide parity、Prettier 与 doc checks；最终组合态执行全栈 build 和相关 smoke。
- 结束条件：实现、自验证、requirements/adversarial/architecture cross-review、修复复验和显式文件提交全部完成后结束开发；任何未完成的实际 bundle/跨平台 mandatory 检查会让 PRD 保持 `in-progress`，不得宣称可发布。

### 开发批次与行动清单

- Batch 1：外部 CLI 契约收敛。五类问题共享同一公开命令/跨 hop/Task authority 端到端证据，拆批会制造临时 alias、半套错误语义或重复 review，因此作为一个实现、review、commit 批次。
  - [x] 扩展轻量 public metadata，补全离线 help、显式 alias 与 external grammar fail-closed。
  - [x] 恢复 canonical Task routes，放松并统一 list/create selector，保持 legacy Cron compatibility。
  - [x] 贯通 Session start/send 的 nested budget 与 unconfirmed 语义，统一 JSON/human exit contract。
  - [x] 在 Rust owner boundary 增加一次 bounded session-get retry，保留精确错误，并修复 structured text fail-open。
  - [x] 补根因回归测试，更新 CLI/Session/Task 文档、外部指南与 CHANGELOG。
  - [x] 完成自验证、三视角 cross-review、修复复验与提交。

### 当前批次 Review 基线

- 批次：Batch 1
- Batch base：`ff5a6419bef21f0fd2906841c27c63ecc2789d3f`
- 预期范围：`src/shared/externalCliCapabilities.ts`、`src/cli/`、`src/server/` Admin/Inbox/Session projection、`src-tauri/src/inbox` 与 `management_api.rs`、对应单测、外部指南、CLI/Session/Task 技术文档和 CHANGELOG。

### 待用户决策

无。

### 进展日志

- 2026-09-21：用户接受纠偏 PRD；readiness gate 通过，建立单批次开发契约并进入 `in-progress`。
- 2026-09-21：完成单批次实现。public metadata 统一 route/alias/flags/positionals/exact help；Task exact-id 恢复 canonical route，list/create 接受任一显式 workspace selector；Session mutation 使用分层预算与 `admission_unconfirmed`，丢 ACK 后复用既有 BackgroundCompletion 保活；Session get 在 Rust owner boundary 最多重解析一次并保留业务错误；structured assistant 投影 fail closed。
- 2026-09-21：requirements/adversarial review 找到并修复语义无效 ACK、丢 ACK owner 释放、HTTP 409 rejection 降级、owner 业务错误被覆盖、`taskMdContentFile` 静默丢弃、alias help 与 Host-down exit code 等问题；最终 architecture/entropy review PASS，确认无新增 store、daemon、ledger、ACL、后台 retry 或通用 CLI framework。
- 2026-09-21：验证通过：TypeScript typecheck；ESLint 与依赖边界/Agent 文档检查；448 个 unit 文件（4441 passed，3 skipped）；Rust `cargo check --lib` 与全部 lib test binary `--no-run`；CLI/Server bundle build；真实 CLI bundle loopback smoke（离线 help、canonical Task route、未知输入前置拒绝、慢 start、send 丢/坏 ACK、Host-down JSON/human exit）。本机 Rust 测试二进制执行仍受缺失 `libswift_Concurrency.dylib` 限制。
- 2026-09-21：PRD 保持 `in-progress`。实际 App + 配置 Runtime 全链路，以及 Windows/Linux launcher/Host discovery/token/路径 smoke 仍是发布前 mandatory gate，未完成前不得宣称可发布。
