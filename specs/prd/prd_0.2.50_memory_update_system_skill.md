---
type: prd
status: draft
created: 2026-07-13
updated: 2026-07-13
scope: "把当前 Session 的 Memory Auto-Update 官方工作流从各工作区的 UPDATE_MEMORY.md 收回为可随 App 强制升级的 system skill `myagents-memory-update`；原 Session 注入只负责精确调用该 Skill 并携带可选的工作区自定义要求。新工作区的 UPDATE_MEMORY.md 默认正文为空，已有文件永不改写；本期不迁移历史内容、不改变现有 session 选择、hidden Task 调度或 Gardener/Molt 的 new-session 机制。"
issue: "产品 bug 调查与需求讨论收敛：Session 7b0b45de-9670-46cd-946c-f3d490b5c778 中 Memory Auto-Update 被语义误导为执行工作区 memory-gardener"
research: "none"
review: "pending（实现前必须验证 system-skill sync 早于 hidden maintenance dispatch，并对 builtin / Codex / Claude Code / Gemini 做精确 Skill 名调用 smoke；重点复核空 UPDATE_MEMORY.md 不再触发双重 skip）"
---

# Memory Update 官方 System Skill PRD

> **执行须知（给空 session 的你）**：本 PRD 是对现有长期记忆 Evo 与隐藏记忆后台任务的增量设计，已经固化本轮 bug 调查、产品意志、完整 prompt 和技术地基；实现不需要回翻聊天记录。
>
> - 自动加载的 `CLAUDE.md` 之外，必须主动 Read：`specs/ARCHITECTURE.md`、`specs/tech_docs/task_center.md`、`specs/tech_docs/multi_agent_runtime.md`、`specs/tech_docs/session_architecture.md`、`specs/tech_docs/system_reminder_protocol.md`、`specs/tech_docs/pit_of_success.md`。
> - 必须先读关联 PRD：`specs/prd/prd_0.2.49_long_term_memory_evolution.md`、`specs/prd/prd_0.2.50_hidden_memory_maintenance_jobs.md`。
> - 关键源码入口见本文“技术地基与改动面”。行号会漂移，本文只给文件名和符号名；实现时用 `rg` 重新定位。
> - 本期不重构 Task Scheduler、SessionEngine 或 Sidecar Owner。Memory Auto-Update 仍注入原 Session，Gardener/Molt 仍各自创建 new session。

## 1. 背景与问题

MyAgents 的长期记忆分为三种不同节奏：

1. **Memory Update**：在符合条件的原 Session 中，回顾该 Session 的工作记忆并沉淀到工作区。
2. **Memory Gardener**：每 72 小时创建独立 Session，整理长期记忆存量。
3. **Memory Molt**：每 14 天创建独立 Session，审视并更新底层原则。

现有调度和 Session 路由本身是正确的，但 Memory Update 的官方方法论放错了 owner：完整 prompt 被复制到每个工作区根目录的 `UPDATE_MEMORY.md`，生成后由用户持有，产品后续无法统一升级。

### 1.1 真实 bug

目标 Session：

```text
7b0b45de-9670-46cd-946c-f3d490b5c778
```

2026-07-13 03:37，该 Session 收到的是旧 Memory Auto-Update 的正常注入，而不是 Gardener/Molt Task：

```xml
<system-reminder>
<MEMORY_UPDATE>
整理你的记忆。不用赶时间，做仔细。
...
</MEMORY_UPDATE>
</system-reminder>
```

随后模型主动读取工作区 `.claude/skills/memory-gardener/SKILL.md`，在原 Session 内执行了 Gardener 的全量维护、状态更新、commit 和 push。

已验证的事实：

- 目标 Session 的 origin 是普通 desktop session，没有 `systemMaintenanceKind=memory_gardener`。
- 真正的 Gardener Task 仍为 `runMode=new-session`，实际创建了独立 Session。
- 统一日志明确记录入口为 `POST /api/memory/update`，最终由 `[memory-auto-update]` 结算。
- `UPDATE_MEMORY.md` 与本地 `memory-gardener` description 同时使用“整理记忆”、日志路由、核心记忆裁剪等语义，造成 Skill 自动选择碰撞。
- 2026-07-05 之后抽查的 30 次 `<MEMORY_UPDATE>` 中，至少 15 次直接读取或执行了本地 `memory-gardener`，不是单次偶发。

### 1.2 根因

根因不是 `new-session` 失效，而是官方 Memory Update 工作流与工作区自定义内容混在同一个用户文件中：

```text
官方流程应该随产品升级
        ↓
却被首次生成后冻结在 UPDATE_MEMORY.md
        ↓
不同工作区长期漂移，且可能与其它 Skill 的触发描述重叠
        ↓
模型在当前 Session 中选择了错误的维护流程
```

用户的核心判断是：

> Session 级 Memory Update 也应该是一个官方 system skill，有版本升级能力。工作区可以补充自定义要求，但新工作区的自定义模板默认为空；历史文件先不做任何处理。

## 2. 产品目标

把 Memory Update 的官方方法论收回到 MyAgents 自己拥有的 system skill：

```text
myagents-memory-update
```

它与 `myagents-memory-gardener`、`myagents-memory-molt` 一样：

- 打包在 App 的 `bundled-skills/`。
- force-sync 到 `~/.myagents/skills/`。
- 随 `SYSTEM_SKILLS_VERSION` 升级并覆盖旧官方副本。
- description 只在系统或用户明确指定完整 Skill 名时触发。

工作区根目录 `UPDATE_MEMORY.md` 的职责改为：

> 只保存该工作区对官方 Memory Update 流程的附加要求。

新工作区的该文件默认没有正文。空文件不代表关闭，是否启用只有一个权威：

```text
agent.memoryAutoUpdate.enabled
```

## 3. 本期范围

### 3.1 做什么

1. 新增官方 system skill `myagents-memory-update`，持有完整的 Session 工作记忆沉淀流程。
2. Memory Auto-Update injected turn 精确指定 `myagents-memory-update`，并携带工作区可选的自定义要求。
3. 将新生成的 `UPDATE_MEMORY.md` 改为“frontmatter 存在、正文为空”。
4. 修改空文件语义：正文为空时继续执行官方 Skill，不再跳过 Memory Update。
5. 保留 `UPDATE_MEMORY.md` 的本地可编辑入口；用户可填写工作区特有的文件结构、分类方式和维护偏好。
6. 将 `myagents-memory-update` 接入现有 system-skill force-sync 与完整性门控，并 bump `SYSTEM_SKILLS_VERSION`。
7. 将 Gardener/Molt 的 description 收窄为“只有明确指定完整 Skill 名才触发”。
8. 保证 system-skill sync 在 hidden memory maintenance 可能 dispatch 之前完成；缺少官方 Skill 时 fail closed，不允许模型临场猜测官方流程。
9. 保留当前成功标记：只有官方流程及必要的 Git 操作完成后，才返回 `MEMORY_UPDATE_OK`。

### 3.2 明确不做什么

- 不自动改写、清空、迁移或删除任何已有 `UPDATE_MEMORY.md`。
- 不对历史文件做 hash migration、templateVersion migration 或内容识别。
- 不自动修改工作区已有的本地 `memory-gardener` / `molt` Skill。
- 不修改 Memory Auto-Update 的 eligible Session 计算、query threshold、idle cooldown、扫描窗口或 hidden Task 调度。
- 不把 Memory Auto-Update 改成 new session；它必须继续使用原 Session 的完整上下文。
- 不修改 Gardener/Molt 的 `new-session` 机制、周期或 managed task 可见性。
- 不新增一套 system-skill 安装机制；复用现有 `SYSTEM_SKILLS` / `SYSTEM_SKILLS_VERSION` force-sync。
- 不在本期新增 Memory Update UI badge；来源可观测性可作为后续独立需求。
- 不让用户编辑官方 system skill 来保存工作区差异；差异只能写入工作区 `UPDATE_MEMORY.md`。

## 4. 最终职责模型

| 层 | Owner | 作用域 | 执行位置 | 是否随 App 升级 |
|---|---|---|---|---|
| Memory Update 官方流程 | `myagents-memory-update` system skill | 当前 Session 产生的工作记忆与相关工作区产物 | 原 Session | 是 |
| Memory Update 工作区补充 | `<workspace>/UPDATE_MEMORY.md` | 工作区特有的记忆结构、目录和偏好 | 随原 Session prompt 注入 | 否，用户权威 |
| Gardener | `myagents-memory-gardener` system skill | 工作区长期记忆存量 | 72h 独立 Session | 是 |
| Molt | `myagents-memory-molt` system skill | 底层原则与长期演化 | 14d 独立 Session | 是 |

最终执行链：

```text
App bootstrap
  → force-sync system skills
  → hidden Memory Auto-Update Task 扫描原 Sessions
  → 选中 eligible Session
  → ensure UPDATE_MEMORY.md 存在（正文可以为空）
  → 读取可选 workspace custom instructions
  → 注入 <MEMORY_UPDATE>
  → 精确调用 myagents-memory-update
  → 官方 Skill 在原 Session 上下文内执行
  → 成功后仅回复 MEMORY_UPDATE_OK
```

## 5. Prompt 与 Skill 契约

本章内容是产品契约。实现时可以做必要的空白符调整，但不得改变职责、优先级或完成语义。

### 5.1 Memory Auto-Update injected prompt

完整 prompt：

```xml
<system-reminder>
<MEMORY_UPDATE>
深度回顾当前 Session 的工作记忆，使用 `myagents-memory-update` skill，遵循记忆系统原则，将记忆沉淀到工作区内，让未来 Session 通过工作区仍然记得发生过的关键信息。

以下是当前工作区自定义的维护要求：
<workspace-memory-instructions>
${UPDATE_MEMORY_MD_CONTENT}
</workspace-memory-instructions>

只处理当前 Session 的工作记忆、相关工作区产物及其直接造成的修正。

Current time: ${now}

完成后仅回复 MEMORY_UPDATE_OK。
</MEMORY_UPDATE>
</system-reminder>
```

约束：

- `${UPDATE_MEMORY_MD_CONTENT}` 是去掉 YAML frontmatter 后的正文，可以为空字符串。
- 正文为空时仍保留空的 `<workspace-memory-instructions>` 标签，使 wire 形态稳定，也便于日志与 transcript 确认本轮确实读取了工作区配置。
- 精确 Skill 名使用普通文本 `` `myagents-memory-update` skill ``，不依赖 `/myagents-memory-update` 的 slash 解析。
- 原因：该 injected turn 绕过 Renderer slash-command 处理；builtin、Codex、Claude Code、Gemini 对 `/xxx` 的原生命令语义不统一。现有 Gardener/Molt managed task 也使用 `Use the <exact-name> skill` 的跨 Runtime 形式。
- prompt 必须通过专用纯 builder 构造，不继续在 `/api/memory/update` handler 内手拼大段字符串。遵守 `system_reminder_protocol.md` 的生成侧约束。

### 5.2 `myagents-memory-update` 完整 Skill 草案

目标路径：

```text
bundled-skills/myagents-memory-update/SKILL.md
```

草案：

```markdown
---
name: myagents-memory-update
description: >
  MyAgents 当前 Session 工作记忆沉淀 Skill。只有系统或用户明确指定使用
  `myagents-memory-update` 时才触发；不要根据任务语义或相似表述自行触发。
---

# MyAgents Memory Update

深度回顾当前 Session 的工作记忆，遵循工作区的记忆系统原则，将有持续价值的信息沉淀到工作区，让未来 Session 仍然能够准确接续这里发生过的事情。

本 Skill 只处理当前 Session 产生的工作记忆、相关工作区产物及其直接造成的修正。直接执行本流程，不再委派其它记忆维护流程。

## 输入

- 当前 Session 的完整对话与工作上下文。
- 当前时间。
- 可选的 `<workspace-memory-instructions>`。它可以补充本工作区的文件位置、记忆分类、目录习惯和维护偏好；如果与本 Skill 的作用域冲突，以本 Skill 的作用域为准。

## 工作流程

### 1. 深度回顾当前 Session

回顾整个 Session，重点识别自上次记忆更新以来产生的有效增量：

- 已完成的工作和当前状态
- 重要事实、判断、决策及其原因
- 新发现的经验、规律和踩坑
- 用户给出的新偏好、反馈或要求
- 未完成事项、下一步和阻塞条件
- 本 Session 产生、修改或引用的重要工作区文件

只沉淀会帮助未来 Session 恢复上下文或避免重复犯错的信息，不把完整聊天内容机械复制进记忆。

### 2. 读取记忆系统原则

查找并阅读工作区已有的记忆规则、近期日志和与本 Session 直接相关的 topic。遵循工作区已经建立的记忆分层、文件命名、时间戳、去重和索引原则；不要凭空发明第二套结构。

如果工作区提供了 `<workspace-memory-instructions>`，在本 Skill 的作用域内应用这些补充要求。

### 3. 整理本 Session 的工作区文件

检查能够确认由本 Session 创建或修改的工作区文件，按照工作区已有的目录结构和命名习惯做适当整理：

- 将散落的交付物、研究材料和中间产物放入合适位置
- 合并或移除已经确认无价值的重复、临时文件
- 文件移动后同步修正相关引用和记忆中的路径

只整理能够确认属于本 Session 的文件，不卷入其他 Session 或用户正在进行的无关改动。

### 4. 沉淀工作记忆

根据工作区既有记忆结构，将信息写入最合适的位置。对于采用 MyAgents 默认记忆结构的工作区：

- 当天工作过程和结果写入 `memory/YYYY-MM-DD.md`
- 项目状态、具体经验、决策和下一步写入对应的 `memory/topics/<name>.md`
- 会持续影响未来工作的跨项目原则、稳定认知和重要索引写入工作区的 MEMORY 规则文件

相同信息只保留在最合适的位置，其他层通过指针引用。不要为了显得完整而重复保存。

### 5. 同步直接修正

如果当前 Session 明确推翻了旧状态、旧判断、旧路径或旧下一步，同步修正对应记录，避免未来 Session 继续读取已经失效的信息。

只处理当前 Session 直接造成的修正，不借本次更新对整个记忆库存做无关巡检。

### 6. 记录本次维护

在今天的日志中简要记录：

- 本次新增或更新了哪些记忆
- 整理了哪些工作区文件
- 修正或移除了哪些失效信息
- 未来 Session 应从哪里继续

### 7. Commit 并 push

如果工作区是 Git 仓库：

1. 检查本次记忆沉淀和文件整理产生的变更。
2. 只暂存本次 Session 直接产生或修改的文件，不带入其他 Session 或用户已有的无关未提交改动。
3. 创建清晰的记忆维护 commit。
4. push 当前分支。

如果工作区不是 Git 仓库，跳过本步骤。没有产生任何需要保存的变化时，不创建空 commit。

只有所有必要操作都完成后，才回复 `MEMORY_UPDATE_OK`。Git 仓库需要 push 而 push 失败时，不得回复成功标记；应简洁说明失败原因，让系统将本次运行记录为失败。

## 完成检查

- 未来 Session 能否只通过工作区文件恢复本次工作的关键上下文？
- 记忆是否写进了正确层级，而不是重复散落？
- 本 Session 产生的文件是否位于合理位置，引用是否仍有效？
- 是否只处理了本 Session 及其直接影响？
- Git commit 是否只包含本次相关文件，且 push 已完成？
```

### 5.3 新的默认 `UPDATE_MEMORY.md`

目标文件：

```text
src/shared/default-update-memory.md
```

新模板：

```markdown
---
description: >
  可选的工作区记忆更新要求。留空时使用 MyAgents 官方
  myagents-memory-update 流程；可以在下方补充本工作区的文件结构、
  记忆分类、目录习惯和维护偏好。
---
```

产品语义：

- “模板为空”指 YAML frontmatter 之后的正文为空，不要求生成物是 0 字节。
- frontmatter 给用户解释文件用途，但运行时继续 strip，不进入 custom instructions。
- 空正文表示“没有工作区附加要求”，不表示关闭 Memory Update。
- 是否启用只看 `memoryAutoUpdate.enabled`。
- 默认模板不再包含 `{{MEMORY_RULE_PATH}}`，因此旧的 placeholder 替换与参数传递如果没有其他调用方，应同步删除，避免保留失去职责的复杂度。

### 5.4 Gardener/Molt description

`myagents-memory-gardener`：

```yaml
description: >
  MyAgents 长期记忆整编 Skill。只有系统或用户明确指定使用
  `myagents-memory-gardener` 时才触发；不要根据任务语义或相似表述自行触发。
```

`myagents-memory-molt`：

```yaml
description: >
  MyAgents 长期记忆进化 Skill。只有系统或用户明确指定使用
  `myagents-memory-molt` 时才触发；不要根据任务语义或相似表述自行触发。
```

这两个 Skill 的 body 和 managed task prompt 本期不重写。description 不再罗列“整理记忆”“记忆体检”“信念审计”等语义触发词；系统 Task 已经会精确指定完整 Skill 名，不需要依赖模糊匹配。

## 6. 空文件与历史文件语义

### 6.1 新工作区

当 Memory Auto-Update 第一次运行，或用户在设置页点击 `UPDATE_MEMORY.md` 且文件不存在时：

1. 继续 ensure `.claude/rules` 的 SOUL / USER / MEMORY 基座。
2. 在工作区根目录创建新的 frontmatter-only `UPDATE_MEMORY.md`。
3. 正文为空也继续执行 `myagents-memory-update`。

### 6.2 已有工作区

已有 `UPDATE_MEMORY.md`：

- 永不自动覆盖、清空、改写或迁移。
- strip frontmatter 后的正文原样作为 `<workspace-memory-instructions>` 注入。
- 老官方模板、用户定制模板和强工作区 prompt 都按“用户自定义要求”继续生效。

这是有意的向后兼容决策，不是遗漏。它意味着历史工作区不会自动切换成“纯官方默认行为”；用户需要时可以主动清空或修改正文。

### 6.3 历史边界的已知结果

本期不处理 `/Users/zhihu/Documents/project/mino/UPDATE_MEMORY.md` 或其本地 `.claude/skills/memory-gardener`。因此：

- 产品不能声称升级后会自动清理所有旧工作区的语义冲突。
- Mino 如需立即采用纯官方流程，需要用户手动清空/精简 `UPDATE_MEMORY.md`，并自行决定是否收窄或退休本地重复 Skill。
- 这不是产品自动 migration 的一部分，不能在实现中顺手修改。

## 7. 成功、失败与 Git 语义

### 7.1 成功

仅当以下条件全部成立时返回：

```text
MEMORY_UPDATE_OK
```

- Runtime turn 本身成功。
- 需要的记忆和工作区整理已完成，或确认无有效增量。
- Git 仓库中需要保存的相关变更已经 commit。
- 只要产生了本次 commit，该 commit 就已经 push；没有 remote、认证失败或 push 失败都不算完成。
- 没有把无关未提交改动带进 commit。

如果没有任何需要保存的变化，可以不创建空 commit，仍视为成功。

### 7.2 失败

以下情况不得返回成功标记：

- 官方 `myagents-memory-update` Skill 缺失或未被 Runtime 加载。
- 文件读写失败。
- 必需的 commit 或 push 失败。
- Runtime turn 失败或超时。
- 无法确认本次操作只涉及当前 Session 的文件。

现有 `/api/memory/update` 已用 `turnResult.success && turnResult.text.trim() === 'MEMORY_UPDATE_OK'` 判定完成。本期保留该强 gate。失败文本可以用于日志诊断，但不得被 Rust 记录为“updated successfully”。

## 8. System Skill 安装与启动顺序

### 8.1 复用现有 force-sync

新增目录：

```text
bundled-skills/myagents-memory-update/
└── SKILL.md
```

同步接入：

- Rust：`src-tauri/src/commands.rs::SYSTEM_SKILLS`
- Node：`src/server/index.ts::SYSTEM_SKILLS`
- Rust：bump `SYSTEM_SKILLS_VERSION`（实现时以当前值为准；本 PRD 成文时为 `32`）
- Tauri bundle 已整体打包 `../bundled-skills`，不新增独立资源映射。

现有完整性门控必须继续成立：

- bundle 源目录缺 `SKILL.md` 时，不清除用户机器上的旧完整副本。
- 任一应安装 system skill 缺失或不完整时，不写新版本戳。
- 健康安装按版本戳和每个 `SKILL.md` 快速返回。

### 8.2 sync 必须早于 maintenance dispatch

当前 system-skill force-sync 主要由 Renderer `ConfigProvider` 调用 `cmd_sync_system_skills`。但 hidden Memory Auto-Update 的 startup reconcile 是 Rust disk-first，未来也可能在无窗口或 Renderer 尚未完成加载时运行。

一旦 Memory Update 依赖官方 Skill，Renderer 不能继续是唯一同步 owner。实现必须满足：

```text
system-skill sync complete
        ↓
TaskScheduler initialize / memory maintenance reconcile
        ↓
任何 Memory Update / Gardener / Molt dispatch
```

推荐复用 `sync_system_skills_blocking` 的同一实现，在 Rust app bootstrap / `initialize_cron_manager` 前建立一次可等待的完成点；阻塞文件 IO 必须放进 `tauri::async_runtime::spawn_blocking`，不能阻塞 Tauri setup 主线程。

Renderer 的调用可以保留为幂等 opportunistic/self-healing 路径，但不能承担唯一正确性责任。

若同步失败或 `myagents-memory-update/SKILL.md` 不完整，本轮 Memory Auto-Update 必须 fail closed 并写 unified log，不能让模型在找不到 Skill 时自行猜测流程。

## 9. 跨 Runtime 约束

Memory Auto-Update 继续通过 `SessionEngine.runInjectedTurn()` 路由到目标 Session 的真实 Runtime，不允许重新手写 runtime 分支。

现有技能暴露路径：

- builtin Claude Agent SDK：`~/.myagents/skills` 通过工作区 `.claude/skills` symlink 暴露；SDK session 启动时扫描，builtin 支持 `reloadSkills()`。
- Codex：`CodexRuntime.startSession()` 调 `syncProjectUserConfigFiles()`，并通过 `skills/extraRoots/set` 注入 `<workspace>/.claude/skills`。
- Claude Code / Gemini：沿用现有 external runtime 的工作区 Skill 同步与下次 Session 重扫语义。

产品不把 `/myagents-memory-update` 当跨 Runtime 协议。稳定协议是 prompt 中精确出现完整 Skill 名，并要求使用该 Skill。

生产 App 升级会重启进程，正常情况下 system skill 会在 Session/Sidecar 启动前同步。开发态或同步异常下仍需 fail closed；不能因为 UI Slash Picker 能看到 Skill 就假设活跃 external runtime 已加载。

## 10. 技术地基与改动面

| 文件 / 符号 | 当前职责 | 本期要求 |
|---|---|---|
| `src-tauri/src/memory_auto_update.rs::run_batch` | ensure 文件、收集 eligible sessions、逐 Session 注入 | 不再因 `UpdateMemoryFileState::Empty` 跳过；在依赖缺失时 fail closed |
| `src-tauri/src/memory_auto_update.rs::prepare_update_memory_file` | ensure 记忆基座和 `UPDATE_MEMORY.md` | 空正文返回 ready；必要时删除 `Empty` 状态 |
| `src-tauri/src/memory_auto_update.rs::ensure_update_memory_file` | 缺失时从默认模板创建，已有文件不覆盖 | 保持 create-new 与 symlink/dir 防护；frontmatter-only 文件合法 |
| `src/server/index.ts` `/api/memory/update` | 读文件、strip frontmatter、拼 prompt、`runInjectedTurn`、marker gate | 删除 `empty_content` skip；调用统一 prompt builder；保留 SessionEngine 和 marker 强 gate |
| `src/shared/default-update-memory.md` | 新工作区完整官方工作流模板 | 改为 frontmatter-only 的可选自定义模板 |
| `src-tauri/src/workspace_files/memory_rules.rs` | embed/render 默认模板与 `{{MEMORY_RULE_PATH}}` | placeholder 不再需要时删除相应参数和替换逻辑 |
| `src/shared/memory-rules.ts` | Renderer 侧默认模板 placeholder render | 同步删除失去用途的 placeholder helper/参数 |
| `AgentMemoryUpdateSection.tsx` | 打开/创建/编辑本地 `UPDATE_MEMORY.md` | 继续提供编辑入口；创建结果与 Rust 路径一致 |
| `bundled-skills/myagents-memory-update/` | 新增 | 官方 Session 级工作记忆沉淀方法论 |
| `bundled-skills/myagents-memory-gardener/SKILL.md` | 官方 Gardener | 只改 description 为精确名称触发 |
| `bundled-skills/myagents-memory-molt/SKILL.md` | 官方 Molt | 只改 description 为精确名称触发 |
| `src-tauri/src/commands.rs::SYSTEM_SKILLS` | system skill force-sync 清单 | 加入 update skill，bump version，保持完整性门控 |
| `src/server/index.ts::SYSTEM_SKILLS` | Node seed 排除清单 | 与 Rust 保持完全一致 |
| `src-tauri/src/cron_task/init_recovery.rs::initialize_cron_manager` | scheduler 初始化和 Memory Auto-Update startup reconcile | 保证 system-skill sync 完成点在维护任务可 dispatch 之前 |
| `src/server/session-engine/` | runtime-aware injected turn facade | 继续复用，不新增业务分支 |

### 10.1 必须遵守的项目红线

- 前后端工作区文件 IO 继续走 Rust workspace file 能力，不新增 Sidecar workspace IO endpoint。
- Rust localhost HTTP 继续使用 `local_http`，不创建裸 `reqwest::Client`。
- Tauri startup 的递归文件同步必须 async + `spawn_blocking`，不能冻结 WebView。
- 不直接设置 `shouldAbortSession`；本需求不需要新增 abort 路径。
- 所有新增 system skill 必须同时进入 Rust/Node 清单并 bump 版本，不能只放 bundle 目录。
- system skill 同步必须验证源含 `SKILL.md` 后再覆盖，完整落地后才写版本戳。
- 新的 system-reminder prompt 使用统一 builder；如新增可见 badge 才需改 `systemTagLabel()`，本期不新增 badge。
- 任何 Session 配置/注入/等待完成继续走 `SessionEngine` facade。

## 11. 实施顺序

### Phase 1：官方 Skill 与同步地基

1. 新增 `bundled-skills/myagents-memory-update/SKILL.md`。
2. 收窄 Gardener/Molt descriptions。
3. 更新 Rust/Node `SYSTEM_SKILLS` 清单。
4. bump `SYSTEM_SKILLS_VERSION`，更新同步完整性测试。
5. 将 sync 的正确性 owner 前置到 hidden maintenance dispatch 之前。

### Phase 2：Prompt 与空自定义语义

1. 新增纯函数 `buildMemoryUpdateReminder(...)`，生成 §5.1 的唯一 wire 文本。
2. `/api/memory/update` 删除 `empty_content` skip。
3. Rust `run_batch` 删除空正文 skip，空文件继续参与 eligible session 扫描与注入。
4. 保留已有文件、symlink、目录、读取失败的安全语义。

### Phase 3：默认模板和冗余清理

1. 将 `src/shared/default-update-memory.md` 改成 frontmatter-only。
2. Rust/Renderer 两条创建路径输出字节一致。
3. 删除失去用途的 `{{MEMORY_RULE_PATH}}` render 参数和 helper；如果实现调查发现仍有真实调用方，则保留并在代码注释中说明 owner。

### Phase 4：验证

1. 跑 deterministic unit/integration tests。
2. 对 builtin、Codex、Claude Code、Gemini 做 credentialed smoke。
3. 用一个空正文工作区和一个旧自定义正文工作区分别端到端验证。
4. 确认 Gardener/Molt 仍然 new-session，Memory Update 仍然原 Session。

## 12. 验收标准

### A. 新工作区默认路径

1. 工作区没有 `UPDATE_MEMORY.md`。
2. Memory Auto-Update 开启并到达扫描窗口。
3. 系统生成 frontmatter-only 文件。
4. 正文为空，但 eligible Session 仍收到 injected turn。
5. 模型精确读取并执行 `myagents-memory-update`。
6. 未来 Session 可以从工作区记忆恢复本次关键上下文。
7. 有相关 Git 变更时，只提交相关文件并 push。
8. 成功后 assistant 最终文本严格等于 `MEMORY_UPDATE_OK`。

### B. 已有自定义文件

1. 工作区已有非空 `UPDATE_MEMORY.md`。
2. App 升级后文件字节完全不变。
3. 正文被放入 `<workspace-memory-instructions>`。
4. 官方 Skill 仍是执行 owner，自定义内容只作为该工作区补充要求。

### C. 空文件不是开关

- frontmatter-only、0 字节或只有空白正文的 `UPDATE_MEMORY.md` 都不得产生 `empty_content` / `UpdateMemoryFileState::Empty` 跳过。
- `memoryAutoUpdate.enabled=false` 才会禁用自动更新。
- 手动 Memory Update 使用同一个官方 Skill 和空自定义语义。

### D. 精确 Skill 触发

- prompt 明确包含 `myagents-memory-update` → Update Skill 可被调用。
- 普通用户说“整理一下记忆”“更新工作状态”但未明确指定 Skill 名 → 三个官方 memory skills 的 description 都不应因此自行触发。
- Gardener/Molt managed task 精确指定各自完整名称 → 仍正常触发。
- Memory Update turn 不再因为相似语义自动选择 Gardener/Molt。

### E. System-skill 升级

- 新 App 版本启动后，`~/.myagents/skills/myagents-memory-update/SKILL.md` 存在且内容等于 bundled 版本。
- 旧版本副本在 `SYSTEM_SKILLS_VERSION` bump 后被覆盖。
- bundle 缺失/不完整时不写新版本戳、不删除已有完整副本。
- hidden maintenance 不能抢在 system-skill sync 之前 dispatch。

### F. 路由不回归

- Memory Update 继续向原 Session 注入，不创建新 Session。
- Gardener/Molt 继续每次生成新 UUID，并带正确 `systemMaintenanceKind`。
- builtin 与 external runtime 都继续走 `SessionEngine.runInjectedTurn()`。
- 失败 turn、push 失败或 completion marker 缺失都不能记录为 updated successfully。

## 13. 测试要求

### 13.1 Rust

- `ensure_update_memory_file`：缺失时生成 frontmatter-only 文件。
- 现有非空文件不覆盖。
- frontmatter-only / 空白 / 0 字节文件均为 ready，而不是 skip。
- symlink 与目录继续拒绝。
- `run_batch` 在空自定义正文下仍收集并执行 eligible sessions。
- system-skill 同步列表完整性包含 `myagents-memory-update`。
- 缺失或不完整的 bundled source 不推进版本戳。
- startup 顺序测试证明维护 reconcile 等待 system-skill sync completion。

### 13.2 TypeScript unit/integration

- `buildMemoryUpdateReminder` 对空正文和非空正文生成稳定快照。
- `/api/memory/update` 空正文不返回 `empty_content`。
- 非空自定义内容完整保留在内部标签中。
- Runtime turn 仅在文本严格等于 `MEMORY_UPDATE_OK` 时完成。
- prompt 使用精确 Skill 名，不依赖 slash command。
- Rust 与 Renderer 创建的默认模板字节一致。
- Rust/Node `SYSTEM_SKILLS` 清单有 cross-check，防未来漂移。

### 13.3 Credentialed smoke

至少覆盖：

- builtin Claude Agent SDK
- Managed Codex 或 system Codex
- Claude Code
- Gemini

每条 smoke 使用包含以下 fixture 的临时工作区：

- 官方 `myagents-memory-update`
- 一个 description 含“整理记忆”的相邻本地 Skill
- 空 `UPDATE_MEMORY.md`

验收模型实际读取/执行的是 `myagents-memory-update`，完成记忆文件写入，并返回 marker。测试不得依赖真实用户仓库或真实 Git remote；Git push 行为用受控本地 bare remote 验证。

## 14. 关键设计决策

### D1：官方流程归 system skill，不再复制进工作区模板

原因：官方方法论需要随产品升级。继续 seed-once 到工作区会让旧用户永久停留在旧 prompt，并把官方流程与用户定制混成一个 owner。

### D2：工作区文件正文默认空，但文件继续存在

原因：用户仍需要一个直观、可编辑的工作区差异入口。frontmatter 解释用途，空正文表达“没有附加要求”，比删除文件或在代码配置中维护另一套文本更直接。

### D3：空正文不再表示禁用

原因：是否启用已经由 `memoryAutoUpdate.enabled` 负责。让空文件再承担隐式开关会产生双权威，并使新默认模板直接关闭功能。

### D4：不处理历史文件

原因：已有 `UPDATE_MEMORY.md` 是用户内容权威，无法可靠区分“旧官方模板”与“用户有意保留的完整工作流”。本期宁可保留旧行为，也不静默覆盖用户工作区。

### D5：Skill 只靠精确名称触发

原因：这三个 Skill 都由系统流程精确引用，不需要通过“整理记忆”等泛化语义争抢普通 turn。精确触发可以从源头减少跨层误路由。

### D6：精确名称使用普通 prompt，不把 slash 当协议

原因：injected turn 不经过 Renderer 的 slash command 解析，外部 Runtime 对 `/xxx` 的定义也不统一。跨 Runtime 的最窄公约数是完整 Skill 名和明确的 use 指令。

### D7：官方 Skill sync 是维护任务的启动前置

原因：新流程在运行时硬依赖 system skill。只由 Renderer opportunistic sync 会让无窗口、延迟前端或异常启动场景先 dispatch 后安装，产生不可预测的 fallback。

### D8：Git 仓库需要 commit 并 push

原因：用户把工作区视为跨 Session 的持久记忆载体；只写本地但不 push，无法保证工作区记忆在其正常 Git 工作流中完整持久化。为了不吞掉并发工作，stage 范围必须限制在当前 Session 直接产生或修改的文件。

### D9：不修改现有调度和 Session 路由

原因：本次调查已经证明 `memory_auto_update_batch → 原 Session` 与 Gardener/Molt `new-session` 路由正确。修复 owner 和 Skill 触发边界即可；在 scheduler 或 SessionEngine 上叠 guard 会修错层。

## 15. 开放问题与后续期

本期没有阻塞性产品开放问题。以下内容明确推迟：

1. **历史模板升级 UI**：未来可提供“对比官方默认 / 清空自定义要求”，但不得自动覆盖。
2. **Memory Update 来源 badge**：未来可在原 Session 显示“Memory Update · 当前会话”，解决隐藏 user turn 造成的来源误解。
3. **system skill 设置页只读标识**：如用户经常误以为可长期编辑官方 Skill，可在 UI 标注“随 App 更新”。
4. **结构化失败结果**：当前沿用 marker missing/turn failed；未来可增加受控的 `MEMORY_UPDATE_FAILED:<reason>` 诊断协议。
5. **更强的 per-turn Skill allowlist**：只有 Runtime 官方支持并完成源码验证后再考虑；本期不伪造不存在的硬隔离能力。

## 16. 附录：关联文件

### 必读文档

- `CLAUDE.md`
- `specs/ARCHITECTURE.md`
- `specs/tech_docs/task_center.md`
- `specs/tech_docs/multi_agent_runtime.md`
- `specs/tech_docs/session_architecture.md`
- `specs/tech_docs/system_reminder_protocol.md`
- `specs/tech_docs/pit_of_success.md`
- `specs/prd/prd_0.2.49_long_term_memory_evolution.md`
- `specs/prd/prd_0.2.50_hidden_memory_maintenance_jobs.md`

### 关键源码

- `src-tauri/src/memory_auto_update.rs`
- `src-tauri/src/workspace_files/memory_rules.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/cron_task/init_recovery.rs`
- `src-tauri/src/lib.rs`
- `src/server/index.ts`
- `src/server/session-engine/`
- `src/server/runtimes/codex.ts`
- `src/server/agent-session.ts`
- `src/shared/default-update-memory.md`
- `src/shared/memory-rules.ts`
- `src/renderer/components/AgentSettings/sections/AgentMemoryUpdateSection.tsx`
- `bundled-skills/myagents-memory-gardener/SKILL.md`
- `bundled-skills/myagents-memory-molt/SKILL.md`

### 调查证据（仅用于复核，不应写入产品逻辑）

- `~/.myagents/sessions/7b0b45de-9670-46cd-946c-f3d490b5c778.jsonl`
- `~/.myagents/logs/unified-2026-07-13.log`
- `/Users/zhihu/Documents/project/mino/UPDATE_MEMORY.md`
- `/Users/zhihu/Documents/project/mino/.claude/skills/memory-gardener/SKILL.md`

## 执行台账

### 开发契约

#### 必赢场景

1. 新工作区生成 frontmatter-only 的 `UPDATE_MEMORY.md` 后，Memory Update 仍会在原 Session 触发，并明确使用官方 `myagents-memory-update` system skill。
2. 既有工作区的 `UPDATE_MEMORY.md` 永不被启动同步或本期升级覆盖；其正文继续作为工作区自定义维护要求原样注入。
3. 空正文、仅 frontmatter、零字节三种文件状态都表示“没有自定义要求”，而不是“禁用 Memory Update”。
4. `myagents-memory-update`、`myagents-memory-gardener`、`myagents-memory-molt` 只在完整名称被明确引用时触发，不再通过泛化场景描述参与普通 turn 的语义匹配。
5. 官方 Memory Update skill 对当前 Session 的工作区产物做适当整理和记忆沉淀；若工作区为 Git 仓库且本次产生相关变更，则只提交相关变更并推送当前分支；push 失败不得返回成功 marker。
6. Memory Update 保持原 Session + SessionEngine 路由；Gardener/Molt 保持独立 new-session 路由，不更改 scheduler owner 或任务模型。

#### 复用的既有抽象

- System skill 安装：`SYSTEM_SKILLS`、版本门控、完整性校验、`sync_one_system_skill` 与异步 `spawn_blocking` 同步链。
- 调度与路由：Rust `TaskSchedulerController`、`memory_auto_update::run_batch`、`local_http`、Sidecar `SessionEngine.runInjectedTurn`。
- 工作区文件：`ensure_update_memory_file`、现有 symlink/目录防护、Renderer `useWorkspaceFileService`。
- 隐藏消息协议：`system-reminder` + 纯 prompt builder + `MEMORY_UPDATE_OK` 精确 marker。

#### 反向边界

- 不新增 scheduler、后台进程、Session 类型、配置开关或历史迁移器。
- 不让 Gardener/Molt 回到原 Session，不让 Memory Update 新建 Session。
- 不依赖 Renderer 才能完成 system skill 正确性同步。
- 不覆盖、重写或猜测历史 `UPDATE_MEMORY.md` 是否仍是旧默认模板。
- 不把 `/skill-name` slash 解析伪装成 injected-turn 的跨 Runtime 协议。
- 不把空正文继续当作禁用信号；启停唯一权威仍为 `memoryAutoUpdate.enabled`。

#### 允许新增的概念

- 一个官方 system skill：`myagents-memory-update`。
- 一个纯函数 prompt builder：`buildMemoryUpdateReminder`。
- “空正文 = 无工作区附加要求”是既有文件状态的语义修正，不新增第三套状态或配置。

#### 红线

- System skill 清单必须 Rust/Node 对齐，并通过版本升级和完整性校验强制同步；同步不得在 async 主线程做阻塞 IO。
- Memory Update dispatch 前必须保证官方 skill 已完成同步；skill 缺失或不完整时 fail closed。
- 所有 injected turn 必须继续走 SessionEngine facade，成功必须由真实 turn success + 精确 marker 共同判定。
- 已有工作区文件属于用户权威；只允许新建缺失文件，不允许升级覆盖。
- Prompt 必须保留空的 `<workspace-memory-instructions>` 容器，且隐藏 payload 必须继续包在 `<system-reminder>` 中。
- Git 操作只能处理当前 Session 直接相关变更，不得吞入用户并发或无关修改，不得制造空提交。

### 行动清单

- [x] Phase 1：新增并打包 `myagents-memory-update`，收窄三个 memory skill 的 description，更新双端 system skill 清单与版本。
- [x] Phase 1 验证：system skill 清单对齐、版本/完整性同步、三个 description 的精确触发契约。
- [x] Phase 2：新增纯 prompt builder，统一 `/api/memory/update` 注入内容，移除 Node/Rust 空正文 skip。
- [x] Phase 2 验证：空/自定义正文 prompt、精确 marker、SessionEngine 路由与 endpoint 行为。
- [ ] Phase 3：将默认 `UPDATE_MEMORY.md` 模板改为 frontmatter-only，移除失效 placeholder plumbing，保留既有文件不覆盖。
- [ ] Phase 3 验证：缺失文件创建、既有文件不覆盖、零字节/frontmatter-only ready、symlink/目录 fail closed。
- [ ] Phase 4：运行受影响测试、`test:changed`、typecheck/lint、Rust fmt/clippy/相关测试；完成需求复核与 cross-review。
- [ ] Phase 4：修复 review 问题、更新 PRD 状态与台账、按 phase 形成 Conventional Commits 并推送分支。

### 待用户决策

无。现有 PRD 已明确本期产品语义、兼容策略、Git 行为和非目标；如实现中发现与真实 Runtime/同步机制冲突，再暂停并提出具体决策题。

### 进展日志

- 2026-07-13：完成 PRD、架构、任务中心、跨 Runtime、隐藏消息协议和现有代码链第一轮 ground truth 对照。确认当前错误点是 Node/Rust 两处将空正文解释为 skip，以及 Memory Update 尚未由官方 system skill 承担；现有“Memory Update 原 Session、Gardener/Molt new-session”的调度路由无需修改。
- 2026-07-13：完成 Phase 1。新增 force-synced `myagents-memory-update`，三个 memory skill description 改为完整名称精确触发；system skill snapshot 升至 v33，Rust/Node 清单一致。Rust automation startup 在 Task scheduler recovery 前完成同步，三类 hidden memory task dispatch 前再次校验版本与完整性，失败则 fail closed。`cargo test ... system_skills_tests --locked` 10 项通过。
- 2026-07-13：完成 Phase 2。新增纯函数 `buildMemoryUpdateReminder`，`/api/memory/update` 继续走 SessionEngine，但注入内容改为官方 skill + 窄作用域 + 工作区自定义容器；空容器保留。删除 Node `empty_content` 返回与 Rust `UpdateMemoryFileState::Empty` 整批 skip。验证通过：prompt builder 2 项、Rust memory_auto_update 12 项、TypeScript typecheck。
