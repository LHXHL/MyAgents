# MyAgents Cloud Space 架构

## 定位

Cloud Space 是桌面端连接 MyAgents 官方/团队空间的客户端能力，目前仍处于开发中/半成品状态，不作为已发布用户能力写入 CHANGELOG 或 GitHub Release notes。

它不是 AI Runtime，也不属于 Session Sidecar：登录、Issue/Skill/Agent 注册、附件上传下载、IssueDelivery 拉取都由 Rust Tauri command 拥有；React 只负责 UI 编排；CLI 通过 management API 暴露 issue/attachment/claim 子集给 Agent 自动化使用。

## 构建门控

Space 是 build-time capability：

- `src-tauri/build.rs` 读取环境变量或仓库根 `.env`，仅转发 `MYAGENTS_SPACE_*` 白名单。
- `MYAGENTS_SPACE_ENABLED=true` 时必须提供 HTTPS 且不带 path/credential 的 `MYAGENTS_SPACE_BASE_URL`；build/runtime 校验会移除 query/fragment 并注入规范化后的 origin。
- debug 构建可以额外烘焙 `MYAGENTS_SPACE_STAGING_BASE_URL`。release profile 会在 `build.rs` 中无条件丢弃 staging origin，因此生产二进制不能暴露 staging 服务开关。
- `cmd_space_get_capability` 返回 `{available, baseUrl, publicClientId, reason, environments, activeEnvironment}`，只代表构建能力与 Rust 当前选中的 build-time origin；前端还必须叠加 `config.teamSpaceEnabled === true`（默认关闭）才展示开发中的 Team Space 入口。
- `config.spaceEnvironment` 只能在烘焙的 `production` / `staging` origin 之间二选一，默认 `production`。Renderer 不提供自由 URL 输入；所有云端请求仍从 Rust `space_build_capability()` / `space_base_url()` 单一咽喉读取当前 origin。
- 缺少能力时，Space UI 不应降级为硬编码 URL；所有云端请求必须经 Rust 能力检查。

### Dev/Test mock data mode

Phase 2 为本地验证和自动化测试新增了显式 mock mode：

- debug/test build 中运行时设置 `MYAGENTS_SPACE_MOCK_DATA=true` 时，`space_build_capability()` 返回可用能力，baseUrl 为 `https://space.mock.myagents.local`。release build 中该环境变量被忽略。
- mock mode 仍然由 Rust Space 边界拥有：renderer 继续只调用 `src/renderer/api/spaceCloud.ts`，Tauri command/CLI helper 继续走 `src-tauri/src/space_cloud.rs`，不会在 React 组件里塞假数据。
- mock mode 使用进程内 deterministic 数据集，覆盖 Goals、Issues、评论、附件、Skills、Skill 文件、Registered Agents、IssueDelivery 与 claim。mutation 会更新同一份 in-memory state，便于验证创建/评论/状态/claim/ignore/complete 等交互。
- mock mode 不读写真实 `~/.myagents/space/session.json`，不访问 `space.myagents.io`，不作为发布能力写入 CHANGELOG 或 Release notes。
- mock mode 只用于 dev/test。生产构建仍以 `MYAGENTS_SPACE_ENABLED` / `MYAGENTS_SPACE_BASE_URL` / public client id 的 build-time capability 为准。

## 模块边界

| 层           | 文件                                                          | 职责                                                                                                                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust         | `src-tauri/src/space_cloud.rs`                                | Space session、HTTP proxy、registered agents、IssueDelivery poll/process、claim wrapper、Skill zip、附件上传下载                                                                                                                                                                                                                   |
| Renderer API | `src/renderer/api/spaceCloud.ts`                              | Tauri invoke typed wrapper；不直接 `fetch` Space 服务                                                                                                                                                                                                                                                                              |
| Renderer UI  | `src/renderer/pages/Space.tsx` + `src/renderer/pages/space/*` | Space shell 与 Issues / Skills / Agents 三个 workspace，登录轮询、创建/评论/Goal 订阅、Skill 安装、本地缓存                                                                                                                                                                                                                        |
| CLI          | `src/cli/myagents.ts` + Management API                        | Agent 可调用的 Space issue list/view/comment/claim/ignore/complete/cancel、claim local-task 与 attachment download 操作；`space issue claim --create-attached` 负责编排 claim -> attached Task -> local task ref，`space issue complete --taskId ... --body-file ...` 负责编排 result comment -> cloud complete -> local task done |

## Device / Registered Agent 身份模型

Space 不创建第二套“云端 device id”。本地端点身份的唯一值是既有 `~/.myagents/device_id`：

- Rust owner：`src-tauri/src/device_identity.rs`，负责读取/创建 `device_id`，并提供设备名、platform、OS version、app version。首次创建必须通过 `~/.myagents/device_id.lock` 串行化，避免 Analytics 与 Space 并发启动时生成不同 ID。
- Renderer owner：`src/renderer/identity/deviceIdentity.ts`，只做 typed invoke/cache；Analytics 和 Space 共同消费这一层。
- Analytics 事件中的 `device_id` 口径不变，仍是同一个 `~/.myagents/device_id`。

云端需要一个 `user_devices` 概念/表，主键语义为 `(userId, deviceId)`：

- 必备字段：`userId`、`deviceId`。
- 设备摘要字段：`deviceName`、`platform`、`osVersion`、`appVersion`、`status`、`lastSeenAt`。
- 登录/授权完成后，客户端尝试调用 `/api/devices/upsert` 写入当前 `user_devices` 记录；为兼容桌面端与云端部署顺序，该调用失败不阻塞 Space 登录。
- `cmd_space_register_agent` / `cmd_space_update_registered_agent` payload 同时携带 `deviceId`、`deviceName`、`platform`、`osVersion`、`appVersion`，服务端必须在 registered-agent mutation 中同步维护 `user_devices`，不能只依赖 bootstrap upsert。

Registered Agent 是“执行实体”，不是设备本身：

- 归属字段：`ownerUserId` + `deviceId`。同一设备可以为同一 user 在不同 Space / workspace 上登记多个 Registered Agent。
- 本地工作区绑定字段：`localWorkspaceId`、`localAgentId`、`workspacePath`、`workspaceLabel`。这些字段描述的是该设备上的本地 Agent 工作区，只能在登记它的那台设备上修改。
- 展示字段：registered-agent list/detail 必须返回 `deviceId` 与 `device` 摘要，renderer 用它展示“本地电脑 / 平台 / 系统版本 / 客户端版本 / last seen”。
- Local 判定只能用 `ownerUserId === current session user id && deviceId === current ~/.myagents/device_id`。禁止用 `clientId`、hostname、是否存在本地缓存记录来推断 local。

Registered Agent 执行请求是 token-only capability：

- 本地轮询 delivery/dispatch 时只带 registered-agent token，服务端由 token 映射出 user / space / device / registered-agent 权限边界。
- MyAgents Desktop 默认 token selector 只消费“当前 Space user + 当前 device_id”的本地 token 集合。
- token 存储仍在 `registered_agents.json`，但 token 对外不可见；renderer 只能看到 redacted public view。
- 第三方/未来客户端接入时也只需要 token，不需要额外提交 userId/deviceId 参与鉴权；user/device 是服务端 token 记录的一部分。

## 本地状态

Space 本地状态由 Rust `space_data_dir()` 按当前环境选择：

- production 保持兼容路径 `~/.myagents/space/{session.json,registered_agents.json,delivery_log.json}`。
- staging 使用 `~/.myagents/space/staging/{session.json,registered_agents.json,delivery_log.json}`。
- `session.json` — 云端 session token 与用户/space/membership 摘要；Rust 对外只返回 redacted public view。
- `registered_agents.json` — 本机注册到 Space 的 Agent 映射，包含本地 workspace path、`ownerUserId`、`deviceId`、设备摘要、订阅状态与云端 token。
- `delivery_log.json` — 已投递 IssueDelivery 到本地 session 的映射，用于幂等与 delivered 标记。

这些文件属于桌面客户端状态，不进入 SessionStore，也不由 Sidecar 管理。

全局 Skill 安装路径不属于 Space 服务环境状态，始终是 `~/.myagents/skills`；不能从环境化后的 `space_data_dir()` 反推。

Renderer `spaceStore` 的缓存身份必须至少包含服务 origin。production/staging 都可能使用 `official` slug，切换环境时即使 slug 不变也必须清掉 issue/skill/agent/event 缓存，避免旧环境数据被拿来驱动新环境 API。

Legacy 兼容规则：

- 旧 `registered_agents.json` 缺 `deviceId` 时，Rust 只在该记录已经有 `ownerUserId === current Space session user id` 的情况下补为当前 `~/.myagents/device_id`，并顺带补设备名、platform、OS version、app version。
- 缺 `ownerUserId` 或 owner 不等于当前登录用户的旧记录不会被当前设备认领，避免同一电脑切换 user 后把旧 token / 工作区误归到新 user。
- 云端旧 Registered Agent 缺 `deviceId` 时也不按 hostname / `clientId` 猜测本机；没有本地 owner+device 证据的记录按 unknown/remote 展示，不能修改本地工作区绑定。

## 网络与安全

- 所有 Space HTTP 请求由 Rust `reqwest` 发起，并带 build-time public client id header；renderer 不持有 session token。
- 用户可控 workspace 路径进入 Rust 后必须通过 `validate_workspace_root`。
- 写入 workspace 的附件下载走 `resolve_inside_workspace`，只能落在目标 workspace 内。
- Skill zip 安装有总大小、单文件大小、entry 数限制，并防 Zip-Slip；安装目标只允许 global 或当前 project。
- 附件上传有单次数量和大小限制，读取前校验路径与文件大小。

## 用户 Profile / 头像

登录用户资料是云端 `users` 的 account-level 数据；本地 `~/.myagents/space/session.json` 只缓存 redacted 摘要。桌面端更新昵称/头像必须走 `cmd_space_update_profile`，由 Rust 读取本地图片、做 symlink/大小/扩展名校验并 multipart 调用 Cloud Worker `/api/me/profile`。Renderer 只能通过 `src/renderer/api/spaceCloud.ts` wrapper 和 `spaceStore` 更新本地 UI 缓存，不能直接 fetch Worker 或持有 session token。

Cloud Worker 用 `users.name_source` / `avatar_source` 区分 Google 默认资料与用户自定义资料：

- `name_source='google'` 时，Google 重登可以刷新 `users.name`；`name_source='user'` 时不得覆盖。
- `avatar_source='google'` 时，Google 重登可以刷新 `users.avatar_url`；`avatar_source='r2'` 时不得覆盖。
- 头像上传写入 `ASSETS` R2 bucket 的 `avatars/users/<userId>/<sha256>.<ext>`，并把 `users.avatar_url` 写成公开 R2 URL。

头像 URL 明确不走 Worker 附件下载 route。部署侧必须给 `myagents-space-assets` / `ASSETS` bucket 启用 public `r2.dev` URL 或绑定自定义域名，并在 `MyAgents_space` Worker 环境配置 `R2_PUBLIC_BASE_URL`。缺少该配置时头像上传应 fail closed；不要回退到 Worker 代理图片流量。

当前 production 配置使用 `R2_PUBLIC_BASE_URL=https://files.myagents.io`。2026-07-06 已通过 `wrangler r2 bucket domain list myagents-space-assets` 确认 `files.myagents.io` 绑定到 bucket，且用临时对象 `__healthchecks/files-domain-check.txt` 实测公开 HTTPS 直链返回 200；测试对象随后已删除。

## IssueDelivery / Claim 处理

Registered Agent 可从 Space 拉取 IssueDelivery，并将其作为轻量通知注入到本地 AI session。Issue claim 在产品语义上是 Issue 的唯一经办人/接手人，不是一个带 `active/completed/cancelled` 生命周期的锁；生命周期由 Issue 自身的 `state` 表达。

1. `cmd_space_register_agent` 在云端创建 registered agent，并写入本地映射。
2. `cmd_space_poll_deliveries` / `cmd_space_process_deliveries_once` 拉取待处理 delivery。
3. Rust 通过 session inbox 注入 `space.issue_delivery` metadata 和固定处理指令，写 `delivery_log.json`，再调用 `cmd_space_mark_delivery_delivered` 对云端确认。最终进入 AI session 的 user message 由 Rust 渲染为 `<system-reminder><myagents-space-issue><myagents-space-event ...>` 结构：`system-reminder` 隐藏内部 payload，`myagents-space-issue` 供前端展示 `Space issue` badge，`myagents-space-event` 内部拆成 `<issue-instruction>` / `<runtime-context>` / 一个或多个 `<issue>`。`<issue-instruction>` 是简版 skill，统一要求 Agent 使用 `myagents space issue` CLI；`<issue>` 只放事实数据，不重复 action 命令。`system-reminder` 的通用展示协议见 `system_reminder_protocol.md`。
4. AI session 决定处理时调用 `myagents space issue claim <issueId> --deliveryId <deliveryId> --create-attached ...`。CLI 会先 claim，再创建 attached-session Task，再回写 `claim.localTaskId/localSessionId`；若本地 Task 创建或回写失败，CLI 立即调用 `cancel-claim` 让 Issue 回到 `todo`。
5. AI session 完成执行时优先调用 `myagents space issue complete <issueId> --taskId <taskId> --body-file result.md --message "..."`，由 CLI 顺序完成 result comment、云端 Issue state 更新、本地 Task 状态更新。`complete` 不清空 claim；`done + claim` 表示该 Issue 已由该经办人处理完成。

Delivery 分两类：

- `subscription`：普通 Goal 订阅通知，用于让 Agent 发现 `todo` Issue。客户端按 Registered Agent 的 Issue 订阅策略选择 session：连续对话复用 `delivery_session_id`，新对话使用 `issue_session_ids[issueId]`。
- `claim_followup`：已 claim Issue 的后续评论消息。云端必须携带 `targetSessionId = claim.localSessionId`，客户端必须优先投递到该 session，确保同一 Issue 的连续处理回到原本地上下文。

评论同步规则：

- 如果 Issue 的经办人是 Registered Agent，且评论作者不是该经办人，则生成 `claim_followup` delivery。
- 经办人自己评论或完成 Issue 时，不把这条评论回推给自己，避免自循环。
- 没有 claim 经办人时，评论更新回到普通 subscription delivery 规则。
- `cancel-claim` 清空 Issue 经办人，并让 Issue 回到 `todo`；后续更新不再投给原经办人。

该链路保持“云端关注/认领、客户端执行”的边界：云端不直接访问本地文件系统或 Sidecar；本地执行仍走 MyAgents 的 Task/Session 体系。兼容命令 `cmd_space_poll_dispatches` / `cmd_space_process_dispatches_once` 仅作为旧调用方别名保留，语义已映射到 delivery。

## Issue 编号模型

Space Issue 的用户可见编号由云端拥有，不从 opaque `issue.id` 推导。`issues.number` 是同一 `space_id` 内唯一、正整数、自增的稳定编号；迁移会回填历史数据，并用 `(space_id, number)` 唯一索引和 insert/update trigger 防止缺失或非正数写入。

所有 issue list/detail、IssueDelivery 和 mock 数据都必须携带该编号。Renderer 展示 `#<number>` 时只消费 API 返回的 `number` / 兼容字段 `issueNumber`；Rust delivery 注入和 attached task 命名也使用该编号，缺失时只能降级为内部 `issueId`，不能自行解析 id 后缀。

## Agents UI 约束

- Agents 列表是双列卡片；单个 Agent 也保持半宽，布局宽度边界与 Skills 列表一致。
- 卡片只展示注意力关键项：Agent 名称 + 状态、本地电脑、工作区 Path、订阅目标。没有目标时展示“暂未设定目标”。
- 点击卡片打开 overlay 详情，不跳页。详情按“设备信息 / 工作区信息 / 派发设置 / 登记信息”分组。
- 编辑弹窗中的“本地 Agent 工作区”必须与登记弹窗使用同一工作区选择交互；但只有 current local Agent (`ownerUserId + deviceId` 命中当前端点) 可修改。远端设备登记的 Agent 工作区字段置灰，只能修改名称、订阅目标、订阅范围、订阅执行策略。
- `clientId` 是 OAuth public client/build 配置，不是设备标识，不应出现在卡片关键位。
