---
name: support
description: >-
  MyAgents 用户问题诊断与支持工作流。用户只要描述报错、异常、功能不动、界面崩溃、任务没跑、
  IM/Agent 不回复、MCP/Provider/Runtime/插件/工具/媒体产物不可用，或者前端"召唤小助理"注入诊断请求，
  就使用这个 skill。先取证、再分类、再修复或产出 bug report；不要基于猜测直接改配置。
---

# MyAgents Support

你正在处理用户本地 MyAgents 实例的问题。支持工作的价值不在于背错误表，而在于把本地证据、CLI 诊断、日志时间线和 MyAgents 架构边界串起来。

## 总原则

1. 先理解主诉，再取证。用户描述不清时，先问发生时间、复现步骤、影响范围。
2. 先用低风险证据：`status`、`version`、列表、日志。把 active probe 和写操作留到需要时。
3. 任何配置修复优先走 `/myagents-cli`，不要直接改 `config.json`。
4. 报告和日志必须脱敏。API Key、Token、Secret、Webhook query secret 都不能原样输出。
5. 给用户的解释可以通俗；给开发者的 bug report 要保留精确术语和证据。

## Step 1 - 基线取证

先收集环境和最近启动信息。不要因为某条命令失败就停住，记录失败原因后继续。

```bash
myagents status --json
myagents version
rg '\[boot\]' ./logs/unified-*.log | tail -5
```

如果没有 `rg`，用：

```bash
grep '\[boot\]' ./logs/unified-*.log | tail -5
```

如果日志文件不存在，说明“本地还没有 unified log 或路径不可用”，继续用 CLI 和用户复现信息取证。

## Step 2 - 选择问题域并读取 reference

根据主诉读取下面最相关的 reference。只读需要的文件；跨域问题再追加读取。

| 主诉 | 读取 |
|---|---|
| Codex/Gemini/Claude Code 不工作、终端能用但 MyAgents 不行、runtime/model/permissionMode 异常 | `references/runtime.md` |
| Provider 验证失败、API Key/模型不可用、MCP 工具启动/登录/握手失败 | `references/provider-mcp.md` |
| Telegram/钉钉/飞书/微信/QQ Agent 不在线、社区插件装不上或登录后不生效 | `references/agent-channel-plugin.md` |
| 定时任务没执行、任务中心卡住、想法/任务状态异常、需要跨 session 反馈 | `references/automation.md` |
| 图片/音频/PDF 等工具产物生成了但不显示、Codex image_generation 没图、IM 媒体没发出 | `references/attachments.md` |
| 工作区文件树/搜索/预览、@ 文件或图片、拖拽/粘贴附件、新建/重命名/删除/移动文件不正常 | `references/workspace-files.md` |
| AI 不回复、sidecar 重启、pre-warm、历史恢复、回溯/分叉异常 | `references/session-sidecar.md` |
| 网络/代理、Provider 可达性、npm 拉包、终端和 MyAgents env 差异 | `references/proxy-env.md` |
| 白屏、整页“界面渲染出错”、点击某处 UI 崩溃 | `references/frontend-render.md` |
| 功能入口不存在、设置项看不到、Runtime/CLI 工具注册表/实验功能没出现 | `references/feature-gates.md` |
| 桌面宠物/悬浮窗打不开、一直“正在连接 Mino”、提示 `Global sidecar startup timeout`、悬浮窗能打开但不能对话 | 先按本文件“桌面宠物 / 悬浮窗”小节查日志，再视结果转 `references/session-sidecar.md` 或 `references/frontend-render.md` |

## Step 3 - 被动证据 vs active probe

被动证据通常安全：
- `myagents status --json`
- `myagents version`
- `myagents <group> list --json`
- `myagents <group> show/get ... --json`
- `myagents runtime list --json`
- `myagents runtime describe <runtime> --json`
- 日志 grep/rg
- 脱敏读取相关配置

active probe 会实际连接外部服务、启动进程、消耗请求或弹浏览器，应先说明目的：
- `myagents model verify <provider>`（API Key Provider 的现场验证；订阅 Provider 先看 provider 状态和日志，不能把“无 API Key”误判成失败）
- `myagents mcp test <id>`
- `myagents mcp oauth start <id>`
- `myagents runtime diagnose codex --workspacePath <path> --json`
- `myagents cron run-now <id>`
- 插件安装、Channel 登录、任何写操作

## Step 4 - 建时间线

日志不够时，按这条链重建：

```text
用户动作/时间
  -> [REACT] UI 或请求
  -> [RUST] proxy / sidecar / management / IM / cron
  -> [NODE] Sidecar / Provider / MCP / Runtime / SDK
  -> 返回 UI、IM、cron run 或 session history
```

优先查最近时间窗口，不要全日志漫游。先用用户提供的时间、`sessionId`、`workspacePath`、runtime/provider 收窄。前端“召唤小助理”注入的 Terminal Reason / Runtime Diagnostics 是第一份证据，但仍要用日志补全发生前后的时间线。

常用模式：

```bash
rg -n "ERROR|WARN|auth error|401|403|provider/verify|subscription/verify|terminal_reason|AppErrorBoundary|external-session|runtime_diagnostics|RuntimeDiagnostics|runtimeSource|managed-codex|codex-sub|anthropic-sub|subscription|CronTask|bridge|tool-attachment|ToolAttachment|cmd_workspace|workspace_files|DirectoryPanel|SimpleChatInput|attachment" ./logs/unified-*.log | tail -160
```

### 桌面宠物 / 悬浮窗

悬浮窗由独立 Tauri WebView 承载，不挂主窗口 `App.tsx`。排查时不要假设主窗口日志和悬浮窗日志一定在同一个 renderer 生命周期里；统一日志里应能看到这些前缀：

- `[fb-ball]`：桌宠球窗口启动、日志接入。
- `[fb-companion]`：展开后的悬浮对话窗启动、日志接入。
- `[fb-session]`：悬浮窗会话链路，包括 boot、mint session、ensure sidecar、sync config、connect SSE、history load、send。
- `[tauriClient] Global sidecar`：Global Sidecar URL 获取、等待、超时。

用户说“桌宠一直显示正在连接 Mino”或看到 `Global sidecar startup timeout` 时，先查最近窗口：

```bash
rg -n "fb-ball|fb-companion|fb-session|Global sidecar|正在连接 Mino|startup timeout|cmd_get_global_server_url" ./logs/unified-*.log | tail -160
```

判断顺序：

1. 没有 `[fb-companion] window boot`：悬浮窗 WebView 可能没创建或前端入口崩了，转前端渲染/窗口创建方向查。
2. 有 `[fb-companion] window boot` 但没有 `unified log sink ready`：重点查 Global Sidecar 是否启动、`cmd_get_global_server_url` 是否返回 URL、是否有 Rust sidecar 启动错误。
3. 有 log sink ready 但 `[fb-session] boot failed`：看失败 stage。`mint-session` 常指 Global Sidecar/API 创建 session；`ensure-session-sidecar` 指 Session Sidecar；`sync-config` 指 MCP/Agent 配置同步；`connect-sse` 指 SSE。
4. Windows 上只看到 `Global sidecar startup timeout` 时，不要只把结论写成“sidecar 慢”。要确认是否有 Rust `[boot]`、Global Sidecar 启动/崩溃日志，以及悬浮窗是否拿到了 cross-WebView 的 Global Sidecar URL。

## Step 5 - 分类

| 类型 | 判断依据 | 行动 |
|---|---|---|
| 配置错误 | Key/URL/模型/开关/Channel 凭证/MCP env 明显错误 | 用 `/myagents-cli` 修，修完验证 |
| 环境问题 | 网络、代理、PATH、runtime 安装、npm registry、OAuth 状态问题 | 给出具体修复路径，必要时 active probe |
| 使用困惑 | 日志正常，用户误解功能边界或生效时机 | 解释边界，并用 CLI 直接帮用户完成可完成部分 |
| 实验门控 | 功能默认关闭或只能人工打开 | 解释开关位置，不绕过人类可见门控 |
| 产品 bug | 崩溃、状态不一致、可复现 unexpected、配置无法解释 | 产出 bug report，询问是否提交 |
| 无法判断 | 证据不足但问题存在 | 追问复现；仍不明则按未知 bug 报告 |

## Step 6 - 修复与验证

修复前：
- 写操作先用 `--dry-run`，除非命令不支持。
- 删除、覆盖、重置、重新登录前必须确认对象。
- 用户没有提供密钥时，不要追问密钥明文；引导去设置页输入，或说明可以在本轮提供后由你写入。

修复后：
- 再跑对应的 read/list/status/verify/test。
- 告诉用户实际改了什么、现在状态是什么、是否需要新开 session 或发新消息生效。

## Bug report 模板

先把报告给用户看，得到确认后再提交 issue 或打开 issue 页面。

```markdown
## 环境信息
- boot: ...
- myagents version: ...
- myagents status: ...

## 用户主诉
...

## 复现步骤
1. ...
2. ...

## 关键日志（已脱敏）
...

## 已检查配置（已脱敏）
...

## 分析结论
- 已确认：
- 推测：
- 已排除：
```

## 已知非问题

这些现象单独出现时不要误报 bug：
- 短暂 `Connection error - cannot establish connection`：sidecar 重启窗口，持续复现才排查。
- `pre-warm failed`：首消息会慢；反复失败或影响工具列表再查 MCP/Provider。
- `terminal_reason=completed`：本轮正常结束。
- 回溯无文件 checkpoint：该回复没改文件，回溯消息仍可正常工作。
- CLI 工具注册表关闭时 `myagents tool --help` 只显示开启指引：实验门控正常行为。
