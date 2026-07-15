---
type: prd
status: implemented
created: 2026-07-15
updated: 2026-07-16
scope: "在现有网络代理自定义范围中增加一个置顶的“通用网络请求”选择项，把此前固定使用应用代理的非 Provider 网络基线变成可选；模型供应商继续逐个选择，两类决策真正独立并保持旧配置行为不变。本期不增加服务级细分、不承诺绕过系统代理/TUN 的强制直连，也不为系统浏览器或 WebView 网络增加新的代理通道。"
issue: "产品需求：模型供应商需要代理时，用户仍可让 Space、统计、更新、Runtime 下载、IM、MCP/工具下载等通用网络请求不使用 MyAgents 应用代理，以验证它们在中国大陆当前系统网络下的可达性。"
review: "PASS（requirements / adversarial correctness / architecture 三路独立复审；已闭合 IM lifecycle、disk-first replacement、热配置并发、generation 收敛与跨目标 cron 排空）"
---

# 0.3.1 通用网络请求代理范围 PRD

## 执行须知（给空 session 的你）

- 本 PRD 是需求与实现边界的单一权威，不需要回翻原始对话。
- 开发前 MUST 阅读：`specs/ARCHITECTURE.md`、`specs/tech_docs/proxy_config.md`、`specs/tech_docs/pit_of_success.md` 的 `local_http` / `proxy_config` 章节、`specs/tech_docs/multi_agent_runtime.md` 的 Runtime envPolicy 章节、`specs/tech_docs/im_integration_architecture.md`、`specs/tech_docs/plugin_bridge_architecture.md`、`specs/tech_docs/third_party_providers.md`、`specs/DESIGN.md`。
- 需要修改 SDK MCP 配置或对 SDK/Runtime 内部流量归属作新断言时，MUST 重新核对当前 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`；禁止凭假设扩展 SDK 交互。
- 本期延续现有代理架构，不新建代理进程、域名规则引擎或服务清单。核心改动是把已存在但写死的通用代理基线暴露为配置项。
- 本文引用文件路径和符号名，不依赖易漂移的行号；找不到时先用 `rg` 搜索符号。
- 当前工作区可能存在用户的其它未提交改动。实现时不得覆盖、回退或顺手整理无关文件。

## 0. 一句话决策

当前自定义代理实际上是“模型供应商逐个选择，通用网络请求固定使用应用代理”。本期把后半句从硬编码 `true` 改成用户可选，并保证通用网络基线与 Provider 专属覆盖互不串线。

## 1. 背景与用户意志

### 1.1 用户真正要解决的问题

用户在中国大陆使用 MyAgents 时，经常遇到两类网络：

1. Anthropic、Codex 等模型供应商必须经过应用代理才能访问。
2. Space、统计、更新、IM、MCP/工具下载等请求，用户想让它们使用当前系统网络，以验证这些服务在大陆网络下是否本来就可达。

现有自定义代理已经允许用户取消某个模型供应商，但没有给“其它联网请求”同等的选择权。用户的原话是：

> “通用代理之前很死板，开关就是全部。现在我们自定义支持了单个模型取消。那不就相当于这里的『通用网络请求』仍然是全部走代理。这次其实就是这块也可以选择不走代理。”

另一个最关键的场景是：

> “我模型是要做代理的，因为这些东西它确实只有通过代理才可以通。但是我的内部的服务，我其实想要让他去处于不开代理的状态。”

因此，本需求不是增加“MyAgents 官方域名”白名单，也不是为 Space 单独加开关。它要暴露的是现有网络架构里已经存在的“非 Provider 通用基线”。

### 1.2 讨论中的纠偏

讨论一度把新选项理解成“MyAgents 一方服务”，这不符合用户意图。以下请求无论由 MyAgents、一家 IM 平台、GitHub 还是 Petdex 提供，只要当前不属于明确的 Provider-owned 路径，都属于本需求中的通用网络请求：

- 应用更新检查与下载；
- Managed Codex Runtime 安装包下载；
- Space 与 Analytics；
- Telegram、飞书、钉钉、企业微信；
- Plugin Bridge；
- MCP、工具联网和下载；
- Petdex、LiteLLM/GitHub；
- 其它沿用现有通用代理 helper 的外部请求。

分类依据是已有请求 owner，不是域名，也不是一方/三方身份。

## 2. 当前技术现实

### 2.1 配置与 UI 只表达 Provider 选择

共享配置位于 `src/shared/config-types.ts`：

- `ProxyScopeMode = 'all' | 'custom'`；
- `ProxyScopeSettings` 只有 `mode` 与 `providerIds`；
- `ProxySettings.scope` 缺失时按历史行为视为全部 Provider。

`src/shared/proxyScope.ts` 的当前行为：

- `normalizeProxyScope()` 把缺失、非法或空 custom provider list 回退成 `{ mode:'all' }`；
- `shouldUseMyAgentsProxyForProvider()` 只回答某个 Provider 是否使用应用代理；
- `effectiveProxyScopeKey()` 只计算 Provider 会话的有效代理重启 key；
- `removeProviderFromProxySettingsScope()` 删除 custom 中最后一个 Provider 后回退 `all`。

`src/renderer/components/ProxyScopeDialog.tsx` 只接收 Provider 列表和 `initialProviderIds`，标题是“选择使用代理的供应商”，选中数也只统计 Provider。

`src/renderer/pages/settings/SettingsPage.tsx` 的 `saveProxyScope()` 在零个或全部 Provider 被选中时保存 `{ mode:'all' }`。这套归一化无法表达“全部 Provider 使用代理，但通用请求不使用代理”。

### 2.2 Rust 通用路径固定使用应用代理

`src-tauri/src/proxy_config.rs` 有两类现成入口：

| 类型 | 现有符号 | 当前行为 |
|---|---|---|
| 通用请求/子进程 | `build_client_with_proxy()`、`apply_to_subprocess()` | 只要全局代理 enabled，就使用/注入应用代理 |
| Provider-owned | `build_client_with_proxy_for_provider()`、`build_blocking_client_with_proxy_for_provider()`、`apply_to_subprocess_for_provider()` | 按 `scope.providerIds` 决策 |

通用 helper 的代表调用方包括：

- `space_cloud.rs::http_client()`；
- `updater.rs::build_updater_with_proxy()` 及 updater manifest client；
- `litellm_cache.rs::build_client()`；
- `floating_ball_pets.rs::build_external_http_client()`；
- `im/telegram.rs`、`im/dingtalk.rs`、`im/feishu.rs`；
- `commands.rs` 企业微信 QR 请求；
- `sse_proxy.rs::proxy_http_request()` 的 external branch（Renderer Analytics 走这里）；
- `sidecar/instances.rs`、`sidecar/session_lifecycle.rs` 的 Sidecar spawn；
- `im/bridge.rs` 的 Plugin Bridge spawn；
- `terminal.rs` 的 PTY proxy env 注入。

`updater.rs::build_updater_with_proxy()` 和 `terminal.rs` 目前直接读取 `read_proxy_settings()`，没有经过通用 scope 判断，实施时必须显式迁移。

### 2.3 Node 把通用生效环境和应用代理模板混成一份

`src/server/proxy-state.ts` 当前保存：

- immutable `inheritedProxySnapshot`：Rust 注入应用代理前的系统/父进程 proxy env；
- `currentProxySettings`；
- 当前 `process.env`：代理启用时被 `applyProcessProxyConfig()` 改成应用代理。

Provider helper 的现状是：

- Provider 被选中：`applyProviderProxyPolicyToEnv()` 从 `process.env` 复制代理变量；
- Provider 未选中：从 `inheritedProxySnapshot` 恢复系统基线。

这隐含了“`process.env` 永远等于应用代理 overlay”的假设。一旦通用请求关闭并把 `process.env` 恢复系统基线，已选 Provider 也会失去应用代理。因此本需求不能只在 Rust spawn 时少注入几个环境变量；必须把“通用当前环境”和“应用代理模板”拆开。

### 2.4 热更新与会话重启已有正确方向

Settings 的 `config.proxySettings` 变化会调用 Rust `cmd_propagate_proxy()`，向所有活跃 Sidecar POST `/api/proxy/set`。

Builtin 路径 `agent-session.ts::setProxyConfig()` 在调用 `setProcessProxyConfig()` 前后比较当前 Provider 的 `getProviderProxyScopeKey()`；Provider 有效路径不变时跳过 Session restart。

External 路径 `session-engine/external-adapter.ts::updateProxyConfig()` 同时计算：

- Managed Codex 的 Provider key；
- `getProcessProxyEnvKey()`。

`runtimes/external-session.ts::handleExternalProxyConfigChange()` 已按 runtime source 分流：

- `codex/managed-provider` 看 `codex-sub` Provider key；
- system CLI 且 `envPolicy.proxy='myagents'` 看 Sidecar process env；
- `envPolicy.proxy='terminal'` 不归 MyAgents 代理热更新所有。

本期应延续这个 owner 模型：general-only 修改不重启 managed-provider；system CLI 的 `'myagents'` 策略继续跟随通用进程基线。

## 3. 产品目标与成功定义

### 3.1 产品目标

用户在自定义模式中可以独立决定：

- 通用网络请求是否使用 MyAgents 配置的应用代理；
- 每个模型供应商是否使用 MyAgents 配置的应用代理。

用户无需理解 Space、Updater、Plugin Bridge 或 Sidecar 的内部进程结构。界面只呈现两个稳定概念：通用网络请求与模型供应商。

### 3.2 四种必须成立的组合

| 通用网络请求 | 某模型供应商 | 通用路径 | 该 Provider-owned 路径 |
|---:|---:|---|---|
| 开 | 开 | 使用应用代理 | 使用应用代理 |
| 开 | 关 | 使用应用代理 | 继承系统网络 |
| 关 | 开 | 继承系统网络 | 使用应用代理 |
| 关 | 关 | 继承系统网络 | 继承系统网络 |

第三行是本需求的必赢场景。

### 3.3 “不走代理”的准确语义

UI 与日志必须使用“未使用 MyAgents 应用代理”或“继承系统网络”，不能承诺“强制直连”。

- 如果系统没有配置代理/TUN，继承系统网络通常等价于直连。
- 如果系统代理、VPN 或 TUN 正在接管流量，应用无法可靠绕过它。
- localhost 例外：继续由 `local_http` / `NO_PROXY` 强制绕过代理。

## 4. 本期范围

### 4.1 必须交付

1. `ProxyScopeSettings` 增加通用网络请求选择。
2. 自定义范围弹窗置顶增加“通用网络请求”项。
3. `all`、`custom`、摘要、全选、迁移和 Provider 删除归一化全部支持新维度。
4. Rust 通用 reqwest、Updater、子进程、PTY 路径遵守通用选择。
5. Node 通用 process env 与 Provider app-proxy overlay 解耦。
6. HTTP/SOCKS5 都支持“通用关 + Provider 开”的组合。
7. Settings 对活跃 Sidecar 继续热传播；长驻通用网络 owner 按第 7.6 节收敛生效时机。只改变通用项时，不误重启 Provider 有效路径未变化的 builtin 或 managed-provider 会话。
8. Managed Codex 安装包下载归通用路径；Codex Runtime 调模型仍归 `codex-sub` Provider。
9. 中英文 i18n、统一日志、配置/纯逻辑/组件/集成回归测试。
10. 更新 `specs/tech_docs/proxy_config.md`，必要时同步 `pit_of_success.md` 对 helper 语义的说明。

### 4.2 明确不做

- 不增加 Space、Analytics、Updater、IM、MCP 等服务级复选框。
- 不按 hostname、URL 后缀或一方/三方身份动态分类流量。
- 不新增 PAC、域名白名单、绕过列表或规则编辑器。
- 不增加“强制直连”模式；不试图绕过系统代理/TUN。
- 不改变 localhost 永远绕过代理的规则。
- 不改变 Agent `runtimeConfig.envPolicy.proxy='myagents'|'terminal'` 的产品入口和两档语义。
- 不把 system-installed Claude Code/Codex/Gemini Runtime 伪装成 Provider 列表项；它们继续由 Runtime envPolicy 控制。
- 不为系统浏览器、内嵌 WebView 页面导航、`<img>` 等浏览器网络栈增加应用代理通道。
- 不为不透明 SDK/Runtime 子进程内部的每一条 socket 流量做包级分类。一个明确标记为 Provider-owned 的 SDK/Runtime 进程，其内部无法由宿主分流的请求继续沿该进程的 Provider/Runtime 代理策略。
- 不新增独立连通性诊断面板或为每个服务设计健康检查按钮。

## 5. 核心交互

### 5.1 设置页入口

设置页现有“适用供应商”改为“适用范围”。模式仍只有：

- 全部；
- 自定义。

“全部”继续表示通用网络请求和全部模型供应商都使用应用代理，不增加第三个顶层模式。

### 5.2 自定义范围弹窗

弹窗标题：

> 选择使用应用代理的范围

说明文案：

> 选择哪些请求使用 MyAgents 中配置的代理。未选择的项目会继承系统网络设置；应用内本地通信始终直连。

列表结构：

```text
已选择 7 项                                      全选
────────────────────────────────────────────────────
✓  通用网络请求                                  通用
   更新、Space、IM、MCP、工具下载等
────────────────────────────────────────────────────
   模型供应商
✓  Anthropic（订阅）                             订阅
✓  Codex（订阅）                                 Managed
✓  Grok（订阅）                                  订阅
…
```

交互要求：

- 通用网络请求使用与 Provider 行相同的复选视觉，不使用 Toggle，避免一个选择器里出现两套选择语法。
- 通用行固定置顶，不参与 Provider 排序，不伪装成 Provider id。
- “全选/取消全选”同时操作通用项和全部 Provider。
- 保存允许零项被选择。零项表示应用代理地址仍保存、总开关仍可开启，但当前 custom scope 没有选中的通用或 Provider owner。
- Overlay 继续使用 `OverlayBackdrop`；关闭行为和 Footer 沿用现有弹窗。
- 所有新文案进入 `settings` i18n namespace，中英文同步。

### 5.3 摘要

摘要不能只显示 Provider 数量，应同时表达两个维度。推荐文案：

- 全部：`通用请求和全部模型供应商都会使用此代理`；
- Custom：`通用请求未使用代理 · 6 个模型供应商使用代理`；
- Custom：`通用请求使用代理 · 仅 Anthropic、Codex`；
- Custom zero：`当前范围未选择任何项目`。

窄宽度下允许截断并保留 `title` 完整文案，沿用现有 Settings 行为。

## 6. 配置与迁移模型

### 6.1 磁盘格式

目标格式：

```json
{
  "proxySettings": {
    "enabled": true,
    "protocol": "http",
    "host": "127.0.0.1",
    "port": 7897,
    "scope": {
      "mode": "custom",
      "generalRequests": false,
      "providerIds": ["anthropic-sub", "codex-sub"]
    }
  }
}
```

字段名定为 `generalRequests`，只表示是否给通用网络基线应用 MyAgents proxy。

### 6.2 归一化规则

| 原始配置 | 归一化结果 | 理由 |
|---|---|---|
| 缺失 `scope` | `{mode:'all'}` | 保持旧版全部行为 |
| `{mode:'all'}` | `{mode:'all'}` | 隐含 general=true + all providers |
| 旧 custom，缺失 `generalRequests` | custom + `generalRequests:true` | 旧版通用路径固定走应用代理，升级不得改变 |
| 新 custom，`generalRequests:false` | 保留 false | 新能力 |
| 新 custom，零 Provider、general=true | 保留 custom | 只让通用请求走代理 |
| 新 custom，零 Provider、general=false | 保留 custom | 明确零范围，不得翻转成 all |
| 全部可见 Provider + general=true | UI 保存时可折叠成 all | 与 all 完全等价 |
| 全部可见 Provider + general=false | 必须保留 custom | 折叠会丢失通用选择 |

为了区分“旧版非法空 custom”与“新版明确空 custom”，raw parse 必须能识别 `generalRequests` 是否存在：

- 旧 custom `providerIds:[]` 且缺少 `generalRequests` 可继续按历史规则回退 all；
- 只要新字段明确存在，零 Provider 就是合法选择。

### 6.3 Provider 删除

`removeProviderFromProxySettingsScope()` 删除最后一个 Provider 时不得再自动回退 all。它必须：

- 保留 custom；
- 保留/物化 `generalRequests`；
- 只从 `providerIds` 移除目标 id。

否则删除 Provider 会把用户的“通用关”静默翻成全部请求走代理。

### 6.4 配置 owner

写盘继续通过 renderer `patchProxySettings()` → `atomicModifyConfig()` 的 disk-first/锁内 merge，不新增第二份代理配置文件，也不让 Sidecar 成为配置权威。

Rust `cmd_propagate_proxy()` 的 payload 必须携带归一化后的 `generalRequests`。所有活 Sidecar 从同一份磁盘配置热更新。

## 7. 技术方案

### 7.1 Rust：让现有通用 helper 真正遵守通用选择

在 `src-tauri/src/proxy_config.rs` 增加纯决策：

- `proxy_enabled_for_general_requests(settings: &ProxySettings) -> bool`；
- `read_proxy_settings_for_general_requests() -> Option<ProxySettings>`。

保留 `read_proxy_settings()` 的现有含义：只回答应用代理总开关是否有效。不能把它改成通用 scope-aware，因为 `read_proxy_settings_for_provider()` 仍需在 general=false 时为已选 Provider 返回代理。

修改既有 helper：

- `build_client_with_proxy()` 使用 `read_proxy_settings_for_general_requests()`；
- `apply_to_subprocess()` 使用 `read_proxy_settings_for_general_requests()`；
- Provider-aware 三个 helper 继续只看 Provider 选择。

总开关关闭或 general=false 时，通用 helper 都继承系统网络；仍注入/保留 localhost `NO_PROXY` 保护。不得用 `.no_proxy()` 实现 general=false，因为那会错误承诺并强制绕过系统代理。

### 7.2 Rust：迁移绕过通用 helper 的调用点

以下调用点必须单独审计：

1. `updater.rs::build_updater_with_proxy()`：改读 general-aware settings。
2. `updater.rs` 手工 manifest client：继续走已更新的 `build_client_with_proxy()`。
3. `terminal.rs`：PTY 的 proxy env 基线跟随 general；继续保留 `LOCALHOST_NO_PROXY`。
4. `managed_codex.rs::external_http_client()`：Runtime manifest/artifact 下载改用通用 `build_client_with_proxy()`；`direct_external_http_client()` 的受限 first-party 直连 fallback 保持原安全和校验语义。
5. `managed_codex.rs` 的登录检查、Codex Runtime 子进程继续使用 `codex-sub` Provider-aware helper，不得因下载归类改变模型路径。
6. 所有裸 `read_proxy_settings()` 调用逐个确认：它是在判断全局配置、构造通用出口，还是 Provider 出口。禁止批量替换后靠测试碰运气。

### 7.3 Node：建立两个独立网络基线

`src/server/proxy-state.ts` 必须显式拥有：

1. `inheritedProxySnapshot`：进程启动前/应用注入前的系统网络基线，生命周期内 immutable；
2. app-proxy overlay：由当前 `ProxySettings` 构造的应用代理环境，HTTP/HTTPS 使用配置 URL，SOCKS5 使用 bridge URL；
3. 当前 `process.env`：只表达通用网络请求实际采用的基线。

不要继续用 `process.env` 反推 app-proxy overlay。

目标决策：

```text
setProcessProxyConfig(settings)
  ├─ 更新 currentProxySettings
  ├─ 建立/更新 app-proxy overlay（含 SOCKS bridge）
  └─ generalRequests ? overlay -> process.env : inherited -> process.env

applyProviderProxyPolicyToEnv(target, providerId)
  └─ provider selected ? overlay -> target : inherited -> target
```

`getProxyForProviderUrl()` 同样直接在 overlay 与 inherited snapshot 之间选择，不得从当前 `process.env` 取已选 Provider 的代理。

通用 Node 请求（包括 server-side Analytics）必须逐条验证其实际 HTTP 栈是否会消费当前 proxy env；不能凭“设置了 `HTTP_PROXY`”就假设 Node global `fetch` 一定使用它。若现有调用需要显式 dispatcher，应增加/复用与当前 undici 版本兼容的 general-aware URL/helper，不能误调 Provider helper，也不能把 npm `undici` 的 `ProxyAgent` 直接塞给不兼容版本的 global fetch。

### 7.4 Node 启动与 SOCKS5

当前 `initSocksBridgeFromCurrentEnv()` 假设 Rust 已把 app proxy 注入 Sidecar `process.env`。general=false 后这个假设不成立，但 Provider 仍可能需要 SOCKS5 bridge。

实现必须让 Sidecar 启动时从 `currentProxySettings` 初始化完整 proxy state，而不是只看继承进来的 `HTTP_PROXY`。要求：

- general=false + 某 Provider selected + socks5：bridge 仍启动，Provider env 得到 bridge URL，通用 `process.env` 保持 inherited；
- general=true + Provider excluded + socks5：通用环境得到 bridge URL，excluded Provider 得到 inherited；
- custom zero scope：无消费者时可以不启动或停止 bridge；
- 配置快速连续变化继续用 `proxyConfigGeneration` 丢弃过期 callback；
- bridge start/stop 不得形成并发竞态或把较新的配置覆盖回旧值。

可重命名初始化函数以反映新语义，但不能留下“一处从磁盘、一处从 env”两套初始化事实源。

### 7.5 热更新与 restart key

Builtin：

- general-only 变化会更新 `process.env`，供通用 Node 路径使用；
- `getProviderProxyScopeKey(currentProviderId)` 不应包含 `generalRequests`；
- 当前 Provider 的 proxy URL/选择不变时，不 restart/abort/prewarm Query。

External：

- `codex/managed-provider` 继续看 `codex-sub` Provider key；general-only 变化不重启它；
- system CLI + `envPolicy.proxy='myagents'` 使用 Sidecar 通用 process env，general 变化应沿现有 `handleExternalProxyConfigChange()` 重启或延迟重启；
- `envPolicy.proxy='terminal'` 不受 MyAgents general/provider scope 变化影响。

通用配置变化不得修改 Session provider identity、resume id、MCP authority 或其它 Session 配置。

### 7.6 长驻通用网络 owner 的生效时机

代理环境和 reqwest client 在创建后不能原地改写。本期必须审计并明确不同 owner 的生效边界，不能让用户面对一个无说明的“有些立即生效、有些重启 App 才生效”：

- 活跃 Sidecar：继续通过 `cmd_propagate_proxy()` 热更新 Node proxy state。
- Space/Analytics/Updater/普通短请求：下一次新建请求/client 时使用新 general policy；不取消已经在飞的请求或下载。
- Rust IM adapter、Plugin Bridge 等长驻连接/进程：通过现有 bot/bridge lifecycle 做有界 reconnect/restart，使新通用基线生效；不得新建第二套进程管理器。重连期间保留配置和启用状态，并在日志中明确原因。
- 已打开 Terminal/PTY：进程环境不可变，本期只保证新建 Terminal 使用新 general policy；不杀掉用户正在运行的 shell。
- 已启动的不透明 SDK/Runtime/MCP 子进程：按其现有 Provider/Runtime restart owner 处理，不能为了 general-only 变化误杀 managed-provider turn。

若实现核对发现某个长驻 owner 已有更精确的热更新能力，应复用；若没有，使用其现有 stop/start/reconnect owner，而不是在请求层叠动态全局变量。

### 7.7 进程内混合流量边界

“通用网络请求”是现有 owner/helper 层的分类，不是包级网络分类器：

- Rust/Node/MyAgents 直接拥有的非 Provider 请求、通用子进程和 Plugin Bridge 遵守 general。
- Builtin SDK、Managed Codex 等明确 Provider-owned 子进程遵守 Provider 选择。
- Provider-owned 不透明进程内部代发的 remote MCP、connector、shell/tool 子流量，如果 SDK/Runtime 没有逐请求代理 API，宿主无法从同一进程环境中再次拆开。本期不引入本地 egress relay 绕过该限制。
- SDK `McpStdioServerConfig.env` 虽存在 per-server env，但 remote MCP HTTP/SSE 配置没有 per-server proxy 字段；实现者不得宣称已覆盖 SDK 内所有 MCP 网络，除非另行验证并形成新的架构方案。
- 工具/Skill 下载中的受信任 GitHub codeload 路径遵守 general；任意用户提供的 raw ZIP URL 为 SSRF 安全例外，继续使用逐跳 public-address 校验后的 DNS-pinned direct dispatcher，不消费 app overlay 或 inherited env proxy。否则代理侧重新解析会重新打开 DNS rebinding 窗口。UI 的“工具下载等”是类别示例，不覆盖这一安全例外。

这个边界必须写入 `proxy_config.md`，避免后续把 UI 分类误解成对每个网络包的识别承诺。

### 7.8 日志

统一日志至少能验证决策，而不记录敏感代理凭据。推荐字段：

```text
[proxy_config] owner=general path=myagents-proxy protocol=http
[proxy_config] owner=general path=inherited
[proxy_config] owner=provider providerId=anthropic-sub path=myagents-proxy protocol=socks5-bridge
[proxy_config] owner=provider providerId=deepseek path=inherited
```

要求：

- 不打印代理用户名、密码、token 或完整含 credential URL；
- 高频请求不逐次刷屏，client/env 建立或配置切换时记录即可；
- Renderer 文案与日志都不把 `inherited` 翻译成“强制直连”。

## 8. 关键设计决策

### D1：暴露现有通用基线，不建服务清单

这是一次 scope 补全，不是网络规则系统。现有通用 helper 已经是更新、Space、IM 等路径的共同 owner；让它读取一个布尔值，比维护不断漂移的 URL/服务枚举更符合架构延续性。

### D2：通用与 Provider 是独立维度

用户需要“通用关 + 模型开”，也可能需要“通用开 + 国内模型关”。任何用 `process.env` 同时代表两者的实现都无法覆盖四象限，因此必须保留 inherited baseline 与 app-proxy overlay 两份事实。

### D3：未选择等于继承系统网络

这与现有 excluded Provider 语义一致，也符合系统代理/TUN 的现实。新增“direct”会制造应用无法完整兑现的承诺；项目的 Runtime envPolicy 也曾因选项过多移除 `'direct'`。

### D4：通用请求是置顶项，不是伪 Provider

把它塞进 `providerIds` 会污染 Provider 删除、排序、类型标签、restart fingerprint 和运行时身份。独立布尔字段能表达真实语义，且没有引入新的配置集合。

### D5：旧配置默认 general=true

历史版本的通用请求始终使用应用代理。缺失新字段时若默认 false，会让升级用户的更新、IM、Space 等突然换网络路径，属于不可接受的静默行为变化。

### D6：允许 custom 零选择

零选择是一个明确、安全的 no-app-proxy scope，并能保留用户填写的代理地址供稍后启用。强行回退 all 会把“都不选”翻成“全部使用”，方向完全相反。

### D7：Managed Codex 下载与模型执行分开

Runtime 安装包下载是通用下载；安装后的 Codex 进程访问模型服务是 `codex-sub` Provider。按行为 owner 分类，而不是因为二者都叫 Codex 就绑定在一起。

### D8：本期诊断停在日志

单一测试地址不能证明 Space、IM、Updater、MCP 都可达。日志能可靠回答“应用是否注入了代理”，不会制造伪健康结论；服务本身的 HTTP/auth 错误继续在各自界面呈现。

## 9. 测试计划

### 9.1 Shared 单元测试

扩展 `src/shared/proxyScope.test.ts`：

- 缺失 scope → all；
- 旧 custom 缺失 `generalRequests` → true；
- new custom false 被保留；
- new custom 零 Provider + true/false 均不回退 all；
- all Provider + general=false 不能折叠 all；
- 删除最后一个 Provider 保留 custom/general；
- `shouldUseMyAgentsProxyForProvider()` 不受 general-only 变化影响；
- 新增 general decision helper 覆盖 enabled/all/custom/legacy。

### 9.2 Rust 单元测试

扩展 `proxy_config.rs` tests：

- serde 读写 `generalRequests`；
- legacy missing 默认 true；
- `proxy_enabled_for_general_requests()` 四类输入；
- Provider selected 在 general=false 时仍返回 true；
- general=true 时 excluded Provider 仍返回 false；
- custom zero 不回退 all；
- HTTP/HTTPS/SOCKS5 URL 校验保持现状。

对 `build_proxy_payload()` 增加可测试 pure shaping 或窄测试，确认热传播 payload 始终带归一化字段。

### 9.3 Node 单元测试

扩展 `src/server/proxy-state.unit.test.ts`，完整覆盖 2×2 矩阵：

- general on / Provider on；
- general on / Provider off；
- general off / Provider on；
- general off / Provider off。

每个 case 同时断言：

- `process.env`；
- `applyProviderProxyPolicyToEnv()` 的 target env；
- `getProxyForProviderUrl()`；
- inherited `ALL_PROXY` / `NO_PROXY` baseline；
- localhost `NO_PROXY` 保护。

SOCKS5 测试必须覆盖 general=false + Provider selected，确认 bridge overlay 可供 Provider 使用且没有写进通用 `process.env`。

### 9.4 Hot reload / Runtime 测试

- builtin 当前 Provider key 不变，仅切 general：不调用 Query restart。
- builtin 当前 Provider 开/关变化：仍触发现有 proxy restart。
- managed Codex 仅切 general：不重启 runtime。
- system CLI `'myagents'` 仅切 general：沿现有 external restart/defer 逻辑生效。
- system CLI `'terminal'`：跳过 MyAgents proxy restart。
- 配置连续 A→B→A，SOCKS bridge generation 不提交过期状态。
- Rust IM/Plugin Bridge general 变化后沿现有 lifecycle 重连，新实例获得正确环境；不改变 enabled/config 状态。
- 已打开 PTY 不被终止，新 PTY 使用新 general policy。

### 9.5 Renderer DOM 测试

为 `ProxyScopeDialog` 覆盖：

- 通用行置顶；
- 初始选中/取消；
- 全选/取消全选覆盖通用与 Provider；
- zero selection 可保存；
- Save payload 同时带 general 与 Provider ids；
- 摘要四种形态；
- 中英文 key 存在；
- Overlay 关闭行为无回归。

### 9.6 调用点与真机矩阵

实现后用 `rg` 审计所有以下符号调用：

- `read_proxy_settings()`；
- `build_client_with_proxy()`；
- `apply_to_subprocess()`；
- `build_client_with_proxy_for_provider()`；
- `apply_to_subprocess_for_provider()`；
- `applyProviderProxyPolicyToEnv()`；
- `getProxyForProviderUrl()`。

至少完成以下真机 smoke：

1. HTTP proxy：general=false、Anthropic=true，模型可用，Space/Updater/Analytics 日志显示 inherited。
2. HTTP proxy：general=true、国内 Provider=false，通用请求可用，模型路径 inherited。
3. SOCKS5：general=false、Provider=true，模型通过 bridge 可用，通用路径不使用 bridge。
4. 关闭系统代理/TUN 后复测中国大陆必赢场景；确认 UI 不把系统层代理存在时的结果误报为直连。
5. Plugin Bridge/IM general on/off 各一次。
6. Managed Codex 下载首选路径跟随 general，既有受限直连 fallback 保持；安装后的 Codex turn 跟随 `codex-sub`。

## 10. 验收标准（DoD）

1. 自定义代理弹窗顶部出现“通用网络请求”，其下是模型供应商分组。
2. 用户可以保存“通用关 + 一个或多个 Provider 开”，重开设置和重启 App 后选择保持。
3. 在该组合下，Space、Analytics、Updater、IM/Plugin Bridge、通用下载等既有通用路径不注入 MyAgents 应用代理，选中的模型 Provider 仍使用它。
4. 反向组合“通用开 + 某 Provider 关”继续正确，未被本期回归。
5. 旧版 `{mode:'custom', providerIds:[...]}` 升级后 `generalRequests` 等效为 true，网络行为无变化。
6. 全 Provider + general=false 不被归一化成 all；zero custom 不被翻转成 all。
7. HTTP、HTTPS、SOCKS5 都通过 2×2 核心测试；SOCKS bridge 没有 stale callback 回写。
8. 只切 general 不重启 Provider 有效路径未变化的 builtin/managed-provider 会话；system CLI envPolicy 保持既有语义。
9. Managed Codex 安装下载的首选路径跟随 general，现有经 host/path/size/hash/minisign/平台签名约束的直连 fallback 不扩张；Codex 模型执行跟随 `codex-sub`。
10. 长驻 Rust IM/Plugin Bridge 不需要整 App 重启即可沿现有 lifecycle 获得新 general policy；已有 PTY 不被杀，新 PTY 生效。
11. localhost 仍始终绕过代理；general=false 仍继承系统代理/TUN，而不是强制 `.no_proxy()`。
12. 日志可辨识 owner 与 `myagents-proxy | inherited`，且不泄露代理凭据。
13. `specs/tech_docs/proxy_config.md` 已同步配置格式、语义、生效时机、调用点与 opaque subprocess 边界。
14. `npm run typecheck && npm run lint && npm run test:unit && npm run test:dom && npm run test:integration` 通过；Rust 相关 tests、`cargo fmt --check` 与目标 clippy 通过。

## 11. 建议实施顺序

1. 先改 shared raw/normalized scope 类型与纯函数测试，固定迁移语义。
2. 改 Rust serde、general decision helper 与 tests。
3. 改 Node proxy-state 两份基线和 SOCKS bridge 初始化，先跑 2×2 单测。
4. 修改 Rust generic helper、Updater、Terminal、Managed Codex 下载等调用点。
5. 接通 `cmd_propagate_proxy()` payload、builtin/external hot reload，以及 Rust IM/Plugin Bridge 的既有 lifecycle 重连。
6. 修改 Settings UI、ProxyScopeDialog、摘要与 i18n。
7. 全仓 `rg` 做代理 helper owner audit，补遗漏调用点。
8. 更新 `proxy_config.md`，运行 deterministic test pools 与 Rust checks。
9. 按第 9.6 节做真机 HTTP/SOCKS5 smoke，再进入 cross-review。

## 12. 文件与符号地图

### 12.1 主要修改面

| 文件 | 现有符号 | 本期职责 |
|---|---|---|
| `src/shared/config-types.ts` | `ProxyScopeSettings`、`ProxySettings` | 新字段与兼容类型 |
| `src/shared/proxyScope.ts` | `normalizeProxyScope`、`shouldUseMyAgentsProxyForProvider`、`removeProviderFromProxySettingsScope` | general 决策与新归一化 |
| `src/shared/proxyScope.test.ts` | proxy scope tests | 迁移/零范围/四象限纯逻辑 |
| `src/renderer/components/ProxyScopeDialog.tsx` | `ProxyScopeDialog` | 置顶通用项、全选、save payload |
| `src/renderer/pages/settings/SettingsPage.tsx` | `proxyScope*`、`saveProxyScope` | 摘要、初始值、写盘与热传播 |
| `src/renderer/i18n/locales/*/settings.json` | `general.proxyScope*` | 中英文文案 |
| `src-tauri/src/proxy_config.rs` | `ProxySettings`、`ProxyScopeSettings`、generic/provider helpers | Rust 通用/Provider 独立决策 |
| `src-tauri/src/sidecar/proxy.rs` | `build_proxy_payload`、`cmd_propagate_proxy` | 热传播新字段 |
| `src/server/proxy-state.ts` | `setProcessProxyConfig`、`applyProviderProxyPolicyToEnv`、`getProxyForProviderUrl` | inherited/overlay/process 三者解耦 |
| `src/server/proxy-state.unit.test.ts` | proxy state tests | Node 2×2 + SOCKS5 |
| `src/server/agent-session.ts` | `setProxyConfig`、`initSocksBridgeFromEnv`、`buildClaudeSessionEnv` | init、builtin restart 不变量 |
| `src/server/session-engine/external-adapter.ts` | `updateProxyConfig` | external hot reload key |
| `src/server/runtimes/external-session.ts` | `handleExternalProxyConfigChange` | runtime source/envPolicy restart |
| `src-tauri/src/updater.rs` | `build_updater_with_proxy` | general-aware updater |
| `src-tauri/src/terminal.rs` | PTY proxy env 构造 | general-aware terminal baseline |
| `src-tauri/src/managed_codex.rs` | `external_http_client`、`direct_external_http_client` | 下载归 general，模型仍 provider |
| `specs/tech_docs/proxy_config.md` | 全文 | 更新权威文档 |

### 12.2 重点审计但不一定修改

- `src-tauri/src/space_cloud.rs::http_client()`；
- `src-tauri/src/litellm_cache.rs::build_client()`；
- `src-tauri/src/floating_ball_pets.rs::build_external_http_client()`；
- `src-tauri/src/im/{telegram,dingtalk,feishu}.rs`；
- `src-tauri/src/im/bridge.rs::apply_proxy_env()`；
- `src-tauri/src/commands.rs` 企业微信 QR commands；
- `src-tauri/src/sse_proxy.rs::proxy_http_request()`；
- `src/server/analytics.ts`；
- `src/server/openai-bridge/handler.ts`；
- `src/server/provider-probe.ts`；
- `src/server/runtimes/env-utils.ts::augmentedProcessEnv()`；
- `src/server/runtimes/codex-command-context.ts`。

## 13. 开放问题与后续期

本期没有阻塞性的产品开放问题。以下是明确推迟的能力：

- 按服务或域名细分通用网络请求；
- 为 WebView/系统浏览器提供应用代理；
- 为 opaque SDK/Runtime 内部的 remote MCP、shell/tool 子流量建立本地 egress relay；
- 面向用户的逐服务网络诊断面板；
- 强制直连或显式绕过系统代理/TUN。

这些需求若出现，必须另起 PRD；不得在本期实现中顺手加入隐藏规则、域名判断或额外代理进程。

## 附录：关联文档

- `CLAUDE.md`：代理、localhost、子进程、config lock、日志与前端红线。
- `specs/ARCHITECTURE.md`：Rust 代理层、Sidecar、Plugin Bridge、Multi-Agent Runtime。
- `specs/tech_docs/proxy_config.md`：当前代理配置权威文档，本期实现后必须同步。
- `specs/tech_docs/pit_of_success.md`：`local_http`、`proxy_config` helper 不变量。
- `specs/tech_docs/multi_agent_runtime.md`：external Runtime envPolicy 与 managed-provider owner。
- `specs/tech_docs/im_integration_architecture.md`：Rust IM 与 Plugin Bridge 流量边界。
- `specs/tech_docs/plugin_bridge_architecture.md`：Bridge 进程生命周期与 spawn owner。
- `specs/tech_docs/third_party_providers.md`：ProviderRoute、ProviderEnv、Managed Codex provider 边界。
- `specs/DESIGN.md`：设置页浮层、复选行、颜色/字号/i18n 规范。
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`：如实施触及 MCP env，`McpStdioServerConfig.env` 与 remote MCP config 是当前 SDK 类型权威。

## 执行台账

### 需求契约

- 必赢场景：自定义范围保存“通用网络请求关闭 + 一个或多个模型供应商开启”后，通用请求继承系统网络，而被选中的 Provider 仍使用 MyAgents 应用代理；HTTP 与 SOCKS5 都必须成立。
- 既有抽象：共享层 `ProxyScopeSettings` / `proxyScope` 纯函数；Rust `proxy_config` 的 generic/provider-aware helper；Node `proxy-state` 的继承环境快照、SOCKS bridge 与 Provider policy；现有 `cmd_propagate_proxy`、Sidecar/Runtime restart owner、IM/Plugin Bridge lifecycle；Settings disk-first `patchProxySettings()`。
- 反向边界：不做服务/域名级规则，不做强制直连，不改变 localhost 绕过，不给 WebView/系统浏览器增加代理，不对 opaque SDK/Runtime 内部流量承诺包级拆分，不新增代理进程或第二份配置权威。
- 新概念：仅增加 `scope.custom.generalRequests` 这一独立布尔维度；Node 内部显式拆开 immutable inherited baseline、app-proxy overlay、general process env 三种已有语义，不增加产品层级概念。
- 红线：旧 custom 缺字段必须等效 `generalRequests:true`；显式零范围不得回退 all；全 Provider + general=false 不得折叠 all；Provider 删除不得翻转通用选择；general-only 变化不得误重启 builtin/managed-provider；Provider selected + general=false + SOCKS5 必须仍可取得 bridge；未选择只代表 inherited，不得使用 `.no_proxy()` 强制直连；不得泄露代理凭据。

### 阶段与行动清单

- [x] Phase 0：读取完整 PRD，建立需求契约与执行台账。
- [x] Phase 1：读取强制架构/技术/设计文档，审计现有实现与用户脏改重叠面。
- [x] Phase 2：实现 shared 配置归一化、决策函数与单元测试。
- [x] Phase 3：实现 Rust generic/provider 分流、传播 payload、下载/Updater/Terminal/长驻 owner 生效边界与测试。
- [x] Phase 4：实现 Node inherited/overlay/general 三基线、SOCKS bridge 初始化与 2×2/热更新测试。
- [x] Phase 5：实现 Settings UI、摘要、i18n 与 DOM 测试。
- [x] Phase 6：更新 `proxy_config.md`，完成全仓调用点 owner audit。
- [x] Phase 7：运行 typecheck、scoped lint、deterministic tests、Rust fmt/tests/clippy 与 Web/Server/Bridge build。
- [ ] Phase 7b：在具备真实 HTTP/SOCKS5 代理和 Provider/IM 凭据的环境执行 §9.6 真机 smoke（当前环境不具备；不阻断 deterministic 实现 Review）。
- [x] Phase 8：需求复核；调用 `cross-review-code` 完成需求、对抗正确性、架构三路独立 Review，修复后复验。
- [x] Phase 9：更新 PRD 状态/产品总结，精确暂存本需求文件并 Conventional Commit。

### 基线与预计范围

- Phase base HEAD：`7e019464b13701becd5abb114337030ebd0c4761`。
- 预计修改：PRD §12.1 所列 shared、renderer、Rust、Node 与 `specs/tech_docs/proxy_config.md`；只有 owner audit 证明必要时才触及 §12.2 文件。
- 已有重叠脏改：`src/server/agent-session.ts`、`specs/ARCHITECTURE.md`、`specs/tech_docs/multi_agent_runtime.md`。本功能不计划修改后两份权威文档；`agent-session.ts` 若必须修改，只暂存本需求新增 hunk。其余当前 dirty/untracked 文件均视为用户工作，不纳入本任务提交。

### 用户决策

- 2026-07-15：术语定为“通用网络请求”，指所有非模型 Provider-owned 的既有通用请求 owner，不等同于“MyAgents 一方服务”。
- 2026-07-15：自定义范围允许通用项单独开/关、Provider 单独开/关，也允许零项选择。
- 2026-07-15：未选择语义为“不使用 MyAgents 应用代理、继承系统网络”，不是强制直连。
- 2026-07-15：应用更新、Managed Codex Runtime 下载、Space/Analytics、IM、MCP/工具下载、Petdex、LiteLLM/GitHub 等归通用；模型供应商 API 才归 Provider。
- 2026-07-15：任意用户提供的 raw ZIP 下载保留 DNS-pinned direct SSRF 边界；受信任 GitHub codeload 才应用 general。该安全例外不扩张为产品级域名规则。

### 进展日志

- 2026-07-15：确认 PRD 完整、自带实现边界与测试矩阵；记录工作区 base HEAD 和已有脏改重叠风险，尚未修改产品代码。
- 2026-07-15：完成 shared / Rust / Node 双维度代理语义；旧 custom 缺字段保持 general=true，新 custom 可表达 general-only、provider-only 与 zero scope。
- 2026-07-15：Rust generic helper、Updater、Terminal、Managed Codex 下载与 IM/Plugin Bridge lifecycle 已接入 general owner；Provider helper 与 managed runtime 继续独立。
- 2026-07-15：Node 拆分 inherited snapshot、app-proxy overlay、general process env；HTTP/SOCKS5 2×2、stale generation、Plugin Bridge general-only 初始化与 generic fetch 显式 dispatcher 已覆盖测试。
- 2026-07-15：Settings 完成置顶“通用网络请求”、全选/零选择、摘要、中英文文案与 DOM 测试；权威代理文档和 pit-of-success helper 边界已同步。
- 2026-07-16：全工作区最终验证通过：2625 unit（另 3 skipped）、522 DOM、287 integration、723 Rust lib tests，Rust fmt、目标 clippy、TypeScript typecheck、全仓 ESLint/dependency-cruiser 与 Web/Server/Bridge builds。为排除并行 OAuth 脏改影响，另对精确暂存快照独立验证：TypeScript typecheck、全仓 lint、49 个相关 unit、2 个 DOM、10 个 integration 与 722 个 Rust lib tests 全部通过。dependency-cruiser 仅保留仓库既有 `chatSuggestions.ts` orphan warning。真机外部代理 smoke 需要具备 HTTP/SOCKS5 代理与真实 Provider/IM 凭据的环境，当前回合未执行。
- 2026-07-16：requirements、adversarial correctness、architecture 三路独立 Review 全部 PASS。复审期间按根因收敛 IM replacement：单一 keyed lifecycle boundary、锁后 disk-first 配置、model-work idle gate、连续 generation 收敛、pending cron queue 跨 replacement 与跨 private target 排空；未引入代理专用 manager、状态机或重试层。
