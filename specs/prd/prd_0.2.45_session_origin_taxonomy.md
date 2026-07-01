---
type: prd
status: implemented
created: 2026-07-02
updated: 2026-07-02
scope: "统一 Session / Turn 的来源归因：新增两层 origin（kind + surface）作为持久 session 出生事实与统计上报归因，替代继续扩展旧 source/surface 混用。首期用它解决定时任务 session 刷屏历史的问题：历史列表默认隐藏自动化会话，并提供一个图标开关展示/隐藏定时任务对话。明确不做完整 grouped history / Automation History 独立页，不重构 runtime InteractionScenario。"
issue: "GitHub #420 + 用户需求讨论收敛：scheduled task runs 让普通历史列表变乱；同时当前 source/surface/scenario/统计字段过于混杂，需要先统一抽象。"
research: "无独立研究报告；技术事实来自本 PRD 写作时对 specs/ARCHITECTURE.md、specs/tech_docs/analytics_design.md、specs/tech_docs/task_center.md、specs/tech_docs/task_provider_routing.md 与当前源码的 grep/read 实证。"
review: "implemented — 已验证：① cron new_session / single_session / Task Center task_run 写入 origin；② session_new / history_open / ai_turn_complete 均带 origin_kind/origin_surface，并保留老字段兼容；③ 历史列表默认隐藏只匹配 automation/cron 与 automation/task_run，legacy cronTaskId/source=cron 兜底，不按标题误判。验证命令见会话总结。"
---

# Session Origin 归因统一 PRD

## 执行须知（给空 session 的你）

本 PRD 是从一次已经收敛的产品/架构讨论沉淀出来的。实现前不需要回翻聊天记录，但必须主动读以下文件：

1. `specs/ARCHITECTURE.md`：Sidecar Owner 模型、Tab-Scoped 隔离、定时任务系统、Session 切换。
2. `specs/tech_docs/analytics_design.md`：当前 `source` / `surface` / `entry_intent` / `runtime_source` 的统计契约。
3. `specs/tech_docs/session_architecture.md`：Session metadata、历史恢复、Chat adoption/config sync 红线。
4. `specs/tech_docs/task_center.md`：Task Store、Task ↔ CronTask 执行闭环、Task 审计来源。
5. `specs/tech_docs/task_provider_routing.md`：Task/Cron live-on-tick 与 session snapshot 语义。
6. `specs/tech_docs/im_integration_architecture.md`：IM Bot / Agent Channel 的路由语义。
7. `specs/DESIGN.md`：历史列表 UI 图标、tooltip、hover/disabled 状态需要遵守设计 token。

代码锚点用符号名，不用固定行号；行号会漂移，对不上就 `rg` 符号名：

- Analytics 类型：`src/renderer/analytics/types.ts::Source`、`Surface`、`SessionNewParams`、`HistoryOpenParams`
- Analytics 发送：`src/renderer/analytics/tracker.ts::track`、`src/server/analytics.ts::trackServer`
- session_new：`src/renderer/context/TabProvider.tsx::trackSessionNewForBirth`
- history_open：`src/renderer/App.tsx::trackHistorySessionOpen`、`trackHistorySessionOpenAsync`
- ai_turn_complete：`src/server/builtin-session/turn-lifecycle.ts`、`src/server/runtimes/external-session.ts`
- Session metadata：`src/server/types/session.ts::SessionMetadata`、`src/renderer/api/sessionClient.ts::SessionMetadata`
- Metadata 更新白名单：`src/server/SessionStore.ts::updateSessionMetadata`
- Session materialization：`src/server/utils/session-materialization.ts::createMaterializedSessionMetadata`
- Cron execute：`src/server/index.ts` 的 `/cron/execute` / `/cron/execute-sync`
- IM enqueue：`src/server/index.ts` 的 `/api/im/enqueue`
- Runtime scenario：`src/server/system-prompt.ts::InteractionScenario`
- 历史 UI：`src/renderer/pages/Chat.tsx`、`SessionHistoryDropdown` 相关组件、`src/renderer/pages/Launcher.tsx`

本 PRD 的核心不是“给 cron 单独打一个 `source: cron` 补丁”，而是：**把 session/turn 的归因从旧的 source 混乱里拆出来，只保留两层稳定概念：`origin.kind` 和 `origin.surface`。**

---

## 1. 背景与问题

GitHub #420 的问题很直接：定时任务很有用，但高频任务会把普通历史会话列表刷得很乱。用户希望 scheduled task runs 可以被合并、分组、隐藏，或者放到专门的 automation history 里。核心诉求不是删除数据，而是别让自动化执行把“人主动开的对话历史”淹没。

我们顺着这个问题看现有代码，发现更底层的混乱：

- `SessionMetadata.source` 现在是 legacy channel 字段，语义是 `desktop` 或 `'{platform}_private/group'`，并不是 session 创建方式。
- Analytics 里的 `Source` 又是统计来源：`desktop` / `floating_ball` / `cli` / `cron` / `im`。
- Analytics 里的 `Surface` 是 UI/product surface：`launcher_input` / `agent_card` / `task_center` / `floating_ball` 等。
- Server runtime 里还有 `InteractionScenario`：`desktop` / `im` / `agent-channel` / `cron` / `registeredAgent`。它会影响 prompt、工具权限、MCP authority，不是纯统计字段。
- 当前 `ai_turn_complete.source` 里 `im` 和 `agent-channel` 的差异有实现偶然性：builtin IM enqueue 走 `scenario.type='im'`，external runtime 走 `scenario.type='agent-channel'`。这不是干净的产品 taxonomy。
- `SessionMetadata.cronTaskId` 虽然定义了，但 `updateSessionMetadata` 白名单未包含它，cron `new_session` 创建快照时也没有可靠写入。不能拿它当历史过滤的唯一事实来源。

用户的判断是对的：继续在 `source` 这个词上叠含义，会让抽象、功能和统计上报继续乱下去。需要先把“这个 session / turn 到底来自哪里”收束成一个稳定的、可持久化、可上报、可被 UI 过滤使用的归因对象。

---

## 2. 产品目标

### 2.1 用户价值

1. **普通历史列表恢复干净**
   - 用户默认看到的是人主动创建/打开的对话。
   - 定时任务、Task Center 执行产生的自动化 session 默认不刷屏。

2. **定时任务数据仍然可找回**
   - 默认隐藏不等于删除。
   - 历史列表提供一个明显但轻量的显示/隐藏开关。
   - Task Detail / Cron run record 仍然可以看到执行记录。

3. **统计口径变稳定**
   - 新会话入口分布、来源用量明细、历史打开都能用同一组 `origin_kind` / `origin_surface`。
   - 不再用 `im` vs `agent-channel` 这种 runtime 实现差异当产品来源。

4. **后续 grouped history / automation history 有地基**
   - 首期不做复杂 grouping，但后续要按 task/cron 聚合时，至少 session 和 turn 已经有干净来源。

### 2.2 本期做什么

本期交付四件事：

1. 新增 `SessionOrigin` 两层模型：
   ```ts
   type SessionOrigin = {
     kind: OriginKind;
     surface: OriginSurface;
   };
   ```

2. 将 `origin` 写入 session metadata：
   - desktop 新建 session
   - floating ball 新建 session
   - cron / task_run 创建或 materialize session
   - agent-channel materialize session
   - registered-agent materialize session

3. 三个事件上报 `origin_kind` / `origin_surface`：
   - `session_new`
   - `history_open`
   - `ai_turn_complete`

4. 历史列表默认隐藏自动化 session，并在“全部”右侧新增一个显示/隐藏定时任务对话的 icon：
   - 默认状态：隐藏。
   - hover tooltip：
     - 当前隐藏时：`展示定时任务对话`
     - 当前展示时：`隐藏定时任务对话`

### 2.3 明确不做什么

- 不实现完整“按 cron task parent 分组”的 history tree。
- 不新增独立 `Automation History` 页面。
- 不把 `platform` / `private|group` / `taskId` / `cronTaskId` / `runMode` 放进 `origin`。这些是独立维度或业务表 join，不进本期两层模型。
- 不把 analytics `surface` 改名为 `scenario`。项目里已有 runtime `InteractionScenario`，改名会更乱。
- 不重构 runtime `InteractionScenario.type='im' | 'agent-channel'`。本期只做产品/统计归一化，runtime 控制面保持稳定。
- 不删除老字段 `source` / `triggered_by` / `entry_source`。统计侧必须兼容老数据和老版本客户端。
- 不做历史数据强迁移到 100% 准确。老数据只做 best-effort derive，不可靠的 session 不误判。

---

## 3. 统一模型

### 3.1 持久模型

在共享类型中新增：

```ts
export type OriginKind =
  | 'desktop'
  | 'automation'
  | 'agent-channel'
  | 'registered-agent'
  | 'session-inbox'
  | 'unknown';

export type OriginSurface =
  // desktop
  | 'launcher_input'
  | 'agent_card'
  | 'new_chat_button'
  | 'task_center'
  | 'assistant'
  | 'agent_setup'
  | 'floating_ball'
  | 'session_fork'
  | 'cmd_k'
  | 'external_link'

  // automation
  | 'cron'
  | 'task_run'
  | 'memory_update'

  // agent-channel
  | 'channel_message'
  | 'channel_heartbeat'

  // registered-agent
  | 'space_issue_delivery'

  // session-inbox
  | 'session_send'
  | 'session_reply'

  | 'unknown';

export interface SessionOrigin {
  kind: OriginKind;
  surface: OriginSurface;
}
```

写入 `SessionMetadata`：

```ts
interface SessionMetadata {
  origin?: SessionOrigin;
}
```

字段命名说明：

- 持久层用 `origin.kind` / `origin.surface`，表达“这条 session 的出生事实”。
- Analytics 上报扁平字段 `origin_kind` / `origin_surface`，因为现有 `track()` 会把对象 stringify，统计侧不适合吃嵌套对象。
- `origin` 不带版本号。本期只有两个稳定字段，未来如需大改再引入 `originV2` 或新增独立字段，避免过早复杂化。

### 3.2 OriginKind 语义

| kind | 含义 | 典型场景 |
| --- | --- | --- |
| `desktop` | 用户在桌面 GUI / 悬浮球主动创建或触发 | Launcher 输入、Agent 卡片、新建对话、Task Center AI 讨论、悬浮球 |
| `automation` | 系统后台自动执行 | cron tick、Task Center task run、memory update |
| `agent-channel` | IM / OpenClaw / Agent Channel | Telegram/Feishu/DingTalk/OpenClaw 私聊/群聊消息、channel heartbeat |
| `registered-agent` | MyAgents Cloud / Space registered agent 后台事件 | Space issue delivery |
| `session-inbox` | session 间投递触发的 turn | `myagents session send`、自动 reply 回推 |
| `unknown` | 兜底 | 老数据无法推断、异常路径 |

`session-inbox` 主要用于 `ai_turn_complete` 的 turn origin。它通常不创建新 session，因此不应大量出现在 `SessionMetadata.origin` 里。

### 3.3 OriginSurface 语义

| kind | surface | 含义 |
| --- | --- | --- |
| `desktop` | `launcher_input` | 启动页/空态输入框直接发首条消息 |
| `desktop` | `agent_card` | 右侧 Agent 工作区卡片打开新 session |
| `desktop` | `new_chat_button` | Chat 内新对话按钮 |
| `desktop` | `task_center` | Task Center / Thought AI 讨论创建的 alignment session |
| `desktop` | `assistant` | 小助理 / 诊断入口。legacy `bug_report` 归一到这里 |
| `desktop` | `agent_setup` | Agent 初始化 / `/init` 类创建 |
| `desktop` | `floating_ball` | 桌面悬浮球伴侣窗创建 |
| `desktop` | `session_fork` | 用户 fork 出来的新 session |
| `desktop` | `cmd_k` | 命令面板入口，预留 |
| `desktop` | `external_link` | URL scheme / deep link，预留 |
| `automation` | `cron` | 独立 cron / scheduled task 执行 |
| `automation` | `task_run` | Task Center task 执行产生或驱动的 session/turn |
| `automation` | `memory_update` | 记忆维护 turn |
| `agent-channel` | `channel_message` | IM / Agent Channel 普通消息 |
| `agent-channel` | `channel_heartbeat` | IM / Agent Channel heartbeat |
| `registered-agent` | `space_issue_delivery` | Space issue delivery 事件 |
| `session-inbox` | `session_send` | `myagents session send` 投递请求 |
| `session-inbox` | `session_reply` | turn 结束后自动 reply 回推 |
| `unknown` | `unknown` | 无法识别 |

注意：

- `history_click` 不进入 `OriginSurface`。打开历史不是 session 出生来源，它继续由 `history_open.entry_source` 表达。
- `open_history` 不进入新 origin。它是历史打开行为，不是 session birth。
- `im` 不再作为新 origin surface。统一为 `agent-channel/channel_message` 或 `agent-channel/channel_heartbeat`。

---

## 4. 事件上报契约

### 4.1 `session_new`

`session_new` 上报 session 出生来源：

```ts
track('session_new', {
  session_id,
  origin_kind,
  origin_surface,

  // legacy fields retained
  triggered_by,
  entry_intent,
  runtime,
  runtime_source,
  has_initial_message,
  agent_hash,
});
```

兼容关系：

- `triggered_by` 继续保留，短期作为 legacy alias。
- 新查询优先用 `origin_surface`。
- 对于 legacy `triggered_by='bug_report'`，新 `origin_surface='assistant'`。

推荐新 session 映射：

| 当前入口 | origin_kind | origin_surface | legacy triggered_by |
| --- | --- | --- | --- |
| Launcher 输入发首条消息 | `desktop` | `launcher_input` | `launcher_input` |
| Agent 卡片打开工作区 | `desktop` | `agent_card` | `agent_card` |
| 新建对话按钮 | `desktop` | `new_chat_button` | `new_chat_button` |
| Task Center AI 讨论 | `desktop` | `task_center` | `task_center` |
| 小助理/诊断 | `desktop` | `assistant` | `bug_report` 或后续同步改为 `assistant` |
| Agent 初始化 | `desktop` | `agent_setup` | `agent_setup` |
| 悬浮球新会话 | `desktop` | `floating_ball` | `floating_ball` |
| Fork 新会话 | `desktop` | `session_fork` | 可继续用 `unknown` 或新增 legacy surface |

### 4.2 `history_open`

`history_open` 上报“被打开 session 的出生来源”，不是“点击入口”：

```ts
track('history_open', {
  session_id,
  origin_kind,
  origin_surface,

  // legacy / existing fields
  entry_source,
  runtime,
  runtime_source,
  agent_hash,
});
```

`entry_source` 继续表达用户从哪里打开历史：

- `launcher_recent`
- `launcher_overlay`
- `chat_dropdown`
- `chat_dropdown_new_tab`
- `settings_helper_history`
- `task_run_history`

这两个维度不要混：

- `origin_surface='task_run'`：这个 session 是自动化任务执行产生的。
- `entry_source='task_run_history'`：用户从任务详情里的执行记录点开历史。

### 4.3 `ai_turn_complete`

`ai_turn_complete` 上报“本轮 turn 的触发来源”：

```ts
trackServer('ai_turn_complete', {
  origin_kind,
  origin_surface,

  // legacy fields retained
  source,
  platform,
  session_id,
  runtime,
  runtime_source,
  model,
  input_tokens,
  output_tokens,
  ...
});
```

关键原则：

- `ai_turn_complete.origin_*` 是 **turn origin**，不一定等于 `SessionMetadata.origin`。
- 一个 `desktop/launcher_input` 出生的 session，后续可能被 `session-inbox/session_send` 投递一轮。
- 一个 `agent-channel/channel_message` 出生的 session，后续可能有 `agent-channel/channel_heartbeat` turn。
- 一个 cron single_session 会话，出生和每轮 turn 都可能是 `automation/cron`；但如果用户后来从 Chat 输入普通 query，那普通 query 的 turn origin 应是 `desktop` 相关入口，而不是 cron。

推荐 turn 映射：

| 当前路径 | origin_kind | origin_surface | legacy source |
| --- | --- | --- | --- |
| 普通 Chat `/chat/send` | `desktop` | `unknown` 或 session birth surface | `desktop` |
| Floating ball `/chat/send` | `desktop` | `floating_ball` | `floating_ball` |
| Cron execute | `automation` | `cron` 或 `task_run` | `cron` |
| Task Center task run 经 CronTask 执行 | `automation` | `task_run` | `cron` |
| IM / Agent Channel 用户消息 | `agent-channel` | `channel_message` | legacy `im` / `agent-channel` |
| IM / Agent Channel heartbeat | `agent-channel` | `channel_heartbeat` | legacy `agent-channel` |
| Space issue delivery | `registered-agent` | `space_issue_delivery` | legacy `registeredAgent` |
| `myagents session send` target turn | `session-inbox` | `session_send` | legacy `desktop` |
| memory update | `automation` | `memory_update` | legacy `desktop` |

如果落地时无法在所有 path 一次性给普通 Chat turn 填具体 `surface`，可以先填：

```ts
origin_kind = 'desktop'
origin_surface = 'unknown'
```

不要为了猜 surface 引入不可靠状态。

---

## 5. 历史列表交互

### 5.1 默认隐藏自动化 session

普通历史列表默认隐藏：

```ts
session.origin?.kind === 'automation'
&& ['cron', 'task_run'].includes(session.origin.surface)
```

这正好覆盖本期用户截图里的“定时任务 session”刷屏问题。

不默认隐藏：

- `desktop/*`
- `agent-channel/*`
- `registered-agent/*`（是否隐藏待后续产品判断；本期不顺手隐藏）
- `automation/memory_update`（通常不是 session birth；如果未来出现，先不作为“定时任务对话”处理）
- `unknown/*`

老数据兼容：

- 如果 `origin` 缺失但 `cronTaskId` 存在，可 best-effort 当作 `automation/cron`。
- 如果 sessionId 能从 TaskStore `sessionIds[]` 或 CronTask run records 反查到，可 best-effort 当作 `automation/task_run` 或 `automation/cron`。
- 如果无法可靠推断，保持可见，避免误隐藏用户对话。

### 5.2 UI 开关

在历史列表标题行中，“全部”右侧增加一个 icon button：

```text
历史对话   全部 ▾   [eye-off icon]                         [search]
```

交互：

- 默认 `showAutomationSessions=false`。
- icon 默认是隐藏态，比如 `EyeOff`。
- hover tooltip：
  - 隐藏态：`展示定时任务对话`
  - 展示态：`隐藏定时任务对话`
- 点击后切换当前历史列表过滤，不改变 session 数据。
- 状态建议持久化到 localStorage 或用户偏好；如果不持久化，默认每次启动隐藏。

设计约束：

- 用 lucide icon，优先 `Eye` / `EyeOff`。
- 不新增可见说明文案，不把功能解释写在页面上。
- icon button 尺寸和搜索按钮对齐，使用现有历史栏 token。
- Tooltip 用项目现有 tooltip 组件，不手写裸浮层。

### 5.3 搜索和筛选关系

本期规则：

- 默认列表和搜索结果都受 `showAutomationSessions` 影响。
- 如果用户打开“展示定时任务对话”，搜索也能搜到 automation session。
- 现有“全部”下拉如果未来有分类，不在本期扩展。

---

## 6. 关键设计决策

### D1：只保留两层 `OriginKind` + `OriginSurface`

用户明确裁定：前一版把 `entryIntent`、`platform`、`sourceType`、`taskId`、`runMode` 都塞进 origin 太复杂。本期只保留两层：

```ts
origin.kind
origin.surface
```

理由：

- `kind` 足够表达大类：desktop / automation / agent-channel / registered-agent / session-inbox。
- `surface` 足够表达产品场景：launcher_input / cron / task_run / channel_message 等。
- 其它字段本来就属于独立维度或业务表，不应该让 origin 变成“万能上下文袋子”。

### D2：`origin` 是新事实，不继续扩展旧 `source`

旧 `source` 已经承担了三种不同语义：session legacy channel、analytics source、runtime scenario fallback。继续扩展 `source: cron` 会让维护性更差。

本期：

- `SessionMetadata.source` 保留 legacy IM/channel 兼容。
- Analytics `source` 保留 legacy 兼容。
- 新逻辑写 `origin`。
- 新统计查询优先用 `origin_kind` / `origin_surface`。

### D3：`im` 和 `agent-channel` 在产品/统计层合并

代码现实：

- `InteractionScenario` 同时有 `im` 和 `agent-channel`。
- 系统 prompt、MCP authority、session materialization、external runtime 多数地方把两者当同类处理。
- 当前 `ai_turn_complete.source` 里 builtin IM 可能报 `im`，external runtime channel 可能报 `agent-channel`，有 runtime 实现偶然性。

产品/统计层统一：

```ts
origin_kind = 'agent-channel'
origin_surface = 'channel_message' | 'channel_heartbeat'
```

runtime 控制层暂不改：

- 不删除 `InteractionScenario.type='im'`。
- 不把 builtin IM 直接改成 `agent-channel`，因为 `agent-session.ts` 里有 `currentScenario.type === 'im'` 的权限 fast-path。
- 若未来要统一 runtime scenario，单独开重构 PRD。

### D4：`surface` 不改名为 `scenario`

用户提出 `surface` 是否可以叫 `scenario`。结论是不改。

理由：

- 项目已有 `InteractionScenario`，它是 runtime 控制面，会影响 system prompt、工具权限、MCP self-resolve。
- Analytics/product 的 `surface` 是产品场景细分，不应该和 runtime scenario 混名。
- 本期新增的是 `origin.surface`，不是 `scenario`。

### D5：`ai_turn_complete.origin_*` 表示 turn origin

`session_new` 和 `history_open` 的 origin 都是 session birth origin；`ai_turn_complete` 的 origin 是 turn origin。

理由：

- 一个 session 出生于 desktop，后续可能被 cron、session-inbox、IM heartbeat 驱动。
- 如果 `ai_turn_complete` 只复制 session birth origin，来源用量表会错。
- 来源用量明细应该回答“这轮 tokens 是谁触发的”，不是“这个 session 当初谁创建的”。

### D6：统计必须兼容老字段

admin 统计表已经存在：

- 新会话入口分布依赖 `session_new.triggered_by`
- 来源用量明细依赖 `ai_turn_complete.source`

本期不能让老数据断层。查询层必须：

```ts
normalizedKind = origin_kind ?? deriveLegacyKind(source, triggered_by)
normalizedSurface = origin_surface ?? deriveLegacySurface(source, triggered_by)
```

老字段保留至少一个版本周期，后续再看是否下线 legacy query。

### D7：首期做默认隐藏，不做 grouped history

GitHub #420 提到 merge/group/parent item/automation history 等多种可能。本期先做默认隐藏 + 展示开关。

理由：

- 用户当前截图里的痛点是普通列表被定时任务刷屏。
- 复杂 grouping 需要 task/cron/run record 三侧更完整的 join 和 UI 设计。
- `origin` 是 grouping 的前置地基。先把地基打准，再做 parent item。

---

## 7. 技术方案

### 7.1 新增共享类型

建议新增文件：

```text
src/shared/session-origin.ts
```

导出：

```ts
export type OriginKind = ...;
export type OriginSurface = ...;
export interface SessionOrigin { kind: OriginKind; surface: OriginSurface; }

export function normalizeLegacySessionOrigin(input: ...): SessionOrigin;
export function originToAnalytics(origin: SessionOrigin | undefined): {
  origin_kind: OriginKind;
  origin_surface: OriginSurface;
};
```

也可以先只导出类型，helper 放在 renderer/server 各自 utils 中。但为了避免枚举漂移，类型本身必须共享。

### 7.2 SessionMetadata 增字段

改：

- `src/server/types/session.ts::SessionMetadata`
- `src/renderer/api/sessionClient.ts::SessionMetadata`

新增：

```ts
origin?: SessionOrigin;
```

`updateSessionMetadata` 白名单加入 `origin`。

如果 Rust search index 需要展示/过滤 origin，后续可把 `origin_kind` / `origin_surface` 加到 Tantivy schema；本期历史列表如果只走 sessions REST，可以先不动 search schema。

### 7.3 创建 / materialization 写入 origin

#### Desktop GUI

`TabProvider.tsx::trackSessionNewForBirth` 已经消费 `PendingSessionBirthContext`：

```ts
surface: birth.surface
entryIntent: birth.entryIntent
```

落地时需要把同一份 birth context 写进 session metadata：

```ts
origin = mapDesktopBirthToOrigin(birth.surface)
```

注意 `bug_report` 映射为 `desktop/assistant`。

具体写法可以是：

- 创建 session 时把 `origin` 放进 `/sessions` POST body / `createSession(...opts)`。
- 或 session id materialized 后 `PATCH /sessions/:id` 写 `origin`。

优先推荐创建时写入，避免 session 短时间没有 origin。

#### Floating ball

`useFloatingSession.ts` 当前直接 track `session_new.triggered_by='floating_ball'`，并发送 `/chat/send` 时带 `analyticsSource:'floating_ball'`。

新增：

```ts
origin = { kind: 'desktop', surface: 'floating_ball' }
```

并上报：

```ts
origin_kind: 'desktop'
origin_surface: 'floating_ball'
```

#### Cron / Task Center task run

`/cron/execute-sync` 的 `new_session` 分支创建 `cronSnapshot`。这里是最重要的写入点：

```ts
cronSnapshot.origin = {
  kind: 'automation',
  surface: payload.taskId ? 'task_run' : 'cron',
}
```

实际判断不要只看 `taskId` 变量名，因为 cron payload 的 `taskId` 是 CronTask id；Task Center 反向指针在 Rust `CronTask.task_id`，传到 Node payload 里需要确认字段。实现时应从 Rust payload 明确带一个可判断字段，或在 Rust 创建 CronTask 时传入 `task_id` 相关信息。

如果一时无法可靠区分 Task Center task vs 独立 cron，先统一写 `automation/cron`，但这是次优；Task Detail 的 run history 最好能显示 `task_run`。

#### Agent Channel / IM

IM materialization 目前通过 `SessionMetadata.source` 写 `payload.source as SessionSource`。新增：

```ts
origin = { kind: 'agent-channel', surface: 'channel_message' }
```

heartbeat turn 不一定创建 session；turn origin 用 `channel_heartbeat`。

#### Registered Agent

`inbox/drain-handler.ts::scenarioForInboxMessage` 已能把 Space issue delivery 映射成 `InteractionScenario.type='registeredAgent'`。

materialize missing session 时写：

```ts
origin = { kind: 'registered-agent', surface: 'space_issue_delivery' }
```

### 7.4 ai_turn_complete 写入 origin

新增 helper：

```ts
function originForTurn(input: {
  scenario: InteractionScenario;
  analyticsSource?: TurnAnalyticsSource | null;
  metadata?: ...
}): SessionOrigin
```

建议映射：

```ts
analyticsSource === 'floating_ball' => desktop/floating_ball
scenario.type === 'cron'           => automation/cron 或 automation/task_run
scenario.type === 'im'             => agent-channel/channel_message
scenario.type === 'agent-channel'  => agent-channel/channel_message 或 channel_heartbeat
scenario.type === 'registeredAgent'=> registered-agent/space_issue_delivery
scenario.type === 'desktop'        => desktop/unknown
```

heartbeat route 显式传入 `origin_surface='channel_heartbeat'`，不要靠 `scenario.type` 猜。

session-inbox route 显式传入：

```ts
origin = { kind: 'session-inbox', surface: 'session_send' }
```

memory update route 显式传入：

```ts
origin = { kind: 'automation', surface: 'memory_update' }
```

为避免把 origin 参数散落到每个 runtime adapter，推荐把它作为 SessionEngine request 的可选字段：

```ts
analyticsOrigin?: SessionOrigin
```

然后 builtin/external adapter 传到 turn lifecycle；缺省时再由 scenario fallback。

### 7.5 Analytics 类型与上报

`src/renderer/analytics/types.ts`：

- 给 `SessionNewParams` 加：
  ```ts
  origin_kind: OriginKind;
  origin_surface: OriginSurface;
  ```
- 给 `HistoryOpenParams` 加同样字段。
- 服务器侧 `ai_turn_complete` 事件契约文档补充同样字段。

`track()` 只能稳定处理简单值，所以不要上报：

```ts
origin: { kind, surface }
```

只上报：

```ts
origin_kind: origin.kind
origin_surface: origin.surface
```

### 7.6 Admin 统计兼容

统计侧查询规则：

```ts
function normalizedKind(params) {
  if (params.origin_kind) return params.origin_kind;
  if (params.source === 'cron') return 'automation';
  if (params.source === 'im' || params.source === 'agent-channel') return 'agent-channel';
  if (params.source === 'floating_ball') return 'desktop';
  if (params.triggered_by) return 'desktop';
  return 'unknown';
}

function normalizedSurface(params) {
  if (params.origin_surface) return params.origin_surface;
  if (params.source === 'cron') return 'cron';
  if (params.source === 'im' || params.source === 'agent-channel') return 'channel_message';
  if (params.source === 'floating_ball') return 'floating_ball';
  if (params.triggered_by === 'bug_report') return 'assistant';
  if (params.triggered_by) return params.triggered_by;
  return 'unknown';
}
```

现有两张表建议口径：

1. 新会话入口分布：
   ```sql
   GROUP BY COALESCE(origin_surface, legacy_triggered_by_mapping(triggered_by))
   ```

2. 来源用量明细：
   ```sql
   GROUP BY COALESCE(origin_kind, legacy_source_mapping(source)),
            COALESCE(origin_surface, legacy_source_surface_mapping(source))
   ```

短期可以保留旧表，同时新增 normalized 表。不要直接把老表替换掉，避免历史趋势断裂。

---

## 8. 验收标准

### 8.1 数据写入

1. Launcher 输入创建 session：
   - `SessionMetadata.origin = { kind:'desktop', surface:'launcher_input' }`
   - `session_new.origin_kind='desktop'`
   - `session_new.origin_surface='launcher_input'`

2. Agent 卡片创建 session：
   - `desktop/agent_card`

3. 小助理/诊断创建 session：
   - `desktop/assistant`
   - legacy `triggered_by` 可继续是 `bug_report`

4. 悬浮球创建 session：
   - `desktop/floating_ball`
   - `ai_turn_complete.origin_surface='floating_ball'`

5. 独立 cron `new_session` 执行：
   - 新 session metadata 有 `automation/cron`
   - `ai_turn_complete` 有 `automation/cron`

6. Task Center task run：
   - 关联 session metadata 有 `automation/task_run`
   - `ai_turn_complete` 有 `automation/task_run`，若实现期确实拿不到 task 关联，必须在 PR 说明里标记为 follow-up，不能默默降级。

7. IM / Agent Channel 普通消息：
   - session metadata 有 `agent-channel/channel_message`
   - `ai_turn_complete.origin_kind='agent-channel'`
   - builtin/external 不再在 normalized 统计里分裂成 `im` 与 `agent-channel`

8. Space issue delivery：
   - materialized session 有 `registered-agent/space_issue_delivery`
   - turn event 同样有该 origin

### 8.2 历史列表

1. 默认打开历史列表时，`automation/cron` 和 `automation/task_run` session 不展示。
2. “全部”右侧 icon 默认显示隐藏态。
3. hover 文案正确：
   - 隐藏态：`展示定时任务对话`
   - 展示态：`隐藏定时任务对话`
4. 点击 icon 后，自动化 session 出现在列表中。
5. 再次点击后，自动化 session 隐藏。
6. 普通 desktop session、agent-channel session 不被误隐藏。
7. 老数据 `origin` 缺失时，不因 `source` 缺失而误隐藏。

### 8.3 统计

1. `session_new`、`history_open`、`ai_turn_complete` 都能在 raw analytics payload 中看到 `origin_kind` / `origin_surface`。
2. 老字段仍存在：
   - `session_new.triggered_by`
   - `history_open.entry_source`
   - `ai_turn_complete.source`
3. admin 查询能用 `origin_*` 优先、legacy 字段 fallback。
4. `im` 与 `agent-channel` 在 normalized 来源用量表中合并为 `agent-channel`。

---

## 9. 开放问题与后续期

### 9.1 后续：Grouped history

GitHub #420 的完整理想态可能是：

- 一个 parent cron task item
- 展开后看到每次 run
- 或独立 Automation History / Task Runs 页面

本期不做。等 origin 落地后，再基于 TaskStore / CronTask run records 设计 grouping。

### 9.2 后续：origin 查询进搜索索引

如果后续历史搜索、全局搜索、Task Center 需要按 origin 过滤，应把 `origin_kind` / `origin_surface` 加入 Rust Tantivy schema。首期如果历史列表走 REST sessions，可以先不动。

### 9.3 后续：runtime `im` / `agent-channel` 统一

产品/统计层本期合并；runtime 层暂不动。

未来若要做，需要处理：

- `InteractionScenario` 类型
- `agent-session.ts` IM permission fast-path
- system prompt / MCP authority / runtime headless policy 的所有分支

这应是单独架构 PRD，不顺手做。

### 9.4 后续：更细 platform/sourceType 统计

本期不把 platform/private/group 放进 origin。

如果 admin 后续要看：

- Telegram vs Feishu vs DingTalk vs OpenClaw
- private vs group

应作为独立 analytics 字段或从 legacy `SessionMetadata.source` / channel config join，不污染 origin。

---

## 附录 A：Legacy 映射表

### A.1 session_new triggered_by

| legacy `triggered_by` | origin_kind | origin_surface |
| --- | --- | --- |
| `launcher_input` | `desktop` | `launcher_input` |
| `agent_card` | `desktop` | `agent_card` |
| `new_chat_button` | `desktop` | `new_chat_button` |
| `task_center` | `desktop` | `task_center` |
| `bug_report` | `desktop` | `assistant` |
| `agent_setup` | `desktop` | `agent_setup` |
| `floating_ball` | `desktop` | `floating_ball` |
| `history_click` | `desktop` | `unknown`，但不建议作为新 origin |
| `cron` | `automation` | `cron` |
| `im` | `agent-channel` | `channel_message` |
| `unknown` | `unknown` | `unknown` |

### A.2 ai_turn_complete source

| legacy `source` | origin_kind | origin_surface |
| --- | --- | --- |
| `desktop` | `desktop` | `unknown` |
| `floating_ball` | `desktop` | `floating_ball` |
| `cron` | `automation` | `cron` |
| `im` | `agent-channel` | `channel_message` |
| `agent-channel` | `agent-channel` | `channel_message` |
| `registeredAgent` | `registered-agent` | `space_issue_delivery` |

### A.3 SessionMetadata.source

| legacy `SessionMetadata.source` | origin_kind | origin_surface |
| --- | --- | --- |
| missing | `desktop` | `unknown` |
| `desktop` | `desktop` | `unknown` |
| `${platform}_private` | `agent-channel` | `channel_message` |
| `${platform}_group` | `agent-channel` | `channel_message` |

这只是 fallback，不应覆盖已经存在的 `session.origin`。

---

## 附录 B：实现顺序建议

1. 新增共享类型 `src/shared/session-origin.ts`。
2. `SessionMetadata` 前后端加 `origin?: SessionOrigin`。
3. `updateSessionMetadata` 白名单加 `origin`。
4. Renderer `session_new` 路径写 metadata origin，并上报 `origin_*`。
5. Floating ball session_new / send 路径补 `origin_*`。
6. Cron / Task run 创建 session 路径写 `origin`。
7. IM / agent-channel / registered-agent materialization 写 `origin`。
8. `ai_turn_complete` builtin/external 统一补 `origin_*`。
9. `history_open` 读取目标 session metadata，补 `origin_*`。
10. 历史列表加默认隐藏和 icon toggle。
11. Admin 查询兼容 `origin_*` 优先、legacy fallback。
12. 单测：
    - legacy mapping helper
    - session origin write path
    - history filter predicate
    - ai_turn_complete origin mapping

---

## 附录 C：重要红线

- 不要把前端 Chat 内请求改成全局 `apiPostJson`。Chat Tab 内仍走 `useTabState()` 的 tab-scoped API。
- 不要把 `origin` 塞进 `SessionMetadata.source`。
- 不要把 analytics 直接上报 `{ origin: { kind, surface } }`，`track()` 会 stringify 对象。
- 不要为了合并统计而重构 runtime `InteractionScenario`。
- 不要在 cron/task 路径用不可靠字段误隐藏老 session；无法判断就保持可见。
- 不要在历史列表里新增解释性大段文案；本期就是一个 icon toggle + tooltip。
