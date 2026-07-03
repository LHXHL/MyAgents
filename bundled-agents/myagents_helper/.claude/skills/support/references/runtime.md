# Runtime 诊断

使用场景：Codex / Gemini / Claude Code 不工作；用户说“终端能用，MyAgents 里不行”；外部 Runtime 的模型、权限、MCP、connector、代理状态异常。

## Ground truth

- 外部 Runtime 有两个来源，诊断时必须保留 `runtimeSource`：
  - `system-cli`：用户系统里安装和登录的 Claude Code / Codex / Gemini CLI，受实验室开关 `multiAgentRuntime` 控制。关闭时 system-cli Runtime 配置不会生效，Agent 实际跑 builtin。
  - `managed-provider`：由 MyAgents Provider 管理的 runtime-backed provider，典型是 `codex-sub`。它不受 `multiAgentRuntime` 门控，而由 Provider readiness gate 控制。
- 不同 Runtime 的 model 和 permissionMode 值域不同，不要把 builtin 的 `auto/plan/fullAgency` 套到 Codex/Gemini。
- system-cli Codex 以 app-server JSON-RPC 持久进程运行。Codex 的 MCP 由 `~/.codex/` 管，不由 MyAgents MCP 配置注入。
- `codex/system-cli` 和 `codex/managed-provider` 是两种会话身份。只看到 `runtime=codex` 不足以判断问题路径。
- Gemini 走 ACP。Claude Code 走自己的 CLI 协议。
- 外部 Runtime 的 env/proxy/PATH 可能与用户交互式终端不同，不能靠 `codex --version` 判断完整可用性。

## 取证命令

被动发现：

```bash
myagents runtime list --json
myagents runtime describe codex --json
myagents runtime describe gemini --json
myagents agent list --json
myagents agent show <agent-id> --json
```

system-cli Codex active probe：

```bash
myagents runtime diagnose codex --workspacePath <absolute-workspace-path> --json
```

这个命令会启动短命 Codex app-server，读取 Codex 自己看到的 auth、experimental features、MCP server status、apps 和 effective env。它可能启动进程、读取 Codex 配置、触发 Codex 侧检查，执行前要说明目的。

如果会话来自 `codex-sub` / `runtimeSource=managed-provider`，不要把 `runtime diagnose codex` 的结果直接当作该会话证据。先查 Provider 和 managed Codex 日志，确认安装、订阅登录和 Provider readiness。

日志：

```bash
rg -n "MYAGENTS_RUNTIME|external-session|external-runtime|runtime_diagnostics|chat:runtime-diagnostics|RuntimeDiagnostics|runtimeSource|managed-provider|managed-codex|codex-sub|Codex|Gemini|ACP|app-server|envPolicy" ./logs/unified-*.log | tail -160
```

## 判断要点

- system-cli `runtime list` 未安装：这是环境问题，按 CLI 的 recovery hint 处理。
- system-cli 实验室开关关闭：解释“更多 Agent Runtime”默认关闭，不要用 `config set` 绕过。`codex-sub` 是 Provider 路径，不按这个门控判断。
- `runtime describe` 失败：先按 recovery hint 跑；可能是 CLI 探测超时、runtime 不在 PATH、runtime 本身启动慢。
- system-cli Codex auth 不健康：让用户在 Codex 自己的登录方式里修复；MyAgents 不应伪造 Codex 登录状态。
- managed Codex / `codex-sub` 不健康：查 `[managed-codex]`、`codex-sub`、`subscription`、`runtimeSource=managed-provider`，重点是 MyAgents 管理的 runtime 版本、订阅登录状态和 Provider readiness。
- Codex MCP/apps 不可达：看 `runtime diagnose` 的 `mcpServerStatus` / `apps`，不要查 MyAgents MCP 配置误判。
- `effectiveEnv.proxyPolicy=terminal` 但 proxy 为空：说明用户 shell 里也没有导出 proxy，不是 MyAgents 漏注入。
- builtin runtime 不受 external `envPolicy` 影响。Provider 网络问题应走 provider/proxy 路径。

## 修复边界

- 可以用 CLI 调整 Agent 的 runtime/model/permissionMode，但写之前先 `agent show` 和 `runtime describe`。
- 不要猜外部 Runtime 的模型名。每次都用 `runtime describe` 查。
- 不要把 Codex/Gemini 的 MCP 问题归到 MyAgents MCP，除非证据显示调用的是 MyAgents builtin runtime。
