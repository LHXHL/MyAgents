---
type: prd
status: implemented
created: 2026-07-11
updated: 2026-07-11
scope: "在模型供应商中新增一等的 Grok（订阅）Provider：复用 Grok CLI 的公开 OIDC client identity，通过 Device Authorization Grant 登录，由 Rust 应用级 GrokAuthManager 统一管理单账号 token 生命周期；会话继续走 builtin Claude Agent SDK + 现有 OpenAI Bridge Responses 路径，并完整复用现有模型管理面板的 preset + discovery 交互。本期不新增 Grok Runtime，不接入 xAI 图像、视频、语音或服务端搜索，也不把通用 Responses translator 的多轮 reasoning 增强打包进本需求。"
issue: "产品需求：让用户在 MyAgents 中像使用 Anthropic、Codex 订阅一样登录自己的 Grok 订阅，直接使用订阅账号可用的模型与额度。"
research: "specs/research/0711_research_hermes_grok_oauth_responses_integration.md"
review: "实现、自验证与三视角 cross-review 已完成并通过；真实 Grok 订阅账号的 OAuth、模型目录、Responses 文本、本地工具调用、应用重启和多 Sidecar 并发 smoke 仍是发布门槛。公开 client identity 与账号 entitlement 都是外部兼容依赖，发布前必须实测。"
---

# 0.2.50 Grok（订阅）Provider

## 执行须知（给空 session 的你）

你接手实现前，不能只读本 PRD。必须先读：

1. specs/ARCHITECTURE.md
2. specs/tech_docs/third_party_providers.md
3. specs/tech_docs/proxy_config.md
4. specs/tech_docs/session_architecture.md
5. specs/tech_docs/pit_of_success.md 中与 config 锁、Provider proxy、Sidecar、前端 overlay 相关的章节
6. specs/tech_docs/react_stability_rules.md
7. specs/DESIGN.md
8. specs/research/0711_research_hermes_grok_oauth_responses_integration.md
9. 本 PRD 列出的当前实现文件与符号

本期是一个完整的 Provider 能力，不是新 Runtime，也不是“把 OAuth token 填进 API Key 输入框”。正确理解是：

- 产品层新增第三张订阅卡片；
- 身份层新增真正的 xAI subscription ProviderRoute；
- secret owner 是整个桌面应用唯一的 Rust GrokAuthManager；
- 执行层仍是 builtin Claude Agent SDK；
- 协议出口仍复用 OpenAI Bridge 的 Responses 翻译；
- 模型管理继续复用现有 ModelManagementPanel；
- token 不进入 renderer、AppConfig、ProviderEnv 静态快照或 session 持久化。

本文引用符号名而不是行号。开始开发时先用 rg 确认符号仍存在；如代码已演进，保留本文定义的行为和 owner 边界，不要机械照搬旧路径。

## 1. 背景与用户意志

用户要的产品体验非常明确：

“我在我的模型供应商里面再增加一个卡片，就叫做 Grok（订阅）。”

它对用户不应该表现为一项实验协议、一个外部 CLI 或一套 OAuth 配置。用户只应该感受到：

1. “模型供应商”里多了一个与 Anthropic（订阅）、Codex（订阅）同级的官方卡片。
2. 点击登录后弹出面板，自动打开浏览器，并同时把登录链接与 user code 留在面板中。
3. 浏览器授权完成后，卡片显示账号摘要和“已验证”。
4. 模型选择器里出现 Grok 供应商及其模型。
5. 点击“管理模型”仍然是现在的两层结构：上面是已启用模型，下面“发现更多模型”从服务端拉取当前账号可用模型。
6. 用户在原来的聊天、工具、MCP、权限、Goal、Cron、IM 产品能力里使用 Grok，不需要学习新的 Runtime 心智。

用户也明确纠正了工程边界：

“多轮 tool calling + encrypted reasoning 是否持续正确，这个应该支持 OpenAI 协议和 Responses 接口的就可以。有问题单独处理。”

所以本需求的主体不是重写 Responses 协议层，而是把 Grok 订阅的身份、登录、token 生命周期、Provider 路由和模型目录正确接入现有架构。

最后一项产品决策也已收敛：

“对复用他们的那个。”

这里指直接复用 xAI 官方 Grok CLI 使用的公开 OIDC client_id，不等待另行申请，不做本地生成。

## 2. 目标与成功定义

### 2.1 产品目标

在 0.2.50 中交付一个一等的 Grok（订阅）Provider，使拥有可用 Grok 订阅权益的用户能够：

- 在 MyAgents 内完成登录、验证、退出登录和重新登录；
- 查看账号状态；
- 使用预置 Grok 模型；
- 登录后发现当前账号可见的更多模型并添加；
- 在现有模型选择器中选择 Grok；
- 继续使用 builtin Agent 的本地工具与现有产品能力；
- 在 token 到期、刷新、应用重启和多 Sidecar 并发时无需人工维护 token。

### 2.2 技术成功定义

实现完成后，系统必须满足：

- 只有 Rust 应用级 GrokAuthManager 能持久化和旋转 refresh token；
- 所有 Tab、Cron、IM、BackgroundCompletion、Agent Sidecar 共享同一个 canonical grant；
- 每次 xAI 上游请求都从 owner 解析当前 bearer，不依赖 Sidecar 启动时快照；
- token 刷新不重启 Sidecar、不重置 MyAgents session；
- rotating refresh token 的并发、跨进程和崩溃边界由锁、fresh-read 与原子替换保证；
- 401 最多触发一次强制刷新与原请求重试；
- 403、429 不清理登录态；
- 模型 discovery 不向 renderer 暴露 bearer；
- provider-owned 网络请求遵守 xai-sub 的独立代理策略；
- API Key 方式的 xAI Provider 与 Grok subscription 身份保持完全分离。

## 3. 本期范围

### 3.1 本期必须交付

1. Grok（订阅）预置 Provider 与卡片。
2. Device Code 登录面板：start、status/poll、cancel、browser open、copy URL、copy user code。
3. 应用级 GrokAuthManager 与独立凭据存储。
4. refresh、rotation、single-flight、quarantine、logout/relogin。
5. 泛化 subscription ProviderRoute 与 credential materialization，不再把 subscription 等同于 anthropic-sub。
6. builtin Claude Agent SDK + OpenAI Bridge Responses 执行路径。
7. Bridge 每请求动态 bearer 解析，以及 401 刷新后只重试一次。
8. 订阅状态与错误分类。
9. Grok 模型 preset。
10. 复用 ModelManagementPanel，并让 subscription discovery 通过受管凭据工作。
11. 模型选择器、Provider 启用与排序、Agent/Task/Cron/IM 等现有 Provider 选择面的一致可用性。
12. macOS 与 Windows 支持。
13. mock 测试与真实账号 credentialed smoke。
14. 中英文 i18n、统一日志与敏感信息脱敏。

### 3.2 明确不做

- 不新增 Grok CLI Runtime，不启动 grok CLI 子进程。
- 不把 xAI subscription token 写入 XAI_API_KEY、providerApiKeys 或普通 API Provider。
- 不支持多账号池、自动账号轮换或账号优先级。
- 不导入、修改或复用用户的 ~/.grok/auth.json；MyAgents 使用自己的 canonical store。
- 不接入 xAI 原生 image generation、video、TTS、STT。
- 不接入 xAI server-side web_search、X Search、file search、code interpreter。
- 不展示订阅套餐名称、剩余额度百分比或账单详情；当前没有稳定的 subscription usage API 契约。
- 不将 models.dev 作为运行时模型目录依赖。
- 不给所有 Grok 模型强行发送 reasoning.effort。
- 不从非官方来源抄一个 provider 级 max output cap。
- 不在本需求中重写通用 Responses translator 的 encrypted reasoning、多轮 reasoning replay 或 server-side tools。
- 不因为 Grok 而默认建立新的 Provider history isolation；只有真实回归证明不兼容时，才按现有 ISOLATED_PROVIDER_HISTORY_KEYS 机制单独处理。

## 4. 核心用户体验

### 4.1 Provider 卡片

设置 → 模型供应商新增：

| 字段 | 取值 |
|---|---|
| 名称 | Grok（订阅） |
| 厂商 | xAI |
| 类型 | subscription |
| 官方标识 | 与 Anthropic、Codex 订阅卡片一致 |
| 说明 | 使用 Grok 订阅账户额度 |
| 模型摘要 | 取已启用模型，沿用现有截断展示 |
| 管理入口 | 复用现有模型管理按钮 |

卡片结构和视觉层级必须与现有订阅卡片一致，不为 Grok 设计一套新的卡片。

SettingsPage 当前 renderSubscriptionProviderContent() 不接收 provider 参数，并直接读取 Anthropic 的 subscriptionStatus 和登录 state。实现时必须把它重构为：

- 可复用的 subscription card shell；
- 按 providerId 隔离的状态；
- provider-owned auth adapter。

Anthropic 继续由 Claude Code native OAuth owner 管理；Codex 继续走 runtime-backed 特例；Grok 走 Rust GrokAuthManager。三者只复用产品外观与状态协议，不共享 token 实现。

### 4.2 卡片状态

Grok 卡片至少有以下状态：

| 状态 | 卡片表现 | 模型选择器 |
|---|---|---|
| logged_out | 未登录；主动作“登录” | 不显示 |
| login_starting | 正在发起登录 | 不显示 |
| login_waiting | 显示链接、user code、剩余时间；标签“登录中” | 不显示 |
| validating | 已取得 token，正在验证账号可用性 | 不显示 |
| valid | 账号摘要 + “已验证” | 显示 |
| auth_required | 登录已失效；主动作“重新登录” | 不显示并阻断旧选择 |
| entitlement_required | 账号已登录，但套餐、地区或所选模型不可用 | 不显示；保留模型配置 |
| rate_limited | 保留“已验证”，展示临时限流或额度提示 | 保持显示 |
| network_error | 保留已登录状态，提供重试验证 | 已有 valid 记录时不因一次网络失败隐藏 |

“已授权”和“已验证”不是同一个状态：

- Device token 交换成功只代表登录态已拿到；
- 至少一次真实 xAI 模型请求成功后，才展示“已验证”。

Rust credential store 是登录态权威；providerVerifyStatus 可以保存 UI 投影和最近验证结果，但不能反向证明 token 仍存在。

### 4.3 账号摘要

优先展示：

1. email；
2. display name；
3. 两者都取不到时显示“Grok 订阅账户”。

账号摘要只用于 UI，不作为授权判断。若从 id_token 读取 claim，只能作为未验证的显示元数据；真正的 auth 与 entitlement 由 xAI 响应决定。

### 4.4 登录面板

用户点击“登录”后：

1. 打开 Grok 登录 overlay。
2. 调 Rust startDeviceLogin。
3. 面板出现 loading skeleton。
4. 成功后显示 verification_uri_complete 或 verification_uri、user_code、过期倒计时。
5. 自动用系统浏览器打开 verification_uri_complete；打开失败不影响流程。
6. 提供“打开浏览器”“复制链接”“复制验证码”“取消”。
7. UI 按 Rust 返回的状态轮询，不自行请求 xAI。
8. approved 后进入 validating。
9. 验证成功，关闭面板并刷新 Provider 状态。
10. denied、expired、cancelled、network error 给出可操作说明，不留下半登录状态。

前端 overlay 必须使用 OverlayBackdrop 和 useCloseLayer；不得用裸 div 遮罩。所有颜色使用 DESIGN.md token，所有文案进入 i18n。

关闭面板时：

- 用户主动取消：调用 Rust cancel，停止对应 poller；
- 授权已完成但 UI 被关闭：不得删除已成功落盘的 grant；
- 组件卸载：必须停止 renderer polling，Rust login session 由自己的 deadline/cancel 清理；
- 同时只允许一个有效 Grok device login session；再次点击登录应复用正在等待的 session 或先明确取消旧 session。

### 4.5 模型管理面板

完全沿用现有 ModelManagementPanel 的两层产品语义。

上半区“可用模型”：

- 展示 bundled preset；
- 展示用户从 discovery 添加的模型；
- 支持手工输入 model ID；
- 支持删除；
- 支持设为首选；
- 继续写 presetCustomModels、presetRemovedModels 和 primary model 的既有持久化字段。

下半区“发现更多模型”：

- 仅在 Grok 已登录时可用；
- 打开面板自动请求一次；
- 点击“刷新”重新请求；
- 搜索、排除已添加模型、点击添加全部复用现有逻辑；
- discovery 失败只显示下半区错误，不清空上半区 preset；
- 403 显示账号/模型权限问题；
- 401 由 token owner 恢复一次，失败后引导重新登录；
- 429 显示限流/额度信息，不注销账号。

当前 ModelManagementPanel 的 canDiscover = !!apiKey && supportsModelDiscovery(provider)，而 supportsModelDiscovery() 对所有 subscription 返回 false。这是当前实现的错误抽象，不是 Grok 的产品限制。

实现应把模型发现泛化为一个 capability/action：

- 普通 API Provider 继续使用现有 API Key discovery；
- xai-sub 使用 Rust 受管凭据 discovery；
- renderer 只收到模型 JSON 或统一 DiscoveredModel，不收到 OAuth bearer；
- UI、解析、筛选、添加和持久化仍是同一套。

推荐让 ModelManagementPanel 接收统一 discovery adapter 或 action，而不是在组件内部继续增加 provider.id 条件分支。

## 5. OAuth 与 client identity

### 5.1 固定常量

首版直接复用 Grok CLI 的 public OIDC client identity：

| 项 | 值 |
|---|---|
| issuer | https://auth.x.ai |
| discovery | https://auth.x.ai/.well-known/openid-configuration |
| device endpoint | https://auth.x.ai/oauth2/device/code |
| client_id | b1a00492-073a-47ea-816f-4c329264a828 |
| scope | openid profile email offline_access grok-cli:access api:access |
| inference base URL | https://api.x.ai/v1 |
| model list | https://api.x.ai/v1/models |
| Responses | https://api.x.ai/v1/responses |

这个 client_id：

- 不是 MyAgents 生成的；
- 不是 Hermes 生成的；
- 不是 secret；
- 不需要写入用户配置；
- 不存在 dynamic registration 步骤；
- Device Code token endpoint 的客户端认证方式是 none。

它必须集中定义在 Rust Grok auth 模块中，不在 renderer、Node、测试夹具和多处字符串复制。测试可以引用同一常量或显式固定协议契约。

### 5.2 外部依赖边界

直接复用 public client identity 是已拍板的产品决定，但仍是外部兼容依赖：

- xAI 可以撤销、改 scope、收紧 client allowlist 或改变 entitlement；
- MyAgents 不能把“今天可用”当成永久平台承诺；
- 发布前必须用真实账号验证；
- 失败时要展示“Grok 登录服务当前不接受此客户端，请更新 MyAgents 或稍后再试”，不能伪装成用户密码错误；
- 不增加让用户手填 client_id 的高级设置；这会把平台兼容责任转嫁给用户。

### 5.3 OIDC discovery 安全

GrokAuthManager 每次使用 discovery 结果前必须验证：

- scheme 是 https；
- hostname 是 x.ai 或其子域；
- token endpoint 与 authorization endpoint 都通过 origin pinning；
- 持久化后的 token endpoint 在每次 refresh 前再次验证。

discovery 失败时不得回退到响应中任意第三方 endpoint。可以对官方固定 endpoint 做明确的、测试覆盖的 fallback，但不能放松 origin pinning。

### 5.4 Device Code 交换

start：

- POST application/x-www-form-urlencoded 到 device endpoint；
- 请求 client_id 和完整 scope；
- 要求返回 device_code、user_code、verification_uri、verification_uri_complete、expires_in、interval；
- 缺少 verification_uri_complete 也按无效响应处理，与本期复刻的 Grok CLI 契约保持一致；
- 缺关键字段直接失败，不持久化半状态。

poll：

- 使用服务器 interval；
- authorization_pending：继续；
- slow_down：每次增加一秒，最大 30 秒；
- access_denied：终止并展示用户拒绝；
- expired_token 或到 deadline：终止并允许重新开始；
- 200 必须同时有 access_token 与 refresh_token 才算成功；
- token pair 必须先原子写盘成功，再把 login session 标记为 approved。

## 6. GrokAuthManager

### 6.1 Owner

GrokAuthManager 是 Tauri Rust app process 的应用级单例。

它不是：

- renderer state；
- Global Sidecar 服务；
- per-session Sidecar singleton；
- OpenAI Bridge 内部静态 token；
- config.json 的一部分。

选择 Rust 的原因是 MyAgents 的 Session : Sidecar = 1 : 1。Tab、Cron、IM、Agent 可以并发启动多个 Node Sidecar，但它们都属于同一个桌面应用。只有 Rust app process 位于这些 owner 之上，能保证一个 canonical grant 和一个 refresh single-flight。

### 6.2 对外契约

具体命名可按现有 Rust 模块约定调整，但行为面应保持小而完整：

~~~text
startDeviceLogin()
getLoginStatus(sessionId)
cancelLogin(sessionId)
getAuthStatus()
verifyAccount()
resolveBearer(reason, rejectedCredentialVersion?)
logout()
fetchModels()
~~~

renderer 只可调用 login/status/cancel/logout/verify/fetchModels。

Sidecar 只通过现有 Rust Management API 调 resolveBearer。它返回当前 access token 与不含 secret 的 credentialVersion；不得返回 refresh token、id token 或完整持久状态。

resolveBearer 是 secret-bearing 内部路由，不能只依赖“随机 localhost 端口”：

- 只允许 POST；
- 必须携带 management-api-client.ts 已有的 X-MyAgents-Sidecar-Generation 身份；
- 请求同时带 session identity，Rust 通过 SidecarManager 校验该 generation 当前仍存活并归属于该 session；
- 使用 application/json 与自定义 header，使普通网页无法用 simple request 绕过浏览器 preflight；
- Management API 不返回 CORS allow-origin；
- credentialed resolver 响应设置 no-store；
- renderer 不得调用此路由；
- 若实现时引入每 Sidecar 随机 capability，应由 Rust spawn 时注入且只存进程内，不能落盘或进日志。

同一用户权限下的本机恶意进程理论上已经能读取该用户的 0600 文件；这里的硬闸主要防止浏览器页面、陈旧 Sidecar 和非 owner 的 loopback 调用把 Management API 当成 token oracle。

### 6.3 持久化

建议 canonical 文件：

~~~text
~/.myagents/credentials/grok-oauth.json
~~~

文件至少包含：

- schemaVersion；
- accessToken；
- refreshToken；
- optional idToken；
- tokenType；
- expiresAt 或 expiresIn + issuedAt；
- lastRefreshAt；
- validated discovery endpoints；
- account display metadata；
- credentialVersion；
- lastAuthError / quarantine reason；
- verifiedAt 与最近验证分类。

硬约束：

- secret 不进 ~/.myagents/config.json；
- secret 不进 providerApiKeys；
- secret 不进 sessions.json；
- secret 不进 providerEnvJson；
- secret 不进 analytics；
- secret 不进日志；
- Unix 文件权限 0600；
- Windows 使用当前用户 ACL，照 managed_codex.rs::harden_managed_auth_file_permissions 的平台模式；
- 写入使用临时文件、fsync/flush 与原子替换；
- 整个 read → decide → refresh → write 走 src-tauri/src/utils/file_lock.rs 的 with_file_lock / with_file_lock_blocking；
- async Tauri command 不得在 UI 线程做同步锁与文件 IO，阻塞段进入 spawn_blocking；
- 不宣称“加密存储”，除非实现时确实引入并验证了 OS secure storage。首版安全承诺是独立 secret file + 最小权限 + ACL + 日志脱敏。

### 6.4 到期判断

优先使用 OAuth 响应的 expires_in/issuedAt；JWT exp 只可作为刷新时机辅助，不校验签名也不承担身份验证。

刷新窗口必须按 token 生命周期成比例，不能固定提前一小时：

- 短生命周期 token：最多提前约 120 秒；
- 数小时 token：最多提前约 3600 秒；
- opaque 或无可靠过期信息：正常使用，遇 401 再响应式刷新；
- 所有判断要保留最小安全 skew，避免刚取出就过期。

### 6.5 刷新算法

每次 resolveBearer：

1. 读取内存快照；
2. 未临近到期且未 quarantine，直接返回当前 bearer + credentialVersion；
3. 需要刷新时进入 process-global single-flight；
4. 获取跨进程 auth file lock；
5. 重新从磁盘读取 canonical state；
6. 再判断是否仍需刷新；
7. 如果另一个调用者已写入更新版本，直接采用新 token；
8. 只有仍需刷新时才 POST refresh；
9. 成功后把新 access token 和新 refresh token 作为一个不可分割状态原子写回；
10. 更新内存状态并唤醒所有等待者。

refresh 请求：

~~~text
grant_type=refresh_token
client_id=b1a00492-073a-47ea-816f-4c329264a828
refresh_token=<current>
~~~

xAI refresh token 按 rotating/single-use 处理。成功响应如果返回新 refresh token，旧值立即作废；如果协议明确没有返回新值，才保留旧值。不能先更新内存、稍后异步写盘。

### 6.6 401 恢复

Bridge 发起 xAI 请求前获得：

- bearer；
- credentialVersion。

若上游返回 401：

1. 同一请求只允许进入一次 auth recovery；
2. Bridge 向 Rust 请求 resolveBearer(reason = auth_recovery, rejectedCredentialVersion)；
3. Rust 如果发现 canonical version 已变化，直接返回其他调用者刚刷新的 token，不再刷新；
4. 如果 version 未变化，执行强制刷新 single-flight；
5. Bridge 用新的 bearer 重试完全相同的上游请求一次；
6. 再次 401 时 quarantine grant，卡片变为 auth_required；
7. 禁止自动第三次重试。

credentialVersion 用于并发判断，不含 token 内容。日志只记录 version 的短、安全标识，不记录 bearer hash、token prefix 或完整响应 body。

### 6.7 终态 quarantine

以下情况进入 auth_required/quarantine：

- 缺 refresh token；
- invalid_grant；
- refresh token revoked/reused；
- refresh 明确返回不可恢复的 400/401；
- 401 recovery 后原请求仍是 401；
- 持久状态结构损坏且无法安全恢复。

quarantine 后：

- 清除或隔离不可再用的 access/refresh token；
- 保存脱敏的 lastAuthError；
- 后续 resolveBearer fail fast；
- 不再持续重放旧 refresh token；
- 要求用户重新登录。

以下不进入 quarantine：

- 403；
- 429；
- 5xx；
- timeout；
- DNS/代理/离线错误。

### 6.8 Logout 与重新登录

logout：

- 取消正在进行的 device login session；
- 在同一 auth file lock 下清除 canonical grant；
- 清空内存 token；
- 清除 account summary 与 valid 投影；
- 保留 Grok Provider、模型 preset 和用户自定义模型；
- 不删除普通 xAI API Provider 的 API key；
- 已启动 Sidecar 的下一次 xAI 请求通过 resolveBearer 立即失败，不继续使用旧快照。

重新登录：

- 清除 quarantine；
- 创建新的 device session；
- 新 grant 原子覆盖 canonical state；
- 不复用旧 refresh token；
- 验证成功后恢复 Provider 可用性。

## 7. Bridge 与 builtin 执行路径

### 7.1 执行形态

Grok Provider 必须配置为：

| 字段 | 值 |
|---|---|
| provider id | xai-sub |
| type | subscription |
| execution | builtin |
| apiProtocol | openai |
| upstreamFormat | responses |
| baseUrl | https://api.x.ai/v1 |
| auth owner | host-managed Grok OAuth |
| maxOutputTokens | undefined |

数据流：

~~~text
模型选择器 / ProviderRoute { kind: subscription, providerId: xai-sub, model }
  → session-engine/builtin-adapter
  → structured managed-subscription ProviderEnv（不含 token）
  → agent-session 注册 OpenAI Bridge
  → Claude Agent SDK 请求本地 Anthropic-compatible Bridge
  → Bridge 每次通过 Rust Management API resolveBearer
  → Anthropic Messages 转 xAI Responses
  → provider-aware proxy
  → https://api.x.ai/v1/responses
~~~

### 7.2 泛化 subscription 身份

当前 src/shared/providerRoute.ts 存在这些硬编码：

- ProviderRoute.kind = subscription 的 providerId 只允许 anthropic-sub；
- hasProviderRouteCredential() 对其他 subscription 直接 false；
- createConcreteProviderRoute() 只为 anthropic-sub 创建 subscription route；
- isConcreteProviderRoute() 也写死 anthropic-sub。

当前 src/server/utils/admin-config.ts 还假设：

- 所有 subscription 都不 materialize ProviderEnv；
- subscription 等同于 SDK native OAuth。

这些假设在 Grok 加入后不再成立。必须把“Provider 是 subscription”与“谁拥有凭据、怎么执行”拆开。

推荐引入结构化 subscription auth policy，语义等价于：

| 类型 | owner | 执行 |
|---|---|---|
| sdk-native | anthropic | builtin，Claude Code 自己读 OAuth |
| host-managed-oauth | grok | builtin，OpenAI Bridge 每请求向 Rust 取 bearer |
| runtime-managed | codex | runtime-backed，仍由 Provider.execution 管理 |

不要求字段名必须与表一致，但必须满足：

- 不能用 undefined/null 表示某个特定订阅动作；
- 不能靠 scattered provider.id if-chain 把 Grok 塞进现有 Anthropic sentinel；
- ProviderRoute 能持久化 xai-sub；
- Runtime-backed Codex 不误入 builtin；
- Anthropic native OAuth 行为不回归；
- 历史 session repair 只在有对应账号证据时认领 xai-sub，不按 model 名猜默认 Provider。

### 7.3 ProviderEnv 不是 token 容器

src/server/builtin-session/types.ts::ProviderEnv 当前只有静态 apiKey。Grok 需要表达的是“受管 credential reference”，不是复制 bearer。

实现应增加结构化 credential source，例如 managed OAuth provider identity，或等价的不可序列化 resolver reference。要求：

- session snapshot 只保存 xai-sub identity；
- currentProviderEnv 可以保存 providerId、baseUrl、protocol、format、model aliases 和 managed credential kind；
- 不保存 access token；
- buildClaudeSessionEnv 仍把 SDK 指向本地 Bridge；
- 切换模型不需要 token 重物化；
- token 刷新不触发 session abort。

### 7.4 Bridge 动态解析

现有事实：

- openai-bridge/types/bridge.ts::getUpstreamConfig 已允许 Promise；
- handler.ts 已 await getUpstreamConfig；
- bridge-registry.ts::Entry.resolve 与 lookupBridge 仍是同步 UpstreamBridgeConfig；
- resolveActiveSessionUpstreamConfig 仍返回静态 apiKey。

实现应沿现有 per-request resolver chokepoint 泛化，不建立第二个 Grok 专用 HTTP bridge。

推荐 contract：

- registry 能异步解析当前 upstream config；
- resolver 收到 request 或 auth_recovery 意图；
- API Key Provider 返回现有静态 key；
- xai-sub 通过 Management API 获取 bearer + credentialVersion；
- handler 只有在上游配置声明 supportsAuthRecovery 时才处理 401；
- count_tokens 等只需要判断 bridge token 是否存在的路径，使用 hasBridge/metadata lookup，不应为了 existence check 触发 bearer 解析；
- registry/listBridges/health 输出永远不包含 credential。

### 7.5 代理

所有 xAI 请求都属于 provider xai-sub：

- OIDC discovery；
- device code；
- token polling；
- refresh；
- /v1/models；
- /v1/responses。

它们必须遵守 provider-aware proxy scope：

- Rust 使用 proxy_config::build_client_with_proxy_for_provider；
- Node Bridge 继续使用 getProxyForProviderUrl；
- providerId 必须是 xai-sub，不借用 anthropic-sub 或普通 xai-api；
- localhost Management API 必须走 local_http/no-proxy 语义；
- 不使用裸 reqwest::Client::new()；
- 网络请求必须有 deadline/cancellation；
- login cancel 应中断 poller，不等待 OS TCP timeout。

### 7.6 Session 与历史边界

Grok 仍是 builtin Provider：

- 不新增 Runtime；
- 不改 Session : Sidecar = 1 : 1；
- 不绕过 session-engine facade；
- Provider 切换仍使用 abortPersistentSession()；
- 仍按现有 provider boundary 规则决定能否 resume；
- token refresh 不属于 Provider 切换，不 abort；
- 不因推测 encrypted reasoning 风险预先把 xai-sub 加入 ISOLATED_PROVIDER_HISTORY_KEYS；
- credentialed smoke 如果证明跨 Provider replay 不兼容，单独建立协议 bug，并按 exact provider/model/endpoint key 隔离。

## 8. 模型目录与参数

### 8.1 权威优先级

Grok 模型目录采用：

~~~text
MyAgents 官方校准 preset
  + 用户已保存的 presetCustomModels
  + 登录后的 xAI /v1/models discovery
  + 少量 OAuth 隐藏模型 curated allowlist
~~~

优先级：

1. bundled preset 的 model name、context、capability 是最高本地信任；
2. discovery 为新 model 创建 source = discovered；
3. 对同 ID，discovery 只填 preset 缺失字段，不覆盖已校准值；
4. 用户显式编辑仍按现有 custom override 语义；
5. 下线模型由用户删除或后续 preset migration 处理，单次 discovery 缺失不能自动删除。

Hermes 不是模型目录权威。它的 xAI OAuth 列表来自 models.dev 磁盘 cache + curated extras + static fallback，provider_model_ids(xai-oauth) 不调用 live xAI catalog。MyAgents 不复制这条依赖。

### 8.2 首版 preset

0.2.50 预置：

| 模型 ID | 展示名 | context | reasoning 参数策略 | 备注 |
|---|---|---:|---|---|
| grok-4.5 | Grok 4.5 | 500K | 支持 low / medium / high；默认不发送 | 首选模型 |
| grok-build-0.1 | Grok Build 0.1 | 256K | 模型会推理，但不暴露 effort 开关 | Grok Build / coding |
| grok-composer-2.5-fast | Grok Composer 2.5 Fast | 200K | 默认不发送 effort | OAuth 可用但可能不出现在 /v1/models，curated |
| grok-4.3 | Grok 4.3 | 1M | 支持 none / low / medium / high；默认不发送 | 通用长上下文 |
| grok-4.20-0309-reasoning | Grok 4.20 Reasoning | 1M | 固定推理形态，不发送 effort | catalog 变化需实测 |
| grok-4.20-0309-non-reasoning | Grok 4.20 Non-reasoning | 1M | 无 reasoning 控件 | catalog 变化需实测 |
| grok-4.20-multi-agent-0309 | Grok 4.20 Multi-Agent | 1M | 仅在验证支持时发送 effort | 模型名称不代表 MyAgents Runtime |

primaryModel = grok-4.5。

这些是 0.2.50 的启动 preset，不是永久平台契约。模型可见性最终取决于账号 entitlement；用户可以从 discovery 添加新模型，也可以手工输入 ID。

注意：Hermes 当前硬编码 fallback 对 Grok 4.20 有过 2M 数值，而当前 catalog/官方校准口径为 1M。MyAgents 不继承该冲突值。真实账号 smoke 若返回不同 context_length，只记录差异并核对官方文档，不让 discovery 静默覆盖 bundled preset。

### 8.3 max output

xAI 当前没有给这些 OAuth 模型提供稳定、统一的 max output 契约。首版：

- Provider.maxOutputTokens 保持 undefined；
- 不把 models.dev 的 limit.output 写入 provider 级 maxOutputTokens；
- discovery 返回模型级 max tokens 时，可以作为 discovered model 的可选元数据；
- Bridge 不主动发送 provider 级 max_output_tokens，让 xAI 使用默认行为；
- 后续只有官方文档与真实调用共同验证后，才校准具体模型。

### 8.4 reasoning effort

现有 reasoningEffort 是通用 UI 状态，但 xAI 支持是 model-specific。

要求：

- default 继续表示“不发送 reasoning 字段”；
- grok-4.5 允许 low/medium/high；
- grok-4.3 允许 none/low/medium/high；
- grok-build-0.1、composer、4.20 reasoning/non-reasoning 不因全局选择而盲发；
- grok-4.20-multi-agent-0309 只有 credentialed smoke 确认后才开放；
- 不支持时 UI 隐藏/禁用 effort，translator 也必须 fail-safe 地 omit；
- 这是模型参数 policy，不是对通用 encrypted reasoning 的扩项。

### 8.5 discovery 实测事实

2026-07-11 的无凭据实测：

- GET https://api.x.ai/v1/models 返回 HTTP 401，错误为 no credentials；
- GET https://api.x.ai/v1/language-models 也返回 HTTP 401；
- GET https://api.x.ai/models 返回 404。

结论：

- 正确 endpoint 是 /v1/models；
- endpoint 存在；
- 没有鉴权不能获得列表；
- 现有 OpenAI list parser 能处理其 object=list, data=[...] 形态；
- OAuth bearer 是否被接受、返回是否按账号过滤，仍必须用真实账号验证。

## 9. 验证流程

### 9.1 登录后的自动验证

token 成功落盘后：

1. getAuthStatus 返回 logged_in；
2. 尝试 fetchModels，获取账号可见模型；
3. 从可见列表与 preset 交集中选择验证模型；
4. 优先 grok-4.5；若账号列表明确不含它，则选择首个可见 preset；
5. 通过现有 one-shot OpenAI Bridge + Responses 发起最低成本文本验证；
6. 第一个成功请求即停止，不做无上限 model probing；
7. 成功后写 valid + verifiedAt + account summary；
8. 失败按 auth/entitlement/rate-limit/network 分类。

如果 fetchModels 因网络或目录接口问题失败，但已知模型验证成功，Provider 仍可标 valid；模型面板只显示 discovery 错误。

如果 token 交换成功但模型验证 403：

- 登录态保留；
- 卡片显示“账号已登录，但当前订阅、地区或模型不可用”；
- 不显示“已验证”；
- 不刷新 token；
- 不删除 preset；
- 提供“重新验证”和“退出登录”。

### 9.2 模型选择器可用性

providerService 当前已经按 subscription 的 providerVerifyStatus.valid 判断可用性。泛化后应以：

~~~text
provider enabled
AND Rust auth state has canonical grant
AND latest effective verification status is valid
~~~

为准。

硬约束：

- xai-sub 不可用时不能 fallback 到 Anthropic 或其他 Provider；
- 历史 session 选中 xai-sub 但 auth 失效时，阻断 turn 并引导登录；
- 用户关闭 Provider 时不删除 token 或模型；
- logout 时立即从所有 Provider picker 隐藏/禁用；
- Agent、Task、Cron、IM 保存的 provider identity 仍是 xai-sub + model，不保存 bearer。

## 10. 错误语义

### 10.1 401

- 触发一次 managed auth recovery；
- 最多重试原请求一次；
- 仍失败则 auth_required；
- quarantine 后 fail fast；
- UI 主动作“重新登录”。

### 10.2 403

- 不刷新；
- 不清 token；
- 不 quarantine；
- 归类 entitlement_required；
- 文案覆盖订阅、地区、模型权限；
- 当前模型失败不代表所有模型永久失败，允许用户打开模型管理选择其他可见模型后重试。

### 10.3 429

- 不改变登录或验证状态；
- 可重试型 rate limit 展示“请求过多，请稍后再试”；
- quota/billing 型永久 429 继续复用 openai-bridge/translate/errors.ts 的非重试映射；
- 不做自动账号轮换；
- 不假装有用量百分比。

### 10.4 网络与 5xx

- 保留 canonical grant；
- 保留最近一次 valid；
- 当前操作可失败并允许重试；
- 遵守 AbortSignal/timeout；
- 不把代理错误归类成登录失效。

### 10.5 错误信息安全

所有上游错误在日志/UI 前脱敏：

- Authorization header；
- access/refresh/id token；
- device_code；
- Management API bearer 响应；
- prompt_cache_key；
- raw session id；
- 上游回显的完整 request body。

user_code 可以在登录面板显示，但不应进入长期日志或 analytics。

## 11. 技术改动地图

### 11.1 Shared

重点文件：

- src/shared/config-types.ts
- src/shared/providerRoute.ts
- src/shared/providerExecution.ts
- src/shared/subscription.ts
- src/shared/providerHistory.ts

需要完成：

- 新增 xai-sub 常量与 PRESET_PROVIDERS 定义；
- ProviderRoute subscription identity 泛化；
- 新增结构化 subscription auth owner/policy；
- credential availability 能识别 Rust Grok auth 投影；
- ProviderVerifyStatus 继续按 providerId 隔离；
- 不改变 Codex runtime-backed execution；
- 不把 Grok 默认加到 history isolation。

### 11.2 Rust

建议新建聚合模块：

~~~text
src-tauri/src/grok_auth/
  mod.rs
  manager.rs
  oauth.rs
  store.rs
  commands.rs
  types.rs
~~~

职责：

- app-global state；
- OIDC discovery 与 origin pinning；
- device login session；
- auth file；
- file lock + atomic write；
- refresh single-flight；
- quarantine；
- account status；
- model discovery；
- Tauri commands；
- Management API bearer resolver。

复用：

- src-tauri/src/utils/file_lock.rs
- src-tauri/src/proxy_config.rs
- src-tauri/src/local_http.rs
- src-tauri/src/management_api.rs
- managed_codex.rs 的权限硬化模式
- ulog_info!/ulog_warn!/ulog_error!，且日志中不带 secret

不要：

- 用同步 Tauri command 阻塞 UI；
- 裸 reqwest::Client::new()；
- 裸 tokio::spawn；
- 将 bearer 放到 command error 文本；
- 给 renderer 返回 secret。

### 11.3 Server / Sidecar

重点文件：

- src/server/utils/admin-config.ts
- src/server/session-engine/builtin-adapter.ts
- src/server/builtin-session/types.ts
- src/server/agent-session.ts
- src/server/openai-bridge/bridge-registry.ts
- src/server/openai-bridge/handler.ts
- src/server/openai-bridge/types/bridge.ts
- src/server/openai-bridge/translate/request-responses.ts
- src/server/openai-bridge/translate/errors.ts
- src/server/index.ts

需要完成：

- materialize xai-sub 为 managed Responses provider，而非 Anthropic sentinel；
- Bridge registry resolver 支持异步；
- 每请求向 Rust resolve bearer；
- 401 recovery + retry once；
- existence check 与 secret resolution 分离；
- xAI requests 使用 providerId xai-sub 的 proxy；
- model-specific reasoning effort policy；
- 保持现有 prompt_cache_key；
- 不把通用 encrypted reasoning 改造扩大到本需求。

### 11.4 Renderer

重点文件：

- src/renderer/pages/settings/SettingsPage.tsx
- src/renderer/components/ModelManagementPanel.tsx
- src/renderer/config/services/modelDiscoveryService.ts
- src/renderer/config/services/providerService.ts
- src/renderer/config/services/appConfigService.ts
- src/renderer/config/ConfigProvider.tsx
- 现有 subscription login overlay / API 封装
- i18n 资源

需要完成：

- subscription card shell provider-aware；
- Grok login overlay；
- auth state keyed by providerId；
- Rust invoke API；
- model discovery adapter 泛化；
- 上下两层模型面板保持现状；
- model picker gating；
- loading/error/cancel/unmount 稳定性；
- OverlayBackdrop、useCloseLayer、CSS token、七档字号；
- 不使用 renderer 原生 fetch 直连 xAI。

### 11.5 Config 与持久化

普通配置：

- Provider preset；
- provider order / disabled；
- presetCustomModels；
- presetRemovedModels；
- primary model；
- providerVerifyStatus 的非 secret 投影。

secret 配置：

- 仅 GrokAuthManager 独立 store。

所有 config 写盘继续遵守 disk-first + config lock；不能用 React 内存 config 直接覆盖磁盘。

## 12. 关键设计决策

### D1：Grok 是 Provider，不是 Runtime

执行继续走 builtin Claude Agent SDK + OpenAI Bridge Responses。这样用户得到的是现有 MyAgents agent/tool 产品能力，而不是另一套 Grok CLI 会话引擎。

### D2：Rust 是唯一 token owner

每个 Sidecar 都自行 refresh 会并发消费 rotating refresh token。Rust app singleton 是所有 Sidecar 共同的真实 owner。

### D3：首版单账号

“使用我的 Grok 订阅”不需要凭据池。多账号会引入独立 entitlement、cooldown、切换和 refresh lock identity，本期没有价值证据。

### D4：直接复用 Grok CLI public client_id

client_id 是固定 public identity，不是 Hermes 生成，也不需要 secret。用户已决定复用，不保留申请新 client 的 TBD；但发布前真实验证是硬门槛。

### D5：token 与普通 Provider 配置分离

OAuth grant 不能伪装成 API Key。这样 logout、订阅额度、代理策略和错误分类不会与 xAI developer billing 混在一起。

### D6：卡片外观复用，auth owner 不共用

Anthropic、Codex、Grok 可以长得一样，但三者 credential owner 完全不同。复用 UI shell，不复制/串联状态。

### D7：模型面板完全复用

现有“可用模型 + 发现更多模型”已经是正确产品模型。只泛化 discovery credential action，不新增动态目录 UI。

### D8：preset + live discovery + curated hidden model

只靠 preset 会过时，只靠 /v1/models 会漏 OAuth hidden slug，只抄 Hermes/models.dev 会引入第三方缓存漂移。混合权威与现有配置合并逻辑最匹配。

### D9：403/429 不等于 auth invalid

403 是 entitlement/region/model permission，429 是 rate/quota；盲目 refresh 会浪费 rotating token 并错误要求用户重登。

### D10：Responses 通用问题单独处理

本需求做一次真实本地工具往返以证明基本集成，但 encrypted reasoning 等通用协议问题属于 OpenAI Bridge owner，发现后独立修复，不让 Grok token 工程无限扩张。

### D11：不为刷新重启 Session

bearer 是每请求凭据，不是 ProviderRoute 或 SDK session 身份。刷新 token 不改变模型、Provider 或历史边界。

### D12：不预设 history isolation

MyAgents 的普通 OpenAI Bridge Provider 当前属于 portable third-party family。只有证据才能新增 isolation key，不能因担忧先破坏跨 Provider 连续体验。

## 13. 测试与验证

### 13.1 Unit

至少覆盖：

- origin pinning：x.ai、子域允许；http、同形域、非 x.ai 拒绝；
- discovery schema；
- device code response schema；
- OAuth error mapping；
- interval/slow_down/deadline；
- expiry/skew；
- model-specific reasoning effort；
- 401/403/429 分类；
- ProviderRoute xai-sub concrete/credential policy；
- preset/discovered merge precedence；
- secret redaction；
- account label fallback。

### 13.2 Rust integration / mock OAuth

用 loopback mock server 覆盖：

- authorization_pending → success；
- slow_down；
- access_denied；
- expired_token；
- cancel；
- token response 缺 access/refresh；
- proactive refresh；
- concurrent resolve single-flight；
- rotating refresh token；
- 两个 process/owner 依次竞争同一个 store，后者 fresh-read；
- refresh 成功后崩溃点与原子文件；
- invalid_grant quarantine；
- network/5xx 不 quarantine；
- logout 与正在进行请求；
- Windows/Unix permission hardening 的可测试部分；
- provider proxy selection。

### 13.3 Bridge integration

覆盖：

- xai-sub registry 每请求异步解析；
- API Key Provider 不回归；
- 401 → auth recovery → retry once；
- 401 second failure no third retry；
- concurrent 401 只发生一次 refresh；
- 403 no recovery；
- 429 no recovery；
- translated request body 在重试中保持一致；
- count_tokens/health existence check 不触发 token resolve；
- unregister 后 late request 返回 unknown bridge token；
- 日志不含 bearer、credentialVersion 敏感派生、prompt_cache_key。

### 13.4 Renderer DOM

覆盖：

- 三张 subscription 卡不串状态；
- login overlay start/wait/approved/error/cancel；
- browser open 失败仍显示 URL/code；
- unmount 后不 setState；
- Grok 未登录时 discovery 显示登录提示；
- 登录后自动 discovery；
- discovery 失败不清 preset；
- 添加 discovered model 写入 presetCustomModels；
- logout 后模型选择器隐藏；
- entitlement 状态保留账号，不展示 verified；
- Cmd+W 先关闭 overlay。

### 13.5 Credentialed smoke

真实 Grok 订阅账号必须覆盖：

1. Device Code 登录。
2. 卡片显示正确账号摘要。
3. OAuth bearer 调 GET /v1/models。
4. Responses 文本流。
5. 一次 MyAgents 本地工具调用往返。
6. App restart 后 grant 恢复。
7. 同时打开至少两个 builtin Sidecar 发请求。
8. 强制接近过期或等待真实 refresh，证明 rotation 后持续工作。
9. logout 后旧 Sidecar 下一请求立刻失败并引导登录。
10. 至少一个 403/无权限模型或可控 mock 对应 UI 分类。

credentialed 测试只进 npm run test:credentialed 或 Rust 等价显式入口，不进入默认 CI。

## 14. 验收标准

### A. 用户主路径

- [x] 设置页出现 Grok（订阅）官方卡片，结构与另外两张订阅卡一致。
- [x] 点击登录打开面板，展示 URL 和 user code，并自动打开浏览器。
- [x] 用户授权后自动完成 token 交换与验证。
- [x] 验证成功后卡片展示账号摘要和“已验证”。
- [x] 模型选择器出现 Grok Provider 和预置模型。
- [ ] 用户选 Grok 后能流式对话并完成一次 MyAgents 本地工具调用。

### B. 模型管理

- [x] 上半区展示 preset 和已添加模型。
- [x] 下半区登录后调用 xAI /v1/models。
- [x] discovery 结果排除已添加模型，可点击添加。
- [x] 手工 model ID、删除、首选模型保持可用。
- [x] discovery 失败不影响 preset。
- [x] OAuth bearer 从未到达 renderer。

### C. Token 生命周期

- [x] 多 Sidecar 共享一个 canonical grant。
- [x] 临近过期只发生一次 refresh。
- [x] rotating refresh token 原子替换。
- [x] app restart 使用最新 token。
- [x] 401 只恢复并重试一次。
- [x] 403/429 不清登录态。
- [x] invalid_grant quarantine 并要求重登。
- [x] logout 立即对所有 Sidecar 生效。

### D. 架构与安全

- [x] Grok 仍是 builtin Provider，不新增 Runtime。
- [x] ProviderRoute 不再硬编码 subscription = anthropic-sub。
- [x] Anthropic native OAuth 和 Codex runtime-backed 行为无回归。
- [x] token 不进 config、session、renderer、analytics、日志。
- [x] secret file 权限、ACL、锁和原子替换满足跨平台约束。
- [x] 所有外部请求使用 xai-sub provider-aware proxy。
- [x] 无裸 WebView fetch、裸 reqwest client、同步阻塞 Tauri command。

### E. 发布门槛

- [ ] 真实 Grok 订阅账号完成完整 credentialed smoke。
- [ ] 公开 client_id 在发布构建中仍能完成 device flow。
- [ ] /v1/models 与 /v1/responses 都接受该 OAuth bearer。
- [ ] preset 模型 ID、context 与 reasoning 参数重新核对。
- [ ] 对公开 client identity 外部兼容失败有清晰用户文案。

## 15. 已验证事实、待验证项与后续

### 15.1 已验证事实

- Hermes 没有生成 client_id；它硬编码复用 Grok CLI public identity。
- xAI Grok CLI 安装入口使用同一 client_id。
- OIDC discovery 不提供 dynamic client registration。
- Device Code flow 不需要客户端 secret。
- MyAgents 已有 OpenAI Responses Bridge 和 prompt_cache_key。
- Bridge handler 的 getUpstreamConfig 已支持 async。
- ModelManagementPanel 已有完整 preset/discovered 添加闭环。
- cmd_fetch_provider_models 已有 provider-aware proxy 与 OpenAI list JSON 解析路径。
- 无鉴权 GET /v1/models 返回 401，而不是 404。

### 15.2 发布前待验证，不是产品 TBD

- ⚠️ Grok subscription OAuth bearer 是否在当前 xAI 生产环境对 /v1/models 和 /v1/responses 均可用。
- ⚠️ 不同 Grok 套餐、地区和模型的 entitlement 差异。
- ⚠️ 0.2.50 preset 的模型是否仍在线、context 是否变化。
- ⚠️ xAI 实际 refresh token rotation 响应是否始终返回新 refresh token。
- ⚠️ Grok 与 portable third-party transcript 的跨 Provider replay 是否存在已知不兼容。

这些项目不需要用户继续做产品决策。实现者应通过 credentialed smoke 得到证据；若外部行为变化，按本 PRD 的 owner 与错误语义调整实现或阻断发布。

### 15.3 后续独立需求

- Grok 多账号与凭据池。
- xAI subscription usage/额度可视化。
- xAI 图像、视频、TTS、STT。
- xAI 原生 Web/X Search。
- 通用 Responses encrypted reasoning 持久化与 issuer isolation。
- 通用 server-side Responses tool item 支持。
- 如果 xAI 要求独立合作方 client，迁移到 MyAgents 自有 OAuth client。

## 16. 关联资料

- specs/research/0711_research_hermes_grok_oauth_responses_integration.md
- specs/ARCHITECTURE.md
- specs/tech_docs/third_party_providers.md
- specs/tech_docs/proxy_config.md
- specs/tech_docs/session_architecture.md
- specs/tech_docs/pit_of_success.md
- specs/prd/prd_0.2.48_builtin_anthropic_subscription_auth_repair.md
- specs/prd/prd_0.2.43_managed_codex_provider.md
- specs/prd/prd_0.2.49_openai_responses_prefix_cache_bridge.md
- /Users/zhihu/Documents/project/hermes-agent/hermes_cli/auth.py
- /Users/zhihu/Documents/project/hermes-agent/hermes_cli/models.py
- /Users/zhihu/Documents/project/hermes-agent/agent/model_metadata.py

## 执行台账

### 开发契约（动第一行代码前写完）

- 必赢场景：用户在设置页看到与 Anthropic、Codex 同级的“Grok（订阅）”卡片；点击登录后面板立即展示登录链接和 user code、自动打开系统浏览器；授权后由应用自动换取并验证 token，卡片展示账号摘要与“已验证”；模型管理上半区沿用 preset/自定义模型，下半区用受管 OAuth 调用 xAI `/v1/models`；用户从模型选择器选中 Grok 后，builtin Claude Agent SDK 经现有 OpenAI Responses Bridge 流式对话并可完成本地工具调用；应用重启、token 临期、并发 Sidecar、401、403、429、logout 均保持本文定义的生命周期与错误语义。
- 复用的既有抽象：`ProviderRoute` / `createConcreteProviderRoute()` 作为会话持久身份；`ProviderExecution` 与 `session-engine/builtin-adapter.ts` 作为 builtin/runtime-backed 分流；`ProviderEnv` / `buildClaudeSessionEnv()` / `startOneShotBridge()` 作为请求期执行配置；`openai-bridge/bridge-registry.ts` 的 per-token resolver 与 `handler.ts` 的唯一 egress chokepoint；Rust `management_api.rs` + `management-api-client.ts` 的 Sidecar generation 身份；`proxy_config::build_client_with_proxy_for_provider()` / Node `getProxyForProviderUrl()`；`utils/file_lock.rs::with_file_lock()`；`config_io::with_config_lock()`；`ModelManagementPanel` 的 preset/discovered 合并、添加、删除、首选持久化；`cmd_fetch_provider_models` 的普通 API-key discovery；`OverlayBackdrop` + `useCloseLayer`；`providerVerifyStatus` 的非 secret UI 投影。
- 反向边界：不新增 Grok Runtime/CLI 子进程；不把 OAuth bearer 写入 API Key、AppConfig、ProviderEnv 静态值、session、renderer、analytics 或日志；不接入图像/视频/语音/服务端搜索；不新增多账号池；不导入 `~/.grok/auth.json`；不扩大通用 encrypted reasoning / server-side tools；不预设新的 history isolation；不把 models.dev 变成运行时依赖；不让 refresh 触发 Sidecar/session 重启。
- 新概念清单：`xai-sub`（必要的订阅 Provider identity，与 API-key xAI 计费身份分离）；结构化 `subscriptionAuth` policy（必要，用 owner 而非 `provider.id` 分支区分 sdk-native / host-managed / runtime-managed）；应用级 `GrokAuthManager`（必要，唯一拥有 rotating refresh token）；`managed-oauth` ProviderEnv credential reference（必要，让 Bridge 每请求解析 bearer 而不是复制 secret）；统一 model discovery action（必要，把“是否有 renderer API key”改成“当前 Provider 是否提供 discovery action”）。除此之外不建立新 Runtime、进程、状态框架或 UI 体系。
- 触及的红线：跨模块/跨进程功能已读 `ARCHITECTURE.md`、`third_party_providers.md`、`proxy_config.md`、`session_architecture.md`；secret 文件读改写走 `with_file_lock`，普通 config 投影走 `with_config_lock`；外部请求走 `xai-sub` provider-aware proxy，localhost Management API 走既有 no-proxy client；Tauri 网络/文件命令必须 async，阻塞段进入 `spawn_blocking`；Rust 日志只用 `ulog_*` 且绝不打印 token/device_code/user_code；renderer 不直连 xAI；Bridge fetch 保留 AbortSignal/timeout；模型 >200K 的 SDK ingress 继续过 `applyContextWindowSuffix`；登录 overlay 使用 `OverlayBackdrop`、`useCloseLayer`、设计 token、七档字号和 i18n；React effect/callback 遵守稳定性与卸载清理规则。

### 行动清单

- [x] Phase 1 — Provider identity + Rust auth owner：泛化 subscription route/auth policy，加入 Grok preset；实现 OIDC/device flow、独立 secret store、文件锁/原子写/权限、refresh single-flight/rotation/quarantine、状态/verify/model discovery Tauri commands、非 secret config 投影及 Rust 测试；完成本期自验证、cross-review、提交。
- [x] Phase 2 — builtin/Bridge execution：让 `xai-sub` materialize 为不含 token 的 managed ProviderEnv；Bridge registry 支持 async resolver；Sidecar 通过 generation + session 校验的 Management API 每请求取 bearer；实现 401 recovery 只重试一次、第二次 401 quarantine，403/429 不恢复；加入模型级 reasoning effort fail-safe 与 Bridge/route 测试；完成本期自验证、cross-review、提交。
- [x] Phase 3 — Settings/UI/model discovery：实现 provider-aware subscription card shell、Grok Device Code overlay、登录/验证/退出状态；ModelManagementPanel 接统一 discovery action 并复用原 UI；模型选择器可用性与 logout 收敛；补齐中英文 i18n、DOM/服务测试；完成全栈构建、针对性 smoke、cross-review、提交。
- [x] Completion audit — 重读 PRD，逐条核对 §13 测试、§14 A–E 验收证据；记录真实账号 credentialed smoke 是否可执行及真机验收项；回写 frontmatter 状态与最终验证结果。

### 待用户决策

无。产品岔路已在 PRD 中全部收敛。真实 Grok entitlement / public client compatibility 属于发布验证门槛，不是待产品决策。

### 进展日志

- 2026-07-11：完整读取 PRD、研究报告、`ARCHITECTURE.md`、`third_party_providers.md`、`proxy_config.md`、`session_architecture.md`、`pit_of_success.md`、`react_stability_rules.md`、`DESIGN.md`；核对现有 `ProviderRoute`、admin-config materialization、Bridge registry/handler、Management API generation、Settings subscription card 与 ModelManagementPanel/discovery 实现。确认三期契约如上，尚未改动产品代码。
- 2026-07-11：Phase 1/2 合并完成实现。新增 `xai-sub` preset、结构化 subscription auth policy、Rust app-global `GrokAuthManager`、独立 secret store、OIDC Device Code、refresh single-flight/rotation/quarantine、generation+session 校验的 Management API，以及不含 secret 的 `managed-oauth` ProviderEnv 引用；Bridge registry 改为 request-scoped async credential resolver，完成 401 一次恢复/原请求重试、第二次 401 quarantine、403/429 保留登录态和模型级 reasoning fail-safe。三轮 Phase 1 review 发现的 cancel/logout race、redirect、stale projection、grant lineage、空 token、`/models` 误标 valid 等问题均已在根因 owner 上修复；验证改为临时 builtin Sidecar → 既有 one-shot SDK → OpenAI Responses Bridge 真请求，只有 SDK terminal success 才由 Rust 按 expected grant lineage 投影 valid；普通 Bridge 2xx 不写状态，执行 bearer 与 verification bearer purpose 在 Rust owner 处硬隔离。
- 2026-07-11：Phase 3 完成实现。Settings 复用现有 Provider card 外壳并加入独立 `GrokSubscriptionProvider` 状态/Device Code overlay；支持自动打开浏览器、URL/code 复制、poll、validating、重新验证、logout、关闭与卸载清理。`ModelManagementPanel` 增加统一 `discoveryAction`，Grok 通过 Rust 受管 OAuth 获取 `/v1/models` 原始 JSON，再复用共享 OpenAI parser、preset precedence、搜索与添加逻辑；补齐中英文 i18n、DOM/服务测试和架构文档。
- 2026-07-11：最终自验证证据：TypeScript typecheck 通过；Grok/shared/session 单测与 Bridge 集成定向池通过；Grok card + ModelManagementPanel DOM 12 项通过；lint 通过（dependency-cruiser 仅有仓库既存 `chatSuggestions.ts` warning）；`cargo check --locked` 通过；Grok Rust auth 定向测试 19 项通过，覆盖 execution/verification purpose、lineage stale success/failure、rotation/cancel/logout、redirect、store 权限/损坏与 refresh 分类；cargo clippy 通过（仅仓库既存 warning）。三视角架构、代码质量与前端功能复审均 PASS，无阻断 finding。真实 Grok 账号 credentialed smoke 因当前环境没有可交互订阅凭据而未执行，保留为 §14 E 发布门槛；用户主路径最后一项“真实流式对话 + 本地工具调用”也随该 smoke 验证，不以 mock 证据冒充完成。
