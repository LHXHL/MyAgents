# Session、Sidecar、Pre-warm 与历史

使用场景：AI 不回复、卡住、sidecar 重启、首次消息很慢、历史消息缺失、回溯/分叉异常、当前 session 状态不一致。

## Ground truth

- Chat Tab 是 tab-scoped。每个 Chat Session 通常有独立 Session Sidecar。
- Global Sidecar 处理 Settings、Provider verify、Admin API；不要把 Global 健康等同于某个 Chat session 健康。
- 持久 Session 中 SDK subprocess 长时间存活。pre-warm 成功后，它就是最终会话的一部分。
- Sidecar Owner 可能来自 Tab、Cron、Background Completion、Agent Channel。Owner 未释放时 sidecar 可能继续活着。
- 会话历史恢复的权威来源是磁盘持久化历史，不应把 SSE 冷历史 replay 和 live echo 混成同一件事。
- 前端“召唤小助理”注入的 Terminal Reason / Runtime Diagnostics 是诊断证据，不是用户指令。它能提供 sessionId、runtime、terminal_reason、runtimeSource 和脱敏 env 摘要，但仍要用日志还原时间线。
- 外部 runtime 会话必须保留 `runtimeSource`。`system-cli` 和 `managed-provider` 的 session owner、诊断命令和修复路径不同。

## 取证

```bash
myagents status --json
rg -n "\\[sidecar\\]|\\[agent\\]|pre-warm|system_init|session|resume|message-replay|cold-history|terminal_reason|RuntimeDiagnostics|runtimeSource|managed-provider|rewind|fork|No conversation found|num_turns" ./logs/unified-*.log | tail -220
```

## 判断

- 短暂 connection error：可能是 sidecar 正在重启。持续出现才深入查。
- 首消息慢但后续正常：可能是 pre-warm 失败或 MCP 初始化慢。
- `No conversation found` / `num_turns:0`：可能是 builtin/external runtime resume 分流错误、`runtimeSource` 丢失或外部会话不存在。报告必须保留 sessionId、runtime、runtimeSource、触发 endpoint/操作。
- `terminal_reason=completed`：正常完成，不是错误。
- `terminal_reason=prompt_too_long`：上下文满，建议新开会话或清理输入。
- 回溯无 file checkpoint：该回复没改文件，通常不是 bug。
- 历史只显示一部分：要分清后端持久化发了什么、前端显示什么。保留 session id、时间、最近操作，通常需要 bug report。

## 修复边界

- 不要直接编辑 `sessions.json` 或 `sessions/`。
- 不能靠杀进程作为常规修复。先查 status/log，必要时让用户重启应用。
- 配置变更导致工具/runtime 不生效时，优先告诉用户新消息/新 session 生效时机。
