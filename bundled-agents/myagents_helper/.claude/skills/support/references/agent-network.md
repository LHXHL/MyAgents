# Agent 网络与 Session 协作诊断

使用场景：同账号设备/Agent 不可见，跨设备调用、会话读取、结果回传或观察管理失败，`@` Agent 不完整或来源错误。

先读 `/myagents-docs/references/agent-network.md`。Space Issue/Delivery 异常转 `cloud-space.md`；本机 Runtime 执行异常转 `runtime.md` / `session-sidecar.md`。

## 被动取证

按实际版本的精确 help 选择只读命令：

```bash
myagents version
myagents agent network-diagnose --json
myagents agent list --json
myagents session state <完整Session-selector> --json
myagents session get <完整Session-selector> --limit 5 --json
myagents session watches --json
rg -n 'agent-network|NETWORK_|WATCH_OWNER|admission_unconfirmed|requestId|watchId|targetSession' ./logs/unified-*.log | node .claude/skills/support/scripts/redact-log-output.mjs | tail -180
```

`watches` 查询小助理当前调用方，不能替代用户另一个 Session 的观察列表。网络诊断需要双方版本、deviceId、协议能力与真实 connectionState；设备过多时按返回 cursor 继续。只收集相关目标，不读取凭据/私钥，也不把业务正文贴进报告。

## 分界判断

- 设备已加入但 Agent 不可调用：检查目标在线/目录同步、Agent 是否开放、是否归档、账号是否相同；入网与 Agent enabled 不等于开放。
- `@` 超时/不完整：两秒首屏上界、未完成来源提示与主动重试是正常行为。空搜索不列文件；打开面板期间目录变化不自动插入。稳定缺失本机项才沿本地 identity/Workspace 查。
- `NETWORK_METADATA_INVALID` / 协议校验失败：核对双方客户端和协议，尤其是旧端不能识别的字段；不通过编辑包或 store 绕过校验。
- start/send 接纳未知：可能已执行，保留 requestId/messageId/Session selector，先读历史和 activity，不自动重发。
- 已接纳但未完成：查实际消费/turn/terminal，不能凭 CLI exit 0、HTTP 2xx 或 idle 判成功。手动 turn 队列不应阻塞可实时消费的 Inbox。
- `waiting_user_action`：目标的用户需审批、确认或回答；不远程代批，不改权限来绕过。
- 回传缺失：区分目标未消费、执行未结束、原连接已失去关联、回传已进入来源 Inbox。真实断线无离线补投，但目标已接纳执行可能继续。
- watch 返回最近历史：按 live/history/none/unavailable 和原 terminalStatus 判断；不是对特定请求的完成证明。
- 取消观察后仍见结果：unwatch 不取消 start/send 自动回传，也不撤回已进入 Inbox 的消息；观察清理与对方进程不是跨进程原子事务。
- `WATCH_OWNER_UNAVAILABLE` / 活跃会话读取失败：确认目标 Session owner 路由与双方版本，不用调用方或 Global 状态替代目标。

## 恢复与报告

只读查询可按错误提示重试；发送工作、加入/退出、开放设置与停止执行需有明确目标和用户授权。不要用发送第二份 prompt 当读链路 probe，也不要让用户删历史、网络关联或私钥。

恢复后从原来源、原目标与原命令核对发现 → 接纳 → 消费 → terminal → 回传；仅网络显示 online 不够。报告保留双方版本/OS、设备、完整 selector、request/Session/turn/watch ID、首个失败 stage/code 与脱敏时间线。开发协议或云服务部署状态不明时明确记录，不承诺旧设备兼容。
