# Provider 与 MCP 诊断

使用场景：API Key 验证失败、模型不可用、回复报错、MCP 工具不显示、MCP 启动/登录/握手失败。

## Provider

### Ground truth

- Provider 验证有 30 秒 timeout。真实 401 可能晚于 UI 的“验证超时”出现在日志里。
- Provider 的 authType、baseUrl、模型列表、上下文窗口可能变化，不要靠内置静态表猜。
- 验证请求是 active probe，会实际请求供应商。
- Provider 不全是 API Key 路径。`anthropic-sub` 是 Anthropic 订阅 Provider，`codex-sub` 是 runtime-backed Provider；不要要求用户提供 API Key 来修订阅 Provider。
- `codex-sub` 会创建 `runtime=codex` + `runtimeSource=managed-provider` 的会话。它不是用户系统安装的 Codex CLI，也不受 `multiAgentRuntime` 实验开关控制。

### 取证

```bash
myagents model list --json
rg -n "provider/verify|subscription/verify|api/provider/verify|auth error|401|403|验证超时|model_error|terminal_reason|anthropic-sub|codex-sub|subscription|managed-codex|runtimeSource=managed-provider|entitlement|Extra usage|usage credits" ./logs/unified-*.log | tail -160
```

API Key Provider 需要现场重测时：

```bash
myagents model verify <provider-id> --json
myagents model verify <provider-id> --model <model-id> --json
```

订阅 Provider 优先用 `model list` 和日志看状态。如果 CLI 没有明确支持订阅 Provider 的 verify，不要把 “缺 API Key / 不支持 verify” 当成 Provider 失败本身。

### 判断

- UI 显示 timeout，但日志有 `auth error` / `401`：按 Key/认证问题处理，不报产品 bug。
- `403` 或 quota/rate limit：让用户查供应商后台权限、余额、额度、地区限制。
- Base URL 错误或 OpenAI/Anthropic 兼容路径混用：用 `model list/show` 与配置核对。
- `anthropic-sub` 报错：按订阅登录、账号权益、模型/上下文 entitlement 查，不要走 API Key 修复路径。1M context 相关错误通常是账号权益或 extra usage 配置问题。
- `codex-sub` 报错：同时看 Provider 状态和 managed Codex runtime。关键词是 `[managed-codex]`、`codex-sub`、`subscription`、`runtimeSource=managed-provider`。
- “以前能用现在不行”：查 provider verify cache、供应商状态、最近代理变更和日志时间线。

## MCP

### Ground truth

- MCP 配置在 session 启动时绑定。新增/启用/改 env 后，通常要发下一条消息或新 session 才能被 AI 看到。
- `mcp test` 是 active probe，会启动或连接 MCP server。
- OAuth MCP 需要查授权状态，enabled 不等于 token 有效。
- 外部 Runtime 的 MCP 可能不走 MyAgents MCP。Codex MCP 归 Codex 自己管理。

### 取证

```bash
myagents mcp list --json
myagents mcp show <mcp-id> --json
myagents mcp oauth status <mcp-id> --json
rg -n "\\[mcp\\]|MCP|mcp.*failed|command not found|oauth|tool_use|tool_result" ./logs/unified-*.log | tail -120
```

需要现场握手时：

```bash
myagents mcp test <mcp-id> --json
```

### 判断

- `command not found`：先看 MCP command 是否拼错，再看 PATH。MyAgents shell 有 bundled Node/npx 兜底，但用户自装 CLI 仍可能不在 PATH。
- 远程 MCP timeout：查 URL、代理、证书、服务端可达性。
- OAuth 过期：用 `mcp oauth status` 证实，再引导 `oauth start`。
- 工具刚配置但 AI 当前轮看不到：正常生效时机，告知“发条新消息后可用”。
- 工具调用有结果但 UI 不显示媒体：转 `attachments.md`。
