# 托管 CLIProxy 组件

`antigravity-sub` 是 builtin SDK 的订阅 Provider。MyAgents 直接使用原版 CLIProxy 的 Anthropic 接口；它不是外部 Agent Runtime，也不经过 OpenAI Bridge。组件来源固定在 `src/shared/managed-cliproxy-source.json`，模型批准记录另行签名，不从版本号或目录存在推导兼容性。

## Owner 与数据流

```text
Renderer 设置操作 → Tauri commands → Rust CliProxyManager
                                      ├─ active / candidate CLIProxy child tree
                                      ├─ account-state / component-state
                                      └─ 临时 localhost OAuth callback relay

Session / Task / Goal / Channel 的 builtin Query，title / vision / verify one-shot
  → prepareProviderBinding(non-secret endpointSource)
  → Rust management API（准确 Sidecar generation）
  → execution-only binding + modelPolicy
  → Claude SDK → CLIProxy /v1/messages → Antigravity
```

Rust 是账号目录注册、正式/候选指针、组件选择、进程、准入和 lease 的 owner。CLIProxy 独占 OAuth state、token 文件与 refresh；MyAgents 不读取完整 token 文档、不调用强制 refresh、不自行交换 Google code。浏览器 URL 由原版生成，Rust 只校验并转交回调。

`config.json` 保留用户模型首选、启用列表、别名和可用性投影。Session snapshot 固化 Provider route；本次 Query 的端口、模型 key、instance generation 和批准能力只在执行进程内存在。`providerHistory` 按稳定的 managed Provider identity 分类，临时端口变化不构成 Provider 切换。

目录刷新只追加未移除的新配置模型，不覆盖已编辑的行或删除暂时不在路由中的配置；运行能力仍取 Rust 的当前目录交集。逐模型验证结果保存在相应账号记录中，按组件兼容 identity 限定适用范围。显式检查与普通 Query/辅助请求的真实 SDK terminal 更新它；取消不投影成模型失败，迟到的旧 lease / 账号结果不写新账号。设置卡片挂载只读本地状态，点击刷新才启动原生目录检查。

每个 Query/one-shot 经同一准备入口取得 lease；普通执行只取 active，验证只取 Rust 预先登记的准确账号 generation / verification operation。模型 key 不进入 Renderer、Session、任务或日志；管理 key 不出 Rust/CLIProxy。同步 resolver 不启动进程，也不返回秘密。

Provider 代理配置变化通过既有 `cmd_propagate_proxy` 通知 Rust；执行前也比较实例实际环境和磁盘策略，旧网络配置不能继续接新轮次。替换复用组件的 drain 与实例 generation 生命周期。认证停用先停止消费者，再等待实例创建锁，避免被正在等待长任务的普通更新挡住。应用安装更新复用已有可释放的 update gate；只有终止 App 才设置 CLIProxy 的永久 shutdown watch，安装失败返回应用后可重新准入。

SDK 进程的所有模型别名绑定到本次准入模型。主 Query 的 PreToolUse 在已有权限裁决通过后，把 Agent/Task 的 model override 投影到该别名，覆盖 SDK 直接加载的 project/plugin agent frontmatter；它不改变工具权限或 agent prompt。切换主模型需重建 Query 并重新准入。

## 账号与进程生命周期

单账号有一个 active 和至多一个隔离 candidate。新候选先注册目录，再启动写入者。Rust 在等待健康检查前保留 child tree；失败停止未确认时不能丢掉句柄并复用同一 auth-dir。

连接依次完成：绑定双栈 localhost callback → 请求原版 auth URL → 系统浏览器授权 → 转交一次 callback → 按准确 state 查询 → 读取白名单账号摘要 → 原版模型交集 → SDK 工具闭环验证。回调 200、文件存在或 SDK idle 均不能当成验证成功。

候选验证成功后，Rust 阻止新 turn、等待既有 lease、停止旧 active 与 candidate，使用候选原目录启动正式实例。最后原子保存 candidate → active 和旧目录清理意图，再开放正式 binding。提交后不得因清理失败回退到旧账号。

取消候选只清理候选；断开覆盖该 Provider 的所有已登记目录。两者先保存删除意图，后停止 writer 并删目录。`retry_cleanup` 仅重试已有目标，不能把 retired/candidate 清理扩展成断开 active。写意图失败时不返回成功，本进程保持对应准入关闭。普通停止不扫描或误杀其他 CLIProxy 安装。

正常升级/账号替换的 drain 经现有 Rust → Sidecar 控制通道通知准确 operation/lease/instance。已准入 turn 和子任务完成后释放；空闲 Query 保存 resume 并退出。控制响应可确认该 Sidecar 已没有 SDK owner，收敛丢失的 release；仅正在进行的 drain 重查，不设独立心跳或时间过期强杀。尚未投递到 SDK 的新轮次沿原队列重建 Query，不重放已执行工具。

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
| 模型交集 | GET `/v0/management/auth-files/models?name=...`、`/v0/management/model-definitions/antigravity`、`/v1/models` |

原版管理 key 经 bcrypt 处理，输入不能超过 72 字节；目前生成 64 字节 base64url，随机强度为 366 bit。模型 key 独立生成。callback 固定 localhost:51121，先占用成功再打开浏览器；不使用原版 CLI/webui callback listener。URL 响应丢失不得重试创建，callback 响应丢失只按已知 state 查询，不重放 code。

目录探测不带 Anthropic-Version、claude-cli UA 或 client_version，固定读取原始 `data[].id`。`-local-model` 与禁用模型名称伪装固定目录解释；模型准入为账号注册集合、当前路由、原版定义、签名兼容记录的交集。缺失能力保持未知，刷新失败保留旧列表并标为过期，每次 turn 检查当前路由。权限/额度失败不触发 MyAgents 刷新 token 或换模型。

## 组件与批准记录

实际执行位置统一为 `<data>/runtimes/cliproxy/<version>/<platform>/<artifact-digest>/`。随包程序也先校验复制到该目录，App 升级不会移除 previous。配置/key 只在 `<data>/providers/cliproxy/antigravity-sub/run/<instance-generation>/`；凭据在独立 accounts/<opaque-id>/auth。

签名信任根复用 `resource_signature.rs` 与 Tauri updater pubkey。签名 controls 的单调 revision 与组件的 App/SDK/模型兼容分别裁决；线上新组件不兼容仍执行有效停用/撤销。没有短 TTL 或续签要求，网络不可达保留本机可信记录。

App 启动后和每 15 分钟检查固定 MyAgents manifest；更高兼容版本自动准备并在 drain 后切换。同版本仅允许同一产物更高兼容 revision 更新。已失败 artifact/App/SDK/compatibility 组合不自动重复安装或启动；传输失败可重新检查，用户显式操作可重试。正常运行后的崩溃恢复有独立的次数上限，不重放任务。

新版的 credentialCompatibleVersions 列表证明它与所列旧版的双向凭据兼容；旧清单不需要预知未来版本。不兼容或已撤销的旧版不可作为回退。GC 仅处理组件 owner 目录，并保留 current/previous/pending。

## 构建、验收与发布

源代码仓库不提交二进制缓存、签名私钥或真实账号数据。先取得 source lock 指定的上游原包，再生成平台产物与测试批准记录：

```sh
node scripts/package-cliproxy-component.mjs artifact --platform darwin-arm64 --source /path/to/upstream.tar.gz --out /path/to/records --development
node scripts/package-cliproxy-component.mjs manifest --approval /path/to/approval.json --records /path/to/records --out /path/to/distribution
node scripts/package-cliproxy-component.mjs stage --from /path/to/distribution --platform darwin-arm64
```

`manifest` 使用既有 TAURI_SIGNING_PRIVATE_KEY 环境；生产 macOS artifact 使用 APPLE_SIGNING_IDENTITY，去掉 --development。Windows 必须核对 PE x64。最终 ZIP、文件摘要、原始 source 摘要分别保存；外部原版逻辑不修改。公开 enabled 必须已有真实测试模型、完整平台产物及生产签名，不得把内部空模型记录当成生产批准。

构建脚本从 MYAGENTS_CLIPROXY_DISTRIBUTION_DIR 或 `src-tauri/resources/cliproxy-cache/distribution` 取得已签名资源。macOS/Windows 的 Tauri 平台配置内置组件；Rust build.rs 再验共享签名、source pin、目标平台、App/SDK、体积及 hash，支持目标缺资源时构建失败。现有 Linux App 构建不要求此组件，该 Provider 在未批准平台不可用。`build_dev.sh --build-only` 可构建而不停止正在运行的应用。

`node scripts/publish-cliproxy-component.mjs /path/to/distribution` 使用 minisign（复用同一公钥）输出待发布计划。只有明确获准发布后才加 --publish，提供既有 R2/Cloudflare release 环境与 rclone；脚本先传不可变产物并验线上 bytes，再更新 manifest/signature、清 CDN 缓存并验签。公开启用和发布不是开发构建的默认动作。

确定性测试不依赖用户目录、密钥或网络。`verify-cliproxy-contract.mjs` 与 Rust ignored native_process_management_contract 显式检查原版进程和接口，不完成 Google 登录。Rust ignored native_account_sdk_tool_and_history_contract 才打开系统浏览器，使用临时账号目录并调用真实 SDK 工具与历史测试；MYAGENTS_CLIPROXY_SMOKE_EXECUTABLE 必须指向已核验源码摘要的原版程序。

`npm run verify:cliproxy:sdk-local` 显式运行安装的 SDK/native CLI，以本地模拟服务和拒绝外连的代理检查 loopback 绕过、真实 Agent hook 与模型别名约束；不访问 Google，也不形成模型能力批准。

真实账号工具/thinking/模态/上下文/刷新、三平台安装与 OS 权限、更新/回退和线上发布证据属于交付门槛。构建或无凭据 smoke 通过不能替代这些记录；尚未验证的模型保持不批准。
