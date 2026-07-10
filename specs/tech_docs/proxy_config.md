# 代理配置说明

## 概述

MyAgents 支持统一的代理配置，用于访问外部服务（Anthropic API、CDN 等）。代理配置存储在 `~/.myagents/config.json` 中，由应用的「设置 - 通用 - 网络代理」管理。

---

## 🔧 配置文件格式

**路径**: `~/.myagents/config.json`

```json
{
  "proxySettings": {
    "enabled": true,
    "protocol": "http",
    "host": "127.0.0.1",
    "port": 7890,
    "scope": {
      "mode": "custom",
      "providerIds": ["deepseek", "openrouter"]
    }
  }
}
```

### 字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `enabled` | boolean | ✅ | false | 是否启用代理 |
| `protocol` | string | ❌ | "http" | 代理协议：`http` 或 `socks5` |
| `host` | string | ❌ | "127.0.0.1" | 代理服务器地址 |
| `port` | number | ❌ | 7890 | 代理服务器端口 _// 默认值: proxy_config.rs:7_ |
| `scope` | object | ❌ | `{ "mode": "all" }` | Provider 适用范围：`all` 或 `custom + providerIds` |

`scope.mode = "custom"` 只控制 **MyAgents 是否主动给该 provider 注入应用代理**。未选中的 provider 不是“强制直连”：Rust 会把注入前的 proxy env 作为 `MYAGENTS_PROXY_INHERITED_ENV_JSON` 传给 Node，Node 端 excluded provider 会恢复这个 baseline，因此系统代理 / TUN / 终端继承环境仍可自然生效。

---

## 🌐 代理应用范围

### ✅ 使用代理的场景

1. **Claude Agent SDK (Node.js Sidecar)**
   - 访问 Anthropic API (`api.anthropic.com`)
   - 通过环境变量 `HTTP_PROXY` / `HTTPS_PROXY` 注入
   - **实现**: `src-tauri/src/proxy_config.rs::apply_to_subprocess`，由 `src-tauri/src/sidecar/instances.rs` / `session_lifecycle.rs`、`src-tauri/src/im/bridge.rs` 等 spawn owner 调用。Rust 注入应用代理前会写入 `MYAGENTS_PROXY_INHERITED_ENV_JSON`，供 Sidecar provider scope 恢复继承 baseline。

2. **Provider-owned 请求 / 子进程**
   - Builtin SDK / OpenAI Bridge / provider probe / Managed Codex 等具备 provider owner 的路径按 `proxySettings.scope` 决策。
   - Builtin Anthropic subscription 的 provider owner 是 `anthropic-sub`：MyAgents 只按 scope 注入/恢复代理 env，不接管 Claude Code native 的 OAuth credential 读取/刷新。
   - **Rust 实现**: `build_client_with_proxy_for_provider` / `build_blocking_client_with_proxy_for_provider` / `apply_to_subprocess_for_provider`
   - **Node 实现**: `src/server/proxy-state.ts::applyProviderProxyPolicyToEnv` / `getProxyForProviderUrl`
   - 未选 provider：不注入 MyAgents proxy，恢复 Rust 注入前的 proxy env baseline，并保留 localhost `NO_PROXY` 保护。

3. **Rust Updater**
   - 检查更新 (`download.myagents.io/update/*.json`)
   - 下载更新包 (`download.myagents.io/releases/`)
   - **实现**: `src-tauri/src/updater.rs` + `proxy_config.rs`

   Managed Codex 的登录检查 / Runtime 子进程仍按 `codex-sub` provider scope 走代理；但 Runtime manifest / artifact 是 `download.myagents.io` 的 MyAgents 一方控制面流量。下载器先尊重当前配置 / 继承的网络路径；manifest + signature 与 artifact 的每次完整 request/body future 都由 async deadline 包住，首选路径 90 秒硬墙钟到期即取消该次传输（持续有少量字节流入也不会续期）。网络、size、SHA-256 或 minisign 任一失败后，仅对已严格验证 host/path 的 `download.myagents.io` 直连重试。直连 client 禁止 redirect，结果仍必须通过 size + SHA-256 + minisign + 平台签名全链路校验，不是通用的 proxy bypass。

   Runtime 安装锁用 pid + process start time 识别 owner；活 owner 不受锁龄影响，前一 App 进程在下载中退出时，死 owner 经过 5 秒宽限即可被下一次启动回收，不会留下 30 分钟的假“下载中”。取得安装锁后会先清理该 runtime root 下遗留的 `.download-*` 临时目录，再创建本次唯一 staging 目录，避免反复退出积累大文件。

4. **LiteLLM 模型数据缓存**
   - 拉取模型上下文窗口数据 (`raw.githubusercontent.com/BerriAI/litellm/.../model_prices_and_context_window.json`)
   - 启动条件检查 + 24h interval，ETag/If-None-Match 增量
   - **实现**: `src-tauri/src/litellm_cache.rs`（`build_client_with_proxy`）

5. **其他外部资源**
   - 下载二维码等 CDN 资源

### ❌ 不使用代理的场景

**所有 localhost 通信自动排除代理**：
- Rust → Node.js Sidecar (`127.0.0.1:31415+`) _// base/range 常量仍由 `src-tauri/src/sidecar.rs` facade 导出，分配逻辑在 `sidecar/manager.rs`_
- Tauri IPC (`http://ipc.localhost`)
- 内部进程间通信

排除列表：`localhost`, `127.0.0.1`, `::1`

---

## 🛠️ 技术实现

### 架构图

```
┌──────────────────────────────────────────────────────────┐
│                  MyAgents Application                     │
├──────────────────────────────────────────────────────────┤
│                                                            │
│  ┌─────────────────┐          ┌──────────────────┐       │
│  │  Rust Updater   │          │  Node.js Sidecar     │       │
│  │  (CDN 访问)     │          │  (SDK 访问 API)  │       │
│  └────────┬────────┘          └────────┬─────────┘       │
│           │                             │                  │
│           │ 读取配置                     │ 环境变量注入     │
│           ▼                             ▼                  │
│  ┌──────────────────────────────────────────────┐         │
│  │        ~/.myagents/config.json               │         │
│  │  { proxySettings: { enabled, host, port } }  │         │
│  └──────────────────────────────────────────────┘         │
│           │                             │                  │
│           │ 使用用户代理                 │ 使用用户代理     │
│           ▼                             ▼                  │
│  ┌─────────────────┐          ┌──────────────────┐       │
│  │  Clash / V2Ray  │          │  Clash / V2Ray   │       │
│  │  127.0.0.1:7890 │          │  127.0.0.1:7890  │       │
│  └────────┬────────┘          └────────┬─────────┘       │
│           │                             │                  │
└───────────┼─────────────────────────────┼──────────────────┘
            │                             │
            ▼                             ▼
    download.myagents.io          api.anthropic.com
```

### 代码实现

#### 1. 共享配置读取 (`proxy_config.rs`)

```rust
pub fn read_proxy_settings() -> Option<ProxySettings> {
    // 从 ~/.myagents/config.json 读取
    // 仅当 enabled=true 时返回
}

pub fn build_client_with_proxy(builder: ClientBuilder) -> Client {
    if let Some(settings) = read_proxy_settings() {
        // 使用用户配置的代理，但排除 localhost
        builder.proxy(Proxy::all(url)?.no_proxy(...))
    } else {
        // 继承系统网络行为（reqwest 默认代理检测：env vars + macOS 系统代理）
        builder
    }
}

pub fn build_client_with_proxy_for_provider(
    builder: ClientBuilder,
    provider_id: &str,
) -> Client {
    // 仅当 provider_id 命中 proxySettings.scope 时注入 MyAgents proxy；
    // 否则继承系统网络行为。
}
```

#### 2. 子进程代理注入 (`proxy_config::apply_to_subprocess`)

```rust
if let Some(proxy_settings) = read_proxy_settings() {
    cmd.env("HTTP_PROXY", proxy_url);
    cmd.env("HTTPS_PROXY", proxy_url);
    cmd.env("http_proxy", proxy_url);  // lower-case for stacks that only read those
    cmd.env("https_proxy", proxy_url);
    cmd.env("NO_PROXY", "localhost,...");
    cmd.env("no_proxy", "localhost,...");

    // Issue #194 — `ALL_PROXY` (curl-style "use proxy for everything") takes
    // precedence over HTTP_PROXY/HTTPS_PROXY in many HTTP stacks (reqwest,
    // openssl, curl). If the launching shell exported `ALL_PROXY` it would
    // shadow the proxy we inject above. Strip both casings unconditionally.
    cmd.env_remove("ALL_PROXY");
    cmd.env_remove("all_proxy");

    cmd.env("MYAGENTS_PROXY_INJECTED", "1"); // TypeScript 端区分显式注入 vs 系统继承
    cmd.env("MYAGENTS_PROXY_INHERITED_ENV_JSON", "..."); // 注入前 proxy env baseline
} else {
    // 继承系统网络行为，但始终注入 NO_PROXY 保护 Node.js 的 localhost fetch 调用。
    // 注意：未配 MyAgents proxy 时 **不** 剥离继承的 `ALL_PROXY`——
    // "未配置 = 继承系统" 的设计语义包含 system 层的 `ALL_PROXY` 设置。
    // 用户视角的对应入口是 Settings → 网络代理 关闭开关。
    cmd.env("NO_PROXY", "localhost,...");
    cmd.env("no_proxy", "localhost,...");
}
```

Provider-owned 子进程必须使用 `apply_to_subprocess_for_provider(&mut cmd, provider_id)`。它只在 provider 命中 scope 时注入 MyAgents proxy；未命中时继承系统网络行为并只补 localhost `NO_PROXY`。

Node Sidecar 内的 provider-owned 请求不得直接读 `process.env.HTTP_PROXY`：

```ts
applyProviderProxyPolicyToEnv(env, providerId);     // SDK / runtime subprocess env
getProxyForProviderUrl(providerId, upstreamUrl);   // fetch / undici ProxyAgent
```

#### 2.1 外部 Runtime 的 `envPolicy` override（PRD 0.2.16）

`apply_to_subprocess` 给所有 Rust spawn 的子进程（Sidecar、Plugin Bridge、updater、tray helpers ...）的 proxy env 设定一个**基线**。外部 AI Runtime（Claude Code CLI / Codex / Gemini）在 Sidecar 进程内再 spawn 时，可以由用户在 Agent 设置里选 `runtimeConfig.envPolicy.proxy` 进一步覆盖：

| 字面量 | 行为 | 适用场景 |
|--------|------|---------|
| `'myagents'`（默认） | 保留 Rust 注入的 proxy var——上游 Sidecar 的 `process.env.HTTP_PROXY` 已是 MyAgents 配置的代理 | 绝大多数用户 |
| `'terminal'` | 剥掉继承的 proxy var，恢复用户 interactive shell 在 `~/.zshrc` / `~/.bashrc` 里 export 的（Sidecar 启动时 `shell.ts::warmupShellPath` 抓的 8 个 var）；语义 = "等同于在你电脑的终端里手动启动这个 CLI" | 用户终端能访问的 endpoint 在 MyAgents 里访问不到；Clash TUN / VPN 用户（shell 通常无 proxy export，结果是无 proxy 注入） |

实现在 `src/server/runtimes/env-utils.ts::augmentedProcessEnv(policy)`，未知字面量 fallback 到 `'myagents'`（防御纵深）。disk 上的 envPolicy 必须通过 `env-utils.resolveAgentEnvPolicy(workspacePath)` 读取——它做 proxy 字面量校验并对未知值 warn-log，**禁止**裸 cast。

> 0.2.16 dev 阶段曾有第三档 `'direct'`（无条件剥 proxy），dogfooding 反馈选项太多后于 release 前移除。Terminal 档已覆盖原 `'direct'` 的核心 use case（TUN/VPN 用户 shell 没 proxy → terminal 模式结果就是无 proxy 注入）。存量 `'direct'` 在校验白名单里 fallback 到 `'myagents'`。

诊断面板（`RuntimeDiagnosticsBanner`）展示实际生效的 `RuntimeEffectiveEnv`，让用户直接看到 envPolicy 决定的 proxy var 落在 Runtime 子进程的具体值。详见 `tech_docs/multi_agent_runtime.md` 「Runtime 诊断 + envPolicy」节。

#### 3. Rust Updater (`updater.rs`)

```rust
let builder = reqwest::Client::builder()
    .user_agent("MyAgents-Updater/0.1.7")
    .timeout(Duration::from_secs(30));

let client = proxy_config::build_client_with_proxy(builder)?;
```

#### 4. Rust SSE Proxy (`sse_proxy.rs`)

```rust
// 访问 localhost，强制禁用代理
let client = reqwest::Client::builder()
    .no_proxy()  // 确保直连 localhost
    .build()?;
```

---

## 🔍 常见问题

### Q1: 为什么配置了代理后，localhost 还是连不上？

**A**: 不应该发生！MyAgents 已自动排除 localhost。如果遇到此问题：
1. 检查 `NO_PROXY` 环境变量是否被覆盖
2. 查看日志是否有代理相关错误

### Q2: 代理配置不生效怎么办？

**A**: 检查步骤：
1. 确认 `~/.myagents/config.json` 中 `enabled: true`
2. 重启应用（代理配置在启动时读取）
3. 查看日志：
   ```
   [proxy_config] Using proxy for external requests: http://127.0.0.1:7890
   ```

### Q3: 支持哪些代理协议？

**A**: 目前支持：
- ✅ HTTP 代理 (`http://`)
- ✅ HTTPS 代理 (`https://`)
- ✅ SOCKS5 代理 (`socks5://`) - 通过 `protocol: "socks5"` 配置

### Q4: 可以使用系统代理吗？

**A**:
- **启用应用代理** → 使用应用配置的代理
- **禁用应用代理** → 继承系统网络行为（与其他软件一致）

禁用时，应用不会主动干预网络代理设置，行为与普通软件一致：如果系统开了全局代理/TUN 模式，流量会走代理；如果系统没有代理，则直连。Localhost 通信始终直连（由 `local_http` 模块保障）。

---

## 🐛 调试

### 查看代理日志

**Rust 日志** (`~/.myagents/logs/unified-*.log`):
```
[proxy_config] Using proxy for external requests: http://127.0.0.1:7890
[proxy_config] No proxy configured, inheriting system network behavior
```

**Node.js Sidecar 日志**:
```bash
# 设置环境变量后查看
HTTP_PROXY=http://127.0.0.1:7890 bun src/server/index.ts
```

### 测试代理连通性

```bash
# 测试代理是否可用
curl -x http://127.0.0.1:7890 https://api.anthropic.com/v1/messages

# 测试 CDN 访问
curl -x http://127.0.0.1:7890 https://download.myagents.io/update/darwin-aarch64.json
```

---

## 📝 开发注意事项

### 添加新的外部 HTTP 请求

如果需要添加新的外部 HTTP 请求，请使用 `proxy_config::build_client_with_proxy`：

```rust
use crate::proxy_config;

let builder = reqwest::Client::builder()
    .timeout(Duration::from_secs(30));

let client = proxy_config::build_client_with_proxy(builder)?;
```

### localhost 请求

访问 localhost 时**必须**禁用代理：

```rust
let client = reqwest::Client::builder()
    .no_proxy()  // 强制禁用代理
    .build()?;
```

> 实践中 MUST 用 `crate::local_http::*` 连 localhost，自动注入 `.no_proxy()`。详见 `pit_of_success.md` 的「local_http」节。

---

## 代理使用场景完整列表

| 组件 | 代理来源 | 特殊处理 |
|------|---------|---------|
| Rust reqwest（HTTP proxy） | `proxy_config::read_proxy_settings()` | `local_http` 内置 `.no_proxy()` |
| Node.js Sidecar subprocess | env vars（`HTTP_PROXY` 等） | SDK 子进程继承 |
| OpenAI Bridge subprocess | **代理变量被剥离** | SDK→Bridge 是 loopback，Bridge→upstream 从 `process.env` 读代理 |
| Plugin Bridge | `apply_proxy_env()` 注入 | 与 Sidecar 相同逻辑 |
| Updater | Rust reqwest | 使用 `local_http` |

### SOCKS5 桥接机制

Node.js 的 `fetch()` 不支持 `socks5://` 环境变量。系统启动 HTTP-to-SOCKS5 桥接代理（`src/server/utils/socks-bridge.ts`）在本地随机端口，SDK subprocess 连接桥接代理而非直连 SOCKS5 服务器。

### OpenAI Bridge 代理剥离

当供应商使用 OpenAI 协议时，SDK subprocess 的 `ANTHROPIC_BASE_URL` 指向 sidecar loopback。此时**必须剥离所有代理变量**，否则 SDK 的 `fetchOptions.proxy` 会将 loopback 请求路由到系统代理（→ 超时/502）。Bridge handler 自身从 `process.env` 读取代理访问上游 API。
