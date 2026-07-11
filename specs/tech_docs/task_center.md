# 任务中心架构

> 0.2.50 起，Task 是所有新定时自动化和任务中心执行的唯一持久化实体。Cron 只保留兼容命令名与旧数据读取，不再是 Task 的调度投影。

## 1. 所有权

两个 Store 位于 `~/.myagents/`：

| Store | 文件 | Owner |
|---|---|---|
| `ThoughtStore` | `thoughts/<YYYY-MM>/<id>.md` | 想法与 Task 关联 |
| `TaskStore` | `tasks.jsonl` + `tasks/<id>/{task.md,verify.md,progress.md,alignment/...}` | Task 身份、状态、调度配置、运行统计与审计 |

`TaskStore` 是 Task 的唯一真相。不存在 `Task.cronTaskId`、关联 `CronTask` 副本、schedule 双写或启动时反向修补。

Task 的核心职责：

- 用户可见身份、文档、状态机与审计链。
- `once / scheduled / recurring` 执行模式及 `dispatchAt / interval / cron expression / timezone / recurring window`。
- `new-session / single-session` 会话策略。
- 新执行 Session 的 runtime/provider/model/MCP 初始配置，以及每轮 permission policy。
- notification、关联 Session、执行次数与最近执行时间。

`Loop` 已退出 Task 模型：新建/编辑拒绝，旧 Loop 启动时转 `Stopped`，不转换为 Goal。

## 2. 状态与调度

```text
Todo -> Running -> Verifying -> Done
          |             |
          +-> Blocked / Stopped
Done -> Archived
any allowed state -> Deleted (soft delete)
```

对时间型 Task，`Running` 表示 scheduler enabled，不表示某个 AI Turn 正在执行。瞬时执行状态只存在于 `TaskSchedulerController.executions`，API 的 `currentlyExecuting` 由它投影。

`TaskSchedulerController` 只拥有可重建的内存资源：

- 一个 `taskId -> timer JoinHandle` map。
- 一个 `taskId -> { queueId, canceled, sessionId }` 的瞬时 execution map：复用 SessionEngine 普通 turn identity，原子拒绝重叠、撤销未 dispatch turn，并把 stop 与结果提交线性化；它不是持久 TaskRun。
- 启动时从 `TaskStore` 的 Running Task 重建 timer。

启动 Task 只有一个事务入口：`run_task_by_id()` 先校验 schedule、提交 `Running`，再 arm timer；arm 失败则提交 `Blocked`。前端不再分别调用“start task”和“start scheduler”。所有 terminal status 与 soft delete 都经 `TaskStore` 统一停止 timer、取消当前 Turn、释放 Task Sidecar owner。

timer handle 只负责“何时触发”。真正的 AI Turn 是独立执行作业；Stop 撤销该次 queue authority，并只对当前 execution Session 请求 SessionEngine stop。只有 stop 得到业务确认才释放 Task owner，历史 `sessionIds` 不承担实时取消索引。

### Scheduled tick 与 run-now

二者复用 `task_execution::execute_task()`，但 lifecycle 不同：

- Scheduled tick 推进一次性任务终态、失败状态与 end condition。
- `cron run-now` 是兼容的 manual trigger：Running/Stopped Task 可执行，不启用 scheduler，不改变原 schedule/status；其他终态必须先走 rerun。
- `lastExecutedAt` 记录任何执行；`lastScheduledAt` 只记录 timer tick。Recurring 的下一次触发只使用后者，因此 manual run 不会移动调度锚点。

每次执行前都重新读取 `task.md`，用户修改会在下一次执行生效。运行历史继续写 `cron_runs/<taskId>.jsonl`，这是查询/审计投影，不是 Task 状态权威。

## 3. Session 与配置边界

Task 执行统一经过 `task_execution.rs` -> Rust Sidecar bridge -> Node `SessionEngine` facade，builtin/external runtime 均走 adapter selector。

- 已存在的 Session：runtime/model/provider/reasoning/MCP 全部继承该 Session；Task 不做 turn-scoped 覆盖或回滚。
- 新建执行 Session，或首次 materialize 专属 single-session Session：Task 配置只用于初始化一次。
- permission 是本轮执行策略，可由 Task 指定；空值解析为对应 runtime 最大权限。
- durable Task 只保存 provider identity (`providerId + model`)，不保存 credential/env。
- 执行期间使用 `SidecarOwner::Task(taskId)`；terminal/stop/delete 对称释放。

完整 provider/runtime/MCP 规则见 `task_provider_routing.md`。

## 4. Managed Task

memory update、memory evolution、Agent heartbeat 等内部定时工作也写入带 `managedKind` 的隐藏 Task，由同一个 Task scheduler 执行。普通 Task Center 列表默认过滤 managed Task，但 Session/history/audit 保留。

managed job 不再创建 managed CronTask 旁路。

## 5. Legacy Cron 迁移

`cron_tasks.json` 是只读兼容输入。应用启动顺序为：

```text
校验 legacy store
-> migrate_legacy_crons_on_startup()
-> TaskSchedulerController.initialize()
-> Session Goal recovery
```

标准 Cron get/list/start/stop/update/delete/run-now facade 只投影 TaskStore。未迁移历史行仅通过显式只读命令 `cmd_get_unmigrated_legacy_cron_tasks` 进入 Legacy 面板；deleted Task 仍作为 legacy id tombstone，旧行不会重新出现或再次迁移。

迁移规则：

| Legacy row | 处理 |
|---|---|
| 普通 At / Every / Cron | 同 ID 迁移为 Task，保留 schedule、状态、执行统计、Session 策略与通知 |
| 旧 Task-linked projection | 已有 Task 为权威，只补不倒退的 execution/session 数据 |
| managed row | 迁移/关联为隐藏 managed Task |
| Loop / 开发期 Goal row | 不迁移、不恢复 |
| credential 或 workspace 无法安全恢复 | 创建可诊断的 Blocked Task，不猜测路由 |
| store 损坏 | 整库只读，禁止用空/部分数据覆盖原文件 |

迁移幂等依赖原 ID 与 migration provenance，不另建 migration ledger。历史 run 文件尽力沿用/迁移同一 ID。所有新 `cron add/create/update/start/stop` 兼容入口均直接读写 TaskStore，永不写回 legacy 文件。

## 6. 数据完整性

Task mutation 的固定事务边界：

```text
TaskStore write lock
-> clone 当前权威 map
-> mutate + validate
-> 原子持久化 candidate
-> 替换内存 map
-> 解锁
-> event / notification / scheduler 副作用
```

`tasks.jsonl` 解析是 all-or-nothing；任一 malformed/duplicate row 使 Store 保持只读。写盘使用 tmp + `sync_all` + rename + parent fsync。Task id/path 入口统一经过 `validate_safe_id` 与 `task_docs_dir()` containment 校验。

## 7. Goal 边界

Goal 是 Session 状态，不是 Task execution mode：

- 不创建 Task、不占用 Task status/schedule 字段。
- Task 与 Goal 可在同一 Session 共存；Task scheduler 不感知 Goal。
- 未来 Task 如需持续执行，可让其 prompt 中的 AI 在当前 Session 调 `myagents goal create`，无需 Task->Goal 编排字段。

详见 `session_architecture.md` 的 Goal Mode 章节。

## 8. 主要入口

- Rust：`src-tauri/src/task.rs`、`task_scheduler.rs`、`task_execution.rs`
- Legacy compatibility：`src-tauri/src/cron_task/*`、`legacy_upgrade.rs`
- Management API：`/api/task/*` 与兼容 `/api/cron/*`
- CLI：`myagents task ...`、兼容 `myagents cron ...`
- Renderer：`src/renderer/components/task-center/`、`useCronTask`（兼容展示 hook）
