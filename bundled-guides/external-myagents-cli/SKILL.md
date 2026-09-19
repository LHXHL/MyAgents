---
name: external-myagents-cli
description: >-
  MyAgents App 提供给本机外部 AI 或自动化程序的公开 CLI 契约。仅在交接 Prompt
  明确要求时读取；使用 Prompt 给出的绝对 CLI 路径和进程环境中的
  MYAGENTS_API_TOKEN 操作 MyAgents，不依赖 PATH，也不尝试内部命令。
metadata:
  author: MyAgents
---

# MyAgents 外部 CLI

你是运行在 MyAgents 之外的本机 AI 或自动化程序。这份文件只说明 token 鉴权的公开 CLI；它不是 MyAgents 内部 `myagents-cli` skill，也不会授予内部 Session 身份。

## 先遵守这些边界

1. 始终使用交接 Prompt 给出的 **MyAgents CLI 绝对路径**。不要假设 PATH 中存在 `myagents`，也不要自行搜索或改写 launcher。
2. MyAgents App 必须保持运行，并在「设置 → 外部调用」开启访问。
3. 访问 token 只从进程环境变量 `MYAGENTS_API_TOKEN` 读取。不要要求用户把真实 token 发进对话；不要打印、记录、持久化 token，也不要把它作为 CLI 参数。
4. 只调用本文列出的公开命令。token 不会解锁 MyAgents 内部命令、当前 Session 身份或隐藏 API；不要探测端口、伪造来源 Session、直接请求 localhost 管理路由。
5. 不熟悉参数时，先运行精确的逐级 `--help`。帮助文本是当前安装版本的参数权威；本文负责选择能力与解释业务语义。

下文用 `<CLI>` 代表交接 Prompt 给出的绝对 CLI 路径。实际执行时必须替换成该路径，并按当前 shell 的规则安全引用它。例如 POSIX shell 使用 `"/absolute/path/myagents" ...`，PowerShell 使用 `& "C:\\...\\myagents.cmd" ...`。

## 开始前检查

```text
<CLI> --help
<CLI> status --json
<CLI> version --json
```

- `--help` 可在 Host 不可用时显示固定公开清单。
- 业务命令建议加 `--json`；stdout 会给出一份机器可解析的 JSON，诊断信息走 stderr。
- 退出状态 `0` 只表示该命令达到自身定义的成功边界；任何非零状态都必须按失败处理，不能因为 stdout 有 JSON 就声称成功。业务拒绝、参数/校验错误、Session admission/delivery 失败和 Host 不可用可能使用不同非零值；精确数字以当前 leaf `--help` 为准，同时优先分支处理 JSON 中的稳定 `code`。
- `session start` / `session send` 的 transport failure 或 `admission_unconfirmed` 属于“结果不确定”，不是普通的确定失败；即使退出状态非零也不得自动重发。
- `status` 只说明 App/Host 状态，不代表某个 Session 或 Task 已完成。

## 公开能力

只有以下 canonical 命令可供外部调用。先用 `<CLI> <group> --help`，再用 `<CLI> <group> <action> --help` 核对当前版本的 flags。

### 状态与版本

```text
<CLI> status
<CLI> version
```

### Workspace Agent

```text
<CLI> agent create
<CLI> agent list
<CLI> agent show
```

- `agent create --workspacePath <absolute-path>` 把一个已存在、可访问的本地目录幂等注册成 Project-backed Workspace Agent。它不会创建目录、初始化 Git、复制模板、修改 Agent 配置或自动启动 Session。
- 路径必须是当前平台的绝对目录路径。成功 JSON 中保存 `agentId`；后续所有 Session 操作使用该 ID，不要用路径或显示名称猜 selector。
- 同一 active workspace 再次创建会返回同一个 Agent，`created=false`。归档、隐藏、内部 workspace 或 identity 冲突会 fail closed，不能擅自解档或挑一条继续。
- `agent list` 用于发现；`agent show <agentId>` 用于读取持久 identity 与 effective 默认。外部调用不能 set/archive/unarchive/enable/disable Agent。

### Runtime 发现

```text
<CLI> runtime list
<CLI> runtime describe
```

- `runtime list` 查看已安装 Runtime；`runtime describe <runtime>` 查看该 Runtime 的 model 与 permissionMode 枚举。
- 这两条命令只做发现，不修改 Provider、模型或 Runtime 配置。

### Session

```text
<CLI> session list
<CLI> session start
<CLI> session send
<CLI> session get
```

- `session list --agent <agentId>` 读取该 Agent 可见的历史 Session metadata。列表不能证明 Session 当前正在运行。
- `session start --agent <agentId> (--prompt <text> | --prompt-file <path>)` 创建隔离的新 Session，并返回新的 Product Session ID。
- `session send <sessionId> (--prompt <text> | --prompt-file <path>)` 向明确的已有 Session 续聊；不要自动选择“最近 Session”。
- `session get <sessionId> [--limit 1..500] [--before <messageId>]` 读取纯文本 user/assistant 历史。默认最近 5 条，结果按旧到新排列；thinking、工具参数/结果和隐藏协议不返回。向前翻页时把当前页第一条 message ID 作为 `--before`。
- 外部 `start` / `send` 是 one-way：成功只表示请求已接受或投递，不代表 AI 执行成功。需要观察进展时主动再次运行 `session get`；不要把旧 assistant 消息当成本次请求的答案。
- 传递多行、较长或来自外部输入的 prompt 时优先写入普通文本文件并使用 `--prompt-file`，避免 shell 转义和注入。相对 prompt 文件按调用进程 cwd 解析；cwd 不用于推断目标 Workspace。
- 若 `start` / `send` 在 transport failure 后结果不确定，保留已取得的 ID 并查询状态，**不要自动重发**；请求可能已经提交，重发会造成重复副作用。

### Task Center 与自动化

```text
<CLI> task list
<CLI> task get
<CLI> task comments
<CLI> task create-direct
<CLI> task update
<CLI> task update-status
<CLI> task run
<CLI> task rerun
<CLI> task run-now
<CLI> task start
<CLI> task stop
<CLI> task runs
<CLI> task trigger validate
<CLI> task trigger test
<CLI> task check-now
<CLI> task reset-checkpoint
<CLI> task append-session
<CLI> task archive
<CLI> task delete
<CLI> task readme
```

- 先运行 `<CLI> task readme` 和目标 leaf 的 `--help`。Task 的状态机、trigger、调度和 managed 限制仍由 MyAgents Task authority 裁决。
- 外部进程没有“当前 MyAgents Workspace/Session”上下文。命令要求 workspace identity 时必须显式提供从公开结果获得的 ID/绝对路径，不能使用 `current` 简写或 shell cwd 猜测。
- 创建复杂任务时优先把完整任务正文写入文件，再按 leaf help 使用 file flag。选择 runtime/model/permissionMode 前先运行 `runtime list` 与 `runtime describe`。
- `task start` 是恢复 schedule，`task run-now` 是立即执行；不要混淆。执行接纳不等于最终成功，用 `task get` / `task runs` 读取权威状态。
- `task trigger test` 不提交 MyAgents checkpoint/Activation 状态，但被测本地命令的外部副作用不会自动回滚。
- `task archive` 可能受“仅用户可执行”等现有权限限制；`task delete` 不承诺可恢复。执行破坏性动作前必须取得用户对具体目标的明确确认。
- 依赖当前 Task/Space/Session 执行上下文的评论、attached 创建和 AI exit 动作不属于外部公开面；不要伪造上下文。

### Record

```text
<CLI> record list
<CLI> record create
```

- `record list` 读取现有 Record。
- 创建文字 Record 时，含多行、CJK 或 shell 元字符的内容优先写入文件，并按 `record create --help` 使用 content-file 形式。
- 外部公开面不包含录音、转录、修改或删除 Record。

## 推荐主链路：目录 → Agent → Session

```text
1. <CLI> status --json
2. <CLI> agent create --workspacePath <absolute-existing-directory> --json
3. 从成功 JSON 保存 agentId
4. <CLI> agent show <agentId> --json
5. <CLI> session start --agent <agentId> --prompt-file <request-file> --json
6. 从成功回执保存 sessionId
7. <CLI> session send <sessionId> --prompt-file <follow-up-file> --json
8. <CLI> session get <sessionId> --limit 5 --json
```

ID 只能来自成功响应或公开 discovery 命令。不要猜 ID，不要把 Workspace path 当作 Agent ID，也不要把投递回执的 messageId 当作 transcript 分页锚点。

## 失败处理

- `MYAGENTS_UNAVAILABLE` / 无法连接：请用户启动 MyAgents 并等待 App ready；CLI 不会自动启动或聚焦 App。
- `external_cli_disabled`：请用户在「设置 → 外部调用」开启；不要尝试绕过。
- token 缺失或无效：请用户重新从设置页复制当前 token，并在启动你的进程环境中设置 `MYAGENTS_API_TOKEN`。token 重置后旧值立即失效。
- capability 未开放：运行顶层与逐级 `--help`，改用本文公开能力；不要尝试同名内部命令或直连 API。
- 参数、路径、目标或 lifecycle 冲突：依据 JSON `code`、错误说明与 suggestion 修正输入；不要通过重试随机选择目标。
- mutation 的响应丢失或结果不确定：先用 list/show/get/runs 等只读命令核实，不自动重放。

## 明确不做

这份外部契约不提供远程访问、App 自动启动、HTTP/OpenAPI/SDK/MCP 接口、内部 Session 身份、自动结果回调、exactly-once、自动重试、等待某次 turn 完成、目录创建、Workspace 模板/Git 初始化、Provider/MCP/Plugin/Skill/Tool/Channel/Space/Goal/Speech 管理，也不开放本文未列出的 Agent、Session、Task 或 Record 动作。

如果用户的目标只能通过未开放能力完成，明确说明“当前外部 CLI 不支持”，并让用户在 MyAgents App 或内部 Agent 中完成；不要把 token 当作扩大权限的依据。
