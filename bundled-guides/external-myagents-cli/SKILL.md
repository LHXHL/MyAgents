---
name: external-myagents-cli
description: >-
  为不了解 MyAgents 的本机外部 AI 补充产品背景、能力模型和公开 CLI 使用方式。
  收到 MyAgents 设置页的交接 Prompt 后读取；使用其中给出的绝对 CLI 路径和
  MYAGENTS_API_TOKEN 操作 Workspace Agent、Session、Task、Record 与 Runtime 发现。
metadata:
  author: MyAgents
---

# MyAgents 外部调用指南

## 1. MyAgents 是什么

MyAgents 是一个在用户电脑上运行的桌面 Agent 产品。它把本地目录、AI 执行环境和长期工作状态组织成几个可以组合的产品实体：

- **Workspace Agent**：绑定一个已有本地目录的长期 Agent 身份。它是工作区、默认 Runtime 和后续 Session 的稳定地址。
- **Session**：某个 Agent 下相互隔离的对话与执行上下文。可以新建干净上下文，也可以向已知 Session 继续发送任务并读取文本历史。
- **Task**：可持久化、可执行、可调度的工作项。适合待办、一次性执行、定时执行和满足条件后激活的自动化。
- **Record**：轻量的信息收集入口，用来保存文字记录，之后可以再整理或转成 Task。
- **Runtime**：真正执行 Agent 的运行环境。MyAgents 可以发现本机已支持的 Runtime，以及它们各自可用的模型和权限模式。

MyAgents App 是这些状态和执行生命周期的本机 Host；CLI 只是调用入口。你是运行在 MyAgents 之外的 AI，能够通过公开 CLI 委托和观察工作，但不会因此获得 MyAgents 内部 Session 身份、全部管理能力或隐藏 API 权限。

MyAgents 产品内部还可以管理模型 Provider、MCP/工具、Skill/Plugin、IM Channel、Cloud Space、Goal、文档与语音等能力；它们帮助 Agent 接入模型、工具、外部沟通渠道和更丰富的工作流。但当前外部 token 契约只开放本文后面介绍的 Agent、Runtime discovery、Session、Task、Record 和状态查询。知道某项产品能力存在，不等于可以从外部 CLI 调用它。

## 2. MyAgents 能解决什么任务

把这些能力组合起来，可以完成几类典型工作：

| 用户意图 | 能力组合 | 结果 |
| --- | --- | --- |
| 让一个本地项目拥有可持续对话的 AI | 注册目录为 Workspace Agent → 新建 Session → 后续 send/get | 获得稳定 Agent ID 和可继续的独立上下文 |
| 把一件工作交给另一个 Agent 完成 | 找到目标 Agent → start 新 Session → 保存 Session ID → get 结果 | 当前 AI 不需要自己进入目标工作区 |
| 创建待办、定时任务或条件自动化 | 明确 Workspace → 创建 Task → 配置/启动 → get/runs 查看状态 | 工作进入 MyAgents 的持久 Task 生命周期 |
| 先记下来，稍后再处理 | 创建 Record → 后续查看并整理为 Task | 信息不会只停留在当前对话里 |
| 在创建 Task 前选择执行环境 | runtime list/describe → 使用返回的合法值 | 避免猜测 Runtime、模型或权限模式 |

最常见的主链路是：

```text
已有本地目录 → Workspace Agent → Session start → Session send → Session get
```

Task 和 Record 可以在这条链路之外保存更长期的工作意图；Runtime discovery 用来了解当前机器真实支持的环境，并为支持 override 的 Task 选择合法值。Session 始终继承目标 Agent 已有的执行配置，外部调用不能临时覆盖。

### 开始调用前

1. MyAgents App 必须保持运行。
2. 用户在 MyAgents 的「设置 → 外部调用」中开启 **MyAgents CLI 外部调用**。
3. 用户从同一页面复制访问 token，并把它注入启动你的进程环境。你不能通过 CLI 读取 token，也不应要求用户把真实 token 发进对话。
4. 始终使用交接 Prompt 给出的 **CLI 绝对路径**。普通终端和外部 Agent 的 PATH 不保证能发现 `myagents`。

POSIX shell：

```sh
export MYAGENTS_API_TOKEN="<token>"
```

PowerShell：

```powershell
$env:MYAGENTS_API_TOKEN = "<token>"
```

下文用 `<CLI>` 代表交接 Prompt 给出的绝对路径。实际执行时替换它，并按当前 shell 安全引用路径：POSIX 可用 `"/absolute/path/myagents" ...`，PowerShell 可用 `& "C:\\...\\myagents.cmd" ...`。

### 先用帮助发现，再调用

不要靠记忆猜参数。按层级读取当前安装版本的帮助：

```text
<CLI> --help
<CLI> agent --help
<CLI> agent create --help
```

- 顶层帮助列出当前外部公开能力。
- group help 用来选择子功能；leaf help 是 flags、输入要求和失败语义的权威。
- 业务调用优先加 `--json`。stdout 返回一份机器可解析 JSON，诊断信息走 stderr。
- 退出状态 `0` 只表示该命令达到自身定义的成功边界；非零状态必须按失败处理，并优先读取 JSON 中的稳定 `code`。精确退出码以 leaf help 为准。

## 3. CLI 能力入口

### App 状态与版本

适合在工作开始前确认 MyAgents Host 是否可用，以及记录当前 App 版本。

```text
<CLI> status --json
<CLI> version --json
```

`status` 只表示 Host 状态，不代表某个 Session 或 Task 已经完成。

### Workspace Agent

适合把一个已经存在的本地目录注册成长期 Agent、发现已有 Agent，或确认目标 Agent 的默认执行配置。

先读：

```text
<CLI> agent --help
<CLI> agent create --help
```

核心动作：

```text
<CLI> agent create --workspacePath <absolute-existing-directory> --json
<CLI> agent list --json
<CLI> agent show <agentId> --json
```

`agent create` 不会创建目录、初始化 Git、复制模板或自动启动 Session。同一未归档、正常可见的 workspace 重复注册会返回同一个 Agent。保存成功响应中的 `agentId`；不要用显示名称或路径猜 ID。

### Runtime 发现

适合查看当前机器安装了哪些执行 Runtime，以及某个 Runtime 支持哪些模型和权限模式。它只做发现，不修改 Provider 或 Agent 配置。

```text
<CLI> runtime --help
<CLI> runtime list --json
<CLI> runtime describe <runtime> --json
```

在为支持 override 的 Task 选择 runtime/model/permissionMode 前先 describe，不要凭经验硬编码值。Session start 不接受这些临时 override，而是继承目标 Agent 的配置。

### Session：委托、续聊与读取结果

适合把工作交给一个 Agent 的新上下文、向已知上下文追加指令，或读取当前可见的文本历史。

先读：

```text
<CLI> session --help
<CLI> session start --help
<CLI> session get --help
```

核心链路：

```text
<CLI> session start --agent <agentId> --prompt-file <request-file> --json
<CLI> session send <sessionId> --prompt-file <follow-up-file> --json
<CLI> session get <sessionId> --limit 5 --json
```

- 保存 `start` 返回的 Product Session ID；后续 `send/get` 都使用这个 ID，不要替换成 Runtime 自己的 session 标识或投递 messageId。
- 多行、较长或来自外部输入的 prompt 优先写入普通文本文件，再使用 `--prompt-file`，避免 shell 转义和注入。
- 外部 `start/send` 是 one-way。成功回执只表示请求已接受或投递，不代表 AI 已执行成功；需要结果时主动 `session get`。
- `session get` 默认返回最近 5 条非空 user/assistant 文本，按旧到新排列；工具调用、thinking 和隐藏协议不会作为正文返回。结合响应中的 `liveSessionState` 判断目标是否仍在执行；暂时没有新 assistant 正文不等于失败或完成。更早内容按 leaf help 使用 `before` 分页。
- transport failure 或 `admission_unconfirmed` 可能表示结果不确定。保留已取得的 ID 并先查询，**不要自动重发**。

### Task Center 与自动化

适合创建持久工作项、派发执行、维护状态、查看运行历史，以及配置定时或条件触发。Task 子能力较多，不要一次加载或猜测全部命令。

先从产品说明和 group help 选择路径：

```text
<CLI> task readme
<CLI> task --help
```

常用入口：

```text
<CLI> task create-direct --help
<CLI> task get <taskId> --json
<CLI> task runs <taskId> --limit 5 --json
```

- 外部进程没有“当前 MyAgents Workspace/Session”上下文。创建或查询要求 Workspace identity 时，显式使用公开结果中的 ID 和绝对路径，不要用 shell cwd 猜目标。
- `task readme` 解释 Task/自动化模型；`task --help` 列出当前公开动作；选定动作后再读该 leaf help。
- 调度、trigger、checkpoint、运行控制、状态更新、归档和删除等细节都按需发现，不需要预先注入整张命令表。
- 执行接纳不等于最终成功。使用 `task get` 查看权威状态，使用 `task runs` 查看执行历史。
- 删除等不可逆动作前，必须让用户确认准确目标。

### Record：轻量记录

适合把想法、材料或待整理的信息先存进 MyAgents，而不是只留在当前聊天里。

```text
<CLI> record --help
<CLI> record create --help
<CLI> record list --json
```

创建多行、CJK 或包含 shell 元字符的文字时，优先按 leaf help 使用 content-file 输入。外部公开面只提供文字 Record 的创建和读取，不包含录音、转录、修改或删除。

## 4. 调用边界与失败恢复

- 访问 token 只从 `MYAGENTS_API_TOKEN` 读取。不要打印、记录、持久化 token，也不要把它写进参数、prompt 或 transcript。
- 只使用顶层外部帮助展示的命令。token 不会解锁内部命令、内部 Session 身份或隐藏 API；不要探测端口、伪造来源或直连 localhost 管理路由。
- ID 只能来自成功响应或公开 discovery 命令。不要猜 ID，也不要把 Workspace path、显示名称或投递 messageId 当作其它资源的 selector。
- App 不可用时请用户启动 MyAgents；CLI 不会自动启动或聚焦 App。
- 开关关闭或 token 失效时，请用户在「设置 → 外部调用」重新开启或注入当前 token，不要尝试绕过。
- 参数、路径或 lifecycle 冲突时，根据 JSON `code`、错误说明和 suggestion 修正输入。mutation 响应丢失时先用只读命令核实，不自动重放。

当前外部 CLI 不提供远程访问、HTTP/OpenAPI/SDK/MCP 接口、自动结果回调、exactly-once、Provider/MCP/Plugin/Skill/Tool/Channel/Space/Goal/Speech 管理，也不自动创建目录、初始化 Workspace 模板或 Git。目标超出公开帮助时，明确告诉用户需要在 MyAgents App 或 MyAgents 内部 Agent 中完成。
