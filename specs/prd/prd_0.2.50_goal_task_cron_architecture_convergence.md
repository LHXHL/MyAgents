---
type: prd
status: implemented
created: 2026-07-11
updated: 2026-07-12
scope: "在不改变 0.2.50 Goal 已收敛产品体验的前提下，完成 Goal、Task 与 Legacy Cron 的架构收口：Goal 成为以 Session 为唯一产品 owner 的持久状态；所有新的定时自动化统一写入 Task；普通 Legacy Cron 在后端无感迁移为 Task 并继续执行；旧 Ralph Loop 不迁移、不恢复；Task 调度不再依赖持久化 CronTask 副本。本期不实现 Task 自动开启 Goal，不引入 TaskRun、Goal execution policy 或通用 Automation 框架。"
issue: "0.2.50 Goal Mode 完成后的全量代码与架构 Review；用户需求讨论收敛"
research: "本会话对提交 5f7ec762..0bcea5e8 及当前 Goal/Cron/Task 实现的代码审计；specs/prd/prd_0.2.50_goal_mode_loop_upgrade.md；specs/ARCHITECTURE.md；specs/tech_docs/task_center.md；specs/tech_docs/session_architecture.md；specs/tech_docs/multi_agent_runtime.md；specs/tech_docs/task_provider_routing.md；specs/tech_docs/cli_architecture.md"
review: "已完成代码质量、对抗性竞态、架构边界三视角 Review。最终结论无 P0/P1；确认 Goal/Task/Cron 各有唯一 owner，未引入 Goal Sidecar、TaskRun、额外 turn identity 或双持久化。"
---

# Goal、Task 与 Cron 架构收口 PRD

> 执行须知（给空 session 的你）：本 PRD 是同版本 `specs/prd/prd_0.2.50_goal_mode_loop_upgrade.md` 的架构纠偏后续。原 PRD 已实现的 Goal 产品语义、交互和协议继续有效；两份文档冲突时，**产品体验以原 PRD 为准，内部所有权、持久化和调度架构以本 PRD 为准**。实现前必须主动读 `specs/ARCHITECTURE.md`、`specs/tech_docs/task_center.md`、`specs/tech_docs/session_architecture.md`、`specs/tech_docs/multi_agent_runtime.md`、`specs/tech_docs/task_provider_routing.md`、`specs/tech_docs/cli_architecture.md`、`specs/tech_docs/system_reminder_protocol.md` 和原 Goal PRD。本文引用源码使用路径和符号名，不写易漂移行号；请用 `rg` 在当前分支重新定位。

## 1. 背景与核心意志

0.2.50 的 Goal 产品体验已经完成：用户在当前 Session 中设置一个长期目标，AI 持续执行，用户可以暂停、补充、恢复、取消，模型可以在严格边界内标记完成或受阻。

但完整 Review 发现，首版为了快速复用 Ralph Loop，把 Goal 的数据和生命周期继续塞进了 `CronTask`：

- `CronSchedule::Loop` 被用作 Goal 的续跑触发。
- Goal admission、lease、revision、outbox 等持久状态被放入 `cron_tasks.json`。
- `CronTaskManager` 同时处理普通 Cron、Task Center 调度投影、managed job 和 Goal。
- Task Center 自己已有 `TaskStore`，却仍复制一份关联 `CronTask` 才能运行。
- Chat、Launcher、CLI 等入口仍能创建新的裸 `CronTask`，因此“Legacy Cron”并不只代表历史数据。

这和本项目的工程目标不一致。用户对本期的核心要求是：

> 软件工程追求的是满足需求的基础上、架构正确、无技术债、不会因为过度防御写出冗余代码。可维护性来自架构清晰干净，让项目保持熵减。

本期不是给现有双写、nullable 字段组合和多套 scheduler 状态继续增加 guard、retry 或兼容 flag，而是把 work 放回正确的 owner，并删除因此失去必要性的旧路径。

## 2. 已确认的产品决策

以下决策已经收敛，不是开放问题：

1. **Goal 是 Session 关联状态。** 它不属于 Task，也不属于某个 React hook、CronTask 或未来 TaskRun。
2. **一个 Session 同时最多有一个未终态 Goal。** 桌面、IM、Agent Channel 和 CLI 打开同一 Session 时看到同一个 Goal。
3. **Goal 尚未随正式版本发布，没有生产历史数据。** 本期不写 Goal 数据迁移器，不保留旧 Goal-on-CronTask 兼容路径。
4. **旧 Ralph Loop 不迁移。** 它停止后不会恢复；即使磁盘上存在，也只作为历史数据读取，不转换成 Goal 或 Task continuous mode。
5. **普通 Legacy Cron 必须无感迁移为 Task 并继续执行。** 用户已有的正常 `At / Every / Cron` 自动化不能因为架构升级静默失效。
6. **所有新定时自动化统一创建 Task。** Chat、Launcher、CLI、IM Tool 和管理 API 不再持久化新的裸 `CronTask`。
7. **本期不实现 Task 自动开启 Goal。** 不新增 Task→Goal 编排、`TaskRun`、`GoalUntilTerminal` 或相关预留字段。
8. **未来允许松耦合组合。** Task 启动的 Session 中，AI 可以按 Prompt 通过 `myagents goal create` 让当前 Session 自己进入 Goal；Task 系统无需感知 Goal。
9. **现有 Goal 并发协议中真正必要的语义必须保留。** Runtime queue admission、current-turn authority、revision/control revision、Sidecar generation 和 delivery outbox 用来解决真实的跨进程竞态；不把旧实现的 lease/pending 状态原样搬家。
10. **CLI 创建 Goal 继承当前既定权限语义。** 空 permission 按对应 Runtime 最大权限解释；本 PRD 不重新讨论这一产品决策。
11. **已有 Session 的运行配置只有一份权威。** Task 投递到已有 Session 时，model/provider/runtime/reasoning/MCP 继承该 Session；Task 自身配置只在创建新 Session（或首次创建其专属 single-session Session）时作为初始配置。permission 仍可作为本轮执行策略。禁止为同一 Session 实现 task-turn 级配置 snapshot/restore。
12. **每个 Runtime turn 只使用已有 queue identity。** builtin/external 均以现有 queue item ID 关联 dispatch、stop 与 terminal outcome；不新增 Goal 专用 injected turn ID、第二套 outcome cache 或并行的 Node authority identity。

## 3. 实施前技术事实（审计基线）

### 3.1 Legacy Cron 不是独立类型

当前代码里没有名为 `LegacyCron` 的独立持久化模型。Legacy Cron 是 UI 对某类 `CronTask` 的推断：

```text
CronTask
├── 无 task_id、无 goal_status、无 managed_kind -> UI 称为 Legacy Cron
├── 有 task_id                              -> Task 的调度投影
├── 有 managed_kind                         -> 内部 managed job
└── 有 goal_status                          -> Goal backing record
```

关键源码：

- `src-tauri/src/cron_task/types.rs::CronTask`
- `src-tauri/src/cron_task/commands.rs::cmd_get_cron_tasks`
- `src/renderer/components/task-center/TaskListPanel.tsx::fetchLegacyCronTasks`

因此 Legacy Cron 和 `CronTask` 不是两代系统。`CronTask` 是一直沿用至今的底层实体，Legacy 只是“直接把它当产品任务使用”的旧模式。

### 3.2 新的裸 Cron 仍在产生

以下路径仍直接调用或暴露裸 Cron 创建：

- `src/renderer/pages/Chat.tsx::createCronTask`
- `src/renderer/pages/Launcher.tsx::createCronTask`
- `src/renderer/hooks/useCronTask.ts::createCronTask`
- `src-tauri/src/cron_task/commands.rs::cmd_create_cron_task`
- `src-tauri/src/management_api.rs::create_cron_handler`
- `src/server/admin-api.ts` 的 Cron create 转发

Task Center 又在 Renderer 加载时把没有 `task_id` 的 Cron 当作 Legacy 自动升级。这会导致同一条新任务在桌面启动后变成 Task，在 headless/IM 路径却可能继续作为 Cron，产品身份依赖 Renderer 是否运行过。

### 3.3 Task 与 Cron 是双真相

`src-tauri/src/task.rs::Task` 已保存 execution mode、schedule、run mode、end conditions、runtime、provider、model、permission、MCP 和 notification 等配置，但 `management_api.rs::ensure_cron_for_task` 又把它们投影成关联 `CronTask`。

当前关系：

```text
Task.cron_task_id <-> CronTask.task_id
```

Task 更新成功、Cron 同步失败时可能出现两份状态不一致；启动时还有 Cron 反向修补 Task schedule 的逻辑。权威方向并不唯一。

### 3.4 Goal 被放在错误的聚合中

`CronSchedule` 同时包含时间触发 `At / Every / Cron` 和完成事件触发 `Loop`。这把“什么时候触发”与“当前 Session 是否处于 Goal 生命周期”混成同一个调度模型。

Goal 的业务身份虽然已经由显式 `goalStatus` 表达，但物理状态仍与所有 CronTask 共用 `cron_tasks.json`，导致每次 admission、claim、finalize、release 都可能克隆和重写整份 Cron 数据。

### 3.5 Scheduler 和执行生命周期有多份事实源

当前存在：

- `CronTask.status`
- `CronTaskManager.active_schedulers`
- `CronTaskManager.scheduler_handles`
- Renderer 分步调用 start task / start scheduler
- Goal pause/cancel 与 `SessionEngine.stopTurn()` 分成两个请求
- Rust、HTTP、Node SessionEngine 各自持有一层长超时

这使“磁盘显示 Running，但没有活 scheduler”“旧 handle 继续执行旧 schedule”“外层已重试但旧 Turn 仍在运行”成为可能。

### 3.6 Cron store 存在真实数据完整性风险

`src-tauri/src/cron_task/store.rs::atomic_save_tasks` 在获得文件锁之前形成整库快照。不同写路径可能按与业务提交相反的顺序落盘，旧快照覆盖更新后的 Goal/Task 状态。

`src-tauri/src/cron_task/manager.rs::load_tasks_from_file` 在文件损坏或部分记录失败时会得到空/部分集合，`init_recovery.rs` 随后可能把恢复结果写回原文件，造成损坏数据被覆盖成空库或部分库。

## 4. 目标架构

最终结构必须收敛为：

```text
                         ┌────────────────────┐
TaskStore ──────────────>│ SchedulerController│
                         └─────────┬──────────┘
                                   │ trigger Task
                                   v
                            Task execution use case
                                   │
                                   v
                              SessionEngine

SessionGoalStore ──> GoalService ──> one-shot continuation / SessionEngine

LegacyCronReader ──> startup migration ──> TaskStore
                 └─> read-only history for non-migrated rows
```

这里共享的是调度、Sidecar 和 SessionEngine 基础设施，不共享 Task 与 Goal 的业务状态。

### 4.1 Task：所有新自动化任务的唯一真相

Task 负责：

- 用户可见任务身份、名称、文档和状态机。
- `At / Every / Cron` 时间触发配置。
- 使用当前 Session、预选 Session 或创建新 Session 的策略。
- Runtime/provider/model/permission/MCP/notification 等 Task 级配置。
- 运行统计、审计和关联 Session 列表。

Task 不再拥有：

- `cron_task_id`
- 需要持久化的 CronTask 副本
- 由 CronTask 反向修补的 schedule 状态

Task Scheduler 每次触发时从 TaskStore 读取当前权威 Task，并生成只存在于本次调用内的执行参数。这个执行参数不是新的持久化聚合。

### 4.2 Goal：Session 的一等持久状态

Goal 的产品查询键是 `session_id`：

```text
getSessionGoal(sessionId)
createSessionGoal(sessionId, objective)
pauseSessionGoal(sessionId)
resumeSessionGoal(sessionId)
updateSessionGoalObjective(sessionId, objective)
markSessionGoalTerminal(sessionId, status, reason)
cancelSessionGoal(sessionId)
```

Goal 使用独立物理 Store，因为 current-turn authority、revision 和 outbox 需要原子事务；但它不是独立于 Session 的产品对象，也不进入 Task Center。

建议逻辑模型：

```text
SessionGoalState
├── session_id
├── id（当前 Goal incarnation，阻止旧 Turn 回写新 Goal）
├── objective
├── status: active | paused | complete | blocked | canceled
├── revision / control_revision
├── turn_number / consecutive_failure_count
├── terminal_reason
├── current turn authority（若有：queue_id / kind / turn_number / sidecar_generation）
├── channel delivery outbox（若有）
└── created_at / updated_at
```

Store 以 `session_id` 为产品查询键，只保留该 Session 当前 Goal；创建新 Goal 时替换已终态旧 Goal。Goal `id` 只承担 incarnation fence，不建立历史列表。

Node 现有消息队列拥有所有尚未 promotion 的消息，Rust 不再复制持久 Pending queue。只有真正到达 Runtime promotion boundary 的 turn 才原子写入 `current turn authority`；terminal/stop 使用同一个 queue ID 完成或撤销。多条 user query 的排队顺序由现有 queue 保证，不再分别持久化 `user_admissions`。

Goal 明确不得持有：

- `task_id` / `run_id` / `cron_task_id`
- Task execution mode
- tab id
- model/provider/runtime/reasoning/MCP 快照
- 普通 Cron delivery 配置

这些配置继续由当前 Session 和 SessionEngine 拥有。Goal 创建来自 Tab、Task 启动的 Session、IM 或 Agent Channel，都走同一条 Session Goal 路径。

### 4.3 Legacy Cron：只读兼容格式

Legacy Cron 的职责只剩：

1. 解析旧 `cron_tasks.json`。
2. 在 scheduler 恢复前，把可迁移的普通时间 Cron 转换为 Task。
3. 为不可迁移或按决策不迁移的记录提供只读历史展示。

Legacy reader 不再：

- 创建新 CronTask。
- 更新 CronTask。
- 启动 CronTask scheduler。
- 承载 Goal。
- 作为 Task 的执行投影。

### 4.4 SchedulerController：唯一 timer owner

SchedulerController 只拥有可重建的内存 handle，不持久化业务真相：

- Task timer 由 Task 状态和时间触发配置重建。
- Goal active continuation 使用完成事件后的 one-shot timer/退避，不再使用 `CronSchedule::Loop`。
- paused/terminal Goal 不持有轮询 scheduler。
- schedule 更新必须原子替换旧 handle。
- stop/delete 必须移除对应 handle。
- 应用启动恢复只从迁移后的 TaskStore 和 SessionGoalStore 读取。

`active_schedulers` 这类第二份状态必须删除；“是否有 handle”由唯一 handle map 回答，“业务上是否应运行”由 Task/Goal Store 回答。

### 4.5 单次执行 owner

本期不要求发明通用 Automation 框架，但 Task 和 Goal 的每一次 AI Turn 必须复用同一组现有基础设施约束：

- Sidecar Owner 获取与对称释放。
- 通过 `src/server/session-engine/` facade 选择 builtin/external adapter。
- 一个端到端 deadline owner。
- timeout/stop 后真正取消当前 Turn，并等待或确认 idle 后才 finalize/retry。
- 真正成功后才能提交成功结果。

Sidecar Owner 应体现真实业务 owner：新的 Task 执行不再使用 `SidecarOwner::CronTask`；Goal 创建后必须独立持有对应 Session 的 Goal owner。具体 enum 命名可以按现有 `SidecarOwner` 约定实现，但不能继续用 CronTask 身份冒充 Task/Goal。

## 5. 本期范围

### 5.1 Goal 从 CronTask 中拆出

必须完成：

- 新建 Session Goal 的 Rust 持久状态与事务入口。
- `cmd_*_goal_task`、Management `/api/goal/*`、CLI `myagents goal` 改为调用 Session Goal facade。
- `src/server/session-engine/goal-orchestrator.ts` 保持 Sidecar/session ingress owner，但不再读写 CronTask identity。
- Goal continuation 由 Turn terminal 事件驱动，在必要 delay/backoff 后触发下一轮。
- 保留原 Goal PRD 已实现的 visible-tail、首轮 user bubble、实时流式展示、pause/resume、objective edit、terminal、IM outbox 等产品行为。
- 保留 Runtime queue admission、current-turn authority、revision/control revision、Sidecar generation 和 outbox 的正确性语义，把持久状态归回正确 Store。
- 上一条要求保留的是并发语义，不是原实现的类型数量：pending admission 由既有 Runtime queue 拥有，scheduler/user 共用一个已 promotion 的 current-turn authority；不得保留 lease 或重复状态机。
- 删除 `CronTask` 上的 Goal 字段、Goal 专用分支和 `CronSchedule::Loop` Goal 语义。
- 不读取、不迁移当前开发构建写下的 Goal-on-CronTask 数据。

### 5.2 Task 直接调度

必须完成：

- SchedulerController 直接从 TaskStore 重建和触发 Task。
- `TaskStore` 成为 schedule、status、runtime override 和 notification 的唯一权威。
- 删除 `Task.cron_task_id`、`CronTask.task_id` 及所有 ensure/sync/heal/CAS back-pointer 流程。
- 删除 `management_api.rs::ensure_cron_for_task`，或用直接 Task 调度 use case 彻底替代；最终产物中不能保留同职责双路径。
- Task 每次执行前继续动态读取 `task.md`，保留用户中途编辑后下一次运行立即生效的现有优点。
- Task provider/model/MCP routing 继续遵守 `task_provider_routing.md`，不得重新持久化 credential env。
- Task 投递到已有 Session 时不得临时覆盖该 Session 的 model/provider/runtime/reasoning/MCP；这些字段只用于创建执行 Session 时的初始配置。若用户显式修改专属 single-session Task 的配置，应通过既有 Session 配置路径更新其基线，而不是建立 turn-scoped rollback 协议。
- managed scheduled jobs 也必须成为隐藏的 managed Task，由同一 Task Scheduler 执行，不能保留 managed Cron 旁路。

本期不要求把 Task 的所有历史字段重写成全新 schema。允许保留 `execution_mode + dispatch_at / interval_minutes / cron_expression` 的兼容存储，但必须有一个 Rust 单一解析/校验入口把它转换为合法的时间触发；Scheduler、UI 和 API 不得各自解释字段组合。

Task 的 `Loop` execution mode 本期退出新模型：

- 新建和编辑不再提供 Loop。
- 旧 Loop 不恢复。
- 不转换为 Goal。
- 未来“Task 启动 Session 后持续做事”通过 Session 内显式创建 Goal 解决，而不是复活 Task Loop。

### 5.3 关闭所有新裸 Cron 写入

必须审计并收口：

- Chat 定时入口
- Launcher 定时入口
- `useCronTask`
- Tauri `cmd_create_cron_task`
- Management `/api/cron/create`
- `myagents cron add`
- IM Cron Tool
- Admin API
- managed maintenance jobs

用户可见命令名可以为兼容继续叫 `myagents cron`，但其 create/update/start/stop/list 语义必须落到 Task API；它不能再写 `cron_tasks.json`。

`cmd_get_cron_tasks` 如仍保留，只能作为 Legacy history reader，不能成为新任务主列表或状态 owner。

修改 `src/cli/myagents.ts` 或 bundled Goal/Task skill 后，必须同步提升 `src-tauri/src/commands.rs` 中对应的 `CLI_VERSION` / `SYSTEM_SKILLS_VERSION`，确保已经安装过中间开发构建的用户也会拿到最终 CLI 和 skill；不能只依赖首次安装同步。

### 5.4 普通 Legacy Cron 无感迁移

迁移必须由 Rust 后端在启动恢复阶段完成，时序为：

```text
读取并校验 Legacy Cron
-> 迁移普通时间 Cron / Task-linked / managed rows
-> 原子提交 TaskStore
-> 建立 Task scheduler handles
-> 恢复 active Session Goals
```

禁止 Renderer 打开 Task Center 后才迁移。

#### 分类规则

| Legacy 行形状 | 处理 |
|---|---|
| 普通 `At / Every / Cron`，无 `task_id` | 无感迁移为 Task，继续执行 |
| 已有关联 `task_id` 的 Task 投影 | 以 Task 为权威；不再恢复这条 Cron projection |
| `managed_kind` 记录 | 关联/迁移为 managed Task，由 Task Scheduler 执行 |
| `Loop` 且无显式 Goal identity | 不迁移、不恢复；只读历史 |
| 当前开发构建产生的显式 Goal row | 无生产兼容承诺；不迁移为 Task/Goal |
| 损坏或语义无法确定 | 隔离原文件并显示可诊断错误，禁止猜测执行 |

#### 无感迁移要求

- 尽量沿用旧 Cron ID 作为 Task ID；TaskStore 已存在同 ID 且 migration provenance 与该 Legacy row 匹配时视为迁移已完成，保证幂等且不需要额外 migration ledger。
- Running 普通 Cron 迁移为应继续调度的 Task；Stopped 保持停止；已自然结束的一次性任务映射为终态。
- 精确保留 schedule、timezone、start/catch-up 语义、workspace、Session 策略、结束条件、Runtime/provider/model/permission/MCP 和 notification。
- 保留原 ID 后，既有 run history 可继续按同一 ID 查询；不得制造重复历史。
- 迁移发生在任何旧/new scheduler 启动前，确保同一触发点最多由一套 scheduler 执行。
- 旧文件可以作为只读原始备份保留；Task Center 主列表只展示迁移后的 Task，不能同时显示重复 Legacy 卡片。
- 合法记录迁移失败时必须显式进入可诊断的 degraded/blocked 状态，不能静默不运行，也不能回退启动旧 Cron scheduler。
- legacy `provider_env` 不得复制到 TaskStore。按 `task_provider_routing.md` 解析 provider identity；无法安全恢复时把 Task 标为 Blocked 并给出重新选择 provider 的操作提示，不能猜测路由。

### 5.5 存储事务与损坏保护

TaskStore 和 SessionGoalStore 的业务 mutation 必须各自只有一个事务入口：

```text
获得 Store 写锁
-> 读取当前权威内存状态
-> clone candidate
-> mutate + validate
-> 原子持久化 candidate
-> 替换内存状态
-> 释放锁
-> 执行广播、通知、Sidecar 等 post-commit 副作用
```

禁止：

- 在文件锁外形成全库旧快照，随后任意顺序写盘。
- mutation 先改内存、异步稍后 best-effort save。
- 持久化失败后仍广播成功。
- 启动解析失败后用空集合覆盖原文件。

加载结果必须显式区分：

```text
Missing
Valid
ValidButNeedsMigration
Corrupt
```

只有完整 `Valid` 或已完整验证的 migration candidate 可以写回；`Corrupt` 必须保留/隔离原始字节并停止该 Store 的自动 mutation。

Task/Goal run history 若继续使用 append 或 read-modify-write 文件，也必须走项目现有 `with_file_lock` / `withFileLock` chokepoint。History 是 best-effort 查询投影，写入失败不得回滚已经提交的 Task/Goal 权威状态，但并发 writer 不能互相覆盖。

### 5.6 Stop、Cancel、超时与恢复

Goal 控制必须是后端单一 use case：

- Stop 当前 Goal Turn：持久化 `paused` 与 `SessionEngine.stopTurn()` 属于同一操作语义。
- Cancel Goal：terminal commit 与停止当前 Turn 属于同一操作语义。
- Resume：不能用旧补偿覆盖并发 terminal 状态。
- objective update：继续遵守现有 admission/queue/CAS 边界。
- adapter timeout：必须取消真实 Turn；Builtin 和 external 语义一致。
- transport timeout 必须长于业务 deadline，只负责发现链路失联，不能成为第二个业务 timeout owner。
- finalize terminal/result 必须验证 current-turn authority、control revision 和 Sidecar generation，旧 generation 不能回写新状态。

应用重启时：

- active Goal 恢复 Goal owner 并重新协调 continuation。
- paused Goal 保持 paused，不启动每秒轮询，不预占无必要 Sidecar。
- terminal Goal 不恢复执行。
- running Task 根据 Task trigger/status 重建唯一 scheduler handle。

### 5.7 删除旧路径与文档对齐

实现结束时必须删除，而不是仅标 deprecated：

- Task↔Cron back-pointer 和同步/反向修复代码。
- Renderer legacy auto-upgrade sweep。
- `active_schedulers` 第二状态源。
- Goal-on-CronTask mutation、scheduler、commands 和 tests。
- 无生产者的 renderer `cron:trigger-execution` 管线及其 mark/record commands。
- 普通创建路径对 `cmd_create_cron_task` 的依赖。
- `CronSchedule::Loop` 的新建/恢复能力。

需要同步：

- `specs/ARCHITECTURE.md`
- `specs/tech_docs/task_center.md`
- `specs/tech_docs/session_architecture.md`
- `specs/tech_docs/task_provider_routing.md`
- `specs/tech_docs/cli_architecture.md`
- `specs/tech_docs/system_reminder_protocol.md`（仅当 Goal wire/UI 协议发生变化）
- 原 `prd_0.2.50_goal_mode_loop_upgrade.md` 顶部追加“内部架构已由本 PRD 收口”的历史说明，但不改写其已实现产品背景

## 6. 明确不做

本期禁止顺手扩大到：

- Task 启动 Session 后由系统自动设置 Goal。
- `TaskRun` 持久实体或 Task→Goal 父子关系。
- `GoalUntilTerminal`、Task execution policy 等未来字段。
- Task 等待 Goal 终态后再决定自身状态的编排。
- 通用 Automation aggregate、插件式 scheduler framework 或动态 trait 注册系统。
- 同一 Session 多个 active Goal。
- detached/new-session Goal 产品入口。
- Goal token budget。
- Goal 专用 `injectedTurnId`、独立 terminal outcome 历史 Map、Node 内存 authority Map。
- Task turn 的 model/provider/runtime/reasoning/MCP snapshot/restore。
- 旧 Ralph Loop 到 Goal/Task 的迁移。
- 为未发布 Goal 数据建立版本兼容层。
- 重做原 0.2.50 Goal 的横条、首轮 user bubble、visible-tail 或流式交互设计。
- 仅为了架构改名而重写所有用户可见文案。

未来 Task 想让 Session 进入 Goal 时，首选简单组合：Task Prompt 要求 AI 在当前 Session 调用 `myagents goal create`。因为 Goal create 只依赖当前 Session，这条路径无需 Task 系统预埋任何关系。只有未来明确要求“Task 生命周期必须等待/控制 Goal”时，才另立需求讨论编排模型。

## 7. 关键设计决策与理由

### D1：Goal 逻辑归 Session，不归 Task/Cron

Goal 的用户体验、恢复、普通 query、pause/resume 和输出路由都围绕 Session。把它放进 CronTask 会让调度形状冒充产品 identity，也迫使普通 Cron API 处处过滤 Goal。

### D2：Goal 使用独立 Store，但不是独立产品对象

独立 Store 是为了事务和更新频率隔离，不是为了把 Goal 做成 Task Center 对象。API 仍以 session-first facade 暴露。

### D3：不迁移未发布 Goal

没有生产历史数据时，兼容旧错误结构只会永久增加分支。现在直接删除是成本最低、架构最正确的窗口。

### D4：旧 Ralph Loop 不迁移、不恢复

旧 Loop 是一次性、已停止即结束的实验能力，不值得为极低价值数据保留新系统入口。它也不能被推断成 Goal，否则会改变用户未明确设置的 Session 状态。

### D5：普通 Legacy Cron 必须迁移并继续运行

普通时间任务可能承载真实用户自动化，直接停掉会造成静默业务损失。迁移必须在后端、scheduler 恢复前、幂等完成，用户无需打开 Task Center 或手动确认。

### D6：Task 是所有新定时自动化的唯一真相

Task 已经拥有产品状态、配置、审计和文档。再保存一份 CronTask 只会制造同步失败、反向修复和不一致，不提供新的领域价值。

### D7：共享基础设施，不共享领域状态

Task 与 Goal 都需要 timer、Sidecar 和 SessionEngine，但生命周期不同。共享 Scheduler/SessionEngine plumbing 可以减少代码；把两者塞进同一聚合只会制造 nullable 字段分支。

### D8：不为未来 Task→Goal 预埋模型

Session 本身就是二者天然的组合点。未来可以通过 Prompt+CLI 进入 Goal；现在引入 TaskRun、origin_task_id 或 execution policy 会创造没有当前需求约束的技术债。

### D9：保留必要并发语义，不保留重复状态机

revision/control revision、当前 turn queue ID、Sidecar generation 和最小 outbox 分别解决旧控制快照、精确 Turn 归属、replacement Sidecar 和 at-least-once delivery。尚未 promotion 的消息已经由 Runtime queue 拥有，不在 Rust 复制 Pending admission；scheduler/user turn 共享一个 current-turn authority。builtin/external 的 terminal waiter 直接绑定 queue item，不保留 Goal 专用 injected ID 或“最近 N 次结果”缓存。

### D10：迁移失败 fail-visible，不回退双引擎

保留旧 scheduler 作为 fallback 会让“双路径”永久存在，并可能重复执行。合法数据迁移应可靠成功；损坏或无法安全恢复的记录必须明确 Blocked/可诊断。

### D11：兼容命令名可以保留，兼容持久模型不能保留

`myagents cron` 可以作为用户习惯和脚本兼容层映射到 Task API，但底层不能继续写 CronTask。兼容发生在 ingress，不发生在领域 Store。

### D12：每个终态只由一个事务 owner 提交

状态先持久化成功，再广播/通知/释放资源。不得由 Renderer、Scheduler 和 SessionEngine 各自猜测同一业务终态。

## 8. 验收标准

### 8.1 架构静态验收

- [x] 新建/编辑 Task、Goal 的代码路径不再持久化 `CronTask`。
- [x] `Task` 不再包含 `cron_task_id`，Cron 数据不再包含 `task_id`。
- [x] Goal 状态类型不位于 `cron_task` 模块，不依赖 `CronSchedule::Loop`。
- [x] 正常 Task/Goal 模块不能 import Legacy Cron mutation API。
- [x] `ensure_cron_for_task`、Renderer legacy auto-upgrade、`active_schedulers` 已删除。
- [x] `SidecarOwner` 对新 Task/Goal 使用真实 owner identity，不再冒充 `CronTask`。
- [x] `myagents cron add` 若保留，最终创建的是 Task。
- [x] managed jobs 走 Task Scheduler，没有 managed Cron 旁路。
- [x] 修改过 CLI/bundled skill 时，对应 `CLI_VERSION` / `SYSTEM_SKILLS_VERSION` 已提升并有同步回归测试。

### 8.2 Legacy 迁移验收

- [x] Running `At / Every / Cron` Legacy 记录升级后仍按原规则执行且只执行一次。
- [x] Stopped Legacy 记录迁移后保持停止。
- [x] 已完成的一次性 Legacy 记录不会被重新触发。
- [x] 对同一份 Legacy store 连续启动两次不会创建重复 Task。
- [x] Task Center 只显示迁移后的 Task，不同时显示 Legacy duplicate。
- [x] Renderer 从未打开，迁移仍会完成。
- [x] headless/IM 启动路径不会继续创建或运行裸 CronTask。
- [x] 旧 Ralph Loop 不迁移、不恢复、不创建 Goal。
- [x] 损坏 Legacy 文件不会被空集合覆盖，原始字节可供诊断。
- [x] 无法安全解析 provider 的记录进入可见 Blocked，不会错路由执行。

### 8.3 Task 调度验收

- [x] Task schedule 更新后旧 handle 被停止，只有新 schedule 生效。
- [x] start/stop/delete/restart 都通过同一 SchedulerController use case。
- [x] 磁盘 Running 与 live handle 不一致时，recovery 能确定性修复或显式报错。
- [x] 每次 Task tick 读取最新 `task.md` 和 Task 配置。
- [x] builtin/external Runtime 都通过 SessionEngine facade，并以真实 Turn 成功决定结果。
- [x] stopped Task 手动 run 后 Sidecar Owner 对称释放。

### 8.4 Goal 回归验收

- [x] `/goal`、CLI、IM/Agent Channel 对同一 Session 创建同一个 Goal。
- [x] 首轮用户原文仍显示 user bubble 和 Goal badge，隐藏 payload 不外显。
- [x] 首轮与后续轮的 thinking/tool/result 持续流式展示。
- [x] Stop 当前 Turn 后 Goal 原子进入 paused，不能自动抢跑下一轮。
- [x] paused 后用户发送普通 query，Goal 恢复且该 query 正常可见。
- [x] Cancel 后没有晚到 continuation 把 Goal 重新激活。
- [x] objective edit、model terminal 和 user cancel 的竞态保持 first-writer-wins。
- [x] timeout 后真实 Turn 已取消，旧 Turn 不会与 retry 并行产生副作用。
- [x] 应用重启后 active Goal 恢复；paused/terminal Goal 不轮询、不续跑。
- [x] IM/Agent Channel outbox 保持 at-least-once 语义和稳定 delivery id。
- [x] Goal terminal 后释放 Goal Sidecar Owner；仍有 Tab/Agent owner 时 Sidecar 不被误杀。

### 8.5 存储与并发验收

- [x] 构造“旧快照晚写”交错时，新状态不会被覆盖。
- [x] 持久化失败不会更新内存权威或广播成功。
- [x] Corrupt/partial store 不会在 recovery 中被覆盖。
- [x] 并发 pause/resume/cancel、scheduler claim/finalize、Sidecar replacement 有确定性测试。
- [x] run history 写入失败不反向改变 Task/Goal 权威状态。

### 8.6 质量门禁

- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] `npm run test:classification`
- [x] `npm run test:unit`
- [x] `npm run test:dom`
- [x] `npm run test:integration`
- [x] `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- [x] `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D clippy::disallowed_methods -D clippy::disallowed_macros`
- [x] Rust Task/Goal/Scheduler migration 与并发测试全部通过
- [x] 完成三视角 cross-review：代码质量、对抗性竞态、架构边界

## 9. 推荐实施顺序

### Phase A：建立正确 owner

1. 新增 SessionGoalStore/GoalService。
2. 把 Goal API、CLI、orchestrator 和状态迁到新 owner。
3. 增加真实 Goal Sidecar Owner。
4. 保持原 Goal UX 回归通过。
5. 删除 Goal-on-CronTask 路径，不保留双写。

### Phase B：Task 直接调度

1. 建立唯一 Task SchedulerController 和 Task trigger resolver。
2. 让 Task run/rerun/scheduled tick 直接读取 TaskStore。
3. 迁移 managed jobs。
4. 删除 Task↔Cron projection、back-pointer、heal 和双状态。

### Phase C：Legacy 迁移与 ingress 收口

1. 后端启动时迁移普通 Legacy Cron。
2. 跳过旧 Ralph Loop 和开发期 Goal rows。
3. Chat、Launcher、CLI、IM、Admin 全部改走 Task create/update。
4. 移除 Renderer 自动迁移。
5. Legacy reader 降级为只读历史。

### Phase D：事务、清理与文档

1. 统一 Store transaction/load health。
2. 统一 stop/timeout/finalize 语义。
3. 删除 dead commands/events/tests 和旧 scheduler branches。
4. 更新长期架构文档与原 Goal PRD 的后续说明。
5. 跑全量门禁和 cross-review。

Phase 可以拆成多个可回滚提交，但最终交付不能留下“新路径为主、旧路径 fallback”的长期双轨。每个 Phase 结束都应删除已经被替代的 owner，而不是只把它标成 deprecated。

## 10. 开放问题与后续期

本 PRD 没有待用户拍板的产品问题。以下仅是未来独立需求，不得在本期预实现：

1. Task 生命周期是否要等待其 Session 中的 Goal 终态。
2. Recurring Task 的某次 Goal 尚未完成时，下一个触发点应该 skip、coalesce 还是 queue。
3. 是否需要显式 TaskRun 审计实体。
4. 是否提供 detached/new-session Goal 产品入口。
5. 是否为 Goal 提供 token/time budget。

在这些需求真正出现前，Task Prompt + `myagents goal create` 已提供足够的松耦合组合能力。

## 11. 关联文档与源码线索

### 产品与架构文档

- `specs/prd/prd_0.2.50_goal_mode_loop_upgrade.md`
- `specs/ARCHITECTURE.md`
- `specs/tech_docs/task_center.md`
- `specs/tech_docs/session_architecture.md`
- `specs/tech_docs/multi_agent_runtime.md`
- `specs/tech_docs/task_provider_routing.md`
- `specs/tech_docs/cli_architecture.md`
- `specs/tech_docs/system_reminder_protocol.md`
- `specs/tech_docs/pit_of_success.md`

### 最终实现入口

- `src-tauri/src/session_goal/manager.rs::SessionGoalManager`
- `src-tauri/src/session_goal/store.rs`
- `src-tauri/src/session_goal/types.rs::SessionGoal`
- `src-tauri/src/task.rs::TaskStore`
- `src-tauri/src/task_scheduler.rs::TaskSchedulerController`
- `src-tauri/src/task_execution.rs`
- `src-tauri/src/legacy_upgrade.rs::upgrade_legacy_cron`
- `src-tauri/src/cron_task/manager.rs::CronTaskManager`（Task 兼容 facade + Legacy 只读诊断）
- `src-tauri/src/sidecar/cron_execute.rs`
- `src-tauri/src/sidecar/types.rs::SidecarOwner`
- `src/server/session-engine/goal-orchestrator.ts`
- `src/server/session-engine/selector.ts`
- `src/renderer/hooks/useSessionGoal.ts`
- `src/renderer/hooks/useCronTask.ts`
- `src/renderer/components/task-center/TaskListPanel.tsx`
- `src/renderer/api/cronTaskClient.ts`
- `src/cli/myagents.ts`

## 12. 空 Session 最终检查

接手实现者读完本文后应能明确回答：

- Goal 是 Session 状态，不是 Cron/Task 子对象。
- Goal 没有生产历史数据，不做迁移。
- 普通 Legacy Cron 迁移为 Task 并继续执行。
- 旧 Ralph Loop 不迁移、不恢复。
- 所有新定时自动化只写 Task。
- Task Scheduler 直接读取 Task，不再持久化 Cron projection。
- 本期不做 Task→Goal 编排，不引入 TaskRun。
- 必要并发协议保留，但移动到正确 owner。
- 实现结束必须删除旧写路径、双真相和多份 scheduler 状态。

任何实现如果无法同时满足以上九点，应先回到本 PRD 重新校准，而不是增加新的兼容分支。

## 执行台账

### 开发契约（2026-07-11）

- **必赢场景：** 升级后，合法的普通 Legacy `At / Every / Cron` 在 Rust 启动恢复阶段幂等变成 Task，并由唯一 Task scheduler 继续执行；所有新定时入口只创建 Task；旧 Ralph Loop 不恢复；同一个 Session 的 Goal 由独立 SessionGoalStore 恢复、暂停、续跑和终态，完全不依赖 CronTask；原 0.2.50 Goal 的首轮气泡、流式展示、Stop→paused、下条 query 恢复、IM outbox 行为无回归。
- **复用的既有抽象：** `TaskStore` 与 `write_atomic_text`；`with_file_lock`；既有 `SidecarOwner` 引用计数；`ensure_session_sidecar` / Sidecar lifecycle；既有消息队列的 `queueId`、turn-boundary 与 terminal signal；`src/server/session-engine/selector.ts` 与 builtin/external adapter；Task 的 provider/model/MCP validator；Tauri `broadcast`/event；现有 Task status history 与 run history 投影。
- **反向边界：** 不实现 Task 自动开启或等待 Goal；不新增 TaskRun、Goal execution policy、通用 Automation aggregate、插件式 scheduler、独立 Goal Sidecar 进程、`injectedTurnId`、detached Goal、token budget、旧 Goal 数据迁移、旧 Ralph Loop 迁移/恢复；不留下 Task→Cron 或 Goal→Cron 的长期 fallback/双写。
- **新概念清单：** 只有 `SessionGoalStore`（必要：Goal 是 Session 的持久状态，不能继续寄存在 CronTask）。Goal turn 直接复用消息队列 `queueId`；Goal owner 只是既有 Sidecar 引用计数中的一个 token；Task 调度器只是把现有多份 handle owner 收成一个实现，不新增领域实体。
- **触及的红线：** Sidecar Owner 全部释放才停止；所有中止走既有 persistent-session cleanup；新增 SessionEngine 读写/turn 操作必须经过 selector facade；新增 CronTask 字段禁令（本期反向删除）；config/provider 路由不持久化 credential env；Task/Cron MCP 三态语义；文件 RMW 必须加锁；Rust 日志只用 `ulog_*`；异步任务使用 `tauri::async_runtime::spawn`；CLI/skill 修改同步 bump 版本；前端 Tab-scoped 调用继续走既有 API；新增事件注册对应白名单/监听边界。

### 行动清单

- [x] **Phase A — Session Goal owner：** 新建独立 Goal types/store/service/commands；仅在真实 Goal turn dispatch 时持有既有 `SidecarOwner::Goal` token；用消息队列 `queueId` 作为唯一 turn 权威；删除 admission/lease/injected-turn 并行状态和 Goal-on-CronTask 路径；恢复首轮普通 user bubble、全程流式展示、一次 Stop 即 paused；补原子事务、竞态与 Goal UX 协议回归；静态验证、构建、cross-review、提交。
- [x] **Phase B — Task 直接调度：** 新建唯一 TaskSchedulerController，直接读取 TaskStore 执行 once/scheduled/recurring/managed Task；移除 `Task.cron_task_id` / `CronTask.task_id` / `ensure_cron_for_task` / reverse heal；统一 start/stop/update/recovery、Sidecar owner、timeout；补 Task 调度和 owner 回归；静态验证、构建、cross-review、提交。
- [x] **Phase C — Legacy 迁移与 ingress 收口：** Rust 启动前幂等迁移普通 Legacy Cron，跳过 Loop/开发期 Goal；Chat/Launcher/CLI/IM/Admin/Tauri 全部改走 Task；legacy reader 只读；移除 Renderer auto-upgrade 和裸 Cron mutation；补 migration/provider/history/CLI 回归；静态验证、构建、cross-review、提交。
- [x] **Phase D — 事务清理、全量验证与文档：** 删除 dead cron events/commands/branches/`active_schedulers`，完成 store corrupt/quarantine 与 history lock，更新 ARCHITECTURE/tech_docs/原 Goal PRD，执行全量测试、build_dev、需求逐条审计、最终 cross-review、提交。

### 待用户决策

无。产品边界已在本 PRD 第 2、6、10 节收敛；实施中的模块命名和文件布局属于技术决策。

### 自动验证覆盖不到的真机项

- 桌面打包后旧普通 Cron 跨版本升级、真实下次触发点和通知投递。
- 桌面 Goal 首轮及连续轮流式渲染、权限弹窗前后不丢 block、Stop/恢复按钮状态。
- IM/Agent Channel 真实绑定下 Goal terminal outbox 的 at-least-once 回投。

### 进展日志

- 2026-07-11：完成需求收敛、代码/历史/架构 Review 和 PRD；进入 `/start-dev`。确认无新增产品决策，按四 Phase 执行，每 Phase 删除被替代 owner 后再提交。
- 2026-07-11：按用户“最精简、架构正确、快速收敛”复审 Phase A：取消独立 Goal Sidecar/额外 injected turn identity 设想；Goal 只在真实 dispatch 持有既有 owner token，turn 只认队列 `queueId`。
- 2026-07-12：Phase A 主体完成。Goal 已迁到 `SessionGoalStore`，只保留 revision/control revision、当前 queue authority、Sidecar generation 与 IM outbox；删除 Goal-on-CronTask、额外 Node authority map 和 injected-turn identity；首轮 visible tail、流式 turn、原子 pause/cancel 与 builtin/external terminal barrier 已补回归。
- 2026-07-12：Phase B/C 主体完成。TaskStore 成为所有新定时自动化唯一权威；唯一 Task scheduler 直接读取当前 Task 与 `task.md`；Task/Cron back-pointer、projection/heal、Cron Sidecar owner、renderer trigger pipeline 与独立 scheduler-start 步骤已删除；普通 Legacy Cron 在 Rust 启动期迁移，Loop/开发期 Goal rows 跳过，旧文件只读。
- 2026-07-12：减法审计修复四个直接调度边界：时间型 Running Task 重启保持 Running 并重建 handle；start 状态提交与 arm scheduler 合并；既有 Session 切换失败不再错误回退当前 Session；Once/Scheduled rerun 不再被累计 execution count 阻断。删除无调用者 `/cron/execute`、`/cron/check-completion`、旧 recovery DTO 与 continuation worker 随机 ID。
- 2026-07-12：三视角最终 Review 收口 Task stop/result 原子边界、Desktop Goal 首轮 Paused admission、Objective/Cancel/terminal 竞态、Legacy tombstone 与只读 facade，并把 Sidecar generation 校验放入 Goal 原子提交边界。全量 TS/JS/Rust 测试、Clippy、依赖边界和 `build_dev.sh` 均通过；剩余仅为第 681 节列出的三项真机发布前验收。
