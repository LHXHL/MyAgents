---
type: prd
status: implemented-audited
created: 2026-07-02
updated: 2026-07-02
scope: "网络代理增加“适用范围”：默认全部供应商，保持现状；用户可切到自定义白名单，只让选中供应商名下的 provider-owned network work 使用 MyAgents 网络代理。范围配置集中收在设置页网络代理板块。Managed Codex（codex-sub）的安装/下载、登录、状态、模型查询、聊天都属于 codex-sub；用户自配 External Runtime 不接入白名单；无 provider owner 的 updater/LiteLLM/普通 CDN 请求仍按总开关走。"
issue: 产品讨论收敛（网络代理按 provider-owned network work 的供应商白名单生效）
review: "implemented-audited（实现已覆盖 builtin SDK env、OpenAI Bridge upstream fetch、Rust provider-aware client、Managed Codex Rust 管理命令、Managed Codex Node runtime 五条链路；cross-review 后补齐订阅 SDK supported models provider identity、Rust camelCase providerIds 解析、provider 删除/Settings stale scope 清理、HTTPS protocol 兼容与 loopback NO_PROXY 边界；保留 provider owner 作为唯一 scope 输入，不按 URL 反推。）"
---

# 网络代理适用范围 PRD

> **执行须知（给空 session 的你）**：本 PRD 是本需求的完整交接物。每次会话只自动加载 `CLAUDE.md`；落地前还必须主动 Read：
> - `specs/ARCHITECTURE.md`
> - `specs/tech_docs/proxy_config.md`
> - `specs/tech_docs/third_party_providers.md`
> - `specs/tech_docs/multi_agent_runtime.md`
> - `specs/DESIGN.md`
>
> 本文引用代码用符号名和文件路径，不依赖行号。行号随并发改动漂移时，用符号名 `rg`。

## 背景与产品定位

MyAgents 现在有一个统一网络代理能力：用户在「设置 - 通用 - 网络代理」里开启后，应用会把代理自动注入到需要访问外部网络的路径里。这个能力对很多用户是“让我能连上模型供应商”的基础设施。

但用户不是总想“一开代理，所有模型供应商都走代理”。真实场景更细：有些供应商本地直连更快，有些供应商必须走 Clash/V2Ray；用户希望能在网络代理板块里做一个很轻的白名单：

- 默认是「全部」，完全等价于当前现状。
- 切到「自定义」后，在供应商列表里多选。
- 被选中的供应商默认拥有 MyAgents 网络代理能力。
- 和这个能力有关的设置都收在网络代理板块，不散落到每个 provider 或每个 Tab。

用户特别强调：这不是要做复杂的全局网络规则引擎，也不是要把用户自配 External Runtime 的既有代理策略混进来。本期只针对“由某个供应商拥有的网络工作”做适用范围控制，一次做一块。

这里的边界按 **provider owner** 定义，而不是按“聊天 / 登录 / 下载 / 验证”这种请求类型定义。只要一段网络工作是为某个供应商服务，它就使用该供应商的 scope 判定；没有供应商 owner 的网络工作继续使用当前全局代理语义。

## 本期范围

### 做什么

1. 在设置页「网络代理」卡片中新增「适用范围」。
2. 默认值为「全部供应商」，等价于当前行为。
3. 支持切换到「自定义」，打开一个供应商多选弹窗。
4. 自定义列表展示全部可见供应商：
   - Anthropic 订阅（`anthropic-sub`）也作为可选项。
   - API provider、自定义 provider 作为可选项。
   - Managed Codex 订阅（`codex-sub`）也作为供应商可选项。
5. 自定义模式下必须至少选择一个供应商才能保存；一个都不选时保存按钮不可点击，只能取消。
6. 被选中的供应商使用 MyAgents 网络代理；未选中的供应商不注入 MyAgents 网络代理。
7. 所有 provider-owned network work 必须使用一致代理策略：
   - builtin 聊天、Anthropic 订阅验证、API provider 验证、provider 网络探针、模型发现。
   - OpenAI-protocol provider 的 one-shot bridge probe、SDK verify、正式聊天 bridge upstream fetch。
   - Managed Codex（`codex-sub`）的 runtime manifest/artifact 下载、登录、登出、状态检查、模型查询、聊天 app-server。
8. 设置变更后，已打开的 Tab 要自动感知；下一次 query 必须进入新的代理状态。

### 明确不做

1. 本期不把 External Runtime 放入白名单选项。
   - 用户自己配置的 Codex CLI / Claude Code CLI / Gemini CLI 继续沿用现有 Agent `runtimeConfig.envPolicy.proxy`。
   - 本期 UI 不新增 “External Runtime” 选项。
2. 本期不做按域名、URL、模型 ID、地域的规则系统。
3. 本期不改变 updater、LiteLLM 缓存、WeCom/二维码、普通 CDN 下载等无 provider owner 的请求；只要总开关开着，它们继续按当前全局代理行为走。
   - 注意：Managed Codex runtime manifest/artifact 虽然也是下载，但它的 owner 是 `codex-sub`，本期纳入 scope。
4. 本期不做每个 provider 独立代理地址；所有被选中的供应商共用网络代理板块里的同一个协议/host/port。
5. 本期不把“未选中”宣传为强制直连。准确语义是：未选中时 MyAgents 不主动注入自己的代理，系统/TUN/终端环境仍可能自然接管网络。

## 核心交互

### 网络代理卡片

现有入口在 `SettingsPage.tsx` 的 Network Proxy Settings。保持现有层级和设计系统，在协议、服务器、端口附近增加一行：

- 标签：`适用范围`
- 摘要：
  - `全部供应商`
  - 或 `DeepSeek、OpenRouter 等 3 个`
- 操作：点击整行或右侧按钮打开多选弹窗。

当网络代理总开关关闭时，这一行可以仍展示但 disabled，说明文案使用“开启代理后生效”。不要让用户以为关闭总开关时白名单还能单独生效。

### 多选弹窗

复用现有供应商管理弹窗的视觉语言（`ProviderEnableOrderDialog` 的行布局、badge、开关/checkbox 风格），但这是选择范围，不允许拖拽排序。

弹窗结构：

- 标题：`选择代理适用供应商`
- 副标题：`选中的供应商会使用 MyAgents 网络代理；未选中的供应商不注入该代理。`
- 顶部摘要：`已选择 N / M`
- 列表：全部可见供应商，顺序跟当前 provider 列表一致。
- 每行展示：
  - provider name
  - `订阅` / `API` / `Managed` 等 badge
  - cloudProvider 或简短描述
  - 可选状态（已禁用、未配置 Key、未就绪）可以弱化展示，但仍允许选择。
- 底部按钮：
  - `取消`
  - `保存`

自定义模式下如果 `N=0`，保存按钮 disabled。用户只能取消；取消后维持原配置。如果用户想恢复“全部”，应在适用范围行切回“全部供应商”。

### 状态切换

推荐用 segmented control 或 CustomSelect：

- `全部供应商`
- `自定义`

切到 `全部供应商` 后保存 `mode:'all'`，清空或忽略 providerIds。

切到 `自定义` 时：

- 如果之前有自定义列表，打开弹窗并保留旧选择。
- 如果没有旧选择，建议默认勾选当前全部可见供应商，降低“切过去却一片空”的风险；用户可以取消不保存，也可以删减后保存。
- 保存时至少一个 providerId。

## 产品语义

### Provider-owned network work

本期的核心语义是：

```
一个网络动作如果能明确归属到某个 providerId，
就按该 providerId 判定是否注入 MyAgents 网络代理。

一个网络动作如果没有 provider owner，
就继续按当前全局 proxySettings.enabled 行为走。
```

例子：

| 网络动作 | owner | scope 判定 |
|---|---|---|
| Anthropic 订阅聊天 / 订阅验证 / SDK supported models | `anthropic-sub` | `shouldUseMyAgentsProxyForProvider('anthropic-sub')` |
| DeepSeek / OpenRouter 等 API provider 聊天、验证、模型发现 | 对应 provider id | `shouldUseMyAgentsProxyForProvider(provider.id)` |
| OpenAI Bridge upstream fetch | bridge registry 里的 provider id | `shouldUseMyAgentsProxyForProvider(provider.id)` |
| Managed Codex runtime 下载、登录、登出、状态、模型查询、聊天 | `codex-sub` | `shouldUseMyAgentsProxyForProvider('codex-sub')` |
| 用户自己配置的 Codex / Claude Code / Gemini external runtime | 无本期 provider owner；走 Agent runtime config | 不接入本白名单，继续使用 `runtimeConfig.envPolicy.proxy` |
| updater、LiteLLM 缓存、WeCom QR、普通 CDN 请求 | 无 provider owner | 继续按全局 `proxySettings.enabled` |

这条规则刻意不按 URL、域名、baseUrl、runtime type 或请求类型判断。`codex-sub` 是 `codex/managed-provider`，不是所有 `runtime:'codex'`。

### 有效代理判定

定义一个统一语义：

```
shouldUseMyAgentsProxyForProvider(providerId):
  if proxySettings.enabled !== true:
    return false
  if proxySettings.scope missing or scope.mode === 'all':
    return true
  if scope.mode === 'custom':
    return scope.providerIds includes providerId
```

注意：

- `scope` 缺省必须等价于 `all`，保证老配置无迁移风险。
- `providerId` 是规则输入，不是 baseUrl。用户是在供应商心智上做选择，不是在 URL 心智上做规则。
- `codex-sub` 是 Managed Codex 供应商选项，影响 `runtimeSource:'managed-provider'` 下所有 codex-sub-owned 网络工作；不影响用户手动配置的 Codex external runtime。
- 任何 provider-owned 调用如果拿不到稳定 `providerId`，实现应先修 contract，把 `providerId` 传到 owner 边界；不要用 baseUrl 反推，也不要用 `undefined` / `null` 表达“订阅 provider”。

### 未选中供应商的网络语义

未选中不等于强制直连。准确语义：

- 不注入 MyAgents 配置的 `HTTP_PROXY` / `HTTPS_PROXY`。
- 允许系统代理、TUN/VPN、终端环境按各自机制自然生效。

UI 文案不要写“直连”，用“不会使用 MyAgents 网络代理”。

## 配置模型

在 `ProxySettings` 上扩展，而不是新增分散配置：

```ts
export type ProxyScopeMode = 'all' | 'custom';

export interface ProxyScopeSettings {
  mode: ProxyScopeMode;
  providerIds?: string[];
}

export interface ProxySettings {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  scope?: ProxyScopeSettings;
}
```

落盘例：

```json
{
  "proxySettings": {
    "enabled": true,
    "protocol": "http",
    "host": "127.0.0.1",
    "port": 7890,
    "scope": {
      "mode": "custom",
      "providerIds": ["anthropic-sub", "deepseek", "codex-sub"]
    }
  }
}
```

规范化要求：

- `scope` 缺省为 `{ mode:'all' }`。
- `mode:'custom'` 且 `providerIds` 为空，前端不允许保存；后端/读取侧必须 fallback 到 `{ mode:'all' }` 并记录 warn。理由：兼容性优先，避免用户意外进入“代理开着但没有任何供应商生效”的反直觉状态。
- providerIds 要 dedupe。
- UI 展示时过滤不存在的 providerId；保存时用当前可见 provider 列表清理 stale id。若清理后变空，按上一条 fallback 到 `all`，不要落一个空 custom。

## 技术地基

### 现有代理链路

当前代码事实：

- Rust 读取 `~/.myagents/config.json` 的网络代理配置：`src-tauri/src/proxy_config.rs::read_proxy_settings`。
- Rust 子进程代理注入：`src-tauri/src/proxy_config.rs::apply_to_subprocess`。
- Rust 外部 HTTP client 代理：`src-tauri/src/proxy_config.rs::build_client_with_proxy`。
- 设置页保存后传播到所有活跃 Sidecar：`src-tauri/src/sidecar/proxy.rs::cmd_propagate_proxy`。
- Sidecar 收到 `/api/proxy/set` 后当前只调用 builtin facade 的 `src/server/agent-session.ts::setProxyConfig` 热更新进程 env；external runtime session 当前不在这条重启判定里。
- `setProxyConfig` 当前通过比较 `HTTP_PROXY` URL 判断是否重启 session；白名单改变但 URL 不变时会被误判为无需重启。
- Builtin provider env 在 `src/server/agent-session.ts::buildClaudeSessionEnv` 里构造。
- OpenAI 协议 provider 走本地 OpenAI Bridge，SDK 连 loopback；真实上游请求在 `src/server/openai-bridge/handler.ts::getProxyForUrl` 和 `createBridgeHandler` 的 upstream fetch。
- Provider 验证探针在 `src/server/provider-probe.ts`，OpenAI 路径通过同一个 one-shot bridge，Anthropic 诊断路径使用 `getProxyForUrl`；设置页 verify 前还有 Rust `src-tauri/src/commands.rs::cmd_probe_provider_network` 前置网络探针。
- API provider 模型发现走 Rust `src-tauri/src/commands.rs::cmd_fetch_provider_models`，当前只按 URL 用全局 `build_client_with_proxy`。
- Managed Codex 有两条链路：
  - Rust 管理链路：`src-tauri/src/managed_codex.rs` 的 manifest/artifact 下载、登录、登出、状态检查，以及 `managed_codex_command` 生成的短生命周期命令。PRD 前旧状态：短生命周期命令使用全局 `apply_to_subprocess`，manifest/artifact 下载的 `external_http_client` 未接入 MyAgents proxy helper；本期必须统一改为 `codex-sub` provider-aware helper。
  - Node runtime 链路：`src/server/runtimes/codex-command-context.ts::resolveCodexCommandContext` / `buildManagedCodexEnv` 和 `src/server/runtimes/codex.ts::CodexRuntime.startSession` / `queryModelsViaAppServer`，`runtimeSource:'managed-provider'` 时使用 managed binary + isolated `CODEX_HOME`。
- External runtime 子进程代理策略在 `src/server/runtimes/env-utils.ts::augmentedProcessEnv`，由 `RuntimeEnvPolicy.proxy` 控制，本期不改其产品入口。

### 推荐实现形态

新增一个共享判定层，不要让各调用点各自解析 `proxySettings.scope`。核心原则：全局 helper 保持全局语义；provider-aware helper 必须显式接收 providerId，不用 `undefined` / `None` 表示“全局”或“订阅”。

- TypeScript 侧：例如 `src/shared/proxyScope.ts`
  - `normalizeProxyScope(raw, visibleProviderIds?)`
  - `shouldUseMyAgentsProxyForProvider(proxySettings, providerId)`
  - `effectiveProxyScopeKey(proxySettings, providerId)`：供重启判定使用。
  - `normalizeProviderOwnedProxySettings(proxySettings, providerId)` 或等价纯函数：返回“该 provider 是否使用 MyAgents proxy + proxy URL key”。
  - Sidecar 侧不要把 `process.env.HTTP_PROXY` 当成 provider-owned 请求的权威来源。`process.env` 是进程级状态，可能已经由 Rust `apply_to_subprocess` 注入 MyAgents proxy；provider 未命中时，Bridge / SDK subprocess / managed runtime 必须显式剥离 MyAgents proxy vars，并按现有 inherited snapshot 语义恢复“未注入 MyAgents 代理”的网络行为。
- Rust 侧：在 `proxy_config.rs` 扩展 `ProxySettings` 和对应 helper。
  - 保持 `read_proxy_settings()` / `build_client_with_proxy()` / `apply_to_subprocess()` 的全局语义，用于 updater/LiteLLM/普通 CDN 等无 provider owner 请求。
  - 新增 provider-aware 入口，例如：
    - `read_proxy_settings_for_provider(provider_id: &str)`
    - `build_client_with_proxy_for_provider(builder, provider_id: &str)`
    - `apply_to_subprocess_for_provider(cmd, provider_id: &str)`
  - provider-aware 入口内部复用同一 normalize/判定逻辑；不在调用点手写 `scope.mode` 分支。

#### Proxy propagation path

现有 `cmd_propagate_proxy` 继续复用，但 payload 必须包含完整 scope：

- `src-tauri/src/sidecar/proxy.rs::build_proxy_payload` 不能只发 enabled/protocol/host/port，必须把 normalized `scope` 一并发给 Sidecar。
- `src/server/index.ts` 的 `/api/proxy/set` 不应继续只调用 builtin `setProxyConfig`。它需要通过 `src/server/session-engine/` facade 分发给当前会话 runtime：
  - builtin adapter 调 builtin proxy handler。
  - external adapter 对 `runtime:'codex' && runtimeSource:'managed-provider'` 计算 `codex-sub` 的 effective proxy key，必要时 stop/defer restart；system-cli external runtime 不受本白名单影响。
- 不要在 route handler 里手写 `shouldUseExternalRuntime()` 或 runtime 分支；遵守 `multi_agent_runtime.md` 的 SessionEngine 边界。

#### Builtin SDK path

`buildClaudeSessionEnv` 需要按当前 providerId 判断是否注入/清除 MyAgents 代理。

关键难点：`ProviderEnv` 对 API provider 有 `providerId`，但 Anthropic 订阅通常是 `providerEnv === undefined`。实现者不能只从 `ProviderEnv` 推 providerId，否则无法判断 `anthropic-sub` 白名单。

建议补齐当前会话的 provider identity：

- 对 builtin API provider：providerId 来自 `ProviderEnv.providerId`。
- 对 Anthropic 订阅：providerId 使用 `SUBSCRIPTION_PROVIDER_ID`（当前常量为 `anthropic-sub`）。
- 对发送路径已有 `providerRoute` 的会话：优先使用 route 的 providerId。
- 对 one-shot 调用：调用方必须显式传 providerId。订阅相关 one-shot 用 `anthropic-sub`，API provider verify/title/vision/model discovery 用对应 provider id。不要让 `buildClaudeSessionEnv(undefined)` 同时表示“沿用当前 provider”和“Anthropic 订阅”。

最终 `buildClaudeSessionEnv` 在构造 env 时要能知道“当前实际 providerId”，再决定：

- 选中：保留/应用 MyAgents proxy env。
- 未选中：移除 MyAgents 注入的 proxy env，恢复到“未注入 MyAgents 代理”的状态。

实现建议：

- 在 builtin config owner 中保存 current provider identity（例如 `currentProviderId` 或 `currentProviderRoute`），不要只保存 `currentProviderEnv`。
- `setSessionProviderEnv` / `enqueueUserMessage` 的 `'subscription'` sentinel 继续保留，但它必须映射到 `anthropic-sub` identity；`undefined` 仍只表示“保持当前 provider”，不能被当成订阅。
- `buildClaudeSessionEnv` 可增加 options 参数承载 provider identity，例如 `{ providerId, bridgeToken }`。具体命名按代码风格定，但语义必须显式。

不要用 baseUrl 反推 provider，custom provider 和聚合平台会让这个逻辑脆弱。

#### OpenAI Bridge path

当前 `getProxyForUrl(url)` 只读 Sidecar `process.env`，这是全局的。白名单后必须变成 per-provider 判定：

- Bridge registry 的 `UpstreamConfig` 需要带上 `providerId` 或等价 identity。
- `src/server/openai-bridge/bridge-registry.ts::UpstreamBridgeConfig` 需要带 `providerId`。
- `startOneShotBridge` 和 active session bridge resolver 都要把 providerId 放进 upstream config。
- Bridge handler upstream fetch 时，调用 per-provider proxy resolver，而不是只看 `process.env`。

否则会出现 SDK loopback 不走代理，但 bridge upstream 仍按全局 env 走代理的问题。

要求：

- OpenAI Bridge SDK subprocess 继续剥离 proxy env，确保 SDK → Sidecar loopback 不走代理。
- Bridge upstream fetch 根据 `upstream.providerId` 调 provider-aware resolver，再决定是否创建 `ProxyAgent` dispatcher。
- `getProxyForUrl(url)` 可以保留为无 provider owner 的低层诊断 helper，但 provider-owned bridge 不应直接调用它。

#### Managed Codex provider path

`codex-sub` 在产品上是供应商选项，但技术上是 runtime-backed managed provider。

本期决策：

- UI 列表展示 `codex-sub`。
- 选择 `codex-sub` 影响 `codex-sub` owner 下的所有网络工作，而不是只影响聊天：
  - runtime manifest/signature/artifact 下载。
  - managed Codex 登录、登出、状态检查。
  - managed-provider 模型查询。
  - managed-provider 聊天 app-server。
- 用户自己配置的 external Codex CLI 不受它影响。

实现分两条链路：

1. Rust 管理链路（`src-tauri/src/managed_codex.rs`）
   - manifest/signature/artifact fetch 使用 `build_client_with_proxy_for_provider(..., "codex-sub")`。
   - `managed_codex_command` 使用 `apply_to_subprocess_for_provider(..., "codex-sub")`。
   - 未命中时不注入 MyAgents proxy；仍保留 localhost `NO_PROXY` 防护，并允许系统/TUN/终端环境自然接管。

2. Node runtime 链路（`src/server/runtimes/codex-command-context.ts` / `src/server/runtimes/codex.ts`）
   - `resolveCodexCommandContext({ source:'managed-provider' })` / `buildManagedCodexEnv` 必须按 `codex-sub` 判定 MyAgents proxy。
   - `CodexRuntime.queryModelsViaAppServer('managed-provider')` 和 `CodexRuntime.startSession(...runtimeSource:'managed-provider')` 走同一 env 逻辑。
   - `source:'system-cli'` 继续走现有 `augmentedProcessEnv(envPolicy)`，不受 `codex-sub` scope 影响。

注意不要把这个逻辑推广到所有 `runtime:'codex'`。只有 `runtimeSource:'managed-provider'` / providerId `codex-sub` 是本期范围。

#### Provider 验证与模型发现

用户明确要求验证也对齐白名单。需要覆盖：

- 设置页 provider verify 前置网络探针：`cmd_probe_provider_network`。
- provider verify API：`/api/provider/verify`、`verifyProviderViaSdk`。
- model discovery API：`cmd_fetch_provider_models`。
- subscription verify / supported models：`verifySubscription`、`fetchSdkSupportedModels` 使用 `anthropic-sub`。
- OpenAI-protocol provider 的 one-shot bridge probe。
- Anthropic-protocol provider 的直接 SDK/diagnostic probe。

目标是：同一个 provider 在聊天和验证中使用同一个 `shouldUseMyAgentsProxyForProvider` 结果。

必须改 contract：

- `SettingsPage.verifyProvider(provider, apiKey)` 调 `/api/provider/verify` 时必须传 `providerId`。
- `cmd_probe_provider_network` 和 `cmd_fetch_provider_models` 必须新增 `providerId` 参数。它们是 provider-owned 请求，不能只靠 URL 决定代理。
- `verifyProviderViaSdk` 的 `ProviderEnv` snapshot 必须包含 `providerId`，OpenAI one-shot bridge token 也要带 providerId。
- 如果某个旧调用路径暂时拿不到 providerId，应先补 provider identity 传递，而不是 fallback 到 baseUrl 反推。

#### 已打开 Tab 的生效

现有设置页已经监听 `config.proxySettings` 变化并调用 `cmd_propagate_proxy`。这条机制继续复用。

必须修复的点：

- `setProxyConfig` 当前只比较 `HTTP_PROXY` URL。
- 加 scope 后，URL 不变但当前 provider 的 effective proxy 状态可能改变。
- 重启判定应比较“当前 runtime/provider owner 的 effective proxy key”，而不是只比较 URL。
- external managed-provider Codex 当前不在 builtin `setProxyConfig` 重启链路里，必须补上。

推荐行为：

- builtin 空闲 / prewarm session：收到 scope 变化后，如果当前 provider 的有效代理状态变了，立即 abort + schedule prewarm。
- builtin 正在回答：defer restart 到 turn 结束。
- external `runtime:'codex' && runtimeSource:'managed-provider'`：按 `codex-sub` effective proxy key 判定；空闲时 stop + 下次 prewarm/start 采用新 env，正在回答时 defer 到 turn 结束。
- external `system-cli`：不受 provider scope 影响，继续由 `runtimeConfig.envPolicy.proxy` 控制。
- 下一次用户 query 必须使用新策略。

## 关键设计决策

### D0：按 provider owner 判定，而不是按请求类型 / URL 判定

用户要的是“这个供应商是否使用 MyAgents 网络代理”，不是“聊天请求用代理、登录请求不用代理”或“某个域名用代理”。因此只要网络工作有明确 provider owner，就按该 providerId 判定。这个决策避免两个技术债：

- 把规则做成 URL/domain 系统，范围膨胀成通用网络规则引擎。
- 把“登录 / 下载 / 状态检查”排除在外，导致同一个供应商聊天能用但登录/模型查询失败。

### D1：默认「全部」等价现状

这是兼容性决策。老用户升级后不应该因为新字段缺省而改变网络行为。`scope` missing 必须视为 `all`。

### D2：自定义是白名单，不做黑名单

用户要的是“哪些供应商默认有这个代理能力”，而不是排除列表。白名单更符合“我只让某些 provider 走代理”的心智，也减少误配置。

### D3：自定义不能为空

一个都不选会造成“总开关开着，但没有任何模型供应商使用代理”的反直觉状态。UI 直接禁用保存，用户可以取消或切回全部。

### D4：供应商列表展示全部可见供应商

只展示“已配置 Key / 可用”的供应商会让用户无法提前规划代理范围。全部可见供应商更符合设置型页面的预期。已禁用/未就绪可以弱化，但不应从范围列表里消失。

### D5：Managed Codex 放在供应商列表，并覆盖 codex-sub owner 的全链路

用户感知上 `codex-sub` 是订阅型供应商，所以它必须和其它 provider 一起选择。技术上它是 runtime-backed managed provider，因此执行链路单独接入，并覆盖安装/下载、登录、状态、模型查询、聊天。这个决策避免了两个坏结果：

- 把 `codex-sub` 藏起来，用户不知道怎么控制它的代理。
- 把所有 Codex runtime 都当成 `codex-sub`，误伤用户自配 external Codex CLI。
- 只让聊天走白名单，导致登录或模型查询仍被网络环境卡住。

### D6：本期不纳入 External Runtime

External Runtime 已有 per-Agent `runtimeConfig.envPolicy.proxy`。本期继续沿用那里维护，不在网络代理白名单里加“External Runtime”选项。这样不会引入两套入口互相覆盖的优先级问题。

### D7：验证/模型发现必须和聊天一致

如果聊天走代理但验证不走，用户会看到“聊天能用，验证失败”；反过来也一样。这会直接破坏信任。因此所有 provider 相关请求都必须调用同一判定。

### D8：非 provider 网络请求保持现状

Updater、LiteLLM 缓存、WeCom QR、普通 CDN 请求没有 provider owner，不是“供应商选择”的一部分。本期不动这块，避免需求扩成通用网络规则系统。

### D9：非法空 custom fallback 到 all

前端不允许保存空自定义列表；但磁盘配置可能来自旧版本、手改或并发写入。读取侧必须把 `mode:'custom'` 且有效 providerIds 为空的配置视为 `all` 并 warn。理由是兼容性和可恢复性优先：总开关开着却没有任何供应商生效，比 fallback 到现状更危险。

## 验收标准

1. 升级后，已有 `proxySettings.enabled=true` 且无 `scope` 的用户行为不变：所有模型供应商仍使用 MyAgents 代理。
2. 网络代理关闭时，适用范围配置不生效；聊天/验证不主动注入 MyAgents 代理。
3. 网络代理开启且范围为「全部供应商」时，行为等价当前版本。
4. 网络代理开启且范围为「自定义」时：
   - 选中的 Anthropic 订阅走 MyAgents 代理。
   - 未选中的 Anthropic 订阅不注入 MyAgents 代理。
   - 选中的 API provider 走 MyAgents 代理。
   - 未选中的 API provider 不注入 MyAgents 代理。
   - 选中的 OpenAI-protocol provider 的 bridge upstream fetch 走 MyAgents 代理。
   - 未选中的 OpenAI-protocol provider 的 bridge upstream fetch 不使用 MyAgents 代理。
5. `codex-sub` 出现在自定义列表；选中/未选中影响 Managed Codex owner 的全链路：
   - runtime manifest/signature/artifact 下载。
   - 登录、登出、状态检查。
   - managed-provider 模型查询。
   - managed-provider 聊天 app-server。
   - 不影响用户自配 external Codex CLI。
6. 自定义弹窗一个都不选时，保存按钮不可点击。
7. Provider 验证、verify 前置网络探针、模型发现与聊天使用同一代理策略。
8. 已打开 Tab 在设置变更后自动生效：
   - builtin 当前 provider 的有效代理状态变化时，下一条 query 使用新策略。
   - managed-provider Codex 的 `codex-sub` 有效代理状态变化时，下一条 query 使用新策略。
   - 如果设置变更发生在 AI 正在回答时，不中断当前输出，turn 结束后再重启。
9. updater、LiteLLM 缓存、WeCom QR、普通 CDN 等无 provider owner 请求仍按总开关走，不受 scope 白名单影响。
10. UI 遵守 `specs/DESIGN.md`：不使用硬编码颜色、不用原生 `<select>`、字号使用既有 token，弹窗关闭走 `OverlayBackdrop` / `useCloseLayer`。

## 测试建议

### 单元测试

- `normalizeProxyScope`
  - missing -> all
  - custom dedupe
  - custom empty -> fallback all + warn 行为
  - stale providerId 清理
- `shouldUseMyAgentsProxyForProvider`
  - disabled -> false
  - enabled + all -> true
  - enabled + custom selected -> true
  - enabled + custom unselected -> false
- Rust `proxy_config`
  - global helper 不受 scope 影响，只看 enabled/protocol/host/port。
  - provider-aware helper selected -> 注入/使用 MyAgents proxy。
  - provider-aware helper unselected -> 不注入 MyAgents proxy，但仍设置 localhost `NO_PROXY`。
  - invalid empty custom -> fallback all + warn。
- OpenAI Bridge proxy resolver
  - selected provider returns dispatcher proxy URL
  - unselected provider returns undefined
- Provider contract
  - `/api/provider/verify` 要求/传递 providerId。
  - `cmd_probe_provider_network` / `cmd_fetch_provider_models` 要求/传递 providerId。
  - one-shot bridge registry snapshot 包含 providerId。
- Managed Codex
  - `buildManagedCodexEnv(source:'managed-provider')` selected/unselected 时 proxy env 符合 `codex-sub` 判定。
  - `source:'system-cli'` 不读 `codex-sub` scope。
- Config migration / compatibility
  - 旧 `ProxySettings` 读入后行为等价 all

### 集成测试 / 手测

1. HTTP proxy 开启，scope=all，DeepSeek 发送消息，日志显示 proxy 生效。
2. HTTP proxy 开启，scope=custom only Anthropic，DeepSeek 发送消息，日志显示未注入 MyAgents proxy。
3. OpenAI-protocol provider 被选中时，bridge upstream 走 `ProxyAgent`。
4. OpenAI-protocol provider 未选中时，bridge upstream 不设置 dispatcher。
5. Provider verify 前置网络探针、SDK verify、model discovery 与聊天日志显示同一 provider 使用同一策略。
6. 设置页修改 scope 后，builtin 活跃 Tab 的下一条消息使用新策略。
7. Managed Codex provider scope 命中时，runtime 下载/登录/状态/模型查询/聊天获取 MyAgents proxy。
8. Managed Codex provider scope 未命中时，上述 codex-sub owner 网络工作不注入 MyAgents proxy。
9. 用户自配 external Codex runtime 行为不变，仍由 `runtimeConfig.envPolicy.proxy` 控制。

## 触及红线

- 修改前端设置页必须读 `specs/DESIGN.md`，颜色/字号/控件遵守设计系统。
- 新增设置写盘必须继续走 disk-first merge：`ConfigProvider.patchProxySettings` / `atomicModifyConfig`，不要直接拿 React `config` 覆盖写盘。
- Tab 内 API 调用必须走 `useTabState()` 的 `apiPost/apiGet`，不要用全局 API。
- Sidecar 与 Rust localhost 通信继续用 `local_http`，不要裸 `reqwest::Client::new()`。
- 子进程代理注入仍应集中在 `proxy_config` / 相关 helper，不要在多个 spawn 点手写 `HTTP_PROXY` 分支。
- 全局 proxy helper 与 provider-aware proxy helper 必须分开；不要用 `Option::None` / `undefined` 表达“全局请求”或“订阅 provider”。
- `/api/proxy/set` 若需要触达 external runtime，必须走 `src/server/session-engine/` adapter 边界，不要在 route handler 里手写 runtime 分支。
- OpenAI Bridge 的 upstream fetch 使用 `ProxyAgent` dispatcher；不要假设 Node `fetch` 自动读 proxy env。
- 新增 SSE 事件如有，必须注册 `SseConnection.ts::JSON_EVENTS`。
- 涉及 SDK env / provider 切换时，必须复用现有 provider restart 语义，不要直接改 `shouldAbortSession`。
- Provider-owned 请求必须显式携带 providerId；不要用 baseUrl/domain 反推供应商。

## 开放问题 / 后续期

1. 后续是否要把用户自配 External Runtime 纳入同一个列表：本期明确不做。若未来做，需要先设计它与 `runtimeConfig.envPolicy.proxy` 的优先级和迁移策略。
2. 后续是否支持按 provider 配置不同代理地址：本期明确不做。
3. 后续是否把无 provider owner 的网络请求也纳入范围规则：本期明确不做，未来若做应另起“网络规则”PRD。
4. 自定义列表中已禁用供应商的具体视觉弱化程度可由实现时按当前 Settings 页面组件细化，但不能从列表中消失。

## 附录：代码线索

- `src/renderer/pages/settings/SettingsPage.tsx`：网络代理 UI、`cmd_propagate_proxy` 触发。
- `src/renderer/config/ConfigProvider.tsx`：`patchProxySettings` disk-first merge。
- `src/shared/config-types.ts`：`ProxySettings`、`Provider`、`CODEX_SUBSCRIPTION_PROVIDER_ID`。
- `src/shared/proxyScope.ts`（新增建议）：proxy scope normalize / provider 判定纯函数。
- `src-tauri/src/proxy_config.rs`：Rust proxy settings 读取、子进程注入、reqwest client 构建。
- `src-tauri/src/sidecar/proxy.rs`：广播 proxy config 到活跃 Sidecar。
- `src-tauri/src/commands.rs`：`cmd_probe_provider_network`、`cmd_fetch_provider_models`。
- `src-tauri/src/managed_codex.rs`：Managed Codex runtime 下载、登录、状态、短生命周期命令。
- `src/server/agent-session.ts`：`setProxyConfig`、`buildClaudeSessionEnv`、provider env 切换重启。
- `src/server/session-engine/`：`/api/proxy/set` 触达 builtin/external runtime 的正确 facade 边界。
- `src/server/openai-bridge/handler.ts`：OpenAI-protocol provider upstream fetch proxy dispatcher。
- `src/server/openai-bridge/bridge-registry.ts`：one-shot / active bridge upstream config，需承载 providerId。
- `src/server/provider-probe.ts`：provider 验证探针。
- `src/server/provider-verify.ts`：provider verify、subscription verify、supported models one-shot SDK 调用。
- `src/server/runtimes/codex-command-context.ts`：Managed Codex Node runtime env 构造。
- `src/server/runtimes/codex.ts`：Managed Codex model query / app-server spawn。
- `src/server/runtimes/env-utils.ts`：External Runtime env policy，本期不接入白名单但要避免破坏。
