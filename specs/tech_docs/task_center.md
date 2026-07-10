# 任务中心架构

> 把"想法速记 → 对齐 → 派发 → 执行 → 验收 → 审计"的完整工作流一等公民化。
> 数据层全部在 Rust，前端按卡片 / 列表双视图呈现，AI 和用户共享同一套 CLI 操作闭环。

## 数据层 (Rust)

两个持久化 Store，均存于 `~/.myagents/` 用户目录：

| Store | 文件 | 模块 |
|-------|------|------|
| `ThoughtStore` | `~/.myagents/thoughts/<YYYY-MM>/<id>.md`（按月分目录的 Markdown + 头部 YAML frontmatter） | `src-tauri/src/thought.rs` |
| `TaskStore` | `~/.myagents/tasks.jsonl`（元数据行）+ `~/.myagents/tasks/<id>/{task.md, verify.md, progress.md, alignment/…}`（AI 工作区） | `src-tauri/src/task.rs` |

### 写盘原子性

两个 Store 均走 `write_atomic_text` —— tmp 文件写入 + `sync_all` + `rename` + 父目录 fsync。

TaskStore 的 `create_direct` / `create_migrated` **先写 task.md 再提交 JSONL**（cross-review C3 修复）：JSONL 失败时 best-effort 清理 docs 目录，orphan 目录无害；反序则会残留"有 JSONL 行无 task.md"的鬼任务。

### 路径穿越防御

`validate_safe_id(value, label)` 在每个 task_id / thought_id / alignmentSessionId 入口拦截：
- `..`
- 路径分隔符
- `\0`
- Windows 保留名（CON/PRN/COM1-9 等）
- 非 ASCII 字符

再叠加 `task_docs_dir()` 的 `resolved.starts_with(&base)` 双保险。

## 状态机 + 审计链

### Task 状态

```
Todo → Running → Verifying ↔ Done
        ↓
        Blocked / Stopped / Archived / Deleted
```

### 状态变更行为

每次 `update_status` 都原子写入 `statusHistory: StatusTransition[]`（`{from, to, at, actor, source, message}`）并 append 到 `progress.md`。

广播 Tauri event `task:status-changed`（**非 SSE**，前端 `listen()` 直接消费）让所有打开的任务中心 Tab 实时同步。

### 崩溃恢复

把遗留 `running / verifying` 迁到 `blocked` 并记入 statusHistory。

### 软删审计

`deleted = true` 也写审计 `→ deleted` 伪状态，真删只在 archive 后可选。

## Task ↔ CronTask 反向指针（执行闭环）

**Task 不自己跑**，而是登记一条 `CronTask { task_id: Some(<taskId>) }`。

调度器 tick 时：
1. 检查 `task_id`
2. 回调 `task::build_dispatch_prompt()` **动态**构造首条消息：
   - `direct` 模式 → "执行任务：<task.md>"
   - `ai-aligned` 模式 → `/task-implement`

**好处**：用户中途编辑 task.md，下一次执行立即生效——不需要手动同步 Prompt，也不会跑半新半旧。

### Goal Mode 与 Task/Cron 边界

Goal Mode（0.2.50）也复用 `CronTask` 作为 backing store 和 scheduler，但它不是 Task Center task：

- Goal 不自动创建 `TaskStore` 记录，不写 `task_id`，不进入 Task 状态机。
- Goal identity 只由显式 `goalStatus` 表达；`goalObjective` 是 Goal 数据而不是身份标识。不能把 `CronSchedule::Loop` 或 `RunMode::SingleSession` 形状本身当成 Goal，旧 Loop 不迁移。
- 普通 Task / Cron surface 必须过滤或拒绝 Goal task；Goal 的 create/get/update 走 Goal facade（Tauri `cmd_*_goal_task`、Management API `/api/goal/*`、CLI `myagents goal ...`）。
- Task Center 内部将来仍可使用 loop-shaped CronTask 作为执行机制，只要没有 Goal 字段，它就是 Task/Cron 执行，不是 Goal Mode。
- legacy Cron 升级逻辑不能把 Goal 自动迁成 Task，也不能把 Task-linked Cron 误识别为 Goal。

## AI 讨论路径（想法 → 正式任务）

完整 5 步流程：

1. 用户点想法卡「AI 讨论」→ 打开新 Chat Tab + 注入 `task-alignment` Skill
2. AI 完成 alignment → 四份文档（alignment.md / task.md / verify.md / progress.md）存于 `~/.myagents/tasks/<alignmentSessionId>/alignment/`
3. AI 调 `myagents task create-from-alignment <alignmentSessionId> --name <name>`
4. `TaskStore::create_from_alignment` 事务化迁移：
   - JSONL 先写
   - 原 alignment 目录 rename 到 `~/.myagents/tasks/<newTaskId>/`
   - 失败时 JSONL rollback
5. `dispatchOrigin = 'ai-aligned'`，后续走 `/task-implement` 模板

## Legacy Cron 升级 (`legacy_upgrade.rs`)

早期版本的独立 CronTask 在首次加载时被检测为 "legacy"，自动升级成带 Task 的结构：

- **幂等：** `set_task_id(cron_id, new_task_id, require_null=true)` CAS，已升级过的 cron 会被 short-circuit 跳过
- **Rollback：**
  - Task 创建成功但 CAS 失败 → 回滚 Task
  - CAS 成功后 Rename 失败 → CAS 回滚 + Task 删除
- **状态保留：**
  - Running cron → Running task
  - 已自然结束 → Done
  - 用户手动停的 → Stopped
- **Audit 记 `actor=System, source=Migration`**

详见 `pit_of_success.md` 的「Legacy CronTask CAS Upgrade」节。

## 前端布局

`src/renderer/components/task-center/` 32 个组件。

```
左栏 ThoughtPanel       右栏 TaskListPanel
  速记流                  - 进行中
                          - 规划中     ← 三段
                          - 已完成
                        卡片 / 列表 ViewToggle
```

详情 Overlay (`TaskDetailOverlay` / `TaskEditPanel`) 包含：
- 名称、描述、Prompt
- 执行模式
- per-task Runtime / Model / PermissionMode 覆盖
- 结束条件、通知订阅
- 运行统计、status history、关联 session 列表

## 全文搜索

`search/mod.rs` 新增 `search_thoughts` / `search_tasks` 方法。

- v1 规模用内存线性扫描（<10k 条）
- Thought 遍历 ThoughtStore
- Task 遍历 TaskStore 并按需读 `~/.myagents/tasks/<id>/task.md` 全文
- 超过规模再切 Tantivy，schema 接口已留好

## CLI

`myagents task` 命令族：
```
list / get / run / rerun
update-status / update-progress / append-session
archive / delete
create-direct / create-from-alignment
```

`myagents thought` 命令族：
```
list / create
```

### Actor / Source 自动识别

| 调用方 | actor | source |
|--------|-------|--------|
| AI 子进程（`MYAGENTS_PORT` 环境变量存在） | `agent` | `cli` |
| 用户终端 | `user` | `cli` |
| UI 路径（Tauri 层强制） | `user` | `ui` |

三条入口互不伪造，审计链可溯。

## 资源管理

| 事件 | 行为 |
|------|------|
| 任务立即执行 / 重新派发 | `task::run` → 登记 `CronTask { task_id }` + 触发调度；执行完成后 CronTask 自然结束 |
| Task 软删除 | `TaskStore::delete` → 写 `→ deleted` 伪状态 + 联动清理 `thought.convertedTaskIds` |

## 详细设计文档

- 任务中心完整 PRD（本地）：`prd_0.1.69_task_center.md`
- Session Config Snapshot 设计：`prd_0.1.69_session_config_snapshot.md`

## 与其他文档的关系

- 与 CronTask 的协同 → `ARCHITECTURE.md` 的「定时任务系统」节
- Session Config Snapshot 实现 → `pit_of_success.md` 的「Snapshot Helpers」节
- CLI 完整命令矩阵 → `cli_architecture.md`
- Management API 路由 → `ARCHITECTURE.md` 的 `/api/task/*` 节
