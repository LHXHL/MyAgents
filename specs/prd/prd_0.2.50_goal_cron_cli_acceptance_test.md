---
type: acceptance-test
status: ready
version: 0.2.50
created: 2026-07-12
scope: "通过 MyAgents CLI 验收 Goal 与普通 Cron/Task 收口后的用户可见行为，重点覆盖 Cron 兼容入口、TaskStore 投影、run-now、更新、停止、恢复、删除及 Goal/Cron 隔离。"
related:
  - specs/prd/prd_0.2.50_goal_mode_loop_upgrade.md
  - specs/prd/prd_0.2.50_goal_task_cron_architecture_convergence.md
  - specs/tech_docs/task_center.md
  - specs/tech_docs/task_provider_routing.md
  - specs/tech_docs/cli_architecture.md
---

# Goal / Cron CLI 验收测试

## 1. 给执行 Agent 的任务

你是本轮验收测试执行者。请在一个**新建的普通 MyAgents Chat Session** 中读取并执行本文，不修改产品代码，不直接编辑 `~/.myagents` 下的 Task、Cron、Goal 或 Session 存储。

执行目标：

1. 验证 `myagents cron` 作为兼容入口仍可完整管理普通定时任务。
2. 验证 CLI 创建的 Cron 实际投影为同 ID 的 Task，而不是产生第二份 Cron 权威。
3. 验证 `run-now`、更新、停止、重新启动、删除的状态语义。
4. 验证 Loop 已从 Cron 退休，Goal 不会创建 Task/Cron。
5. 输出一份有命令、有关键 JSON 证据、有 PASS/FAIL 的验收报告。

建议用户用下面这句话启动测试 Agent：

```text
请读取 specs/prd/prd_0.2.50_goal_cron_cli_acceptance_test.md，严格执行其中“强制测试”与清理步骤，不修改代码或底层存储。完成后给我验收报告；任何失败都保留原始命令、退出状态和关键 JSON。
```

## 2. 安全约束

以下约束是测试契约，不得跳过：

- 必须在普通 Session 中执行，不要从已经运行中的 Goal、Cron Task Session 或 IM Session 开始。
- 先运行 `myagents goal get --json`。如果当前 Session 已有 `active` 或 `paused` Goal，停止测试并请用户换一个新 Session；不要替用户结束既有 Goal。
- 所有测试资源使用本轮唯一前缀，只能停止/删除本轮记录下来的 Task ID。禁止按名称模糊删除，禁止碰已有 Task。
- `cron add` 每次实际创建前必须先用相同参数执行 `--dry-run`。
- 禁止直接修改 `tasks.jsonl`、`cron_tasks.json`、`session_goals.json`、运行历史或任何内部状态文件。
- 禁止通过裸 HTTP、Tauri invoke 或数据库/文件注入绕过 CLI。
- 不以 UI 卡片作为强制断言；本文件的强制断言以 CLI JSON 和真实执行历史为准。
- 发生失败时不要通过重复创建同名资源“碰运气”。保留证据，继续执行能够安全执行的只读检查，然后进入清理。
- 本文预先授权删除**本轮唯一前缀且 ID 已记录**的测试资源；不授权删除任何其他资源。

## 3. 测试准备

### 3.1 环境要求

- 当前运行的是待验收的 0.2.50 构建。
- MyAgents App 正在运行，当前 Session 已 materialize。
- 当前工作区允许创建测试 Task，并已有可工作的 Provider/模型。
- CLI 可通过当前 Session 注入的 `MYAGENTS_PORT` 连接 Sidecar。

如果 `myagents` 报 `command not found`，先报告并请用户重启 App 触发 CLI 同步。如果报 `ECONNREFUSED`，报告 Sidecar/App 未运行，不要继续写操作。

### 3.2 本轮变量

执行 Agent 先确定并在报告中记录：

```text
WORKSPACE = 当前工作区的绝对路径（通常为 pwd -P）
RUN_ID    = 当前时间戳，例如 20260712-153000
PREFIX    = ma-0250-goal-cron-<RUN_ID>
```

后文的 `<WORKSPACE>`、`<PREFIX>`、`<TASK_ID>`、`<AT_TASK_ID>` 必须替换为本轮真实值。不要把尖括号占位符原样传给 CLI。

在工作区内用标准文件写入工具建立测试目录：

```text
myagents_files/qa/<PREFIX>/
```

创建两个 prompt 文件：

`recurring-v1.txt`

```text
Reply with exactly this marker and nothing else: <PREFIX>-V1
```

`at-once.txt`

```text
Reply with exactly this marker and nothing else: <PREFIX>-AT-ONCE
```

创建报告文件：

```text
myagents_files/qa/<PREFIX>/report.md
```

每完成一个测试用例就追加结果，不要等到最后凭记忆补写。

## 4. 强制测试

### TC-00：CLI 与基线

依次执行：

```bash
myagents version --json
myagents status --json
myagents cron --help
myagents cron readme
myagents goal --help
myagents goal get --json
myagents cron list --workspace "<WORKSPACE>" --json
myagents cron status --workspace "<WORKSPACE>" --json
myagents task list --json
```

记录：

- App/CLI 版本。
- `goal get` 的当前状态。
- 当前工作区 Cron 基线 ID 集合与数量。
- Task 基线 ID 集合。
- Cron status 的 `totalTasks`、`runningTasks`。

通过条件：

- 所有只读命令成功。
- 当前 Session 没有 unfinished Goal。
- 基线中不存在本轮 `<PREFIX>` 资源。
- `cron list` 明确是当前 `<WORKSPACE>` 的作用域；空列表不解释成“全系统没有 Task”。

### TC-01：dry-run 必须零写入

执行：

```bash
myagents cron add \
  --name "<PREFIX>-dry-run" \
  --prompt-file "myagents_files/qa/<PREFIX>/recurring-v1.txt" \
  --every 5 \
  --workspace "<WORKSPACE>" \
  --dry-run \
  --json
```

随后重新执行：

```bash
myagents cron list --workspace "<WORKSPACE>" --json
myagents task list --json
```

通过条件：

- dry-run 返回成功，并明确包含 `dryRun: true` 和 preview。
- Cron/Task 列表中都没有 `<PREFIX>-dry-run`。
- 基线数量没有因 dry-run 增加。

### TC-02：Cron 创建必须落为唯一 Task

使用与 dry-run 相同的核心参数实际创建：

```bash
myagents cron add \
  --name "<PREFIX>-recurring" \
  --prompt-file "myagents_files/qa/<PREFIX>/recurring-v1.txt" \
  --every 5 \
  --workspace "<WORKSPACE>" \
  --json
```

从响应的 `data.taskId` 记录 `<TASK_ID>`，然后执行：

```bash
myagents cron list --workspace "<WORKSPACE>" --json
myagents cron list --json
myagents cron status --workspace "<WORKSPACE>" --json
myagents task get <TASK_ID> --json
myagents task list --json
```

通过条件：

- 创建响应成功，返回唯一非空 `<TASK_ID>`，创建后状态为 running。
- 显式 workspace list 与当前 Session 默认 list 都能看到同一个 `<TASK_ID>`。
- Cron 投影显示 `every 5m`、`Running`，并有未来的 `nextExecutionAt`。
- `task get <TASK_ID>` 返回**同一个 ID**，`executionMode=recurring`、`intervalMinutes=5`、状态为 Running。
- `task list` 中该 ID 只出现一次；不存在第二个同名前缀 Task。
- Cron status 相对基线增加 1 个 Task、1 个 Running Task。

架构判据：`cron list` 和 `task get` 是同一个 ID 的两个 API 投影，不是两条互相同步的持久记录。

### TC-03：Running Task 的 run-now

先从 TC-02 的 `cron list` 记录 `<TASK_ID>` 当前的 `nextExecutionAt` 和执行次数，然后执行：

```bash
myagents cron run-now <TASK_ID> --json
```

`run-now` 只表示已触发。每隔 5 秒查询一次，最多等待 120 秒：

```bash
myagents cron runs <TASK_ID> --limit 10 --json
```

完成后再执行：

```bash
myagents cron list --workspace "<WORKSPACE>" --json
myagents task get <TASK_ID> --json
```

通过条件：

- `run-now` 返回同一个 task ID 和 execution Session ID。
- 120 秒内新增且只新增一条对应本次触发的 run record。
- run record 为成功，content 包含精确 marker `<PREFIX>-V1`，有非负 duration。
- Task 仍为 Running；`run-now` 没有停止或重新启用 scheduler。
- 若测试期间没有跨过真实 scheduled tick，`nextExecutionAt` 不应因 `run-now` 移动。
- 不得出现同一次 `run-now` 对应两条历史或两个执行 Session。

### TC-04：Running 状态下更新 schedule 与 prompt

执行：

```bash
myagents cron update <TASK_ID> \
  --name "<PREFIX>-recurring-v2" \
  --prompt "Reply with exactly this marker and nothing else: <PREFIX>-V2" \
  --every 10 \
  --json
```

随后执行：

```bash
myagents cron list --workspace "<WORKSPACE>" --json
myagents task get <TASK_ID> --json
myagents cron run-now <TASK_ID> --json
```

继续按 TC-03 的方式轮询 runs。

通过条件：

- ID 保持不变，状态仍为 Running。
- Cron 投影和 Task 详情都变为 10 分钟周期，新 `nextExecutionAt` 符合更新后的 schedule。
- 新增的 run record content 为 `<PREFIX>-V2`，证明下次执行读取了更新后的 Task 内容。
- V1 历史仍保留，但不能成为本次最新输出。
- 一次 update 不能留下旧 5 分钟 handle 与新 10 分钟 handle 并行执行。

最后一条无法靠短时间完全证明；强制证据是“ID 不变、next fire 已更新、单次 run-now 只新增一条历史”。真实旧 handle 排除由扩展测试的跨触发点观察补充。

### TC-05：Stop、Stopped run-now、Start

执行并检查：

```bash
myagents cron stop <TASK_ID> --json
myagents cron list --workspace "<WORKSPACE>" --json
myagents task get <TASK_ID> --json
```

记录当前 run history 数量，再执行：

```bash
myagents cron run-now <TASK_ID> --json
```

按 TC-03 的方式轮询完成，然后执行：

```bash
myagents cron list --workspace "<WORKSPACE>" --json
myagents task get <TASK_ID> --json
myagents cron start <TASK_ID> --json
myagents cron list --workspace "<WORKSPACE>" --json
```

通过条件：

- stop 后 Cron 投影为 Stopped，Task 不再是 Running，scheduler 不再启用。
- Stopped Task 的 `run-now` 仍成功且只新增一条历史。
- Stopped `run-now` 完成后状态仍为 Stopped，不能偷偷重新开启 scheduler。
- start 后同一 ID 恢复 Running，并重新得到未来 `nextExecutionAt`。

### TC-06：Loop 必须被 Cron 拒绝

以下命令**预期失败**：

```bash
myagents cron add \
  --name "<PREFIX>-illegal-loop" \
  --prompt "Do not run" \
  --schedule '{"kind":"loop"}' \
  --workspace "<WORKSPACE>" \
  --json
```

失败后执行：

```bash
myagents cron list --workspace "<WORKSPACE>" --json
myagents task list --json
myagents goal get --json
```

通过条件：

- 命令返回非零退出状态或 `success:false`。
- 错误明确说明 Loop 属于 Goal Mode，并提示 `myagents goal create --objective-file ...`。
- Cron 和 Task 列表中都没有 `<PREFIX>-illegal-loop`。
- 失败的 Cron 创建不能顺带创建 Goal；`goal get` 仍与 TC-00 相同。

### TC-07：Goal CLI 与 Cron/Task 隔离

这是状态隔离测试，不是连续 Goal Loop 的流式体验测试。

先把此刻的 Cron/Task ID 集合写入 report.md，随后在测试目录创建 `goal-objective.txt`。文件中的 `<PREFIX>` 和报告路径必须替换为真实值：

```text
This is the Goal/Cron CLI acceptance Goal for <PREFIX>.

In the first Goal-owned continuation turn:
1. Resume TC-07 from specs/prd/prd_0.2.50_goal_cron_cli_acceptance_test.md.
2. Read myagents_files/qa/<PREFIX>/report.md for the Cron/Task baseline captured immediately before Goal creation.
3. Run myagents goal get --json and confirm this Goal is active in the current Session.
4. Run the read-only Cron/Task list checks from TC-07 and confirm Goal creation added no Cron or Task ID.
5. Mark this Goal complete with myagents goal update --status complete --json.
6. Continue with TC-08 cleanup.

Do not create scheduled work, modify product files, or touch any Task other than the exact test ID recorded in the report.
```

在当前普通 turn 中执行：

```bash
myagents goal create \
  --objective-file "myagents_files/qa/<PREFIX>/goal-objective.txt" \
  --json
myagents goal get --json
```

创建成功后，当前普通 turn **不得**调用 `goal update`，也不得继续 TC-08。把 create/get 结果写入 report.md，然后结束当前回复，让 MyAgents 自动启动下一轮 Goal continuation。

原因：`goal update` 只接受当前 Goal-owned queue turn 的 authority。普通 turn 即使刚刚创建了 Goal，也不能越权把它标记为 complete。

在自动 continuation 到来后，执行 Agent 按 objective 恢复报告并执行：

```bash
myagents goal get --json
myagents cron list --workspace "<WORKSPACE>" --json
myagents task list --json
myagents goal update --status complete --json
myagents goal get --json
```

通过条件：

- Goal create 返回 active Goal，并自动产生一个 Goal-owned continuation；continuation 中的 `goal get` 返回相同 Goal ID、objective 和当前 Session 身份。
- Goal 创建前后 Cron/Task ID 集合完全不变。
- 普通创建 turn 没有 authority 调用 terminal update；Goal-owned continuation 中 update 成功，相同 Goal 进入 complete。
- 不得出现以 Goal ID 为 Task ID 的记录，也不得出现 Loop Cron。

注意：Goal 是 Session 历史状态，CLI 不提供删除终态 Goal。本测试只允许在专用测试 Session 中执行，因此 complete 记录可以保留。

### TC-08：删除与 tombstone 行为

TC-05 已重新 start `<TASK_ID>`，清理前先 stop，再 remove：

```bash
myagents cron stop <TASK_ID> --json
myagents cron remove <TASK_ID> --json
myagents cron list --workspace "<WORKSPACE>" --json
myagents task list --json
```

然后执行一个预期失败的操作：

```bash
myagents cron run-now <TASK_ID> --json
```

通过条件：

- remove 成功。
- Cron list 和普通 Task list 都不再展示该 ID。
- 对已删除 ID 的 run-now 必须失败，不能从旧 Legacy 行复活任务。
- Cron status 回到 TC-00 基线数量，前提是测试期间没有用户或其他 Agent 并发增删 Task。

## 5. 扩展测试：真实时钟触发

这一节仍由 CLI 创建和验证，建议发布前执行。预计额外耗时 3–5 分钟。

### TC-09：一次性 At schedule 真实触发且只触发一次

执行 Agent 用可靠的时间工具计算当前时间 2 分钟后的 RFC3339 时间，必须带 `Z` 或明确 offset，例如：

```text
2026-07-12T16:20:00+08:00
```

记为 `<AT_RFC3339>`。先 dry-run：

```bash
myagents cron add \
  --name "<PREFIX>-at-once" \
  --prompt-file "myagents_files/qa/<PREFIX>/at-once.txt" \
  --schedule '{"kind":"at","at":"<AT_RFC3339>"}' \
  --workspace "<WORKSPACE>" \
  --dry-run \
  --json
```

确认 preview 后去掉 `--dry-run` 实际创建，记录 `<AT_TASK_ID>`。执行：

```bash
myagents cron list --workspace "<WORKSPACE>" --json
myagents task get <AT_TASK_ID> --json
```

不要调用 run-now。每 10 秒查询：

```bash
myagents cron runs <AT_TASK_ID> --limit 10 --json
```

最多等待计划时间后 3 分钟。首次成功后再等 30 秒并复查 runs、cron list 和 task get。

通过条件：

- 创建后 `nextExecutionAt` 与 `<AT_RFC3339>` 表示同一绝对时间。
- 到点后只产生一条成功历史，content 为 `<PREFIX>-AT-ONCE`。
- Task 进入自然终态，不能继续保持 Running scheduler。
- 再等 30 秒仍只有一条历史。

完成后清理：

```bash
myagents cron remove <AT_TASK_ID> --json
```

## 6. 扩展测试：用户协助重启

本节不能由当前 Agent 完全自治，因为重启 App 会终止当前执行上下文。发布前建议执行一次。

1. 按 TC-02 创建 `<PREFIX>-restart` 的 5 分钟 Running Task，记录 ID、`nextExecutionAt` 和当前历史数。
2. Agent 把断点写入 `report.md`，请用户在下一个 scheduled tick 之前完全退出并重新打开 MyAgents。
3. 用户在同一工作区启动新普通 Session，让 Agent 继续读取本报告。
4. 运行 `cron list --workspace ... --json`、`task get <id> --json`。
5. 验证同一 ID 仍为 Running、没有同名 duplicate、scheduler 有新的/正确的 `nextExecutionAt`。
6. 调用一次 run-now，验证只新增一条历史。
7. stop + remove 本轮 Task。

如果用户愿意等待真实周期，还应跨过一个 scheduled tick，确认只执行一次。

## 7. CLI 无法单独完成的项目

以下项目不要在本报告中伪造为 PASS：

- 从旧版本 App 创建真实 Legacy `cron_tasks.json` 后覆盖升级到新版本。
- 升级后 Running/Stopped/已完成一次性 Legacy Cron 的迁移和幂等性。
- 桌面通知是否出现、点击通知是否跳到正确 Session。
- Chat 输入框的 Goal/Cron 状态栏、首轮 user bubble、流式 thinking/tool block。
- UI Stop 按钮、暂停后发送 query 的恢复体验。
- IM/Agent Channel 的真实通知投递与 Goal outbox。
- 当前会话与新会话两种 GUI 调度策略的完整交互。

这些必须在真机 GUI、旧包升级或真实 Channel 环境中另行验收。

## 8. 清理与最终核对

即使中途失败，也必须执行本轮资源清理：

1. 列出报告中记录的所有本轮 Task ID。
2. 对仍存在的本轮 ID 依次执行 stop（允许“已经停止”）和 remove。
3. 重新执行 Cron list、Cron status、Task list。
4. 确认不存在任何 `<PREFIX>` Task/Cron。
5. 不删除 report.md；测试 prompt 文件可保留在同一 QA 目录作为证据。
6. 不清理 TC-07 的 complete Goal，它只属于本测试 Session 历史。

禁止用下面这类危险方式清理：

- 删除整个 `~/.myagents/tasks` 或 `cron_runs` 目录。
- 编辑 Store 文件过滤 `<PREFIX>`。
- 按“最近创建”删除未知 Task。
- 为了恢复基线而删除非本轮 ID。

## 9. 报告格式

`report.md` 至少使用以下结构：

```markdown
# Goal / Cron CLI Acceptance Report

- App version:
- Workspace:
- Session:
- Run prefix:
- Started at:
- Finished at:

| Case | Result | Created ID | Evidence summary |
|---|---|---|---|
| TC-00 | PASS/FAIL/BLOCKED | - | ... |
| TC-01 | PASS/FAIL/BLOCKED | - | ... |
| TC-02 | PASS/FAIL/BLOCKED | ... | ... |

## Failures

### <Case ID>
- Command:
- Exit status:
- Full error:
- Relevant JSON:
- Expected:
- Actual:
- Cleanup state:

## Residual resources
- None / list exact IDs

## Manual items not executed
- ...

## Final verdict
- PASS / FAIL / BLOCKED
```

最终聊天回复必须包含：

1. 总体 PASS/FAIL/BLOCKED。
2. 每个失败用例和严重度。
3. 创建过的 ID 及其清理结果。
4. report.md 的路径。
5. 尚未执行的真机/跨版本项目。

## 10. 严重度与发布判定

### P0：禁止发布

- 修改/删除了其他工作区或基线 Task。
- 一次触发产生重复 AI Turn、重复历史或重复副作用。
- stop/remove 后 Task 仍继续按时运行。
- Goal 创建了 CronTask/Task，或 Loop Cron 绕过拒绝成功创建。
- 删除后的 Task 被旧 Legacy 行自动复活。

### P1：必须修复后重测

- Cron add/list/update/start/stop/run-now/runs 任一核心命令不可用。
- Cron 创建成功但 `task get` 找不到同 ID Task。
- Running update 后仍使用旧 prompt/schedule。
- Stopped run-now 改变 Task 为 Running。
- At schedule 未触发、触发失败或不止一次。
- 重启后 Running Task 丢失、重复或 scheduler 未恢复。

### P2：可评估后处理

- 人类可读文案、时区展示或提示不清楚，但 JSON 和真实执行正确。
- dry-run preview 缺少非关键展示字段，但确认没有写入。
- 输出排序或格式与文档示例不同，不影响机器字段语义。

强制测试 TC-00 至 TC-08 全部 PASS，且无残留测试 Task，才可判定“CLI Cron/Goal 隔离回归通过”。TC-09 和重启测试未执行时，最终结论必须写为“CLI 核心通过，真实时钟/重启待验收”，不能写完整发布通过。
