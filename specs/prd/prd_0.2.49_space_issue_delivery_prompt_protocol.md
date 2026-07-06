---
type: prd
status: implemented
created: 2026-07-06
updated: 2026-07-06
scope: "Registered Agent 的 Space Issue delivery prompt 协议重构：把当前暴露在用户气泡里的 <myagents-session-event> 外包改为现有 <system-reminder> 隐藏协议；新增 <myagents-space-issue> badge 标签和 <myagents-space-event> 业务事件结构；将处理指令抽成 <issue-instruction> 简版 skill，将每条 <issue> 收敛为纯事实数据。不改云端匹配/claim 生命周期，不改 session send/watch 通用事件协议。"
issue: "产品需求：Team Space / Registered Agent / Space Issue delivery prompt 结构讨论收敛"
research: "specs/ARCHITECTURE.md; specs/tech_docs/space_cloud.md; specs/tech_docs/session_architecture.md; specs/tech_docs/i18n_architecture.md; src-tauri/src/space_cloud.rs::{deliver_space_deliveries,build_delivery_prompt,build_delivery_batch_prompt,build_claim_followup_prompt}; src/server/inbox/{drain-handler.ts,session-event.ts}; src/shared/systemReminder.ts; src/renderer/components/Message.tsx"
review: "completed(cross-review-code 三路 review 已完成；修复 workspace_id fallback、Space hidden payload malformed fallback、通用 session-event renderer 对 space.issue_delivery fail-closed、去掉 sessionEvent.payload 重复 prompt；验证 typecheck/lint/targeted tests/cargo check/build_dev 均通过)"
---

# Space Issue Delivery Prompt 协议重构 PRD

## 执行须知（给空 session 的你）

这份 PRD 只处理 Registered Agent 收到 Space Issue delivery 时，注入到 AI session 的 query prompt 协议和用户气泡展示。它不重新设计云端 Issue 匹配、Goal 订阅、claim 生命周期、Task 附着、Space 登录或设备身份。

动手前必须主动读：

- `AGENTS.md` 或当前会话加载的项目指令，重点是 Space、SSE / inbox、UI i18n、Rust owner 边界。
- `specs/ARCHITECTURE.md` 的「MyAgents Cloud Space」和「UI 国际化」：Space 不是 Sidecar / AI Runtime；Space HTTP / delivery poll/process 由 Rust 拥有；产品 UI 语言由 `AppConfig.uiLanguage` 与 Rust native mirror 共同解析。
- `specs/tech_docs/space_cloud.md` 的「IssueDelivery / Claim 处理」：确认 subscription、claim_followup、delivery log、claim + attached Task、complete 的既有语义。
- `specs/tech_docs/session_architecture.md` 的「Session 间事件协议」：通用 `myagents session send/watch` 继续使用 `<myagents-session-event>`，本 PRD 不改它。
- `specs/tech_docs/i18n_architecture.md`：确认 Rust 可通过 `src-tauri/src/i18n.rs::current_locale` 获取当前有效 UI 语言。

关键代码入口：

- Rust Space delivery owner：`src-tauri/src/space_cloud.rs::deliver_space_deliveries`、`build_delivery_prompt`、`build_delivery_batch_prompt`、`build_claim_followup_prompt`。
- Inbox 注入：`src-tauri/src/inbox/deliver.rs`、`src-tauri/src/inbox/types.rs`、`src/server/inbox/drain-handler.ts`。
- 当前通用 session event renderer：`src/server/inbox/session-event.ts::renderSessionEventPrompt`。
- 前端隐藏协议：`src/shared/systemReminder.ts::parseLeadingSystemReminder`、`stripLeadingSystemReminder`。
- 前端 user message badge：`src/renderer/components/Message.tsx::systemTagLabel`。
- i18n 资源：`src/renderer/i18n/locales/{zh-CN,en-US}/app.json`。

引用符号名而非行号；行号会随并发修改漂移。

## 1. 背景与产品判断

Registered Agent 的 Issue 分发是云端任务系统的一部分：云端根据 Registered Agent 的 Goal + state 订阅生成 delivery，本地客户端只拉取数据、选择目标 session、把信息注入 AI 工作区。用户关心的不是“云端下发了完整 prompt”，而是：**Agent 作为 AI，到底收到了什么信息，它是否能按预期处理 Issue。**

当前实现能跑通，但 prompt 层次混在一起：

- Rust 先把 issue 数据和处理命令拼成一段自然语言 prompt。
- Rust 同时把这段 prompt 放进 `PendingInboxMessage.text` 和 `sessionEvent.payload`。
- Node 侧 `renderSessionEventPrompt` 再把 Space delivery 外包成通用 `<myagents-session-event>`。
- 前端 user bubble 看到的是一整段内部事件结构，而不是产品化提示；`system-reminder` 隐藏协议没有发挥作用。

用户对此的判断已经收敛：

> 那一层干那一层的事情。Space Issue delivery 不是普通用户 query，也不是应该暴露给用户看的内部事件。外层应该走已有 `<system-reminder>` 结构，隐藏 Agent 处理所需的信息；用户气泡只展示一句标准提示，并带 `Space issue` badge。

同时，隐藏区里的内容也不能继续是“每条 issue 下面塞一堆命令”的形态。它应该像一个简版 skill：

- `<issue-instruction>` 统一告诉 Agent：你是谁、这是什么事件、必须使用 `myagents` CLI、处理流程是什么。
- `<runtime-context>` 只给本地 runtime 所需的 Space / workspace / registered agent 上下文。
- `<issue>` 只放每条 Issue 的事实数据和 meta。
- 所有下一步动作、命令模板、决策规则集中在 instruction 里，不散落在每个 Issue block 下。

这个改动的产品目标是：**AI 收到更清晰的操作协议，用户看到更干净的 query 气泡，架构边界也回到已有协议上。**

## 2. 当前技术事实

### 2.1 Space delivery 链路

- `cmd_space_poll_deliveries` 拉取云端 pending deliveries。
- `process_pending_deliveries` / `process_agent_deliveries` 只处理当前 Space user + 当前 device 的 active local Registered Agent。
- delivery 分两类：
  - `subscription`：普通 Goal 订阅通知，用于让 Agent 发现需要处理的 Issue。
  - `claim_followup`：已 claim Issue 的后续评论 / 更新，云端必须携带 `targetSessionId = claim.localSessionId`，客户端投递回原 session。
- subscription 按 Registered Agent 的 `issue_subscription_run_mode` 选择 session：
  - `single_session`：同一 agent 复用 `delivery_session_id`，一轮 poll 中多条 delivery 会批量进入同一 turn。
  - `new_session`：每个 issue 复用或创建 `issue_session_ids[issueId]`。
- `deliver_space_deliveries` 构造 `PendingInboxMessage`，通过 `inbox::deliver::deliver_with_resume` 投递到目标 sidecar；如果 session 不在线，会以 transient Tab owner resume，并触发 headless background completion。

### 2.2 当前 prompt 生成

`src-tauri/src/space_cloud.rs` 里有三套 prompt builder：

- `build_delivery_prompt`：单条 subscription Issue。
- `build_delivery_batch_prompt`：同一 turn 多条 subscription Issue。
- `build_claim_followup_prompt`：已 claim Issue 的 follow-up。

当前 builder 把 issue facts 和 action commands 混在同一自然语言列表里。例如每条 issue 下会重复：

- read context command
- ignore command
- claim command
- complete command

这导致 batch prompt 冗长，也让“操作协议”和“业务事实源”变成多份重复文本。

### 2.3 当前 Node 外包

`src/server/inbox/drain-handler.ts::buildSessionEventPrompt` 看到 `msg.sessionEvent` 时会调用 `renderSessionEventPrompt(msg.sessionEvent)`。

`src/server/inbox/session-event.ts::renderSessionEventPrompt` 对所有 `SessionEvent` 统一输出：

```xml
<myagents-session-event ...>
<event-summary>
...
</event-summary>
<payload>
...
</payload>
</myagents-session-event>
```

这对 `myagents session send/watch` 是合理的，因为它们是跨 session 通用事件协议。但 Space Issue delivery 需要用户气泡隐藏和 `Space issue` badge，不能再让 `<myagents-session-event>` 成为最终 user message 的外层。

### 2.4 前端隐藏与 badge 机制

`src/shared/systemReminder.ts::parseLeadingSystemReminder` 只解析消息开头的 `<system-reminder>...</system-reminder>`：

- reminder 内部作为隐藏操作上下文。
- reminder 后面的 `visibleText` 作为用户气泡展示文本。
- reminder body 的第一个 XML-like tag 会被识别为 `kind`。

`src/renderer/components/Message.tsx::systemTagLabel` 目前只 whitelists：

- `HEARTBEAT`
- `CRON_TASK`
- `FLOATING_BALL_CONTEXT`

因此本期要新增 `myagents-space-issue`，显示 label 固定为 `Space issue`。

### 2.5 语言能力

Rust 侧已经有 `src-tauri/src/i18n.rs::current_locale()`，可根据 `AppConfig.uiLanguage` 和 system locale 得到 `zh-CN` / `en-US`。

本期只要求用户可见短句跟随界面语种。隐藏区 instruction 是给 Agent 的执行协议，保持英文，避免 prompt 快照和操作语义随 UI 语言漂移。

## 3. 本期范围

### 3.1 要做

1. Space Issue delivery 的最终注入 user message 必须以 `<system-reminder>` 开头。
2. `<system-reminder>` 内第一层业务 tag 必须是 `<myagents-space-issue>`，供前端 badge 识别。
3. `<myagents-space-issue>` 内保留 `<myagents-space-event ...>`，承载 Space 业务事件协议。
4. `<myagents-space-event>` 内拆成：
   - `<issue-instruction>`
   - `<runtime-context>`
   - 一个或多个 `<issue id="...">`
5. `<issue-instruction>` 承担简版 skill 角色，统一写：
   - Registered Agent 角色
   - 必须使用 `myagents` CLI
   - 可用 `myagents space issue --help` 和 subcommand help 查询语法
   - subscription workflow
   - batch rule
   - claim_followup workflow
6. `<issue>` 只放事实数据和 meta，不放 read / ignore / claim / complete 命令。
7. 用户气泡只展示 reminder 后短句：
   - `zh-CN`：`MyAgents Space 已投递一个 Issue 通知，Registered Agent 开始处理。`
   - `en-US`：`MyAgents Space delivered an issue notification. The registered Agent started processing.`
   - batch / follow-up 可按语义用对应短句，见模板章节。
8. 前端 badge 显示 `Space issue`。
9. 保留 registered-agent scenario / lazy session materialization 语义；去掉 prompt 外包不能影响 headless delivery。
10. 对 issue title / updateSummary / goalPath 等用户或云端可变字段做结构标签转义，避免闭合 `<system-reminder>` / `<myagents-space-issue>` / `<myagents-space-event>` / `<issue>` 等标签。
11. 更新相关 unit tests 和 docs。

### 3.2 明确不做

- 不改 Cloud Worker 的 delivery 匹配算法。
- 不改 Registered Agent 的 Goal / state 订阅配置 UI。
- 不改 claim / complete / cancel-claim 生命周期。
- 不改 CLI 命令语义，只改 prompt 中如何指导 Agent 使用 CLI。
- 不改 `myagents session send/watch` 的通用 `<myagents-session-event>` 协议。
- 不把隐藏区 instruction 做 UI 语言本地化。
- 不新增新的 AI runtime / Sidecar 通信模式。
- 不把 renderer 变成 Space HTTP owner。

## 4. 目标协议

### 4.1 顶层结构

最终注入到 session 的 user message 必须是：

```xml
<system-reminder>
<myagents-space-issue>
<myagents-space-event version="1" type="issue-delivery" mode="subscription" delivery-count="1">
<issue-instruction>
...
</issue-instruction>

<runtime-context>
...
</runtime-context>

<issue id="...">
...
</issue>
</myagents-space-event>
</myagents-space-issue>
</system-reminder>
MyAgents Space 已投递一个 Issue 通知，Registered Agent 开始处理。
```

职责分层：

| 层 | 责任 |
|----|------|
| `<system-reminder>` | 已有 UI 隐藏协议；必须是整条 user message 的第一个标签。 |
| `<myagents-space-issue>` | 前端 badge tag；`systemTagLabel` 显示为 `Space issue`。 |
| `<myagents-space-event>` | Space 自己的业务事件协议；保留 version / type / mode / delivery-count。 |
| `<issue-instruction>` | 给 Agent 的处理规则，像简版 skill。 |
| `<runtime-context>` | 本地执行上下文，供命令模板填参。 |
| `<issue>` | Issue 事实数据。 |
| reminder 后短句 | 用户可见 query 气泡文本。 |

### 4.2 `<myagents-space-event>` 属性

建议属性：

```xml
<myagents-space-event
  version="1"
  type="issue-delivery"
  mode="subscription|claim-followup"
  delivery-count="1"
  target-session-id="..."
  created-at="...">
```

说明：

- `version`：协议版本，初始为 `1`。
- `type`：本期固定 `issue-delivery`。
- `mode`：
  - `subscription`：普通订阅推送。
  - `claim-followup`：已 claim Issue 后续评论 / 更新。
- `delivery-count`：本次 user turn 内 issue 数量。
- `target-session-id`：目标 session id，可帮助模型理解“这就是当前 session”。
- `created-at`：delivery prompt 生成时间。

属性值必须 XML attribute escape。

### 4.3 `<runtime-context>`

示例：

```xml
<runtime-context>
- Space ID: spc_myagents_community
- Registered Agent ID: rag_01JZ8
- Workspace ID: wks_mino_local
- Workspace path: /Users/zhihu/Documents/project/MyAgents
- Workspace label: mino
</runtime-context>
```

要求：

- `Workspace ID` 优先使用 `agent.local_workspace_id`，fallback `agent.workspace_id`，保持现有 claim command 逻辑。
- `Workspace path` 用真实本地路径；命令模板中作为 `<runtime.workspace_path>`。
- 如果缺少 workspace id，instruction 必须告诉 Agent 不要 claim，而不是生成无效 claim command。

### 4.4 `<issue>`

示例：

```xml
<issue id="iss_bug_font">
- Delivery ID: del_001
- Issue #: #128
- Title: Team tab 的 Issue 标题字号偏大
- State: todo
- Notification version: 5
- Goal: MyAgents社区 / MyAgents 发现 BUG
- Update: Issue created and matched this registered agent subscription.
- Suggested task name: Space Issue #128
</issue>
```

规则：

- `<issue>` 只放事实和 meta。
- 不在 `<issue>` 里放 read / ignore / claim / complete 命令。
- `Claim ID` 只在 `claim-followup` 或 claim 相关 delivery 存在时出现。
- `Suggested task name` 继续复用现有 `space_issue_task_name` 规则：
  - 有 issue number：`Space Issue #<number>`
  - 否则：`Space Issue <issueId>`
- 所有 issue 字段文本必须转义 XML 结构字符。

## 5. Instruction 设计

### 5.1 通用总起

`<issue-instruction>` 开头必须明确：

```text
You are a MyAgents Space Registered Agent. You received one or more Space Issue deliveries.

Always use the `myagents` CLI to inspect and operate on Space Issues. Do not edit local Space storage files or call cloud APIs directly.
If you are unsure about command syntax, run:
  myagents space issue --help
  myagents space issue <subcommand> --help
```

这句话很关键：Agent 不应该臆测云端 API，也不应该手写本地 Space JSON。它必须走 `myagents` CLI。

### 5.2 Subscription instruction

用于单条 subscription 和 batch subscription：

```text
Decision model:
- A delivery is a notification, not an assignment.
- Inspect every issue before deciding.
- If this agent should not handle an issue, ignore that delivery.
- If this agent should handle an issue, create an issue-specific `task.md`, then claim it with an attached local Task.
- Keep discussion and progress on the Space Issue with comments.
- When work is complete, complete the Space Issue through the CLI.

Workflow for each subscription issue:
1. Read context:
   myagents space issue view <issue.id> --comments --json

2. Ignore if not appropriate:
   myagents space issue delivery ignore <issue.delivery_id>

3. Claim if appropriate:
   Write a concrete task plan to `task.md`, then run:
   myagents space issue claim <issue.id> --deliveryId <issue.delivery_id> --create-attached --workspaceId <runtime.workspace_id> --workspacePath <runtime.workspace_path> --sourceSpaceId <runtime.space_id> --name <issue.suggested_task_name> --taskMdContent-file task.md

4. Comment when reporting progress or asking questions:
   myagents space issue comment <issue.id> --body-file reply.md

5. Complete after implementation:
   myagents space issue complete <issue.id> --workspacePath <runtime.workspace_path> --taskId <taskId> --body-file result.md --message "completed Space issue"

Batch rule:
- Process issues independently.
- Do not claim every issue by default.
- If claiming multiple issues, handle them one at a time so each claim receives the correct `task.md`.
```

如果 runtime 缺 workspace id，替换 claim 部分：

```text
Claiming is currently unavailable because this Registered Agent has no local workspace id. Do not claim any issue until the agent is re-registered from the Space Agents UI.
```

### 5.3 Claim follow-up instruction

用于 `mode="claim-followup"`：

```text
Follow-up rules:
- This delivery is for an issue already claimed by this registered agent.
- Do not claim this issue again.
- Continue in this same local session so the issue context stays connected.
- First read current context:
  myagents space issue view <issue.id> --comments --json
- If the update needs a reply, write `reply.md` and run:
  myagents space issue comment <issue.id> --body-file reply.md
- If no action is required, run:
  myagents space issue delivery ignore <issue.delivery_id>
- If additional work changes the final outcome, write `result.md` and complete:
  myagents space issue complete <issue.id> --workspacePath <runtime.workspace_path> --taskId <taskId> --body-file result.md --message "completed Space issue"
```

Claim follow-up instruction 不能出现 claim workflow，避免 Agent 二次 claim。

## 6. 三类完整模板示例

### 6.1 单条 subscription Issue

```xml
<system-reminder>
<myagents-space-issue>
<myagents-space-event version="1" type="issue-delivery" mode="subscription" delivery-count="1" target-session-id="sid_abc" created-at="2026-07-06T10:30:00+08:00">
<issue-instruction>
You are a MyAgents Space Registered Agent. You received one or more Space Issue deliveries.

Always use the `myagents` CLI to inspect and operate on Space Issues. Do not edit local Space storage files or call cloud APIs directly.
If you are unsure about command syntax, run:
  myagents space issue --help
  myagents space issue <subcommand> --help

Decision model:
- A delivery is a notification, not an assignment.
- Inspect every issue before deciding.
- If this agent should not handle an issue, ignore that delivery.
- If this agent should handle an issue, create an issue-specific `task.md`, then claim it with an attached local Task.
- Keep discussion and progress on the Space Issue with comments.
- When work is complete, complete the Space Issue through the CLI.

Workflow for each subscription issue:
1. Read context:
   myagents space issue view <issue.id> --comments --json

2. Ignore if not appropriate:
   myagents space issue delivery ignore <issue.delivery_id>

3. Claim if appropriate:
   Write a concrete task plan to `task.md`, then run:
   myagents space issue claim <issue.id> --deliveryId <issue.delivery_id> --create-attached --workspaceId <runtime.workspace_id> --workspacePath <runtime.workspace_path> --sourceSpaceId <runtime.space_id> --name <issue.suggested_task_name> --taskMdContent-file task.md

4. Comment when reporting progress or asking questions:
   myagents space issue comment <issue.id> --body-file reply.md

5. Complete after implementation:
   myagents space issue complete <issue.id> --workspacePath <runtime.workspace_path> --taskId <taskId> --body-file result.md --message "completed Space issue"
</issue-instruction>

<runtime-context>
- Space ID: spc_myagents_community
- Registered Agent ID: rag_mino
- Workspace ID: wks_mino_local
- Workspace path: /Users/zhihu/Documents/project/MyAgents
- Workspace label: mino
</runtime-context>

<issue id="iss_bug_font">
- Delivery ID: del_001
- Issue #: #128
- Title: Team tab 的 Issue 标题字号偏大
- State: todo
- Notification version: 5
- Goal: MyAgents社区 / MyAgents 发现 BUG
- Update: Issue created and matched this registered agent subscription.
- Suggested task name: Space Issue #128
</issue>
</myagents-space-event>
</myagents-space-issue>
</system-reminder>
MyAgents Space 已投递一个 Issue 通知，Registered Agent 开始处理。
```

### 6.2 Batch subscription：一次 3 条 Issue

```xml
<system-reminder>
<myagents-space-issue>
<myagents-space-event version="1" type="issue-delivery" mode="subscription" delivery-count="3" target-session-id="sid_abc" created-at="2026-07-06T10:31:00+08:00">
<issue-instruction>
You are a MyAgents Space Registered Agent. You received one or more Space Issue deliveries.

Always use the `myagents` CLI to inspect and operate on Space Issues. Do not edit local Space storage files or call cloud APIs directly.
If you are unsure about command syntax, run:
  myagents space issue --help
  myagents space issue <subcommand> --help

Decision model:
- A delivery is a notification, not an assignment.
- Inspect every issue before deciding.
- If this agent should not handle an issue, ignore that delivery.
- If this agent should handle an issue, create an issue-specific `task.md`, then claim it with an attached local Task.
- Keep discussion and progress on the Space Issue with comments.
- When work is complete, complete the Space Issue through the CLI.

Workflow for each subscription issue:
1. Read context:
   myagents space issue view <issue.id> --comments --json

2. Ignore if not appropriate:
   myagents space issue delivery ignore <issue.delivery_id>

3. Claim if appropriate:
   Write a concrete task plan to `task.md`, then run:
   myagents space issue claim <issue.id> --deliveryId <issue.delivery_id> --create-attached --workspaceId <runtime.workspace_id> --workspacePath <runtime.workspace_path> --sourceSpaceId <runtime.space_id> --name <issue.suggested_task_name> --taskMdContent-file task.md

4. Comment when reporting progress or asking questions:
   myagents space issue comment <issue.id> --body-file reply.md

5. Complete after implementation:
   myagents space issue complete <issue.id> --workspacePath <runtime.workspace_path> --taskId <taskId> --body-file result.md --message "completed Space issue"

Batch rule:
- Process issues independently.
- Do not claim every issue by default.
- If claiming multiple issues, handle them one at a time so each claim receives the correct `task.md`.
</issue-instruction>

<runtime-context>
- Space ID: spc_myagents_community
- Registered Agent ID: rag_mino
- Workspace ID: wks_mino_local
- Workspace path: /Users/zhihu/Documents/project/MyAgents
- Workspace label: mino
</runtime-context>

<issue id="iss_bug_font">
- Delivery ID: del_001
- Issue #: #128
- Title: Team tab 的 Issue 标题字号偏大
- State: todo
- Notification version: 5
- Goal: MyAgents社区 / MyAgents 发现 BUG
- Suggested task name: Space Issue #128
</issue>

<issue id="iss_bug_claim">
- Delivery ID: del_002
- Issue #: #129
- Title: Registered Agent claim 后没有绑定 localTaskId
- State: todo
- Notification version: 2
- Goal: MyAgents社区 / Agent 分发系统
- Suggested task name: Space Issue #129
</issue>

<issue id="iss_bug_comments">
- Delivery ID: del_003
- Issue #: #130
- Title: Issue 新评论没有推送到原 session
- State: todo
- Notification version: 1
- Goal: MyAgents社区 / Agent 分发系统
- Suggested task name: Space Issue #130
</issue>
</myagents-space-event>
</myagents-space-issue>
</system-reminder>
MyAgents Space 已投递 3 个 Issue 通知，Registered Agent 开始处理。
```

### 6.3 Claim follow-up：已 claim Issue 的评论 / 更新

```xml
<system-reminder>
<myagents-space-issue>
<myagents-space-event version="1" type="issue-delivery" mode="claim-followup" delivery-count="1" target-session-id="sid_claim_local" created-at="2026-07-06T10:32:00+08:00">
<issue-instruction>
You are a MyAgents Space Registered Agent. You received a follow-up delivery for a Space Issue.

Always use the `myagents` CLI to inspect and operate on Space Issues. Do not edit local Space storage files or call cloud APIs directly.
If you are unsure about command syntax, run:
  myagents space issue --help
  myagents space issue <subcommand> --help

Follow-up rules:
- This delivery is for an issue already claimed by this registered agent.
- Do not claim this issue again.
- Continue in this same local session so the issue context stays connected.
- First read current context:
  myagents space issue view <issue.id> --comments --json
- If the update needs a reply, write `reply.md` and run:
  myagents space issue comment <issue.id> --body-file reply.md
- If no action is required, run:
  myagents space issue delivery ignore <issue.delivery_id>
- If additional work changes the final outcome, write `result.md` and complete:
  myagents space issue complete <issue.id> --workspacePath <runtime.workspace_path> --taskId <taskId> --body-file result.md --message "completed Space issue"
</issue-instruction>

<runtime-context>
- Space ID: spc_myagents_community
- Registered Agent ID: rag_mino
- Workspace ID: wks_mino_local
- Workspace path: /Users/zhihu/Documents/project/MyAgents
- Workspace label: mino
</runtime-context>

<issue id="iss_bug_font">
- Delivery ID: del_follow_001
- Claim ID: claim_01JZ8M1C0R9H
- Issue #: #128
- Title: Team tab 的 Issue 标题字号偏大
- State: in_progress
- Notification version: 6
- Goal: MyAgents社区 / MyAgents 发现 BUG
- Update: Ethan added a new comment asking whether the title size can follow text-sm.
- Suggested task name: Space Issue #128
</issue>
</myagents-space-event>
</myagents-space-issue>
</system-reminder>
MyAgents Space 已投递一个 Issue 后续更新，Registered Agent 开始处理。
```

## 7. 技术设计

### 7.1 Rust 成为 Space prompt 的 owner

Space delivery prompt 的模板 owner 应留在 Rust `src-tauri/src/space_cloud.rs`，因为：

- Space delivery poll/process 本来由 Rust 拥有。
- Rust 有 `LocalRegisteredAgent`、workspace path、space id、delivery 数据。
- Rust 可通过 `crate::i18n::current_locale()` 生成用户可见短句。
- Renderer 不持有 Space session token，也不应该参与 delivery prompt 拼装。

建议新增或重命名 helper：

- `build_space_issue_delivery_message(agent, session_id, deliveries) -> String`
- `build_space_issue_instruction(mode, has_workspace_id) -> String`
- `build_space_issue_runtime_context(agent) -> String`
- `build_space_issue_block(delivery) -> String`
- `space_issue_visible_text(locale, mode, count) -> &'static str | String`

当前三个 builder 可以保留为内部细分，但输出应改为上述协议结构，而不是旧自然语言列表。

### 7.2 Node 不再给 Space delivery 套 `<myagents-session-event>`

本期不是删除 `sessionEvent` 元数据。`sessionEvent` 仍可作为 sidecar 内部识别：

- `drain-handler.ts::scenarioForInboxMessage` 仍需要识别 `space.issue_delivery`，设置 registered-agent scenario。
- `drainBatchIntoSession` 仍需要 `allowLazySessionMaterialization`，保证离线目标 session 可 materialize。
- turn meta 仍可保留 `inboxOrigin: registered-agent / space_issue_delivery`。

要去掉的是**最终 prompt 外层的 `<myagents-session-event>`**。

可接受实现路径：

1. Rust 把最终完整 prompt 写入 `PendingInboxMessage.text`。
2. Rust 仍保留 `session_event.type = "space.issue_delivery"` 作为 metadata，`payload` 可等于最终 prompt 或简化后的 metadata。
3. `drain-handler.ts::buildSessionEventPrompt` 特判 `space.issue_delivery`：
   - 对 Space delivery 返回 `msg.text`，不调用通用 `renderSessionEventPrompt`。
   - 对 send/watch 继续走 `renderSessionEventPrompt`。

或者：

1. `renderSessionEventPrompt` 对 `space.issue_delivery` 分支渲染新的 `<system-reminder>` 结构。
2. send/watch 仍使用 `<myagents-session-event>`。

两条路径都可以，但第一条更符合“Rust 业务注入由 Rust owner 拼好”的边界。

无论选哪条，最终 user message 字符串必须满足：

```text
startsWith("<system-reminder>\n<myagents-space-issue>")
```

### 7.3 结构安全

Issue title、goal path、updateSummary、workspace label 等不能直接拼进 XML-like 结构。

必须提供 Rust escape helper：

- `escape_prompt_text(value)`：转义 `&`、`<`、`>`。
- `escape_prompt_attr(value)`：转义 `&`、`<`、`>`、`"`、`'`。

需要覆盖的结构标签：

- `system-reminder`
- `myagents-space-issue`
- `myagents-space-event`
- `issue-instruction`
- `runtime-context`
- `issue`

用户可控字段即使包含 `</system-reminder>`，最终也只能作为文本出现，不能提前关闭隐藏区。

命令模板里的路径、id、name 仍使用现有 `shell_quote` 语义。Instruction 中使用占位符时无需 shell quote；如果未来生成具体命令，仍必须 shell quote。

### 7.4 i18n

隐藏区 instruction 固定英文。

用户可见短句按 `crate::i18n::current_locale()`：

| 场景 | zh-CN | en-US |
|------|-------|-------|
| single subscription | `MyAgents Space 已投递一个 Issue 通知，Registered Agent 开始处理。` | `MyAgents Space delivered an issue notification. The registered Agent started processing.` |
| batch subscription | `MyAgents Space 已投递 {count} 个 Issue 通知，Registered Agent 开始处理。` | `MyAgents Space delivered {count} issue notifications. The registered Agent started processing.` |
| claim follow-up | `MyAgents Space 已投递一个 Issue 后续更新，Registered Agent 开始处理。` | `MyAgents Space delivered an issue follow-up. The registered Agent started processing.` |

Fallback：无法读取 locale 时用 `zh-CN`。

前端 badge label：

- 新增 `message.systemTags.spaceIssue`。
- `zh-CN` 和 `en-US` 都返回 `Space issue`，满足用户指定。

### 7.5 前端展示

`Message.tsx::systemTagLabel` 新增：

```ts
if (kind === 'myagents-space-issue') return t('message.systemTags.spaceIssue');
```

注意：

- `parseLeadingSystemReminder` 的 `leadingReminderKind` 支持小写和连字符 tag，`myagents-space-issue` 合法。
- Message 展示会用 reminder 后的 `visibleText`，内部结构不会出现在用户气泡。
- QueryNavigator 使用 `getVisibleQueryText`，应只展示短句，不纳入隐藏区。
- 标题 / preview 相关 `stripLeadingSystemReminder` 应同样得到短句。

## 8. 关键设计决策

### D1. 用 `<system-reminder>` 做最终外层，而不是继续展示 `<myagents-session-event>`

原因：项目已有 `<system-reminder>` 约定，能同时满足“模型可见、用户气泡隐藏、visibleText 展示”的需求。重新在前端为 `<myagents-session-event>` 做隐藏逻辑会制造第二套隐藏协议。

避开的坑：内部事件结构暴露在用户气泡里；QueryNavigator / session title / preview 继续被内部 prompt 污染。

### D2. `<myagents-space-issue>` 是 badge tag，不承载业务版本

原因：前端 badge 只需要识别“这是 Space issue 注入”。业务版本、mode、delivery count 不应该塞到 badge tag 上。

避开的坑：UI badge 逻辑和业务协议耦合；未来 Space event 版本变化导致前端展示判断漂移。

### D3. 保留 `<myagents-space-event>` 作为 Space 内部业务协议

原因：Space Issue delivery 仍是结构化事件，不应退化成纯自然语言。`version/type/mode/delivery-count` 能让后续协议演进有稳定落点。

避开的坑：后续要增加 delivery 类型时只能解析自然语言；batch / follow-up 语义靠 prompt 文案猜。

### D4. Instruction 与 Issue facts 分离

原因：`issue-instruction` 是简版 skill，`issue` 是事实源。命令模板和处理流程统一在 instruction，避免 batch 中每个 issue 重复命令。

避开的坑：一处 CLI 规则变更要改多处 prompt；模型把某条 issue 下的命令误用到另一条 issue；issue block 既像事实又像 action plan。

### D5. 隐藏 instruction 固定英文，用户可见短句跟随 UI 语言

原因：instruction 面向 AI 执行，稳定性比 UI 语种一致更重要；用户真正看到的是 reminder 后短句和 badge。

避开的坑：prompt 快照随语言切换变化，测试和 Agent 行为难以稳定；同时又不牺牲用户界面语言一致性。

### D6. 不改 send/watch 通用 session event 协议

原因：`myagents session send/watch` 是跨 session 的通用事件协议，已有 system prompt 指导模型理解 `<myagents-session-event>`。Space issue delivery 是 Registered Agent 的产品化自动注入，展示需求不同。

避开的坑：为了 Space UI 展示把通用 inbox 协议一起改坏。

### D7. `sessionEvent` 可以继续做内部 metadata，但不能决定最终 prompt 外包

原因：`sessionEvent.type === "space.issue_delivery"` 当前还驱动 registered-agent scenario 和 lazy materialization。完全删除 metadata 会引入行为回归。

避开的坑：离线 session 不再 materialize；system prompt scenario 丢失；headless background completion 语义退化。

## 9. 实施计划

### Phase 1: Rust prompt builder 重构

1. 在 `space_cloud.rs` 增加 Space prompt escape helpers。
2. 重写单条 subscription prompt 为新协议。
3. 重写 batch subscription prompt 为新协议。
4. 重写 claim follow-up prompt 为新协议。
5. 用 `crate::i18n::current_locale()` 生成 visible text。
6. 保持 `deliver_space_deliveries` 的 delivery log 和 mark-delivered 行为不变。

### Phase 2: Node inbox 渲染边界

1. 修改 `drain-handler.ts::buildSessionEventPrompt` 或 `session-event.ts::renderSessionEventPrompt`，确保 `space.issue_delivery` 不再输出 `<myagents-session-event>`。
2. 保留 `scenarioForInboxMessage` 对 `space.issue_delivery` 的识别。
3. 保留 `allowLazySessionMaterialization` 对 Space delivery 的 true 分支。
4. 调整 `session-event.unit.test.ts`：send/watch 继续是 `<myagents-session-event>`；space issue delivery 输出或透传 `<system-reminder>`。

### Phase 3: 前端 badge

1. `Message.tsx::systemTagLabel` 支持 `myagents-space-issue`。
2. `app.json` 的 `message.systemTags` 加 `spaceIssue: "Space issue"`。
3. 补测试或至少通过现有 `systemReminder` / Message 渲染路径验证：
   - hidden content 不展示。
   - badge 显示 `Space issue`。
   - user bubble 显示 visible text。

### Phase 4: 文档与回归

1. 更新 `specs/tech_docs/space_cloud.md` 的 IssueDelivery / Claim 处理段落，记录新 prompt 协议。
2. 如调整 session event 分支，更新 `specs/tech_docs/session_architecture.md`，说明 Space issue delivery 是特例：复用 inbox metadata，不复用通用 prompt 外包。
3. 跑目标测试。

## 10. 测试与验收

### 10.1 Rust unit tests

覆盖：

1. 单条 subscription：
   - prompt 以 `<system-reminder>` 开头。
   - 包含 `<myagents-space-issue>` 和 `<myagents-space-event ... mode="subscription" delivery-count="1">`。
   - 包含 `<issue-instruction>`、`<runtime-context>`、一个 `<issue id="...">`。
   - reminder 后有 localized visible text。
   - `<issue>` block 不包含 `myagents space issue claim`、`ignore`、`complete` 具体命令。
2. batch subscription：
   - delivery-count 为 `3`。
   - 包含 3 个 `<issue id="...">`。
   - instruction 包含 Batch rule。
   - 每个 issue block 只放 facts。
3. claim follow-up：
   - mode 为 `claim-followup`。
   - instruction 包含 `Do not claim this issue again`。
   - instruction 不包含 subscription claim workflow。
   - issue block 包含 Claim ID。
4. escaping：
   - issue title 包含 `</system-reminder><script>` 时，输出不能提前关闭 reminder。
   - updateSummary 包含 `</myagents-space-event>` 时被转义。
5. locale：
   - zh-CN visible text。
   - en-US visible text。

### 10.2 Node unit tests

覆盖：

1. `send.request` / `watch.completed` 仍渲染 `<myagents-session-event>`。
2. `space.issue_delivery` 不再渲染通用 `<myagents-session-event>` 外包。
3. `drain-handler` 对 `space.issue_delivery` 仍返回 registered-agent scenario。
4. `allowLazySessionMaterialization` 对 `space.issue_delivery` 仍为 true。

### 10.3 Frontend tests

覆盖：

1. `parseLeadingSystemReminder` 能识别 `kind === "myagents-space-issue"`。
2. `Message` 渲染用户消息时：
   - 不展示 `<issue-instruction>` / `<issue>` 内部内容。
   - 展示 reminder 后的短句。
   - 展示 `Space issue` badge。
3. QueryNavigator 只使用 visible text。

### 10.4 手工验收

在 mock Space 或本地可控数据下验证：

1. 注册一个 Agent，订阅 `todo` issue。
2. 拉取单条 subscription delivery。
3. 打开目标 session：
   - 用户气泡只看到短句。
   - badge 是 `Space issue`。
   - 复制原始消息或读取 session JSON 能看到完整 hidden prompt。
   - Agent 会先 `myagents space issue view ...`，不会直接 claim。
4. 一轮 poll 返回 3 条 issue：
   - 同一 turn 只有一个 visible bubble。
   - hidden prompt 有 3 个 `<issue>`。
   - Agent 按 issue 独立判断。
5. 已 claim issue 收到评论：
   - prompt mode 是 `claim-followup`。
   - Agent 不再 claim。
   - Agent 回到原 local session。
6. 切换 UI 语言：
   - zh-CN 显示中文短句。
   - en-US 显示英文短句。
   - badge 始终显示 `Space issue`。

## 11. 风险与注意事项

### 11.1 不要误删 `sessionEvent` metadata

去掉的是最终 prompt 的通用外包，不是所有 metadata。实现时要确认 `scenarioForInboxMessage` 和 lazy materialization 不丢。

### 11.2 不要把用户可控字段原样插进 XML-like prompt

Issue title、comment summary、goal path 都可能来自用户或云端。它们必须 escape，否则会提前闭合 `<system-reminder>`，导致隐藏区泄露或 prompt injection 边界破坏。

### 11.3 不要把命令模板重新复制到每个 issue block

这会回到旧结构。Issue block 只放 facts。命令模板统一在 instruction，用 `<issue.*>` / `<runtime.*>` 占位。

### 11.4 不要为了 badge 新建第二套隐藏协议

前端已经有 `system-reminder`。新增的只有 badge tag label，不应给 `<myagents-space-event>` 再写一套显示/隐藏解析。

### 11.5 不要本地化隐藏 instruction

本期只本地化 visible text。隐藏 instruction 变多语言会影响 Agent 行为稳定性，不在本期做。

## 12. 验收标准

本期完成后，满足以下全部条件：

1. Space Issue delivery 注入 session 的最终 user message 以 `<system-reminder>` 开头。
2. 前端 user bubble 不展示 hidden prompt，只展示 localized visible text。
3. 前端 badge 显示 `Space issue`。
4. Hidden prompt 内有 `<myagents-space-event>`、`<issue-instruction>`、`<runtime-context>`、`<issue>`。
5. 单条 subscription、batch subscription、claim follow-up 三类模板均符合本 PRD。
6. `myagents session send/watch` 仍使用原 `<myagents-session-event>` 协议，不被本改动影响。
7. Registered Agent 的 headless delivery、lazy session materialization、scenario system prompt 均不回归。
8. 用户可控 issue 字段无法闭合 hidden tags。
9. 测试覆盖 prompt 结构、Node 渲染分支、前端 badge / hidden display。

## 13. 后续期

- 可以把 `<issue-instruction>` 提升成版本化 prompt contract，后续加入更严格的 `task.md` 最小结构。
- 可以为 Agent claim 前是否必须 comment “I am taking this” 做产品决策；本期不加。
- 可以把 complete 从 “prefer” 改成 “must when the issue is actually resolved”；本期模板已经更偏 workflow，但不改变 CLI enforcement。
- 可以在 Space Issue UI 中展示“Agent 已收到 / 已忽略 / 已 claim / 已完成”的 delivery timeline；本期只改 prompt 注入和消息展示。
- 可以为隐藏 prompt 增加专门的 debug viewer；本期仍通过 session 原始消息 / logs 验证。

## 执行台账

### 开发契约（动第一行代码前写完）

- 必赢场景：Registered Agent 收到 Space Issue delivery 后，session 里最终 user message 以 `<system-reminder><myagents-space-issue>` 开头，用户气泡只显示本地化短句并带 `Space issue` badge；hidden prompt 内按 `<myagents-space-event><issue-instruction><runtime-context><issue>` 结构表达单条订阅、批量订阅和 claim follow-up，且 Agent 仍走 registered-agent scenario / lazy materialization。
- 复用的既有抽象：`src-tauri/src/space_cloud.rs::deliver_space_deliveries` 和三个 Space prompt builder；`PendingInboxMessage.session_event` 作为内部 metadata；`src/server/inbox/drain-handler.ts::scenarioForInboxMessage` / lazy materialization 分支；`src/shared/systemReminder.ts::parseLeadingSystemReminder`；`src/renderer/components/Message.tsx::systemTagLabel`；`src-tauri/src/i18n.rs::current_locale`。
- 反向边界：不改云端 delivery 匹配；不改 claim / complete CLI 语义；不改 `myagents session send/watch` 的通用 `<myagents-session-event>` 协议；不新增 renderer 直连 Space HTTP；隐藏 instruction 不随 UI 语言本地化。
- 新概念清单：`myagents-space-issue` 作为 system-reminder 内第一业务 tag，用于现有 badge 机制；`myagents-space-event` 作为 Space 专属 hidden 业务事件容器；`issue-instruction` / `runtime-context` / `issue` 是 prompt 内结构标签，不是新的 runtime 状态或持久模型。
- 触及的红线：Space 仍由 Rust owner 处理，renderer 不持有 token；新增用户可见文案必须进 i18n；Space delivery 不应破坏 session event send/watch 协议；用户可控字段必须转义，不能闭合 hidden tags；不新增通信模式或 sidecar owner。

### 行动清单

- [x] Phase 1: Rust prompt builder 重构，输出 `<system-reminder><myagents-space-issue>` 协议并补 Rust 单测。
- [x] Phase 2: Node inbox 渲染边界，Space delivery 不再套通用 `<myagents-session-event>`，但保留 registered-agent scenario / lazy materialization。
- [x] Phase 3: 前端 badge 与 i18n，`myagents-space-issue` 显示为 `Space issue`。
- [x] Phase 4: 文档、验证、cross-review、commit。

### 待用户决策

无阻塞性产品岔路。本期按 PRD 固定：hidden instruction 用英文；用户可见短句跟随 UI 语言。

### 进展日志

- 2026-07-06：读取 PRD、ARCHITECTURE、space_cloud、session_architecture、i18n_architecture、DESIGN 和相关代码入口；确认本期为 PRD 模式 `/start-dev`，开始按台账执行。
- 2026-07-06：完成 Rust Space issue delivery prompt 重构：统一输出 `<system-reminder><myagents-space-issue><myagents-space-event ...>`；`<issue-instruction>` 集中 CLI / workflow 指令；`<runtime-context>` 放 runtime facts；每个 `<issue>` 只放事实数据；visible text 跟随 Rust 当前 UI locale。
- 2026-07-06：完成 Node inbox 边界：`drain-handler` 对 `space.issue_delivery` 透传 Rust-rendered `PendingInboxMessage.text`，保留 registered-agent scenario 与 lazy materialization；`renderSessionEventPrompt` 对 `space.issue_delivery` fail-closed，避免未来误回到 `<myagents-session-event>` 外包。
- 2026-07-06：完成前端隐藏展示：新增 `myagents-space-issue` system-reminder tag 与 `Space issue` badge i18n；Message / QueryNavigator / shared parser 只展示 reminder 后 visible text；纯 Space reminder malformed fallback 不泄露 hidden payload。
- 2026-07-06：完成文档更新：`specs/tech_docs/space_cloud.md` 记录 Rust-rendered IssueDelivery prompt 协议；`specs/tech_docs/session_architecture.md` 记录 Space issue delivery 复用 inbox metadata 但不复用通用 prompt 外包。
- 2026-07-06：cross-review-code 三路 review 完成。采纳并修复：`local_workspace_id` 空白时 fallback 到 `workspace_id`；Space reminder 缺失 visible tail 时不展示 hidden payload；通用 session-event renderer 移除 Space prompt 渲染职责；`sessionEvent.payload` 不再重复保存完整 prompt。
- 2026-07-06：验证通过：`cargo fmt --manifest-path src-tauri/Cargo.toml`；`npx vitest run --project unit src/shared/systemReminder.test.ts src/server/inbox/drain-handler.unit.test.ts src/server/inbox/session-event.unit.test.ts`；`npx vitest run --project dom src/renderer/components/Message.proseContext.test.tsx src/renderer/components/chat/QueryNavigator.test.tsx`；`cargo test --manifest-path src-tauri/Cargo.toml build_space_issue_delivery_message -- --nocapture`；`cargo check --manifest-path src-tauri/Cargo.toml`；`npm run typecheck`；`npm run lint`；`./build_dev.sh`。
