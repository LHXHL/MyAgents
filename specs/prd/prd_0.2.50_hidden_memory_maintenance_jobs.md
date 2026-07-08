---
type: prd
status: implemented
created: 2026-07-08
updated: 2026-07-08
scope: "把老 Memory Auto-Update 从 heartbeat 附属检查收敛为 hidden managed CronTask + Rust dispatcher；同时把 Gardener/Molt 与 auto-update 统一归类为系统级隐藏后台作业，普通 Agent 设置、任务中心、定时任务列表不可见也不可编辑。App 完全关闭期间不做 OS 后台执行；重开后只补一次当前窗口应做的扫描。"
issue: "用户反馈夜间记忆更新无响应，并确认记忆自动更新、3d Gardener、14d Molt 都应是隐藏系统后台任务"
research: "specs/research/0708_memory_auto_update_scheduler_research.md"
review: "implemented-reviewed 2026-07-08（已按 cross-review 修复 Rust startup disk-first reconcile owner、system maintenance session/API fail-closed、ordinary Task/Cron managed guard、Management API 逃逸、Agent 删除清理、旧 heartbeat-era memory_update owner 清理；无阻塞性产品开放问题）"
---

# 隐藏记忆后台维护任务 PRD

> **执行须知（给空 session 的你）**：本 PRD 已经收口产品决策和代码实地勘察，后续开发不需要回翻聊天记录。
> - 自动加载的 `AGENTS.md` / `CLAUDE.md` 之外，必须主动 Read：`specs/ARCHITECTURE.md`、`specs/tech_docs/task_center.md`、`specs/tech_docs/task_provider_routing.md`、`specs/tech_docs/multi_agent_runtime.md`、`specs/tech_docs/session_architecture.md`、`specs/tech_docs/im_integration_architecture.md`。
> - 必须先读关联研究报告：`specs/research/0708_memory_auto_update_scheduler_research.md`。
> - 相关历史 PRD：`specs/prd/prd_0.2.49_long_term_memory_evolution.md`。
> - 关键源码入口见本文“技术地基”。行号会漂移，引用以文件名和符号名为准，接手时用 `rg` 重新定位。

## 背景与产品定位

用户发现“半夜里的记忆更新功能好像没有响应”，怀疑是不是因为夜里把软件 build 关掉了。这个问题暴露出一个更大的事实：当前“老 memory auto-update”不是独立调度系统，而是挂在 Agent/IM heartbeat runner 里的附属检查。

用户对这套系统的核心诉求没有变：

- 只要工作区打开了 `memoryAutoUpdate.enabled`，系统就应该在指定时间窗口里扫描已有 session。
- session 属于这个工作区，且自上次 `<MEMORY_UPDATE>` 后新增 query 达到阈值，就向这个原 session 注入 `UPDATE_MEMORY.md`。
- 这不是开一个新 session 总结所有历史，也不是让用户去任务中心管理一个任务。
- 它应该是后台系统维护，用户不需要感知，也不能随便改。

本轮用户进一步明确了 7 个决策：

1. 接受 hidden managed CronTask 作为调度 owner。
2. App 关闭期间错过多轮，只补一次，不回放 N 轮。
3. 按最简洁且架构正确的方案设计。
4. `lastBatchAt` 用 successful completion 语义。
5. 系统后台任务不展示给普通用户。
6. 开启条件只看 `memoryAutoUpdate.enabled`；“主动 Agent”只是当前前端交互入口限制，不是架构依赖。
7. 窗口内 session 忙或刚有用户输入时，要继续按独立 cadence 检测。例如窗口 00:00-07:00，用户 01:00-02:00 工作，03:00 后空闲，应仍在同一窗口内更新。

同时，3d Gardener 和 14d Molt 也要按同一原则处理：它们是 Memory Evolution 系统后台维护，不应出现在 Agent 设置页底部“工作区相关的定时任务”里，也不应被当普通 CronTask 编辑、停止或删除。

## 本期范围

### 做什么

1. **修复 Gardener/Molt 当前可见泄漏**
   - Memory Gardener 和 Memory Molt 继续作为系统级后台作业运行。
   - 普通 Agent 设置、任务中心、CronTask 列表、detail/editor 操作入口都不展示、不允许普通用户操作。
   - 对历史已创建但 marker 不完整的数据做 backfill 或 reconcile。

2. **把老 Memory Auto-Update 迁到 hidden managed CronTask**
   - 每个显式开启 `memoryAutoUpdate.enabled` 的 workspace 维护一条 hidden CronTask。
   - `managedKind = "memory_auto_update_batch"`。
   - CronTask 只负责 wall-clock 调度、启动恢复、catch-up 和 run record。
   - 真正业务由 Rust `MemoryAutoUpdateService` 做 deterministic orchestration。

3. **保留老 Memory Auto-Update 的产品语义**
   - 仍按 workspace 扫描已有 session。
   - 仍按 query threshold 判断。
   - 仍读取 workspace 根目录 `UPDATE_MEMORY.md`。
   - 仍向目标 session 注入 `<MEMORY_UPDATE>`，并通过 Sidecar `SessionEngine.runInjectedTurn()` 跑在目标 session 的真实 runtime 上。

4. **定义稳定的错过窗口行为**
   - App 完全关闭期间不执行 AI 任务。
   - App 在窗口内重开：很快补一次扫描。
   - App 在窗口外重开：等下一个 update window。
   - 错过多轮扫描只补一次当前应做 batch，不回放历史 tick。

5. **定义窗口内重复检测和 idle 语义**
   - 隐藏扫描 cadence 默认 30 分钟。
   - 隐藏 idle cooldown 默认 30 分钟。
   - session busy 或最近有人输入，本轮跳过，下一次扫描重新判断。
   - 不持久化 pending list；marker 未写入时 query threshold 自然仍成立。

6. **修正 `lastBatchAt` 语义**
   - 不再 batch 开始前写。
   - 改为 successful completion 后写。
   - 不再作为全局扫描冷却 gate。

### 不做什么

- 不实现 App 退出后由 launchd / Windows Service / daemon 继续后台执行 AI。
- 不把 Memory Auto-Update 改成普通 Task Center task。
- 不把 Memory Auto-Update 改成 new session 总结所有历史。
- 不暴露扫描 cadence、idle cooldown、Gardener/Molt 频率设置。
- 不要求用户在任务中心看到或管理这些系统作业。
- 不回放 App 关闭期间每一个错过的 tick。
- 不为了隐藏任务删除必要的 run record / unified log；诊断仍要可查。

## 核心机制

### 系统后台作业分类

本期把记忆维护相关后台动作统一归类为 managed scheduled job：

| managedKind | 触发 | 执行形态 | 用户可见性 |
|---|---|---|---|
| `memory_auto_update_batch` | update window 内每 30 分钟扫描 | Rust dispatcher，逐 session 注入原会话 | 普通 UI 不展示 |
| `memory_gardener` | 72h / 3d | new session 执行 `myagents-memory-gardener` skill | 普通 UI 不展示 |
| `memory_molt` | 14d | new session 执行 `myagents-memory-molt` skill | 普通 UI 不展示 |

“不展示”的精确定义：

- Agent Settings 的“工作区相关定时任务”不显示。
- Task Center 普通列表不显示。
- CronTask 普通 list / status / detail entry 不显示。
- 普通用户操作入口不能 edit / delete / stop / resume managed job。
- 普通聊天历史 / recent / automation-history surface 不显示系统维护 session；这些 session 只通过内部 diagnostics、run records、unified log 排查。
- run records、unified log、内部 diagnostics 可以查；如果复用现有 `/api/cron/runs`，必须要求显式 managed diagnostic opt-in，普通 runs/detail 请求默认拒绝 managed job，不能因为“可诊断”而重新泄漏到普通 API。
- 如果执行 session 需要落盘审计，也不能被包装成普通用户任务卡；默认不主动推到用户任务 UI。

这里要区分两类 session：

- Gardener/Molt 是系统创建的 new session，这类 session 本身应标记为 system maintenance，并从普通 history/recent 中隐藏。
- Memory Auto-Update 是向原用户 session 注入 `<MEMORY_UPDATE>`；目标 session 仍是用户原会话，不能因为被自动维护过就整体隐藏。query/idle 统计必须排除 `<MEMORY_UPDATE>` 这类系统注入，但 UI 不应把原会话当系统维护 session 删除。

### Memory Auto-Update 调度

推荐 CronTask schedule：

```rust
CronSchedule::Every {
  minutes: 30,
  start_at: Some(first_start_at_aligned_to_update_window),
  catch_up_window: Some(RecurringWindow {
    timezone,
    start: updateWindowStart,
    end: updateWindowEnd,
  }),
}
```

这里 30 分钟是 hidden constant，第一版不暴露设置。

`Every + start_at + catch_up_window` 直接复用现有 CronTask 机制：

- `CronTaskManager` 启动后 reattach running tasks。
- `sleep_until_wallclock()` 用 wall clock polling，系统休眠后能识别目标时间已过。
- `resolve_missed_interval_target()` 已支持 missed window catch-up：
  - 仍在窗口内：`now + min_ahead_secs` 很快执行。
  - 不在窗口内：跳到下一个窗口 start。

### 00:00-07:00 示例

用户设置 update window 为 00:00-07:00：

1. 00:00、00:30、01:00、... 每 30 分钟扫描一次。
2. 用户 01:00-02:00 仍在某 session 工作。
3. 01:00/01:30/02:00 扫描时，该 session 因 recent input 或 `engine.isBusy()` 跳过。
4. 02:30 如果还没满足 30 分钟 idle cooldown，继续跳过。
5. 03:00 或后续某个扫描点，如果最后真人输入已超过 30 分钟、sidecar 不 busy、query threshold 仍满足，则注入 `<MEMORY_UPDATE>`.
6. 成功后 session JSONL 中出现新的 `<MEMORY_UPDATE>` marker，后续扫描自然不重复，直到又积累足够新 query。

### `intervalHours` 新语义

旧实现把 `intervalHours` 同时用作：

- 全局 batch 冷却。
- session 最近活跃窗口。
- 用户可理解的“多久更新一次”。

这三个概念必须拆开。

本期定义：

| 概念 | 来源 | 语义 |
|---|---|---|
| `scanCadenceMinutes` | hidden constant，默认 30 | 窗口内多久扫描一次 |
| `idleCooldownMinutes` | hidden constant，默认 30 | 最后一次真人输入后多久允许自动注入 |
| `sessionLookbackHours` | hidden constant，默认 `max(intervalHours, 30d)` | 控制扫描成本；不是用户语义，不用来把一两天前错过窗口的 session 永久踢出 |
| `intervalHours` | 现有用户设置 | 每个 session 上次成功 `<MEMORY_UPDATE>` 后的最小更新间隔 |
| `queryThreshold` | 现有用户设置 | 自上次 marker 后新增真人 query 数达到阈值 |

`intervalHours` 不能再挡住整批扫描。否则第一次扫描遇到 busy session 后，03:00 的重试会被全局冷却拦掉，正好违背用户期望。

旧实现里的 `session.lastActiveAt >= now - intervalHours` 也不能继续作为业务 hard gate；它只能被替换为内部 lookback 粗筛。核心资格应是“同 workspace + query threshold + per-session update cooldown + idle cooldown + Sidecar busy gate”。

### Busy / Idle 判定

busy 与 idle 分层：

| 信号 | owner | 用途 |
|---|---|---|
| `SessionEngine.isBusy()` | Node Sidecar | 权威判断该 session runtime 是否正在 turn / queue 中 |
| 最后真人输入时间 | Rust eligibility 从 session history/metadata 计算 | 判断用户是否刚刚还在操作 |
| `sessions.json.lastActiveAt` | session metadata | 粗筛/保守 fallback，不能作为唯一业务真相 |

实现要求：

1. Rust 先尝试从 session JSONL 找最后一条真人 user message 时间，排除 `<MEMORY_UPDATE>`、`<HEARTBEAT>` 等系统注入。
2. 如果当前 JSONL schema 没有可靠 per-message timestamp，则使用 `sessions.json.lastActiveAt` 作为保守 recent-input fallback，并在代码注释写明限制。
3. 若 `now - lastHumanUserInputAt < idleCooldownMinutes`，本轮跳过，记为 `skippedRecentInput`。
4. 真正注入前仍调用 `/api/memory/update`，由 Node `engine.isBusy()` 做权威 busy gate。
5. `/api/memory/update` 返回 `session_busy` 时，本轮记为 `skippedBusy`，不是 batch failure。

## 技术地基

### 已验证事实

1. **老 Memory Auto-Update 当前挂在 heartbeat**
   - `src-tauri/src/im/memory_update.rs::check_and_spawn`
   - 调用方包括 `src-tauri/src/im/heartbeat.rs` 和 `src-tauri/src/im/config_store.rs` 的 agent-level heartbeat loop。
   - 当前 `lastBatchAt` 在 batch spawn 前写入。
   - 当前 `collect_qualifying_sessions()` 用 `session.lastActiveAt >= now - intervalHours` 作为 hard gate。

2. **Memory Update 注入端已经 runtime-aware**
   - `src/server/index.ts` 的 `/api/memory/update`
   - 自动触发时先看 `engine.isBusy()`。
   - 真执行通过 `SessionEngine.runInjectedTurn()`，支持 builtin / external runtime。
   - 成功判定已 gate 在真实 turn success。

3. **CronTask 已有本期需要的调度能力**
   - `src-tauri/src/cron_task/manager.rs::CronTaskManager`
   - `src-tauri/src/cron_task/init_recovery.rs::initialize_cron_manager`
   - `src-tauri/src/cron_task/schedule.rs::resolve_missed_interval_target`
   - `src-tauri/src/cron_task/run_records.rs`

4. **Memory Evolution 当前是 managed Task -> Cron**
   - `src-tauri/src/memory_evolution.rs::cmd_configure_memory_evolution_tasks`
   - Gardener: `managedKind = "memory_gardener"`，72h。
   - Molt: `managedKind = "memory_molt"`，14d。
   - `cron_task/execution.rs` 对这两个 managed kind 执行前 ensure memory rule substrate。

5. **隐藏链路已有但不完整**
   - `src-tauri/src/cron_task/commands.rs::cmd_get_cron_tasks` 和 `cmd_get_workspace_cron_tasks` 已过滤 `managed_kind.is_none()`。
   - `src-tauri/src/management_api.rs::list_cron_handler` 默认过滤 managed，除非 `include_managed=true`。
   - `src/renderer/components/task-center/TaskListPanel.tsx` 过滤普通列表。
   - `src/renderer/components/AgentSettings/sections/AgentTasksSection.tsx` 当前只按 `!t.managedKind` 过滤。用户实测 Gardener/Molt 仍出现在这里，说明 managed hidden 不是端到端不变量。

### 需要遵守的红线

- 新增 `CronTask` / `Task` 字段必须 `#[serde(default)]`。
- 工作区文件 IO 走 Rust workspace/path-safety helper，不走 Sidecar HTTP。
- 连接 local sidecar 的 reqwest client 走 `crate::local_http::json_client()`。
- Runtime 注入必须走 `/api/memory/update` + `SessionEngine.runInjectedTurn()`，不要在 Rust 手写 builtin/external 分支。
- Config 写盘 disk-first，不直接用 React state 覆盖磁盘。
- UI 文案走 i18n。
- managed job 不能通过普通 Task/Cron UI 暴露编辑入口。

## 技术方案

### 1. 统一 ManagedTaskKind

扩展现有 managed kind 集合：

```ts
export type ManagedTaskKind =
  | 'memory_gardener'
  | 'memory_molt'
  | 'memory_auto_update_batch';
```

Rust 同步增加常量：

```rust
pub const MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH: &str = "memory_auto_update_batch";
```

要求：

- `src-tauri/src/task.rs::normalize_managed_kind` 支持新 kind。
- `src/shared/types/task.ts`、`src/renderer/types/cronTask.ts` 同步。
- 如果新增 helper，命名为“managed scheduled job”，不要再发明一套 system task 类型。

### 2. 先修 Evo 隐藏泄漏

短期必须先修用户已经看到的问题。

实现要点：

1. 新增统一判断 helper：
   - renderer: `isManagedScheduledJob(value)`。
   - 同时兼容 `managedKind` 和 `managed_kind`。
   - 所有 AgentTasksSection / Task Center / Cron detail entry 使用同一个 helper。
2. Rust list 继续默认隐藏：
   - `cmd_get_cron_tasks`
   - `cmd_get_workspace_cron_tasks`
   - Management API `/api/cron/list`
   - CLI 普通 list
3. 操作入口 fail-closed：
   - 普通 UI 发起 edit/delete/stop/resume/run/trigger managed job 时拒绝。
   - Tauri 普通命令和 Management API 普通 handler 都要守这个边界，不能只靠前端隐藏按钮。
   - `/api/cron/list?include_managed=true`、run records、internal diagnostics 可以作为显式诊断入口；普通 list/status/detail/runs 不应泄漏 managed job。`include_managed=true` 只能作为诊断能力，普通 UI 不使用。
   - 如果某个 API 同时服务普通 UI 和内部诊断，必须默认 fail-closed；只有显式 diagnostic 参数或 system caller 才允许读取 managed job/run。
   - system reconcile 可继续 stop/re-arm。
4. 历史数据 backfill：
   - `memory_evolution::reconcile_existing_job` 找到 existing Task 后，确保其 linked CronTask 也带相同 `managed_kind`。
   - 如果发现同 workspace 的 `Memory Gardener` / `Memory Molt` CronTask 缺 marker，按 managed kind 修复，而不是展示给用户。
   - 如果已有 Gardener/Molt 执行 session 只有 `cronTaskId`/`origin` 而缺 system maintenance marker，应通过 cronTaskId -> managed kind backfill，避免旧维护 session 继续出现在普通历史。
5. 补回归测试：
   - AgentTasksSection 输入 camelCase `managedKind` 不展示。
   - AgentTasksSection 输入 snake_case `managed_kind` 不展示。
   - Rust workspace cron list 不返回 managed cron。
   - TaskStore/CronTask projection 保留 managed kind。

### 3. 新增 MemoryAutoUpdateService

从 `src-tauri/src/im/memory_update.rs` 抽出与 IM/heartbeat 无关的逻辑：

```text
src-tauri/src/memory_auto_update/
  mod.rs
  eligibility.rs
  orchestrator.rs
  state.rs
```

职责：

- `ensure_update_memory_file(workspacePath)`
- `collect_qualifying_sessions(workspacePath, config, policy)`
- `count_queries_since_last_update(sessionId)`
- `find_last_memory_update_marker(sessionId)`
- `find_last_human_user_input(sessionId)`
- `run_batch(request) -> BatchSummary`
- `update_single_session(sessionId, ...)`

`MemoryAutoUpdateService` 必须有 workspace 级 in-flight guard。`CronTaskManager` 负责 schedule owner，但迁移期 heartbeat wrapper 仍可能存在；同一 workspace 同一时间只能有一个 batch 在跑，重复触发应返回 skipped/duplicate，而不是并发注入。

第一版 batch 执行必须是串行或显式小并发，不允许按 eligible session 无上限 fan-out sidecar 注入。推荐先用串行执行，后续若有性能压力再把并发数作为 hidden constant 评估。

`im/memory_update.rs` 最终应删除调度责任。过渡期可以保留 wrapper，但必须调用同一个 service 和同一个 in-flight guard，避免 Cron 和 heartbeat 双触发。

### 4. 创建 hidden Memory Auto-Update CronTask

新增 reconcile command，例如：

```text
cmd_configure_memory_auto_update_task(agentId, workspaceId, workspacePath, memoryAutoUpdate, heartbeat?)
```

行为：

- `enabled=false`：停止该 workspace 的健康 `memory_auto_update_batch` managed CronTask，并保持隐藏；只清理重复、损坏、无法归属的 managed job。
- `enabled=true`：
  - 不存在则创建。
  - schedule/config drift 则更新并 re-arm。
  - stopped 则 start。

幂等 key：

- 现有 Project-Agent 模型下按 `normalize(workspacePath) + managedKind`。
- 不依赖任务名称匹配。
- 如果未来支持同 workspace 多 Agent，再引入明确 owner id；本期不为不存在的多 owner 场景加新字段。

CronTask schema 如果仍要求 `sessionId` / `prompt`：

- 使用内部 placeholder，例如 `system:memory-auto-update:<workspace-hash>`。
- `execute_task_directly` 对 `managedKind = memory_auto_update_batch` 必须在创建普通 execution sidecar 前短路到 custom dispatcher。
- 不创建用户聊天 session。
- 实现顺序上，dispatcher 分支必须先落地并测试，再允许 provisioning 创建 running `memory_auto_update_batch` CronTask；否则新 hidden job 会在开发中或灰度中落入普通 prompt execution。

### 5. Cron execution 分流

在 `src-tauri/src/cron_task/execution.rs::execute_task_directly` 中加入 managed dispatcher 分支：

```rust
if task.managed_kind.as_deref() == Some(MANAGED_KIND_MEMORY_AUTO_UPDATE_BATCH) {
    return memory_auto_update::run_managed_cron_batch(&task).await;
}
```

要求：

- 分支应尽量早，避免为 dispatcher 自身创建 Sidecar。
- 返回结果写入 Cron run record。
- `last_run_ok`、`last_run_duration_ms`、`last_error` 正常更新。
- 不走普通 prompt dispatch。

Gardener/Molt 保持现有 Task/Cron prompt execution，因为它们本来就是 new session system skill。它们只需要补齐隐藏和操作保护。

### 6. System maintenance session marker

Gardener/Molt 会通过 Cron new-session 路径创建可落盘审计的执行 session。仅靠 `cronTaskId` 和 `origin: automation` 不足以隐藏，因为普通用户 Cron/Task 也会使用同一套 origin。需要新增一个稳定、窄语义的 session metadata marker，例如：

```ts
type SessionMetadata = {
  systemMaintenanceKind?: 'memory_gardener' | 'memory_molt';
};
```

要求：

- 只给系统创建的维护 session 打 marker；不要给 Memory Auto-Update 的目标用户 session 打 marker。
- Rust cron execution payload 应把 `managedKind` 传到 Sidecar；Node `/cron/execute-sync` 在 `runMode = new_session` 创建 Gardener/Molt session 时写入 `systemMaintenanceKind`。
- `src-tauri/src/session_visibility.rs` 增加 Rust 侧过滤，保证 Launcher / Rust history metadata 读路径也隐藏。
- `src/shared/session-origin.ts` 或相邻 shared helper 增加 `isSystemMaintenanceSession(meta)`，renderer history/recent/automation-history 与 Task Center 共用。
- legacy backfill 可用 `sessions.json.cronTaskId` 反查 managed CronTask，补写 `systemMaintenanceKind`；无法可靠反查的旧 automation session 不按标题猜测，避免误隐藏用户普通 Cron session。
- analytics 的 `origin` 保持 `automation/cron` 或 `automation/task_run`，`systemMaintenanceKind` 是 visibility marker，不取代 origin。

### 7. Config / provisioning 触发

触发点：

1. App 启动后由 Rust 侧从磁盘 AppConfig 做 disk-first reconcile，且应在 CronTaskManager ready 后执行；renderer `ConfigProvider` 不能是唯一 provisioning owner。
2. Agent 设置页修改 `memoryAutoUpdate` 后立即调用 Rust reconcile，并在写盘后 refresh config。
3. Rust `cmd_update_agent_config` 收到 `memoryAutoUpdateConfigJson` 时同步触发或排队 reconcile，避免只靠 UI 层。

启动 reconcile 的权威 owner 必须是 Rust。Renderer 可以做 opportunistic reconcile 来缩短设置页写入后的反馈时间，但它不能是唯一 owner；否则 App 以无窗口、延迟加载前端、前端异常或未来 headless/CLI 路径启动时，hidden CronTask 会漏 provision。

开启判定必须用“显式配置”，不能把 schema/default 的 `MemoryAutoUpdateConfig::default().enabled = true` 当作所有历史工作区都已开启：

- `agent.memoryAutoUpdate?.enabled === true` 才 provision hidden CronTask。
- Rust 侧要保留 `Option<MemoryAutoUpdateConfig>` 的 presence 信息；缺字段不能先反序列化成 `MemoryAutoUpdateConfig::default()` 再判断。
- Mino 模板派生工作区会通过 `agentDefaults.memoryAutoUpdate.enabled = true` 显式落盘，因此仍自动开启。
- 本地已有工作区、旧配置、`memoryAutoUpdate` 缺失的 agent 不自动创建 hidden CronTask。

如果短期先复用现有 Evo pattern，也必须满足：

- 无 IM channel 时仍能创建并运行 hidden CronTask。
- App 重开后 Rust disk-first reconcile 能补齐 missing task。
- 已存在 running managed CronTask 能由 CronTaskManager recovery reattach。

关闭 `memoryAutoUpdate.enabled` 时：

- 停止该 workspace 的健康 `memory_auto_update_batch` managed CronTask，并保持隐藏与可诊断。
- 不为了“关开关”删除唯一健康 job；删除只用于清理重复、损坏、无法归属的 managed job。
- 停止后不能继续被 recovery reattach；再次开启时应复用或 re-arm 同一 managed job。

### 8. 状态写入

BatchSummary：

```ts
type MemoryAutoUpdateBatchSummary = {
  checkedSessions: number;
  eligibleSessions: number;
  updated: number;
  skippedRecentInput: number;
  skippedBusy: number;
  skippedNoThreshold: number;
  failed: number;
  completedAt: string;
};
```

状态语义：

- Cron run record 记录每次扫描。
- `lastBatchAt` 只在 successful completion 后写，且仅代表“至少 1 个 session 实际完成更新”的最近时间。
- `lastBatchAt` 不再用于挡住下一次扫描。
- `lastBatchSessionCount` 写实际 `updated`。
- 纯 no-op scan 不应伪装成“最近记忆更新成功”；可只留在 Cron run record。
- 如果 UI 需要“最近一次检查时间”，从 Cron run record 或明确命名的 diagnostic 字段读取，不要复用 `lastBatchAt`。

### 9. UI 与诊断

Agent 设置保留现有 Memory Auto-Update 开关、阈值、窗口。

普通用户不看到 hidden CronTask。可选轻量状态：

- 最近一次检查时间。
- 最近一次成功更新 session 数。
- 最近一次失败摘要。

这些状态属于 Memory section 自己展示，不借普通“工作区相关定时任务”列表。

## 用户感知变化

用户设置方式基本不变。

变化是：

- Gardener/Molt 不再出现在 Agent 设置页底部定时任务列表里。
- Memory Auto-Update 不再要求主动 Agent/IM channel/heartbeat 正在跑。
- 夜里 App 关掉不会执行；但重开后，如果仍在窗口或到了下一窗口，会补一次扫描。
- session 忙或刚输入不会被打断；系统会在窗口内后续扫描点继续尝试。
- 失败、busy、no-op 不再悄悄把整天自动更新冷却掉。

## 实施顺序

### Phase 0：隐藏泄漏修复

- 新增 renderer managed job helper。
- 修 AgentTasksSection / Task Center / detail operation entry / session history-recent 过滤。
- 为 Gardener/Molt new-session 执行补 `systemMaintenanceKind` marker，并接入 Rust `session_visibility.rs`。
- 补 Evo legacy managed marker backfill。
- 加 regression tests。

### Phase 1：抽 MemoryAutoUpdateService

- 从 `im/memory_update.rs` 抽 eligibility、file ensure、session update。
- 保持旧 heartbeat 入口临时调用新 service。
- 补 marker/query/idle unit tests。

### Phase 2：引入 hidden auto-update CronTask

- 新增 `memory_auto_update_batch` managed kind。
- 新增 execution dispatcher。
- 新增 Rust disk-first provisioning/reconcile。
- 创建 `Every + start_at + catch_up_window` schedule。
- Cron run record 写 summary。

### Phase 3：切断 heartbeat 触发

- 当 managed CronTask 已存在并 running，heartbeat 不再调用 auto-update。
- 稳定后删除或彻底降级旧 heartbeat 调度入口，确保不会成为第二个 owner。
- 避免同一窗口双触发。

### Phase 4：诊断 polish

- Agent Memory section 展示最近 summary。
- unified log 增加清晰 tag。
- 必要时增加 advanced diagnostic include managed jobs。

## 验收标准

1. 开启 Evo 后，Gardener/Molt 不出现在 Agent 设置页“工作区相关定时任务”列表。
2. Gardener/Molt 不出现在 Task Center 普通任务列表和普通 CronTask 列表。
3. Gardener/Molt 执行产生的 system maintenance session 不出现在普通聊天历史 / recent / automation-history surface。
4. Gardener/Molt 执行 session metadata 带 `systemMaintenanceKind`；普通用户 Cron/Task session 不因 `origin=automation` 被误隐藏。
5. Memory Auto-Update 注入的目标用户 session 不被整体隐藏，且 `<MEMORY_UPDATE>` 不计入真人 query/idle。
6. 普通 UI 和普通 API 不能 edit/delete/stop/resume/run/trigger Gardener/Molt；system reconcile 仍可 re-arm。
7. 旧数据中缺 marker 的 Gardener/Molt 会被 reconcile 修复为 managed hidden。
8. 开启 `memoryAutoUpdate.enabled` 后，即使没有 IM channel / heartbeat running，也会创建 hidden `memory_auto_update_batch` CronTask。
9. `memoryAutoUpdate` 缺失或未显式 enabled 的旧/本地工作区，不会因为 schema default 自动创建 hidden CronTask。
10. 关闭 `memoryAutoUpdate.enabled` 后，对应 hidden CronTask 停止并保持隐藏；只有清理重复/损坏的 managed job 时才删除。
11. 00:00-07:00 窗口内，session 01:00-02:00 活跃，03:00 后 idle 且 query threshold 满足时会更新。
12. App 在窗口内关闭后重开，hidden CronTask 只补一次当前扫描，不回放多轮。
13. App 在窗口外重开，不立即跑，等下一个 update window。
14. `/api/memory/update` 仍通过 `SessionEngine.runInjectedTurn()` 执行，builtin/external runtime 都不绕路。
15. `lastBatchAt` 在至少 1 个 session 实际更新成功后写，不在 batch start 前写；no-op scan 只写 Cron run record。
16. busy/recent input 不算失败，也不推进 session marker；下一次扫描仍可重新 qualify。
17. 无 eligible session 的扫描不会显示成一次“记忆已更新”。
18. `npm run typecheck`、`npm run lint`、相关 Vitest/Rust tests 通过。

## 测试建议

### Rust unit / integration

- `resolve_missed_interval_target` 已有测试，新增/确认 30min cadence + window 内 catch-up。
- `MemoryAutoUpdateService`：
  - query threshold 达标。
  - `<MEMORY_UPDATE>` marker 后重新计数。
  - `/UPDATE_MEMORY` manual marker 等价。
  - recent human input 跳过。
  - system injected message 不算 human query。
  - last memory marker interval 未满足时跳过该 session，但不阻止扫描其它 session。
- managed kind：
  - `memory_auto_update_batch` serde default / validation。
  - workspace cron list 默认过滤 managed。
  - existing Evo linked CronTask backfill managed marker。
- session visibility：
  - `systemMaintenanceKind=memory_gardener/memory_molt` 从 Rust `cmd_list_session_metadata` 过滤。
  - 普通 `origin=automation` Cron session 不被误过滤。

### Renderer unit / dom

- `isManagedScheduledJob()` 支持 camelCase 和 snake_case。
- AgentTasksSection 不展示 `memory_gardener` / `memory_molt` / `memory_auto_update_batch`。
- Task Center 普通列表不展示 managed jobs。
- Cron detail 操作入口对 managed job 不出现或 fail-closed。
- 普通历史/recent/automation-history surface 不展示 system maintenance session。
- Memory Auto-Update 的目标用户 session 不因含 `<MEMORY_UPDATE>` turn 被 `isSystemMaintenanceSession()` 误判隐藏。

### Integration / manual

1. 在 Mino 模板工作区打开 Agent Settings，确认 Evo enabled，但底部定时任务区不显示 Memory Gardener/Molt。
2. 手动创建一个缺 `managed_kind` 的旧 Gardener cron，重开 App 后确认被修复并隐藏。
3. 打开 Memory Auto-Update，关闭所有 IM channel，重开 App，确认 hidden CronTask running。
4. 对一个 `memoryAutoUpdate` 缺失的旧工作区重开 App，确认不会自动 provision hidden CronTask。
5. 构造一个达到 query threshold 的 session，在窗口内运行 hidden batch，确认原 session 收到 `<MEMORY_UPDATE>` 并完成。
6. 同一 session 保持 busy，确认本轮 skippedBusy，下一扫描仍尝试。
7. App 在窗口内关闭再打开，确认只补一次扫描。

## 已收敛决策与后续演进

1. **每 workspace 多 Agent 的 idempotency。**
   - 本期决策：按 `workspacePath + managedKind` 做幂等，不为尚未成形的多 owner 场景扩 schema。
   - 后续演进：如果实测同 workspace 多 Agent 是真实产品路径，再补 managed owner id；不要预先扩 schema。

2. **per-message timestamp 可用性。**
   - PRD 目标是“最后真人输入后 30 分钟”。
   - 本期决策：实现时优先用 session JSONL 的 per-message timestamp；没有可靠字段时用 `sessions.json.lastActiveAt` 保守 fallback，并保留 `engine.isBusy()` 权威 gate。
   - 后续演进：如果未来统一 transcript schema，应把“真人输入时间”提升为明确字段，减少 fallback 造成的保守跳过。

## 附录：关联文件

- `specs/research/0708_memory_auto_update_scheduler_research.md`
- `specs/prd/prd_0.2.49_long_term_memory_evolution.md`
- `src-tauri/src/memory_auto_update.rs`
- `src/server/index.ts` 中 `/api/memory/update`
- `src-tauri/src/memory_evolution.rs`
- `src-tauri/src/cron_task/manager.rs`
- `src-tauri/src/cron_task/schedule.rs`
- `src-tauri/src/cron_task/execution.rs`
- `src-tauri/src/cron_task/commands.rs`
- `src-tauri/src/session_visibility.rs`
- `src-tauri/src/session_metadata.rs`
- `src-tauri/src/task.rs`
- `src/shared/types/task.ts`
- `src/shared/session-origin.ts`
- `src/renderer/types/cronTask.ts`
- `src/renderer/components/AgentSettings/sections/AgentTasksSection.tsx`
- `src/renderer/components/task-center/TaskListPanel.tsx`

## 执行台账

### 开发契约（动第一行代码前写完）

- 必赢场景：
  - Gardener/Molt/Memory Auto-Update 这三类系统维护 job 在普通 Agent Settings、Task Center、Cron list/detail、普通历史/recent/automation-history surface 中不可见且不可由普通 UI 操作。
  - 显式开启 `memoryAutoUpdate.enabled` 的 workspace 会获得一条 hidden `memory_auto_update_batch` CronTask；没有显式配置的旧/本地工作区不会因 Rust/TS default=true 被误 provision。
  - App 关闭期间不运行；重开后依赖 `Every + start_at + catch_up_window` 在当前/下个窗口只补一次扫描。
  - Memory Auto-Update 保持原语义：Rust deterministic scan existing sessions，逐个调用 Sidecar `/api/memory/update`，由 `SessionEngine.runInjectedTurn()` 在目标 session 真实 runtime 中注入 `<MEMORY_UPDATE>`。
  - session busy/recent input 跳过本轮，下一次 30min scan 继续判断；`lastBatchAt` 只在至少 1 个 session 完成更新后写。
- 复用的既有抽象：
  - `CronTaskManager` / `CronSchedule::Every { start_at, catch_up_window }` / `resolve_missed_interval_target()` / `sleep_until_wallclock()` / `cron_runs`。
  - `src-tauri/src/memory_evolution.rs::cmd_configure_memory_evolution_tasks` 的 managed reconcile 形态。
  - `src-tauri/src/im/memory_update.rs` 现有 `ensure_update_memory_file`、`collect_qualifying_sessions`、`count_queries_since_last_update`、`update_single_session` 逻辑，抽到新 owner。
  - `src/server/index.ts` 的 `/api/memory/update` 和 `SessionEngine.runInjectedTurn()` runtime-aware injection。
  - `managedKind` / `managed_kind` 作为系统作业 marker；`TaskStore` 与 `CronTask` 已有 projection 字段。
  - Rust startup reconcile / `patchAgentConfig` / `cmd_update_agent_config` 作为 Agent config update/reconcile 入口；renderer `ConfigProvider` 只能触发或刷新，不能成为唯一 owner。
  - `src-tauri/src/session_visibility.rs`、`src/shared/session-origin.ts` 和 session metadata `systemMaintenanceKind` 作为普通历史隐藏入口。
- 反向边界：
  - 不引入 OS daemon / launchd / Windows Service。
  - 不把 Memory Auto-Update 改成普通 Task Center task 或 new session 汇总。
  - 不暴露 scan cadence、idle cooldown、Gardener/Molt 频率设置。
  - 不把 provider credentials 写入 CronTask/Task 持久层。
  - 不绕过 `/api/memory/update` 直接在 Rust 调 runtime。
- 新概念清单：
  - `memory_auto_update_batch` managed kind：必要，因为 Memory Auto-Update 是系统级 hidden scheduled dispatcher，不是用户 Task，也不同于 Gardener/Molt。
  - `MemoryAutoUpdateService` Rust owner：必要，因为旧 owner 是 IM/heartbeat，业务规则需要迁到独立 service。
  - `systemMaintenanceKind` session marker：必要，因为 `origin=automation` 同时覆盖普通用户 Cron/Task，不能用它区分系统维护 session。
  - `isManagedScheduledJob` renderer helper：必要，因为已有 UI 分散过滤 `managedKind`，且需要兼容 `managed_kind` legacy/snake-case shape。
- 触及的红线：
  - 新增 CronTask/Task 字段必须 serde default。
  - local Sidecar HTTP 调用必须用 `crate::local_http::json_client()`。
  - Runtime 注入必须走 SessionEngine facade。
  - Config 持久化 disk-first，不能用 React state 覆盖磁盘。
  - managed job 不能通过普通 Task/Cron UI 暴露编辑入口。
  - 工作区文件 IO 走 Rust/path-safety helper，不走 Sidecar HTTP。

### 行动清单

- [x] Phase 0：统一 managed scheduled job helper，补 `systemMaintenanceKind`，修 Gardener/Molt/managed job 在 Agent Settings、Task Center、Cron detail、history/recent surfaces 的隐藏与操作保护。
- [x] Phase 1：抽出 `MemoryAutoUpdateService`，保留旧入口临时调用新 service，补 eligibility/query/marker/idle 测试。
- [x] Phase 2：新增 `memory_auto_update_batch` managed kind，并先在 Cron execution 中对该 kind 走 custom dispatcher，写 run summary 和 successful-completion 语义 `lastBatchAt`。
- [x] Phase 3：新增 hidden CronTask provisioning/reconcile，接入显式 `memoryAutoUpdate.enabled` 判定；确认 dispatcher 已存在后才创建/start running job。
- [x] Phase 4：切断 heartbeat 双触发，补配置变更/启动恢复/旧数据 backfill。
- [x] 自验证：typecheck、lint、Rust check/test、targeted Vitest/Rust tests、必要 smoke。
- [x] Cross-review、修复确认问题、提交 Git。

### 待用户决策

无。当前 PRD 已把本期行为、非本期范围和后续演进点收敛完毕；后续进入开发时不需要再等产品决策。

### 进展日志

- 2026-07-08：完成初版 PRD final review；确认 owner 切分为 CronTask scheduler + Rust MemoryAutoUpdateService + Sidecar SessionEngine，补充 dispatcher-before-provisioning、successful-completion `lastBatchAt`、普通 runs/detail API 与诊断入口边界、batch 小并发约束。
- 2026-07-08：完成 PRD 终审补强；关闭“开放问题”的阻塞语义，明确 Rust startup disk-first reconcile 是权威 owner、renderer 只能 opportunistic reconcile，补齐 `sessionLookbackHours=max(intervalHours,30d)` 与普通/诊断 API fail-closed 口径。
- 2026-07-08：如进入实现阶段，本 PRD 的自验证目标为 hidden `memory_auto_update_batch` CronTask、Rust dispatcher/service、Gardener/Molt `systemMaintenanceKind` hiding/backfill、ordinary Cron/UI fail-closed、heartbeat 双触发切断，并通过 `npm run typecheck`、`npm run lint`、`cargo check --locked`、`cargo test memory_auto_update --locked`、targeted Vitest、`cargo clippy ... -D disallowed_*`。
- 2026-07-08：完成实现与 cross-review 修复；补齐普通 Session/Task/Cron/Management API fail-closed，`memory_auto_update_batch` 由 hidden CronTask 调度并由 Rust service 执行，启动期从磁盘 AgentConfig 做权威 reconcile，旧 `im::memory_update` heartbeat-era owner 删除，Agent 删除会清理隐藏 auto-update CronTask。验证通过：`npm run typecheck`、`npm run lint`、`npm run test:unit -- managedScheduledJob session-origin session-read`、`npm run test:integration -- session-prequery-draft`、`cargo fmt --check`、`cargo check --locked`、`cargo test memory_auto_update --locked`、TaskStore managed guard targeted tests、`cargo clippy ... -D disallowed_*`。
