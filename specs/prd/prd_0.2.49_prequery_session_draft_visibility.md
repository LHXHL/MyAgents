---
type: prd
status: implemented
created: 2026-07-06
updated: 2026-07-06
scope: "恢复用户感知的历史列表语义：工作区空打开、pre-warm 或 runtime-backed Provider session birth 可以为了正确 runtime identity 提前创建 metadata，但只有首条真实用户 query 之后才进入历史列表、Launcher 最近会话和搜索。P0 复用既有 materializationState:'prepared' 作为隐藏草稿态，覆盖 Managed Codex、builtin/external runtime 的首轮提交、搜索索引和老版本空行兼容；不做 UI-only filter，不把关闭 tab 删除或 TTL 清理作为主正确性路径。"
issue: "用户反馈：最新版本点击工作区产生新 session 后，即使没有发送 query，历史记录里也会出现空 session。用户希望研究清楚变更引入时间、目的，以及能否一次到位恢复“只有发送过 query 的才展示在历史记录列表里”，同时考虑历史兼容与多 runtime 链路。"
research: "本 PRD 内含 2026-07-06 本地代码、架构文档和 git history 调研；没有单独 research 文件。关键提交：4439a22d86247f06ec4d80b162c72a76c656411b（2026-06-27 23:54:44 +0800）和前置 5d871e8764bc9c44258a277d5c61d2fb19a52502（2026-06-27 02:37:19 +0800）。"
review: "implemented：已完成 cross-review-code 三路只读 review。确认并修复 Rust read-error fail-open、Rust search stale-doc 查询兜底、hidden full-reindex offset、prepared durable-first commit、prepared birth identity validation、Rust search 回归测试和 rustfmt 问题。"
---

# 0.2.49 预 Query Session 草稿可见性 PRD

## 执行须知（给空 session 的你）

本 PRD 是一次问题调查后的开发交接物，不需要回翻原始聊天。落地前必须主动读：

1. `specs/ARCHITECTURE.md`
2. `specs/tech_docs/session_architecture.md`
3. `specs/tech_docs/multi_agent_runtime.md`
4. `specs/tech_docs/third_party_providers.md`
5. `specs/tech_docs/search_architecture.md`
6. `specs/tech_docs/pit_of_success.md`
7. 当前代码重点：
   - `src/renderer/App.tsx` 的 `handleLaunchProject` runtime-backed provider birth
   - `src/renderer/api/sessionClient.ts::createSession`
   - `src/renderer/utils/providerSwitchSessionBirth.ts::buildRuntimeBackedInitialSessionBirth`
   - `src/server/index.ts` 的 `GET /sessions` / `POST /sessions`
   - `src/server/SessionStore.ts`
   - `src/server/types/session.ts::SessionMetadata`
   - `src/server/agent-session.ts::ensureSessionMetadataForSdkSystemInit` / `materializeInitialPromptSessionMetadata` / first-message lazy materialization / `materializePendingDesktopSession`
   - `src/server/runtimes/external-session.ts::ensureExternalSessionMetadataForRealUserTurn` / `persistUserMessageBeforeRuntimeDispatch` / `pendingExternalSessionBirth`
   - `src/server/session-engine/builtin-adapter.ts` / `external-adapter.ts`
   - `src-tauri/src/sidecar/runtime_identity.rs` / `session_lifecycle.rs`
   - `src-tauri/src/session_metadata.rs`
   - `src-tauri/src/search/session_indexer.rs` / `search/watcher.rs`

本文引用符号名和文件路径，不依赖行号。实现时以当前代码为准，尤其注意并发中的未提交改动，不要回滚用户已有 worktree 变化。

## 背景与用户意志

用户观察到一个很具体的体验退化：

- 只要点击工作区打开一个新 chat tab，即使没有发送任何 query，历史记录里也会出现一个空 session。
- 如果误点几次，历史记录里会堆出很多空的 `New Chat`。
- 用户记得旧行为是“只有发送 query 后，session 才真实出现在历史记录里”。
- 用户想恢复这个用户感知，但不希望用一层 UI 补丁遮住架构问题；需要考虑历史兼容、多 runtime 链路，并尽量一次到位。

用户要的不是“永远不要提前创建任何 session metadata”。真实意志是：

> 工作区空打开可以有运行时需要的草稿状态，但历史记录是用户对话资产列表，只有发生过真实用户 query 的会话才应该进去。

## 调查结论

### 什么时候引入

直接导致“空 Launcher workspace open 也创建真实 metadata 行”的变更是：

- `4439a22d86247f06ec4d80b162c72a76c656411b`
- 时间：`2026-06-27 23:54:44 +0800`
- 标题：`feat(codex): treat subscription as a managed provider runtime`

它的前置变更是：

- `5d871e8764bc9c44258a277d5c61d2fb19a52502`
- 时间：`2026-06-27 02:37:19 +0800`
- 标题：`feat: add managed codex subscription provider`

前置提交把 Managed Codex subscription Provider 和 runtime-backed metadata 链路搭起来；后续 `4439a22d` 把“Provider 选择”投影到 session/task/IM/channel birth，并在 `App.tsx` 明确覆盖了“empty Launcher opens whose current Provider is Codex (订阅)”。

### 为什么这么改

Codex 订阅在用户界面里要像普通 Provider 一样被选择，但执行时不是 builtin Claude Agent SDK Provider，而是 `codex` external runtime，并且 source 是 `managed-provider`，不是用户自己装的 `codex/system-cli`。

Rust 在 spawn sidecar 前必须从 `sessions.json` 读到这些出生事实：

- `runtime:'codex'`
- `runtimeSource:'managed-provider'`
- `providerExecutionIdentity`
- model / permission / MCP / plugin / official tool snapshot

否则会发生两类错误：

- Rust 按 builtin 或 `codex/system-cli` 启动，导致 wrong binary / wrong auth / wrong `CODEX_HOME`。
- 后续 restore、history open、runtime drift 检查只看到 `runtime:'codex'`，无法区分 managed Codex 和用户系统 Codex CLI。

所以早建 metadata 的目的本身是正确的。问题在于：`POST /sessions` 创建的是普通可见 metadata 行，而 `GET /sessions` / Rust `cmd_list_session_metadata` 只过滤 `materializationState:'prepared'`，没有把“还没收到用户 query 的 runtime birth”当作隐藏草稿。

### 当前代码事实

已验证的 ground truth：

- `src/renderer/App.tsx`：普通新 session 使用 `pending-{tabId}`，由首条消息 materialize；runtime-backed provider 则在 `ensureSessionSidecar` 前调用 `createSession(...)` 生成真实 UUID metadata。
- `src/server/index.ts::GET /sessions`：只过滤 `session.materializationState !== 'prepared'`，再 normalize/redact。
- `src-tauri/src/session_metadata.rs::redact_session_metadata`：同样只隐藏 `materializationState:'prepared'`。
- `src/server/types/session.ts::SessionStats.messageCount` 注释为 user messages / queries 数量。`SessionStore.calculateSessionStats` 只按 `role === 'user'` 计数。
- `src/server/types/session.ts::SessionMetadata.materializationState?: 'prepared'` 已存在，注释是“Prepared sessions are hidden from history until commit clears this marker”。
- `src/server/agent-session.ts::materializePendingDesktopSession` 已经用 `prepared` 做 pending -> real 的两阶段隐藏行，并且 commit/rollback 有 ownership guard。
- `src/server/runtimes/external-session.ts` 已有 `pendingExternalSessionBirth`：external runtime pre-warm 可先创建 runtime thread，首条真实 user turn 再创建 metadata。
- `src-tauri/src/search/session_indexer.rs` 当前没有跳过 `materializationState:'prepared'`，会给 metadata title 建索引。这是本需求必须一并修掉的历史可见性漏洞。

## 产品目标

P0 成功后的用户感知：

1. 点击工作区、打开空 tab、Managed Codex pre-warm、启动 runtime，都不会在历史列表里新增可见空 session。
2. 用户发送第一条真实 query 后，该 session 立即成为历史记录项，标题来自第一条用户消息，runtime identity 与 Provider snapshot 保持正确。
3. 误点多次工作区不会污染历史记录、Launcher 最近会话、历史搜索。
4. 已经由旧版本产生的 Managed Codex 空 session 行被兼容处理，不继续污染用户历史。
5. 当前打开的空 tab 可以继续存在；“tab 恢复”和“历史列表可见”不是同一个概念。

## 本期范围

### P0 做什么

1. **保留 runtime-backed provider 的早建 metadata**，但把它创建成 `materializationState:'prepared'` 的隐藏草稿。
2. **把首条真实用户 query 定义为提交边界**：提交时清除 `materializationState` / `materializationSourceSessionId`，更新默认标题，保留 runtime/source/provider identity。
3. **统一 builtin 与 external runtime 的提交逻辑**：不要让 system-init、pre-warm、config sync、runtime thread start 误提交。
4. **修正所有历史可见入口**：Node `/sessions`、Rust `cmd_list_session_metadata`、Launcher/History 下游、Rust search index。
5. **兼容老数据**：对已存在的 Managed Codex 空 birth 行做保守隐藏或迁移，不能误隐藏有真实消息、收藏、定时任务、IM/Agent、用户命名或自动化来源 session。
6. **补测试**：以 storage/materialization helper 为核心，覆盖 renderer launch、server routes、builtin/external 首轮提交、Rust list/search、legacy fixture。

### 明确不做什么

1. 不回滚 `4439a22d` 的 runtime-backed provider birth 设计。
2. 不用 `stats.messageCount > 0` 在 `SessionHistoryDropdown` / Launcher 组件里零散过滤。这会重复逻辑，并且挡不住 Rust list、search、其它消费者。
3. 不新增持久字段 `historyVisibility`。P0 存储语义复用既有 `materializationState:'prepared'`。
4. 不把“关闭 tab 后删除零消息 session”作为主正确性路径。它只能是隐藏草稿后的 best-effort GC。
5. 不改变 IM / Agent Channel / Cron / Task 的 session 出生模型。这些 owner 可能有零 user query 但仍有运行状态或自动化语义。
6. 不把 external runtime 的所有 pre-warm 都强行写入 `sessions.json`。现有 `pendingExternalSessionBirth` 已经是正确的窄状态。

## 状态模型

本需求只引入一个产品语义，不引入新的持久概念：

| 状态 | 存储表示 | 历史列表 | 直接按 id 恢复 | 典型来源 |
| --- | --- | --- | --- | --- |
| Pending placeholder | `pending-{tabId}`，无 metadata | 不显示 | 当前 tab 内部使用 | builtin 普通空 tab |
| Prepared draft | UUID metadata + `materializationState:'prepared'` | 不显示 | 可以 | runtime-backed provider 空打开、两阶段 pending materialization |
| Committed session | UUID metadata，无 `materializationState` | 显示 | 可以 | 首条真实用户 query 后 |

关键边界：

- metadata 存在不等于历史可见。
- runtime identity 可以在 prepared draft 上提前存在。
- 历史可见的提交事件必须是“真实用户 query 被接收并即将持久化”，不是 sidecar ready、SDK system_init、Codex thread/start、MCP config sync。

## 核心方案

### 1. Runtime-backed empty birth 创建为 prepared

`App.tsx` 的 runtime-backed provider birth 仍然要在 `ensureSessionSidecar` 前调用 `createSession(...)`，否则 Rust 没法正确选择 `codex/managed-provider`。

但这次创建必须带隐藏草稿语义：

- 存储层最终写入 `materializationState:'prepared'`。
- `materializationSourceSessionId` 用于诊断来源。建议使用原本的 `pending-{tabId}` 或一个明确的 source string，但不要让 rollback ownership 误以为它属于 `materializePendingDesktopSession` 的 pending transaction。
- `origin` 仍按当前 `originFromDesktopSurface(...)` 写入，便于 analytics 和兼容判断。

HTTP/renderer API 命名可以由实现者选择，但持久化结果必须复用 `materializationState:'prepared'`。建议不要把 raw storage field 扩散成组件级业务判断，可以采用窄参数：

```ts
createSession(agentDir, runtime, {
  ...birth.opts,
  origin,
  prepareForFirstUserMessage: true,
})
```

服务端 `POST /sessions` 收到该参数后校验：

- 只允许 desktop owned session birth 使用。
- runtime-backed managed provider path 必须继续校验 managed Codex readiness。
- 写盘时转换成 `materializationState:'prepared'`，不新增持久字段。

### 2. 首条真实 user turn 提交 prepared

新增或复用一个 `SessionStore` 级 helper，避免 builtin/external 各写一份提交逻辑。建议形态：

```ts
commitPreparedSessionForFirstUserTurn(sessionId, {
  messageText,
  runtimeSessionId,
  origin,
})
```

语义：

- 如果 metadata 不存在：返回 null 或让调用方走既有 lazy materialization。
- 如果 metadata 存在且不是 `prepared`：只按既有逻辑更新默认标题 / origin，不改变可见性。
- 如果 metadata 是 `prepared`：
  - 清除 `materializationState`。
  - 清除 `materializationSourceSessionId`。
  - 如果 `title === 'New Chat'`，用 `deriveSessionTitle(messageText, 40)` 更新标题。
  - 如果传入 `runtimeSessionId` 且不同，原子 patch。
  - 保留 `runtime`、`runtimeSource`、`providerExecutionIdentity`、`providerId`、`model`、permission、MCP、plugins、official tools。
  - 更新 `lastActiveAt`。
  - 用 `updateSessionMetadata` 的 CAS/precondition 在 sessions lock 内提交。

这个 helper 是本需求的 pit-of-success：以后任何 runtime 只要遇到 prepared metadata，都调用它，而不是手写“清 prepared + 改 title”。

### 3. Builtin runtime 链路

需要审计并调整这些路径：

- `agent-session.ts` first-message lazy materialization：如果 `existingMeta.materializationState === 'prepared'`，必须调用提交 helper，而不是只更新标题。
- `materializeInitialPromptSessionMetadata`：如果 metadata 已存在且是 `prepared`，用 initial prompt 提交，而不是直接 return。
- `ensureSessionMetadataForSdkSystemInit`：system-init 只能补 `sdkSessionId` / `unifiedSession`，不能因为 SDK 初始化就清除 prepared。只有真正 user message 可以提交 prepared。
- `materializePendingDesktopSession`：保持现有两阶段 prepare/commit 语义。它有 ownership guard，不应把 runtime-backed birth prepared row 当成自己的 rollback target。

### 4. External runtime 链路

`external-session.ts::ensureExternalSessionMetadataForRealUserTurn` 是 external runtime 首条真实 user turn 的统一入口，应改为：

- 若 existing metadata 是 prepared：调用提交 helper。
- 若 existing metadata 非 prepared：保留当前 “patch pendingBirth.runtimeSessionId then return” 逻辑。
- 若 metadata 不存在：保留当前 pending birth / metadataBirthPending / fresh-start authority 逻辑。
- 提交时必须继续 patch `runtimeSessionId`，否则 Codex/Gemini/Claude Code restore 会丢 runtime 自己的 thread/session id。

不要在 route 层新增 builtin/external 分支。所有新增 route-facing 行为仍走 `SessionEngine` facade 或 runtime public facade 的现有入口。

### 5. 历史列表与 Launcher 最近会话

历史可见性应该在数据边界处理，而不是 UI 组件补丁：

- Node `/sessions` 继续过滤 `materializationState:'prepared'`。
- Rust `cmd_list_session_metadata` 继续过滤 `materializationState:'prepared'`。
- `SessionHistoryDropdown`、Launcher right rail、Task Center 等消费方不新增 `messageCount` 本地过滤。

兼容老数据时，如果需要临时 predicate，也必须放在 Node/Rust list 的数据边界，不能散落到组件。

### 6. Search 索引必须同样隐藏 prepared

搜索是历史可见性的一部分，不能漏掉。

`src-tauri/src/search/session_indexer.rs` 需要满足：

- `index_all_sessions` 跳过 prepared sessions。
- `index_single_session` 遇到 prepared metadata 时，删除该 session 的 title doc 和 message docs，然后 return。
- `update_session_title_only` 遇到 prepared metadata 时，删除 title doc，不重新 add。
- prepared -> committed 后，sessions.json watcher 或后续 message append 能重新写入 title/message docs。
- committed -> delete 或 prepared cleanup 后，索引中不能留下旧 title doc。

搜索结果端可以额外 fail-closed：如果查询时能廉价拿到当前 metadata 且发现 prepared，过滤掉结果。但主修复必须在 indexer，不能只在 UI 结果层隐藏。

## 历史兼容策略

### 要兼容什么

从 2026-06-27 的 `4439a22d` 到本 PRD 落地之间，用户本机可能已经有一批这样的 visible metadata：

- `runtime:'codex'`
- `runtimeSource:'managed-provider'`
- `providerExecutionIdentity.kind:'runtime-backed-provider'`
- `providerId:'codex-sub'`
- `title:'New Chat'`
- `stats.messageCount` 缺失或为 0
- 没有 JSONL user messages
- 来源是 desktop workspace open
- 没有收藏、cron、IM、agent-channel 等用户或自动化语义

这些就是本 bug 的遗留空行。

### 保守判定

实现时应创建一个明确命名的兼容 predicate，例如：

```ts
isLegacyPreQueryManagedCodexDraft(meta, messageProbe)
```

判定必须保守，至少满足：

- metadata 不是 prepared。
- 是 Managed Codex runtime-backed birth：`providerExecutionIdentity.kind === 'runtime-backed-provider'`，或 `runtime === 'codex' && runtimeSource === 'managed-provider' && providerId === 'codex-sub'`。
- desktop/unknown desktop origin；不能是 IM、agent-channel、registeredAgent、cron、task、automation。
- 没有真实 user messages。不要只信 `stats.messageCount`，迁移时应检查 JSONL/legacy session file 是否确实没有 user message。
- 标题仍是默认空标题：`title === 'New Chat'` 且没有 `titleSource:'user'`。
- 没有 `favorite:true`。
- 没有 `cronTaskId`。
- 没有 `lastMessagePreview`、`lastContextUsage`、明显的 assistant/user transcript usage。

不满足这些条件时，宁可保留可见，也不要误隐藏用户资产。

### 迁移还是过滤

优先级：

1. **最佳**：一次性迁移，把符合 predicate 的 legacy 行标记为 `materializationState:'prepared'`，之后 Node/Rust/list/search 都走现有 prepared 语义。
2. 如果迁移需要跨 Node/Rust 竞争写 `sessions.json`，必须使用同一个锁：Node `SessionStore` 使用 `~/.myagents/sessions.lock`；Rust 如写盘必须用 `utils::file_lock::with_file_lock_blocking` 锁同一路径。禁止无锁读改写 `sessions.json`。
3. 如果无法安全地在 Rust early list 前完成迁移，则 Node list、Rust list、Rust search 必须在数据边界共享同一份概念 predicate 的镜像实现。不要把兼容逻辑下沉到 React 组件。

迁移应只隐藏，不删除。删除留给 GC。

## 多 runtime 行为矩阵

| 链路 | 当前问题 | P0 行为 |
| --- | --- | --- |
| Desktop builtin 普通 Provider | 空 tab 用 `pending-{tabId}`，通常没有 visible metadata | 保持现状；首条 user message lazy materialize 并显示 |
| Desktop Managed Codex Provider (`codex/managed-provider`) | 空打开会提前 `POST /sessions`，现在可见 | 提前 metadata 保留，但标记 prepared；首条 user message 提交 |
| Desktop Codex/Gemini system-cli external runtime | `pendingExternalSessionBirth` 已经把 pre-warm birth 保存在内存，首条 turn 才 metadata | 保持现状；如果未来遇到 prepared metadata，也由 external helper 提交 |
| Claude Code external runtime | per-turn 进程，通常首条消息时 materialize | 保持现状；prepared metadata 不应被 system init 或 resume 误提交 |
| IM / Agent Channel live-follow | session 绑定 peer/runtime identity，消息配置 live resolve | 不按 zero-message 隐藏；不做 legacy draft 迁移 |
| Cron / Task / BackgroundCompletion | 可能没有桌面 user query，但有自动化语义 | 不受本需求影响；自动化历史显隐继续走现有 automation toggle |
| Tab restore | persisted open tabs 可能指向 real UUID | direct `/sessions/:id` 和 `cmd_can_restore_session` 允许 prepared；历史列表仍隐藏 |
| Search | 当前可能索引 prepared 或 legacy 空标题 | prepared 和 legacy draft 不可搜索；提交后可搜索 |

## 关于关闭 tab 删除和 TTL 清理

这个机制可行，但不能作为主方案。

原因：

- 关闭 tab 是 UI 生命周期事件，不是 session 语义边界。它可能和 background completion、sidecar release、SSE stop、open-tab persistence、app crash/restart 交错。
- “零消息”在外部 runtime 里不等于“没有 runtime thread”，Codex thread 可能已经存在但还没收到用户 turn。
- 如果依赖 close cleanup 来修历史，任何异常退出都会留下空行。

P0 正确性必须来自 prepared 隐藏态。之后可以加 best-effort GC：

- 关闭 tab 后，如果 session 仍是 `prepared`、desktop origin、无 user messages、无 active owner、无 in-flight turn，调用 `deleteSession(sessionId, precondition)` 删除。
- GC 不阻塞关闭交互，失败只打日志，因为 prepared 已经不可见。
- TTL cleanup 可清理很老的 prepared desktop drafts，例如 7 天以上，但必须跳过 active sidecar、open tab restore candidate、cron/IM/agent source。
- 删除必须使用 `SessionStore.deleteSession` 的 precondition，且在锁内再次确认 prepared + zero user messages。不要用裸文件删除。

GC 是磁盘卫生，不是历史体验正确性的来源。P0 可以不做 GC。

## 关键设计决策

### D1：不回退早建 metadata，只修历史可见性

早建 metadata 是 Managed Codex runtime identity 的架构需求。移除它会让 Rust spawn sidecar 时缺少 `runtimeSource:'managed-provider'` 和 `providerExecutionIdentity`，重新引入 wrong runtime/auth/CODEX_HOME 风险。正确修复是把 metadata birth 和 history commit 分离。

### D2：复用 `materializationState:'prepared'`

项目已有 prepared 语义、Node/Rust list 过滤、pending materialization commit/rollback。新需求正好是“metadata 存在但历史不可见”。新增 `historyVisibility` 会制造第二套状态机，后续更容易漂移。

### D3：首条真实 user query 才能提交

system-init、runtime thread start、pre-warm ready 都只是运行时生命周期，不代表用户产生了历史资产。提交边界必须放在 user message 被 runtime dispatch 前后的持久化路径，这样即使 assistant 失败，用户发出的 query 仍然是历史的一部分。

### D4：兼容老数据时宁可漏藏，不可误藏

历史记录是用户资产。老数据 predicate 只针对本次已知 bug 的 Managed Codex empty birth 形态。收藏、用户标题、cron、IM/Agent、已有 JSONL user message 都必须保留。

### D5：搜索属于历史可见性

如果历史列表隐藏了 prepared，但搜索还能搜出 `New Chat`，用户感知仍然坏。因此 indexer 必须理解 prepared，不接受仅在 React 搜索结果组件过滤。

### D6：关闭/TTL 清理是 GC，不是 correctness

删除策略很容易和 owner 生命周期、崩溃恢复、runtime thread id 交错。prepared 隐藏让用户体验先正确；GC 只负责减少磁盘草稿。

## 技术落点建议

建议新增或调整：

- `src/server/SessionStore.ts`
  - 新增 `commitPreparedSessionForFirstUserTurn(...)`。
  - 如做迁移，新增保守 legacy predicate 和 migration helper，全部写操作走 `withSessionsLock`。
- `src/server/index.ts`
  - `POST /sessions` 接受窄的 prepared-birth 参数，写入 `materializationState:'prepared'`。
  - `GET /sessions` 继续只返回 history-visible sessions；如未做 migration，则在这里做兼容 predicate。
- `src/renderer/api/sessionClient.ts`
  - `createSession` 增加 prepared-birth 参数。
- `src/renderer/App.tsx`
  - runtime-backed provider birth 传 prepared-birth 参数。
  - 对应 `App.helperLaunch.test.tsx` 更新断言。
- `src/server/agent-session.ts`
  - first-message existingMeta branch 调用 commit helper。
  - `materializeInitialPromptSessionMetadata` 处理 existing prepared。
  - `ensureSessionMetadataForSdkSystemInit` 不再因 system_init 清 prepared。
- `src/server/runtimes/external-session.ts`
  - `ensureExternalSessionMetadataForRealUserTurn` existing prepared branch 调用 commit helper。
- `src-tauri/src/session_metadata.rs`
  - 保持 prepared 过滤。
  - 如迁移无法保证早于 Rust list，增加保守 legacy managed-Codex empty draft 过滤，并配测试。
- `src-tauri/src/search/session_indexer.rs`
  - index/refresh/title-only 路径跳过并清理 prepared docs。
- 文档
  - 更新 `specs/tech_docs/session_architecture.md`：说明 prepared 现在覆盖 runtime-backed pre-query draft，不只是 pending -> real materialization。
  - 如实现了 GC，补一段清理规则。

## 验收标准

### 端到端

1. 选择 Codex 订阅 Provider，点击同一工作区 3 次但不发消息：历史 dropdown、Launcher 最近会话、搜索都不出现 3 个空 `New Chat`。
2. 在其中一个空 tab 发送 `hello`：该 session 出现在历史里，标题来自 `hello`，metadata 保留 `runtime:'codex'`、`runtimeSource:'managed-provider'`、`providerExecutionIdentity`。
3. 发送首条消息后即使 assistant turn 失败，该 session 也应显示，因为用户 query 已存在。
4. 关闭一个未发消息的 prepared tab：历史仍不显示；如果 GC 未实现，磁盘可残留 prepared metadata；如果 GC 实现，删除必须满足 precondition。
5. 重启应用：prepared draft 不进入历史列表；如果 tab restore 恢复了仍打开的空 tab，不视为历史显示问题。
6. builtin 普通 Provider 空打开仍不创建可见历史；发送第一条消息后显示。
7. external system-cli Codex/Gemini/Claude Code 首条消息路径不回归。
8. IM / Agent / Cron session 不因 zero `messageCount` 被误隐藏。
9. 历史搜索搜不到 prepared/legacy draft 的 `New Chat`；提交后能搜到真实标题或消息。

### 自动化测试

至少覆盖：

- `SessionStore` helper unit：prepared commit、non-prepared no-op、title derivation、runtimeSessionId patch、CAS guard。
- `POST /sessions` route：prepared-birth 参数只写 `materializationState:'prepared'`，managed Codex readiness 校验不变。
- `App.helperLaunch.test.tsx`：Managed Codex empty workspace open 会传 prepared-birth 参数，并仍用返回的 real UUID ensure sidecar。
- builtin first-message：existing prepared metadata 清 prepared、更新 title；system_init 不清 prepared。
- external-session mock integration：existing prepared metadata + first user turn 清 prepared、保留 runtime/source/provider identity、patch runtimeSessionId。
- Rust `session_metadata.rs`：prepared 过滤；legacy managed-Codex empty draft 过滤或迁移 fixture；favorite/non-empty/cron 不过滤。
- Rust search indexer：prepared session 不建 title doc；prepared -> committed 后重新可搜索；prepared 删除后无残留 doc。
- legacy compatibility：旧 visible Managed Codex empty rows 被隐藏/迁移；已有 user JSONL、favorite、cron、IM/Agent fixture 不受影响。

## 风险与应对

| 风险 | 应对 |
| --- | --- |
| system_init 误清 prepared，空 tab 又进历史 | 明确改 `ensureSessionMetadataForSdkSystemInit`：只补 SDK id，不提交 visibility |
| first user turn 提交和 message append 顺序 race | 提交 helper 用 sessions lock + CAS；external 已有 `persistUserMessageBeforeRuntimeDispatch`，builtin first-message path 同步 await |
| legacy 迁移误隐藏用户资产 | predicate 保守，检查真实 JSONL user messages，排除 favorite/user title/cron/IM/agent/automation |
| Rust list 在 Node 迁移前仍显示老空行 | 迁移要么在 Rust 早期安全完成，要么 Rust list/search 有同等兼容 predicate |
| prepared metadata 被 pending materialization rollback 误删 | rollback 仍要求 `materializationSourceSessionId === prepared.priorSessionId`；runtime-backed draft source 不应伪装成该 transaction |
| 搜索索引残留 prepared title doc | indexer 遇 prepared 必须 delete existing docs before return |
| close/TTL GC 删除正在首轮发送的 session | GC 只删 prepared + zero user messages + no owner/in-flight，并用 `deleteSession` precondition；GC 非 P0 |

## 开放问题

1. prepared draft 是否要在 tab persistence 里恢复？本 PRD 倾向“可以”：它是打开 tab 状态，不是历史列表。实现时若产品判断不希望恢复空 draft tab，需要另写明确规则，但不要影响历史可见性。
2. legacy migration 是一次性写盘还是长期兼容 predicate？优先写盘迁移；如果跨进程锁和启动时序成本过高，允许保留数据边界 predicate。
3. 是否实现 P1 GC？P0 不要求。若实现，建议 TTL 取 7 天以上，且 close-tab cleanup 只做 best-effort。

## 附录：代码地图与命令

调研命令参考：

```bash
git show --no-patch --format='%H%n%ci%n%s%n%b' 4439a22d
git show --no-patch --format='%H%n%ci%n%s%n%b' 5d871e87
rg -n "materializationState|prepared|createSession\\(|runtimeSource|providerExecutionIdentity" src src-tauri specs/tech_docs
rg -n "cmd_list_session_metadata|index_single_session|ensureExternalSessionMetadataForRealUserTurn|ensureSessionMetadataForSdkSystemInit" src src-tauri
```

建议验证命令：

```bash
npm run test:unit
npm run test:integration
npm run test:dom
npm run typecheck
npm run lint
```

如果只跑 targeted tests，也必须说明没跑全量的原因和剩余风险。

## 执行台账

### 开发契约（动第一行代码前写完）

- 必赢场景：Managed Codex Provider 空打开工作区会提前创建 runtime identity metadata，但该 session 在历史列表、Launcher 最近会话和 session 搜索中不可见；发送首条真实 user query 后清除 prepared、生成标题并进入历史，同时保留 `runtime:'codex'`、`runtimeSource:'managed-provider'` 与 `providerExecutionIdentity`。已有旧版本 Managed Codex 空 `New Chat` 行被保守隐藏或迁移，非空/收藏/cron/IM/Agent 不误伤。
- 复用的既有抽象：`SessionMetadata.materializationState:'prepared'`、`materializationSourceSessionId`、`SessionStore.updateSessionMetadata`/`deleteSession` 锁内 CAS、`createSessionMetadata`/`createSession`、`agent-session.ts` first-message lazy materialization、`external-session.ts::ensureExternalSessionMetadataForRealUserTurn`、`pendingExternalSessionBirth`、Rust `cmd_list_session_metadata` prepared 过滤、Rust `SessionIndex` watcher/indexer。
- 反向边界：不回退 Managed Codex runtime-backed birth；不新增 `historyVisibility`；不在 React history/list/search 组件里用 `messageCount > 0` 零散过滤；不改变 IM/Agent/Cron/Task session 出生语义；不把 close-tab 删除或 TTL cleanup 作为 P0 correctness。
- 新概念清单：无新的持久概念。只新增窄 API 参数表达“本次 session birth 先作为 first-user-message 前的 prepared draft”，落盘仍是既有 `materializationState:'prepared'`。
- 触及的红线：Session ID / 存储 / 状态同步必须遵守 `session_architecture.md`；Multi-Agent Runtime route-facing 行为不能绕过 `SessionEngine` 分流边界；runtime identity 必须比较并保存 `runtime + runtimeSource`；写 `sessions.json` 必须走既有锁；Rust 可能阻塞的 IO 必须在 async command 的 blocking 区执行；搜索索引 schema/写入必须遵守 `search_architecture.md`，不做 UI-only filter。

### 行动清单

- [x] 新增/调整 SessionStore prepared commit 与 legacy empty Managed Codex draft 判定/迁移能力。
- [x] 让 runtime-backed empty workspace birth 写入 prepared，并更新 renderer/server API 类型与测试。
- [x] 修正 builtin 首条 user message / initial prompt / system_init 的 prepared 提交边界。
- [x] 修正 external runtime 首条 user turn 的 prepared 提交边界与 runtimeSessionId patch。
- [x] 修正 Rust session list 与 search indexer 对 prepared/legacy draft 的隐藏与清理。
- [x] 更新 session 架构文档，补齐 targeted tests。
- [x] 运行验证、修复问题、做符合性检查与 review/提交。

### 待用户决策

无阻塞决策。`prepared` tab 是否参与 tab restore 与 P1 GC 是否落地，本期按 PRD 决策：tab restore 可保留，GC 非 P0。

### 进展日志

- 2026-07-06：已重读 PRD、`ARCHITECTURE.md`、`session_architecture.md`、`multi_agent_runtime.md`、`third_party_providers.md`、`search_architecture.md`、`pit_of_success.md` 的相关约束；确认 root fix 是复用 prepared 状态分离 metadata birth 与 history visibility。
- 2026-07-06：已实现 runtime-backed provider prepared birth、首条 user turn commit helper、builtin/external prepared commit 边界、Node/Rust list 统一可见性、Rust search index 清理、legacy Managed Codex 空行保守隐藏；损坏消息文件按 fail-open 保持可见，避免误隐藏历史资产。
- 2026-07-06：验证已通过 `npx vitest run --project integration src/server/__tests__/session-prequery-draft.integration.test.ts`、`npx vitest run --project dom src/renderer/App.helperLaunch.test.tsx`、`npx vitest run --project unit src/server/__tests__/session-materialization-rollback.unit.test.ts`、`npx vitest run --project unit src/renderer/api/__tests__/sessionClient.test.ts`、`cargo test session_visibility`、`cargo test search::`、`npm run typecheck`、`npm run test:classification`、相关文件 `npx eslint ... --max-warnings=0`。`cargo clippy --tests -- -D warnings` 被仓库既有 140+ 个非本次文件 Clippy warning 阻塞，未发现本次新增 Rust 文件相关 warning。
- 2026-07-06：cross-review-code 三路 review 后补修：Rust `read_to_string` 非 NotFound 错误 fail-open；Rust search 查询端按当前 `sessions.json` 过滤 stale hidden docs；hidden full reindex 不再推进 offset，避免 prepared->committed 后只刷新 title 不索引既有 JSONL；builtin/external 首 query 改为 user JSONL durable append 成功后再清 prepared；`POST /sessions` 复用 runtime-backed identity validator；新增 Rust search 回归覆盖 prepared hidden/commit、stale hidden 查询兜底、legacy draft 清 stale docs。
- 2026-07-06：最终验证补充通过 `cargo fmt --check`、`cargo test session_visibility`、`cargo test search::session_indexer`、`npm run lint`。`npm run lint` 中 depcruise 仍报告仓库既有 `src/renderer/constants/chatSuggestions.ts` no-orphans warning，但命令退出码为 0。
