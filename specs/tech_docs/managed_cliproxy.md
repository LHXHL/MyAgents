# 托管 CLIProxy 组件

`antigravity-sub` 是 builtin SDK 的订阅 Provider，直接使用原版 CLIProxy 的 Anthropic 接口，不经过 OpenAI Bridge。组件来源固定在 `src/shared/managed-cliproxy-source.json`；组件完整性、App/SDK 兼容与模型目录分开裁决。MyAgents 不维护模型白名单，不以模型请求验证登录。

## Owner 与数据流

```text
Renderer 设置操作 → Tauri commands → Rust CliProxyManager
                                      ├─ active / candidate CLIProxy child tree
                                      ├─ account-state / component-state
                                      └─ 临时 localhost OAuth callback relay

Session / Task / Goal / Channel 的 builtin Query，title / vision one-shot
  → prepareProviderBinding(non-secret endpointSource)
  → Rust management API（准确 Sidecar generation）
  → execution-only binding + native model metadata
  → Claude SDK → CLIProxy /v1/messages → Antigravity
```

Rust 是账号目录注册、正式/候选指针、组件选择、进程、准入和 lease 的 owner。CLIProxy 独占 OAuth state、token 文件与 refresh；MyAgents 不读取完整 token 文档、不调用强制 refresh、不自行交换 Google code。浏览器 URL 由原版生成，Rust 只校验并转交回调。

`config.json` 保存用户模型首选、启用列表、别名和 Rust 投影的账号可用性。Session snapshot 固化 Provider route；本次 Query 的端口、模型 key、instance generation 与原生模型元数据只在执行进程内存在。`providerHistory` 使用稳定 managed Provider identity，临时端口变化不构成 Provider 切换。

目录刷新追加新模型，尊重用户删除和显示名；已发现行的能力字段按原生元数据刷新，清除旧审批造成的裁剪。缺少元数据不隐藏模型或阻止调用。普通 Query/辅助请求的真实 SDK terminal 可记录逐模型观察，但不影响登录和准入；取消与迟到的旧 lease 结果不能污染新账号。设置挂载只读本地状态，显式刷新读取原版目录。

每个 Query/one-shot 经同一入口取得 active 的 lease，不存在候选模型验证准入。模型 key 不进入 Renderer、Session、任务或日志；管理 key 不出 Rust/CLIProxy。同步 resolver 不启动进程或返回秘密。

Provider 代理配置变化通过既有 `cmd_propagate_proxy` 通知 Rust；执行前也比较实例实际环境和磁盘策略，旧网络配置不能继续接新轮次。替换复用组件的 drain 与实例 generation 生命周期。认证停用先停止消费者，再等待实例创建锁，避免被正在等待长任务的普通更新挡住。应用安装更新复用已有可释放的 update gate；只有终止 App 才设置 CLIProxy 的永久 shutdown watch，安装失败返回应用后可重新准入。

SDK 使用既有模型别名配置；未配置别名默认解析到主模型。用户指定的子 Agent 模型和别名保留，不强制改写为主模型。原生元数据用于本次主模型的请求配置，不构成额外模型许可。

SDK 请求使用与主 Query 一致的 `claude_code` preset + 非空任务 append。`cliproxySdkSystemPrompt` 统一此模式，标题/vision 保留各自任务指令和工具隔离；其他 Provider 不变，不在 HTTP 层改写 SDK 请求。独立 SDK 排障脚本只提供开发证据，不形成模型审批或参与登录。

## 账号与进程生命周期

单账号有一个 active 和至多一个隔离 candidate。新候选先注册目录，再启动写入者。Rust 在等待健康检查前保留 child tree；失败停止未确认时不能丢掉句柄并复用同一 auth-dir。

连接依次完成：绑定 localhost callback → 请求原版 auth URL → 系统浏览器授权 → 转交一次 callback → 按准确 state 查询成功 → 原版账号摘要确认已保存且未 disabled → 保存 `authorizedAt` 并提交 active。无需模型请求。随后读取模型目录，失败保留已登录状态；实际模型权限、额度或调用错误沿正常对话链路返回。

设置卡片显示“已登录”和主要操作，登录弹窗只承载浏览器授权与账号切换进度，成功后关闭。关闭视图不取消 Rust 操作，显式取消才清理准确候选。组件版本/更新在次级菜单的独立弹窗，更新错误不占用账号操作。账号错误按 generation 投影。

原版确认账号后，Rust 通过既有 drain/实例切换原子提交 candidate → active 与旧目录清理意图，投影 `providerVerifyStatus.valid`，与验证通过的 API key 具有相同路由可用性。提交后的清理失败不回退旧账号。旧 active 的 verifiedAt 仅兼容为连接时间；旧候选的 awaiting-verification 不可靠地证明授权，启动后进入 stored，点击“继续连接”由原版账号摘要确认并完成登录，无需模型测试或重复 OAuth。

取消候选只清理候选；断开覆盖该 Provider 的所有已登记目录。两者先保存删除意图，后停止 writer 并删目录。`retry_cleanup` 仅重试已有目标，不能把 retired/candidate 清理扩展成断开 active。写意图失败时不返回成功，本进程保持对应准入关闭。普通停止不扫描或误杀其他 CLIProxy 安装。

正常升级/账号替换通过 Rust → 准确 Sidecar generation 的 `/api/cliproxy/control` 通知 operation/lease/instance。此路由为 common capability，因为 Global one-shot 和 Session Query 均可持有 lease。已准入 turn 结束后释放，空闲 Query 保存 resume 后退出；控制响应收敛丢失的 release，不设独立心跳或过期强杀，不重放已执行工具。

断开/明确停用经 SessionEngine 停止持久 Query，辅助请求只取消自己的 AbortController；通信失败由 Rust 停止自己持有的代理。准确 Sidecar generation 死亡同时回收其全部 operation/lease。

## 原版接口合同

接口仅在 `cliproxy/client.rs` 有限封装，禁止添加任意管理 API 透传。

| 用途 | 原版接口 |
| --- | --- |
| 本地健康 | GET `/healthz` |
| 创建授权 | GET `/v0/management/antigravity-auth-url`，省略 `is_webui` |
| 运输回调 | POST `/v0/management/oauth-callback` |
| 查询/取消 | GET `/v0/management/get-auth-status?state=...`；DELETE `/v0/management/oauth-session?state=...` |
| 有限账号视图 | GET `/v0/management/auth-files` |
| 模型目录与元数据 | GET `/v0/management/auth-files/models?name=...`、`/v1/models`、`/v0/management/model-definitions/antigravity` |

原版管理 key 经 bcrypt 处理，输入不能超过 72 字节；目前生成 64 字节 base64url，随机强度为 366 bit。模型 key 独立生成。callback 固定 localhost:51121，先占用成功再打开浏览器；不使用原版 CLI/webui callback listener。URL 响应丢失不得重试创建，callback 响应丢失只按已知 state 查询，不重放 code。

目录探测不带 Anthropic-Version、claude-cli UA 或 client_version，读取普通 OpenAI 形状 data[].id。账号注册与路由模型合并去重，原版定义只补充元数据，不取审批交集。两个目录均读取失败时保留上次列表并标记过期；执行准入不依赖目录缓存，也不发路由预检。权限/额度失败不触发 MyAgents 刷新 token 或换模型。

MyAgents 不传 `-local-model`，保留原版启动及每三小时更新线上 models.json 的能力。v7.2.158 的 Antigravity 注册来自 CLIProxy 上游维护目录，并非每次向 Google 查询订阅权益；目录不保证每次调用成功。统一日志只记录阶段、目录计数和有限错误码，不记录邮箱、回调 URL、响应内容或 key。

## 组件与兼容记录

实际执行位置统一为 `<data>/runtimes/cliproxy/<version>/<platform>/<artifact-digest>/`。随包程序也先校验复制到该目录，App 升级不会移除 previous。配置/key 只在 `<data>/providers/cliproxy/antigravity-sub/run/<instance-generation>/`；凭据在独立 accounts/<opaque-id>/auth。

签名信任根复用 `resource_signature_core.rs` 与 Tauri updater pubkey。controls 的单调 revision、平台/App/SDK 兼容、hash 与 credentialCompatibleVersions 保留。旧 manifest 的 compatibility.models 兼容读取但不参与准入，新打包记录不写模型审批。网络不可达保留本机可信组件。

App 启动后和每 15 分钟检查固定 MyAgents manifest；更高兼容版本自动准备并在 drain 后切换。同版本仅允许同一产物更高兼容 revision 更新。已失败 artifact/App/SDK/compatibility 组合不自动重复安装或启动；传输失败可重新检查，用户显式操作可重试。正常运行后的崩溃恢复有独立的次数上限，不重放任务。

清单或签名下载的 HTTP 404 返回 `update_unpublished`；网络失败返回 `update_network`。日志仅保留资源类别、失败类别和 HTTP 状态，更新不可达不使本机可信组件或账号授权失效。

新版的 credentialCompatibleVersions 列表证明它与所列旧版的双向凭据兼容；旧清单不需要预知未来版本。不兼容或已撤销的旧版不可作为回退。GC 仅处理组件 owner 目录，并保留 current/previous/pending。

## 构建、验收与发布

源代码仓库不提交二进制缓存、签名私钥或真实账号数据。先取得 source lock 指定的上游原包，再生成平台产物与组件兼容记录：

```sh
node scripts/package-cliproxy-component.mjs artifact --platform darwin-arm64 --source /path/to/upstream.tar.gz --out /path/to/records --development
node scripts/package-cliproxy-component.mjs manifest --approval /path/to/approval.json --records /path/to/records --out /path/to/distribution
node scripts/package-cliproxy-component.mjs stage --from /path/to/distribution --platform darwin-arm64
```

`manifest` 使用既有 TAURI_SIGNING_PRIVATE_KEY 环境；生产 macOS artifact 使用 APPLE_SIGNING_IDENTITY，去掉 --development。Windows 核对 PE x64。保留最终 ZIP、文件和原始 source 摘要，原版逻辑不修改。公开 enabled 要求完整生产平台产物和签名，不要求模型批准。

构建脚本从 MYAGENTS_CLIPROXY_DISTRIBUTION_DIR 或 `src-tauri/resources/cliproxy-cache/distribution` 取得已签名资源。macOS/Windows 的 Tauri 平台配置内置组件；Rust build.rs 再验共享签名、source pin、目标平台、App/SDK、体积及 hash，支持目标缺资源时构建失败。现有 Linux App 构建不要求此组件，该 Provider 在未批准平台不可用。`build_dev.sh --build-only` 可构建而不停止正在运行的应用。

`node scripts/publish-cliproxy-component.mjs /path/to/distribution` 使用 minisign（复用同一公钥）输出待发布计划。只有明确获准发布后才加 --publish，提供既有 R2/Cloudflare release 环境与 rclone；脚本先传不可变产物并验线上 bytes，再更新 manifest/signature、清 CDN 缓存并验签。公开启用和发布不是开发构建的默认动作。

确定性测试不依赖用户目录、密钥或网络。`verify-cliproxy-contract.mjs` 与 Rust ignored native_process_management_contract 显式检查原版进程和接口，不完成 Google 登录。Rust ignored native_account_sdk_tool_and_history_contract 才打开系统浏览器，使用临时账号目录并调用真实 SDK 工具与历史测试；MYAGENTS_CLIPROXY_SMOKE_EXECUTABLE 必须指向已核验源码摘要的原版程序。

`npm run verify:cliproxy:sdk-local` 显式运行已安装 SDK，以本机模拟服务和拒绝外连的代理检查 loopback 绕过、实际子 Agent 模型选择，不访问 Google，不形成能力审批。

真实平台安装、OS 权限、更新/回退和 Google 账号验收分别记录；编译与无凭据 smoke 不代替真机验收。登录产品链路不执行模型工具/thinking/模态/上下文测试。
