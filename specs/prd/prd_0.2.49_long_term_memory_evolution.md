---
type: prd
status: draft
created: 2026-07-05
updated: 2026-07-05
scope: "把 Mino 已经跑通的三层长期记忆机制产品化到 Agent 设置：Memory Update 继续负责 session 级增量维护；新增长期记忆进化 Evo 主开关，复用现有 Task/Cron 能力自动执行 72h 记忆园丁与 14d Molt；同时为 Memory/Evo 共用的 `.claude/rules` 记忆基座补齐 02/03/04 模板。第一版不暴露 Evo 频率设置，不改内置 Mino 私有模板，不把 Evo 当普通用户任务展示。"
issue: "产品需求讨论收敛：长期记忆进化自动化"
research: "none"
review: "pending（实现前重点复核 Task/Cron managedKind 最小扩展、规则文件 ensure 的 symlink/path safety、以及 system skill 脱 Mino 私有上下文后的可执行性）"
---

# 长期记忆进化 Evo PRD

> **执行须知（给空 session 的你）**：本 PRD 自带需求上下文，但实现前仍需主动读项目技术文档。
> - 自动加载的 `AGENTS.md` / `CLAUDE.md` 之外，必须主动 Read：`specs/ARCHITECTURE.md`、`specs/tech_docs/im_integration_architecture.md`、`specs/tech_docs/task_provider_routing.md`、`specs/tech_docs/multi_agent_runtime.md`、`specs/DESIGN.md`、`specs/tech_docs/i18n_architecture.md`。
> - 关键源码入口：`src-tauri/src/im/memory_update.rs`、`src/server/index.ts` 的 `/api/memory/update`、`src/shared/types/im.ts`、`src/shared/types/agent.ts`、`src/shared/config-types.ts`、`src-tauri/src/im/types.rs`、`src-tauri/src/cron_task/types.rs`、`src-tauri/src/task.rs`、`src/renderer/components/AgentSettings/sections/*`。
> - 参考原型在 `/Users/zhihu/Documents/project/mino/.claude/skills/memory-gardener` 与 `/Users/zhihu/Documents/project/mino/.claude/skills/molt`。这些是产品化素材，不可原样搬：要去掉 Mino/Ethan 私有语境，脚本必须支持目标 workspace 参数。
> - 行号会漂移；本 PRD 用文件名与符号名作为线索，接手实现时用 `rg` 重新定位。

## 背景与产品定位

Mino 里已经 dogfood 出一套“长期记忆进化”机制。它不是单纯把聊天记录写进文件，而是把 Agent 的记忆分成三层持续演化：

1. **Memory Update**：活跃 session 的增量记忆维护。它根据最近对话，把新经验沉淀到日志、topic 和核心记忆里。
2. **Memory Gardener**：每 72 小时左右做一次存量整理。它修剪、降级、合并长期记忆，让自动加载层保持小而准。
3. **Molt**：每 14 天做一次更深的自我更新。它允许修改 SOUL 层，把重复出现的经验升级成底层原则，也允许拒绝旧原则。

用户的核心意志是：**把 Mino 中已经实践有效的长期记忆进化机制，正式做进 MyAgents 的 Agent 设置，变成自动化行为。**

这个需求里有一个重要纠偏：Memory Update 和 Evo 都不该假设工作区天然有 `.claude/rules/03-USER.md`、`04-MEMORY.md`、`02-SOUL.md`。只要用户打开 Memory 或 Evo，系统就应该补齐这些规则文件的轻模板，让新的 skill 机制有可依赖的记忆基座。

## 本期范围

### 做什么

1. **新增 Agent 设置项「长期记忆进化 Evo」**
   - 与「记忆更新 Memory」同级。
   - 第一版只有主开关和副标题说明，不提供频率、窗口、Gardener/Molt 子开关等设置。
   - Mino 模板派生工作区默认开启；用户添加本地已有工作区不自动开启。

2. **Memory / Evo 共用规则文件基座 ensure**
   - 只要 `memoryAutoUpdate.enabled` 或 `memoryEvolution.enabled` 任一为 true，就检测 `.claude/rules/`。
   - 检测 SOUL / USER / MEMORY 三类文档；支持编号版和非编号版。
   - 缺失时创建编号版轻模板；已有文件永不覆盖。
   - 开关打开时立刻 ensure；后台执行前也再 ensure 一次。

3. **新建两个 system bundled skills**
   - `myagents-memory-gardener`
   - `myagents-memory-molt`
   - 从 Mino 原型 skill 产品化而来，去私有语境，脚本支持目标 workspace。

4. **复用现有 Task / Cron 能力执行 Evo**
   - Evo 开启后，系统维护两条 managed recurring task / cron：
     - Gardener：72h / 3d，new session。
     - Molt：14d，new session。
   - 使用最大权限执行。
   - 执行窗口复用 Memory Update 的窗口配置。
   - 执行产生的新 session 可进入历史会话。

5. **最小扩展 Task / Cron 类型**
   - 只为了区分 Evo 系统任务与普通用户任务。
   - 建议字段：`managedKind?: 'memory_gardener' | 'memory_molt'`。
   - 旧数据默认 `undefined`；不得影响普通 Task/Cron。

6. **保守 git 策略**
   - 自动维护可以 commit 本次维护产生的记忆相关文件改动。
   - 不自动 push。
   - 不 stage 用户其它未暂存改动。

### 不做什么

- 不修改内置 `mino/.claude/rules/02-SOUL.md` 的强人格内容；如要调整 Mino 本身，另开需求。
- 不给用户暴露 Evo 频率、时间窗口、Gardener/Molt 子设置。
- 不把 Evo managed task 当普通用户任务展示、编辑、删除或自动升级。
- 不自动改写已有 `UPDATE_MEMORY.md`。
- 不自动 push 到远端。
- 不重建一套新的调度系统；必须复用现有 Task/Cron 基础设施。

## 核心产品机制

### 三层职责

| 层 | 作用 | 范围 | 触发 |
|---|---|---|---|
| Memory Update | session 增量记忆维护 | 活跃 session | 现有 Memory 开关控制，默认 24h/阈值 |
| Gardener | 记忆修剪、降级、浓缩 | workspace / Agent | Evo 开关控制，72h |
| Molt | SOUL / 底层原则演化 | workspace / Agent | Evo 开关控制，14d |

Memory Update 继续走现有机制：Rust `memory_update.rs` 在 agent-level heartbeat runner 中检查条件，按 session POST `/api/memory/update`，Node 端通过 `SessionEngine.runInjectedTurn()` 做 runtime-aware 注入。

Gardener / Molt 不是 session 级增量更新。它们是 Agent 级长期维护任务，应当以 fresh/new session 执行，避免污染用户当前聊天上下文。

### Evo UI

Agent 设置新增 section：

- 标题：`长期记忆进化 Evo`
- 副标题建议：`基于长期记忆自动进行修剪、浓缩与底层原则更新。`
- 控件：一个主开关。
- 状态展示建议：
  - `记忆园丁：上次成功 / 跳过 / 失败 / 从未运行`
  - `Molt：上次成功 / 跳过 / 失败 / 从未运行`

第一版不提供“更多设置”。用户只需要理解这是一个长期记忆进化总开关。

### 默认开启规则

Mino 模板派生工作区默认：

- `heartbeat.enabled = true`
- `memoryAutoUpdate.enabled = true`
- `memoryEvolution.enabled = true`

用户添加本地已有工作区：

- 不自动开启 Memory。
- 不自动开启 Evo。
- 保持当前已有默认/配置语义。

## 规则文件基座

### 检测范围

只检测目标 workspace 的：

```text
.claude/rules/
```

不把 `memory/`、`memory/topics/`、`memory/YYYY-MM-DD.md` 视为开启前置条件。它们由执行过程自然创建。

### 等价文件名

三类文件都支持编号版和非编号版：

| 类型 | 优先文件 | 兼容文件 |
|---|---|---|
| SOUL | `02-SOUL.md` | `SOUL.md` |
| USER | `03-USER.md` | `USER.md` |
| MEMORY | `04-MEMORY.md` | `MEMORY.md` |

规则：

1. 编号版和非编号版同时存在时，编号版优先。
2. 任一等价文件存在，即视为该类型已存在。
3. 两种都不存在，创建编号版。
4. 已有文件永不覆盖、永不合并、永不迁移。

### ensure 触发时机

必须有两层触发：

1. **配置/UI 层**
   - 用户打开 Memory 或 Evo 开关后，立刻 ensure。
   - 这样用户能马上看到 `.claude/rules` 下出现依赖文件。

2. **后台执行层**
   - Memory Update 执行前 ensure。
   - Evo managed task 执行前 ensure。
   - 覆盖 CLI/旧版本/外部写配置，以及用户后来删文件的情况。

### 文件 IO 路径

工作区文件 IO 必须走 Tauri/Rust workspace file 能力或 Rust helper，不走 Sidecar HTTP。遵守项目红线：

- 写侧用 lexical inside-workspace 解析。
- 读侧涉及已有文件时注意 symlink。
- 不通过 renderer 直连 Sidecar 操作工作区文件。

### 模板内容

#### `02-SOUL.md`

不能照搬 Mino 强人格版本。默认模板必须极轻，给 Agent 留出生长空间。

```markdown
# SOUL.md - Operating Principles

This file holds the Agent's deepest operating principles.
Keep it small. Let it grow only from repeated evidence and reflection.

## Principles

- Be useful before being expressive.
- Be honest about uncertainty.
- Protect private context.
- Preserve continuity by maintaining memory.
- Prefer evidence over confident guesses.
- Improve your own working process when repeated patterns appear.

## Growth Notes

<!-- Add or revise principles only when repeated experience proves they matter. -->

---

This file should evolve slowly. Do not rewrite it for style; update it when your behavior should change.
```

#### `03-USER.md`

```markdown
# USER.md - About Your Human

<!-- This file stores stable context about the person you are helping. Keep it useful, respectful, and current. -->

- **Name:** *(not yet known)*
- **What to call them:** *(preferred name)*
- **Timezone:** *(if known)*
- **Language / tone:** *(communication preferences)*

## Context

<!-- What do they do? What are they working on? What constraints matter? -->

*(Learn this over time. Add only information that helps you serve them better.)*

## Preferences

<!-- Working style, decision style, formatting preferences, recurring dislikes. -->

## Boundaries

<!-- Privacy, external actions, things to ask before doing. -->

---

The more you know, the better you can help. But this is not a dossier.
Record only context that improves collaboration, and remove stale or invasive details.
```

#### `04-MEMORY.md`

模板里的核心文件路径必须使用解析出的实际文件名。如果 workspace 里已有 `MEMORY.md` 而不是 `04-MEMORY.md`，新建 `UPDATE_MEMORY.md` 和模板说明都应指向实际文件。

默认编号版内容：

```markdown
# MEMORY.md - Long-Term Memory

This file is the curated memory that should be loaded every session.
It stores durable lessons, active context, and pointers. It is not a raw log.

## Memory System

Your memory has three layers:

1. **Core memory (`.claude/rules/04-MEMORY.md`)**
   - Stable cross-project lessons, durable decisions, user preferences, active project pointers.
   - Keep entries concise. Add dates when recency matters.

2. **Topic memory (`memory/topics/<name>.md`)**
   - Detailed experience for one project or topic.
   - Use this for status, decisions, pitfalls, implementation notes, and next steps.

3. **Daily logs (`memory/YYYY-MM-DD.md`)**
   - Raw chronological notes from recent work.
   - Use logs as source material for later maintenance.

Information should flow from logs to topic files to this file.
Do not duplicate details in multiple places. Put details in topic files; keep this file as an index and distilled memory.

## Working Lessons

<!-- Durable lessons about how to work well. -->

## User Preferences

<!-- Stable preferences copied or distilled from 03-USER.md only when they affect every session. -->

## Important Decisions

<!-- Decisions that future sessions must not forget. -->

## Active Context

<!-- Current projects or threads, with pointers to topic files or source docs. -->

---

Update this file during memory maintenance. Prefer deleting, downgrading, or pointing to details over making this file large.
```

## `UPDATE_MEMORY.md` 实际文件名处理

当前 `src/shared/default-update-memory.md` 明确写了 `04-MEMORY.md`，但现在系统会兼容 `MEMORY.md`。

可靠方案：

1. 抽一个明确的规则文件解析函数，例如：

```ts
type MemoryRuleKind = 'soul' | 'user' | 'memory';

interface ResolvedMemoryRuleFiles {
  soul: { filename: '02-SOUL.md' | 'SOUL.md'; path: string; existed: boolean };
  user: { filename: '03-USER.md' | 'USER.md'; path: string; existed: boolean };
  memory: { filename: '04-MEMORY.md' | 'MEMORY.md'; path: string; existed: boolean };
}
```

Rust 可用等价结构。

2. 新创建 `UPDATE_MEMORY.md` 时，用解析出的 `memory.filename` 渲染模板。
3. 已有 `UPDATE_MEMORY.md` 不自动改写。
4. 不做脆弱字符串替换，不扫描用户自定义内容。

注意：创建 `UPDATE_MEMORY.md` 目前有两条路径，必须行为一致：

- Renderer `AgentMemoryUpdateSection` 点击 `UPDATE_MEMORY.md` 链接时，如果文件不存在会创建。
- Rust `src-tauri/src/im/memory_update.rs::ensure_update_memory_file` 后台执行时，如果文件不存在会创建。

这两条路径都要消费同一套模板渲染语义。不能只改前端。

## Evo Task / Cron 设计

### 复用现有能力

Evo 不能另起调度系统。必须复用现有 Task / Cron：

- Task Center 的任务模型负责工作区级任务语义。
- CronTaskManager 负责 recurring 调度、新 session 执行、执行记录。
- Sidecar cron execution 已支持 `runMode: 'new_session'`。

本需求只做最小扩展来区分“系统 managed task”和“普通用户任务”。

### managedKind 字段

建议新增：

```ts
export type ManagedTaskKind = 'memory_gardener' | 'memory_molt';
```

添加到 Task 与 CronTask：

```ts
managedKind?: ManagedTaskKind;
```

Rust serde 要求：

- `#[serde(default, skip_serializing_if = "Option::is_none")]`
- 旧任务缺字段必须正常反序列化。

为什么 Task 和 CronTask 都要有：

- Task 列表需要过滤 managed task。
- CronTask legacy 上浮/自动升级逻辑需要过滤 managed cron。
- linked Task/Cron 需要保持同一系统身份，避免其中一端丢标记后被普通 UI 接管。

### managed task provisioning

当 `memoryEvolution.enabled = true`：

1. ensure 规则文件基座。
2. ensure managed Task/Cron 存在：
   - `managedKind = 'memory_gardener'`
   - `managedKind = 'memory_molt'`
3. 如果已存在同 workspace + same managedKind，则更新必要字段，不创建重复项。
4. 如果配置关闭，则停止对应 managed cron，但保留历史 Task/session 记录。

建议用 workspacePath 归一化 + managedKind 做幂等 key。不要依赖任务名称匹配。

### 调度

| kind | interval | run mode | skill |
|---|---:|---|---|
| `memory_gardener` | 72h / 4320 min | `new-session` | `myagents-memory-gardener` |
| `memory_molt` | 14d / 20160 min | `new-session` | `myagents-memory-molt` |

开启 Evo 后不立即执行。`startAt` 应计算为下一次 Memory Update 窗口开始时间，避免刚打开开关就跑重任务。

执行窗口复用 `memoryAutoUpdate`：

- `updateWindowStart`
- `updateWindowEnd`
- `updateWindowTimezone` fallback 到 heartbeat timezone，再 fallback 到 `Asia/Shanghai`

CronTask 的 `Every { minutes, startAt }` 可让首次执行落在窗口内，后续按间隔运行。实现时仍需确认 CronTask recovery 在 app 睡眠/错过 tick 后的行为：如果恢复时已经在窗口外，不应立即启动 AI；应重新排到下一个窗口，且不计为一次真实执行。

### 权限与 runtime

Evo 是无人值守维护任务，必须使用最大权限：

- builtin：`fullAgency` 或当前 cron resolver 的 runtime max sentinel。
- Codex：`no-restrictions`。
- Claude Code：`bypassPermissions`。
- Gemini：`yolo`。

不要手写 runtime 分支。涉及注入/执行/等待 turn 成功时，继续走现有 CronTask / SessionEngine / runtime adapter 路径，遵守 `multi_agent_runtime.md`：completion 必须 gate 在真实 turn 成功上。

### Prompt 形态

Gardener managed task prompt 只需要明确调用 skill：

```text
Use the `myagents-memory-gardener` skill to run long-term memory gardening for this workspace.

Workspace: <absolute workspace path>
Rules:
- Run in a fresh maintenance session.
- Ensure `.claude/rules` memory substrate exists before making changes.
- Modify only memory-related files.
- If committing, commit only files changed by this maintenance run.
- Do not push.
```

Molt managed task prompt：

```text
Use the `myagents-memory-molt` skill to run a long-term memory molt for this workspace.

Workspace: <absolute workspace path>
Rules:
- Run in a fresh maintenance session.
- You may update `.claude/rules/02-SOUL.md` or equivalent SOUL file.
- Ensure `.claude/rules` memory substrate exists before making changes.
- Modify only memory-related files.
- If committing, commit only files changed by this maintenance run.
- Do not push.
```

具体操作细节放在 skill 内，不把完整 playbook 塞进 Task prompt，避免 prompt 漂移。

## System Skill 产品化

### 目录与注册

新增：

```text
bundled-skills/myagents-memory-gardener/
bundled-skills/myagents-memory-molt/
```

必须同步：

- Rust `src-tauri/src/commands.rs::SYSTEM_SKILLS`
- `SYSTEM_SKILLS_VERSION`
- Node `src/server/index.ts::SYSTEM_SKILLS` 排除/同步列表

系统 skill 是 force-sync，不是 seed-once。它们是产品流程依赖，用户不应通过本地旧版本阻断 Evo 执行。

### 从 Mino 原型迁移

来源：

```text
/Users/zhihu/Documents/project/mino/.claude/skills/memory-gardener
/Users/zhihu/Documents/project/mino/.claude/skills/molt
```

必须产品化：

1. skill 名称改为 `myagents-memory-gardener` / `myagents-memory-molt`。
2. 删除 Ethan/Mino 私有叙述，改成通用 Agent/workspace 语义。
3. 文件路径不要假设脚本位于目标 repo 内。
4. 脚本必须支持 `--repo <workspace>`。
   - `memory_lint.py` 已有 `--repo` 线索。
   - `prepare_molt.py` 需要补 `--repo`，不能再从脚本路径向上找目标 repo。
5. Git 行为改为保守：
   - 可 commit。
   - 不 push。
   - 只 stage 本次维护涉及的记忆相关文件。
6. Molt 的外部事实验证要求保留；如果当前 runtime 无可用搜索工具，必须在 molt 报告中标记 `unverified`，不得把未验证事实写成确定结论。

### 允许修改的文件范围

Skill 应把“记忆相关文件”定义清楚，至少包含：

```text
.claude/rules/02-SOUL.md
.claude/rules/SOUL.md
.claude/rules/03-USER.md
.claude/rules/USER.md
.claude/rules/04-MEMORY.md
.claude/rules/MEMORY.md
memory/**
```

不要 stage 或修改用户代码、产品源码、普通文档，除非 skill 明确把它作为 memory topic 的来源只读引用。

## Agent Config 与默认值

### 新增配置

在 shared / Rust agent config 中新增：

```ts
export interface MemoryEvolutionConfig {
  enabled: boolean;
  lastGardenerAt?: string;
  lastGardenerStatus?: 'completed' | 'skipped' | 'error' | 'timeout';
  lastGardenerMessage?: string;
  lastMoltAt?: string;
  lastMoltStatus?: 'completed' | 'skipped' | 'error' | 'timeout';
  lastMoltMessage?: string;
}
```

`AgentConfig`：

```ts
memoryEvolution?: MemoryEvolutionConfig;
```

默认值：

```ts
export const DEFAULT_MEMORY_EVOLUTION_CONFIG: MemoryEvolutionConfig = {
  enabled: true,
};
```

注意：`DEFAULT_*` 表示模板默认；对已有本地 workspace 不应在迁移时强制补 enabled true。

### Mino template

`WorkspaceTemplateAgentDefaults` 增加：

```ts
memoryEvolution?: MemoryEvolutionConfig;
```

`PRESET_TEMPLATES[mino].agentDefaults.memoryEvolution.enabled = true`。

`buildAgentForProject()` 已按 template defaults 生成 heartbeat / memoryAutoUpdate；新增字段应沿用同一模式。

### Runtime sync

`patchAgentConfig()` 当前把 `heartbeat` 和 `memoryAutoUpdate` 映射到 Rust `cmd_update_agent_config`：

- `heartbeatConfigJson`
- `memoryAutoUpdateConfigJson`

新增：

- `memoryEvolutionConfigJson`

Rust：

- `AgentConfigRust` 增加 `memory_evolution: Option<MemoryEvolutionConfig>`。
- `AgentConfigPatch` 增加 `memory_evolution_config_json: Option<String>`。
- config disk merge 逻辑必须 disk-first，遵守现有 config 持久化红线。

## UI 影响

### Agent 设置入口

两个入口都要接：

- `src/renderer/components/AgentSettings/WorkspaceGeneralTab.tsx`
- `src/renderer/components/AgentSettings/AgentSettingsPanel.tsx`

当前都渲染 Heartbeat、Memory、Tasks。新增 `AgentMemoryEvolutionSection`，放在 Memory Update 附近。

### i18n

新增用户可见文案必须走：

- `src/renderer/i18n/locales/zh-CN/settings.json`
- `src/renderer/i18n/locales/en-US/settings.json`

不要在组件里硬编码正式 UI 文案。

### 普通任务 UI 过滤

如果 Evo 复用 Task/Cron，必须避免普通任务 UI 接管：

1. `AgentTasksSection`
   - 过滤 `managedKind` 不为空的 CronTask。
   - 不让 Evo 出现在普通“定时任务”列表。

2. Task Center
   - 普通 Task 列表过滤 `managedKind` 不为空的 Task。
   - legacy Cron 上浮过滤 `managedKind` 不为空的 CronTask。
   - 自动升级 legacy Cron 逻辑必须跳过 managed Cron。

3. `CronTaskDetailPanel`
   - 第一版不需要为 Evo 打开该面板。
   - 如果未来打开，必须只读并屏蔽编辑/删除/停止/恢复。

Evo 状态由 Agent 设置的 Evo section 自己展示，不借普通 Task Center 交互。

## Git 策略

第一版保守：

1. 可在 git repo 内 commit。
2. 不自动 push。
3. commit 前后都读取 git status。
4. 只 stage 本次 Evo run 修改/创建的记忆相关文件。
5. 不 stage 用户其它未暂存文件。
6. 如果无法可靠区分本次维护改动与已有 dirty memory 文件，则跳过 commit，在报告中说明原因。

建议 commit message：

- Gardener：`memory: garden long-term memory`
- Molt：`memory: molt operating principles`

如果不是 git repo，直接修改文件并在执行结果中说明未 commit。

## 关键设计决策

### D1：Evo 只有主开关

用户明确不想第一版给频率、窗口、子能力做一堆设置。Evo 本质是“长期记忆进化”总能力。把 Gardener / Molt 细节暴露出来会让设置页信息过载，也会把用户拉进不必要的策略选择。

### D2：Memory / Evo 共用规则基座

当前 `UPDATE_MEMORY.md` 默认内容已经假设 Mino 式记忆结构存在。这个问题不是 Evo 独有。只要 Memory 或 Evo 任一开启，就要补齐 `.claude/rules` 的 SOUL/USER/MEMORY 基座。

### D3：编号版优先，非编号版兼容

Mino 使用 `02-SOUL.md` / `03-USER.md` / `04-MEMORY.md`，但用户工作区可能已有 `SOUL.md` / `USER.md` / `MEMORY.md`。兼容两者可以减少破坏；编号版优先可以保持 MyAgents 模板排序稳定。

### D4：已有 `UPDATE_MEMORY.md` 不改

自动替换已有文件里的 `04-MEMORY.md` 风险太高。可靠方案是只在新创建默认模板时使用解析出的实际文件名。已有文件始终是用户内容权威。

### D5：复用 Task/Cron，但加 managedKind

用户明确要求复用现有 task 和定时任务能力，同时要求对 cron/task 修改谨慎。`managedKind` 是最小区分字段：不改变普通任务语义，只让 UI 和 legacy upgrade 逻辑能过滤系统任务。

### D6：Evo 不作为普通任务展示

裸 CronTask 会被 Agent 设置普通任务区展示，并可能被 Task Center legacy cron 上浮/升级。Evo 是系统维护任务，不应被用户当普通任务编辑、删除、停止。状态回到 Evo section 展示，session 历史保留即可。

### D7：Molt 全自动，允许改 SOUL

用户明确拍板：Molt 全自动执行，允许修改 `02-SOUL.md`。因此默认 02 模板必须轻，不能用 Mino 当前强人格版本；真正的个性和原则由 Molt 在长期使用中生长。

### D8：commit 不 push

Mino 原型中有 commit/push，但产品第一版采用保守策略。自动维护可以 commit 自己的记忆改动，但不自动 push，避免无人值守动作影响远端仓库。

## 技术地基与红线

### 已有事实

- `src-tauri/src/im/memory_update.rs` 已负责 Memory Update 调度、session 筛选、`UPDATE_MEMORY.md` runtime ensure。
- `src/server/index.ts` 的 `/api/memory/update` 已通过 `SessionEngine.runInjectedTurn()` runtime-aware 注入，且使用最大权限。
- `src/shared/default-update-memory.md` 是默认 `UPDATE_MEMORY.md` 内容来源；Rust 通过 `include_str!("../../../src/shared/default-update-memory.md")` 使用同一文件。
- Agent 设置有两个入口都渲染 Heartbeat / Memory / Tasks。
- CronTask 已支持 `runMode: 'new_session'`、provider/runtimes、execution records。
- Task Center 会把无 `task_id` CronTask 作为 legacy cron 上浮并自动升级，managed cron 必须过滤。

### 红线

- 工作区文件 IO 不走 Sidecar HTTP；走 Tauri/Rust workspace file helper。
- 新增 CronTask 字段必须 serde default。
- Config 写盘 disk-first，不直接用 React config 覆盖磁盘。
- Runtime 注入/执行不要手写 external runtime 分支；走已有 Task/Cron/SessionEngine 路径。
- System skill 注册要同步 Rust `SYSTEM_SKILLS` / version / Node exclusion list。
- 前端新增文案走 i18n。
- Agent 设置两个入口都要改。
- 不使用普通 Task/Cron UI 暴露 managed tasks。

## 验收标准

1. Mino 模板派生新工作区时，Agent 默认开启 Heartbeat、Memory Update、Evo。
2. 用户添加本地已有工作区时，Memory/Evo 不被自动开启。
3. 打开 Memory 或 Evo 任一开关后，`.claude/rules/` 立即补齐缺失的 SOUL/USER/MEMORY 规则文件。
4. 规则文件检测支持编号版与非编号版；编号版优先；已有文件不覆盖。
5. 新创建 `UPDATE_MEMORY.md` 时，默认模板里的核心记忆文件名与实际解析出的 MEMORY 文件一致。
6. 已有 `UPDATE_MEMORY.md` 不被自动改写。
7. Evo 开启后，系统幂等创建/维护两条 managed Task/Cron：Gardener 72h、Molt 14d，均为 new session、最大权限。
8. Evo 不立即执行；等下一次调度窗口。
9. Evo managed tasks 不出现在普通 Agent Tasks 列表，不被 Task Center legacy cron 自动升级。
10. Gardener/Molt 执行 session 可在历史会话中看到。
11. Gardener/Molt 使用 system bundled skills `myagents-memory-gardener` / `myagents-memory-molt`。
12. Molt 可以自动修改 SOUL 文件。
13. git repo 中只 commit 本次维护产生的记忆相关文件；不 push；不 stage 用户其它改动。
14. `npm run typecheck`、`npm run lint`、相关 Rust tests / TS unit tests 通过。

## 测试建议

### Unit

- 规则文件 resolver：
  - 只有编号版。
  - 只有非编号版。
  - 两者都有时编号版优先。
  - 都没有时返回待创建编号版。
- 模板渲染：
  - `UPDATE_MEMORY.md` 新建时使用 `04-MEMORY.md`。
  - workspace 已有 `MEMORY.md` 时使用 `MEMORY.md`。
  - 已有 `UPDATE_MEMORY.md` 不改。
- Agent defaults：
  - Mino template agentDefaults 包含 `memoryEvolution.enabled = true`。
  - 非 template/local workspace 不自动开启。
- managedKind serde/default：
  - 旧 Task/Cron JSON 缺字段可读。
  - managedKind 能随 Task -> Cron 投影。
- UI 过滤：
  - AgentTasksSection 不展示 managed cron。
  - Task Center legacy cron fetch 不上浮 managed cron。

### Integration / Manual

1. 新建 Mino 派生工作区，确认 Memory/Evo 默认开启，`.claude/rules` 基座存在。
2. 添加普通本地工作区，确认 Evo 不自动开启；手动打开后补齐 02/03/04。
3. 手动预置 `SOUL.md` / `USER.md` / `MEMORY.md`，打开开关后不创建重复非必要文件，新建 `UPDATE_MEMORY.md` 指向 `MEMORY.md`。
4. 触发 Gardener managed task，确认新 session、最大权限、skill 被调用、普通任务列表不显示。
5. 触发 Molt managed task，确认可改 SOUL，且只 commit 记忆相关文件、不 push。

## 后续期

- 在 Evo section 增加“立即运行 Gardener / Molt”按钮。
- 给 managed system task 做只读 Task Center 展示，而不是完全过滤。
- 根据 dogfood 决定是否允许用户配置 Gardener/Molt 频率。
- 允许用户选择是否自动 push。
- 把 Mino 内置 `02-SOUL.md` 另行调整为更适合公开分发的版本。

## 附录：关联文档与源码

- `specs/ARCHITECTURE.md`
- `specs/tech_docs/im_integration_architecture.md`
- `specs/tech_docs/task_provider_routing.md`
- `specs/tech_docs/multi_agent_runtime.md`
- `specs/DESIGN.md`
- `specs/tech_docs/i18n_architecture.md`
- `src-tauri/src/im/memory_update.rs`
- `src/server/index.ts` (`/api/memory/update`)
- `src/shared/default-update-memory.md`
- `src/shared/types/im.ts`
- `src/shared/types/agent.ts`
- `src/shared/config-types.ts`
- `src-tauri/src/im/types.rs`
- `src-tauri/src/cron_task/types.rs`
- `src-tauri/src/task.rs`
- `src/renderer/components/AgentSettings/sections/AgentMemoryUpdateSection.tsx`
- `src/renderer/components/AgentSettings/sections/AgentTasksSection.tsx`
- Mino 原型：`/Users/zhihu/Documents/project/mino/.claude/skills/memory-gardener`
- Mino 原型：`/Users/zhihu/Documents/project/mino/.claude/skills/molt`

## 执行台账

### 开发契约（动第一行代码前写完）

- 必赢场景：Mino 模板派生 workspace 默认开启 Memory + Evo；本地已有 workspace 不自动开启。打开 Memory 或 Evo 任一开关会立即在 `.claude/rules/` 里补齐 SOUL/USER/MEMORY 规则基座，支持编号版/非编号版且不覆盖已有文件。Evo 复用现有 Task/Cron 创建 managed Gardener/Molt recurring 任务，72h/14d、new session、最大权限、普通任务 UI 不接管。新建 `UPDATE_MEMORY.md` 能根据实际 MEMORY 文件名生成，已有文件不改。两个 system skill 可被同步并用于执行。
- 复用的既有抽象：`PRESET_TEMPLATES[].agentDefaults`、`buildAgentForProject()`、`patchAgentConfig()` → `cmd_update_agent_config`、`AgentConfigRust` / `AgentConfigPatch`、`memory_update.rs::ensure_update_memory_file`、`src/shared/default-update-memory.md`、`CronTaskManager` / `CronTaskConfig` / `CronTask.task_id`、`TaskState::create_direct` / `ensure_cron_for_task`、`RunMode::NewSession`、`AgentTasksSection`、Task Center legacy Cron 上浮过滤、system skill sync (`SYSTEM_SKILLS` / `SYSTEM_SKILLS_VERSION` / Node `SYSTEM_SKILLS`)。
- 反向边界：不改内置 `mino/.claude/rules/02-SOUL.md`；不暴露 Evo 频率/窗口/子开关；不自动改写已有 `UPDATE_MEMORY.md`；不自动 push；不新建一套独立调度系统；不把 Evo managed task 当普通用户任务展示或编辑；不迁移/合并已有 `SOUL.md` / `USER.md` / `MEMORY.md`。
- 新概念清单：`memoryEvolution`（Agent 级 Evo 开关和状态，必要，因为它是 Memory 外的产品能力）；`managedKind`（Task/Cron 最小系统任务标记，必要，因为复用现有 Task/Cron 时必须过滤普通 UI 与 legacy upgrade）；规则基座 resolver（必要，因为编号/非编号文件兼容和 `UPDATE_MEMORY.md` 实际文件名生成必须单一事实源）。
- 触及的红线：工作区文件 IO 不能走 Sidecar HTTP；Config 写盘 disk-first；新增 CronTask 字段必须 `#[serde(default)]`；Task/Cron provider/runtime 执行不能写入 credential、不能手写 external runtime 分支；Agent 设置两个入口都要改；新增 UI 文案走 i18n；system skills 注册三处同步；不要碰用户未暂存改动；不把 managed task 暴露给普通 Task/Cron 编辑路径。

### 行动清单

- [x] 建立 `memoryEvolution` shared/Rust 类型、Mino 默认值、config sync。
- [x] 实现 `.claude/rules` SOUL/USER/MEMORY resolver + ensure + 轻模板，并接入开关打开与后台执行前。
- [x] 让新建 `UPDATE_MEMORY.md` 使用实际 MEMORY 文件名；前端创建路径和 Rust runtime 创建路径一致；已有文件不改。
- [x] 产品化并注册 `myagents-memory-gardener` / `myagents-memory-molt` system skills。
- [x] 给 Task/Cron 增加 `managedKind` 最小字段，保证旧数据兼容并过滤普通 UI / legacy upgrade。
- [x] 基于现有 Task/Cron provision Evo managed recurring tasks：Gardener 72h、Molt 14d、new session、最大权限、不开启即停止/不重复创建。
- [x] 新增 Evo Agent Settings section，两个设置入口接入，i18n 文案和状态展示齐全。
- [x] 补单测/集成测试，跑 typecheck/lint/Rust check/必要构建。
- [x] cross-review-code，修复确认问题，提交 git。

### 待用户决策

无。当前产品决策已收敛；实现中若发现需要新增通信模式或无法用现有 Task/Cron 表达，再回填这里。

### 进展日志

- 2026-07-05：按 `/start-dev` 启动实现；已重读 PRD 指定文档关键段，确认 Task/Cron、Memory Update、Mino template defaults、i18n/UI 红线；写入开发契约。
- 2026-07-05：完成 Evo 配置、规则基座 ensure、Memory 模板路径替换、system skills、managedKind、Evo managed Task/Cron provisioning、Agent Settings UI/i18n 和普通任务过滤。
- 2026-07-05：cross-review-code 发现并已修复：Evo 首次触发不能 2 秒补跑、错过窗口后不能等完整 14d/72h、启动自愈 Agent 需要 reconcile managed tasks、已有 managed task 需要按 workspace path 幂等更新、执行前必须 path-safe ensure `.claude/rules`、公开 Task/Cron list 默认隐藏 managed jobs、旧 AgentSettingsPanel 也要接入 Evo。
- 2026-07-05：验证通过 `cargo check`、`cargo test`（475 tests + doctest）、`npm run typecheck`、`npm run lint`、`npm test`（240 unit files + DOM + 31 integration files）、`npm run build:web && npm run build:server && npm run build:bridge && npm run build:cli`；新增 skill Python 脚本通过 `py_compile`。
