---
type: prd
status: implemented
created: 2026-07-06
updated: 2026-07-06
scope: "修正 Agent workspace 绑定多个 IM channel 时 heartbeat/cron 主动投递的目标解析：仍然只选择一个最近活跃目标，不向多个 bot 广播；但目标必须是该 Agent 下当前有效的 private peer session。Heartbeat 不投 group，不在选中 channel 后重新猜 session，不让 heartbeat 自己污染最近活跃判断。"
issue: 用户反馈 WeChat bot channel 连接工作区并开启 HEARTBEAT 后，heartbeat 经常发到老 session，而不是当前 WeChat bot 持有的有效会话；需求讨论收敛为“Agent 只选一个最近活跃 channel/session，但 HB 只能投 private，且必须投到当前有效 private session”
research: ""
review: "cross-reviewed：三路 review 均确认核心方向正确；已修复 review 发现的 cron delivery bot-id side path、manual wake targetless path、Agent wake send failure liveness、LastActiveChannel group/offline fallback、wake coalescing target metadata 风险。"
---

# IM Heartbeat Private Target Routing PRD（0.2.49）

> **执行须知（给空 session 的你）**：本 PRD 自带完整 context，按顺序执行不需要回头翻聊天记录。
> - 每次会话只自动加载 `CLAUDE.md`。本需求触及 Agent Channel、IM Router、Heartbeat、Cron delivery、Session restore，必须主动 Read：`specs/ARCHITECTURE.md`、`specs/tech_docs/im_integration_architecture.md`、`specs/tech_docs/session_architecture.md`、`specs/tech_docs/task_provider_routing.md`。
> - 先 grep 真实符号，不要凭记忆改：`src-tauri/src/im/types.rs::WakeReason`、`src-tauri/src/im/types.rs::LastActiveChannel`、`src-tauri/src/im/config_store.rs::resolve_target_channel`、`src-tauri/src/im/heartbeat.rs::HeartbeatRunner::run_once`、`src-tauri/src/im/router.rs::SessionRouter::find_any_peer_session`、`src-tauri/src/im/router.rs::SessionRouter::touch_session_activity`、`src-tauri/src/im/agent_channel.rs` 写入 `LastActiveChannel` 的路径、`src-tauri/src/im/handover.rs` 写入 `LastActiveChannel` 的路径、`src-tauri/src/cron_task/delivery.rs::deliver_cron_result_to_bot`。
> - 本 PRD 引用符号名而非行号，因为这些文件变动频繁。行号对不上时，用符号名和路径搜索。
> - 本期不是要重做 IM session 模型，也不是要让 heartbeat 发给所有 bot；本期只把已有“Agent 级仲裁一个主动投递目标”的语义修到正确 owner 和正确 session 上。

## 背景与产品定位

用户反馈的场景是：

```text
一个 Agent workspace
  绑定多个 bot/channel
    - 一个 WeChat bot
    - 一个 Feishu bot
    - 甚至多个 Feishu bot

开启 HEARTBEAT 后：
  期望：HB 只发给最近活跃且可接收 HB 的 private 会话
  实际：HB 经常发进老 session，不在当前 WeChat bot 持有的有效 session 里
```

用户补充的产品判断很明确：

1. **HB 不应该挨个 bot 都发。** Agent workspace 绑定多个 channel 时，主动消息只能选一个目标，避免同一条系统提醒在多个 IM 里重复出现。
2. **“最近活跃”的前提是它能真实投递。** 不能只选最近活跃 channel，然后在这个 channel 内随便找一个 peer session；用户最终必须在那个有效会话里收到 AI 信息。
3. **HB 只向 private 发送。** group 可以是 IM 对话入口，但 heartbeat 不投 group。没有有效 private target 时，本轮 heartbeat 应该跳过，而不是为了“尽量发出去”改投 group 或历史 private。

一句话定位：**Agent heartbeat 的仲裁单位不是 channel，而是当前有效的 private peer session；channel 只是这个 private session 所属的 bot/channel。**

## 已验证的技术事实

当前代码里已经有“最近活跃 channel”的状态：

- `LastActiveChannel { channel_id, session_key, last_active_at }` 位于 `src-tauri/src/im/types.rs::LastActiveChannel`，注释写着用于 heartbeat/cron routing。
- Agent Channel 普通消息结束时会写 `LastActiveChannel`。
- Handover 时也会写 `LastActiveChannel`。

但 Agent heartbeat 实际消费时丢掉了 session：

- `src-tauri/src/im/config_store.rs::resolve_target_channel` 只返回 `Option<String>`，也就是 `channel_id`。
- Agent heartbeat loop 调 `resolve_target_channel` 后，只把 `WakeReason` 发给该 channel 的 per-bot `heartbeat_wake_tx`。
- `src-tauri/src/im/heartbeat.rs::HeartbeatRunner::run_once` 收到 wake 后，会重新调用 `SessionRouter::find_any_peer_session()`。
- `find_any_peer_session()` 当前只过滤 private，然后取 `last_active` 最大的 peer session。它不知道 Agent 层刚刚选中的 “当前 session” 是谁。
- `HeartbeatRunner::run_once` 之后还会调用 `touch_session_activity(&session_key)`。如果它选错了老 session，这一步会把老 session 刷成最新，形成自我强化。

所以 bug 的根因不是 WeChat 插件把消息发错，也不是 Node `/api/im/heartbeat` endpoint，也不是 Claude SDK。根因是 **Agent 层的路由决策只保留了 channel，没有把目标 session 作为一等公民传到 per-bot heartbeat runner**。

## 引入历史

这个问题不是最近 2026-07-05 `92049ded fix(im): recover stale peer session bindings` 引入的。那个修复负责在恢复 / wakeup / reset 前校验 cached peer session 是否仍存在于 SessionStore，不负责选择 heartbeat 应投给哪个 peer。

更准确的历史脉络：

- 2026-02-20 `1ba9ef78 fix: heartbeat & cron use ensure_sidecar to survive idle collection` 引入了 heartbeat/cron 可从 router 找 peer session 并 `ensure_sidecar` 的基础能力，解决 idle collection 后主动消息不可达的问题。
- 2026-05-10 `48b24fb7 feat(session): surface tags + handover from desktop to IM channel` 之后，IM channel session / handover 有了更明确的“当前会话”产品语义。
- 2026-06-21 `597e0a17 refactor(tauri): turn sidecar cron and im giants into owners` 把 Agent-level heartbeat 和 `LastActiveChannel` routing 固化到 `config_store.rs`，但 resolver 只返回 `channel_id`，没有保留 `session_key`。
- 2026-06-28 `7b90e48a fix: stabilize openclaw weixin im routing` 让 WeChat/OpenClaw 的 session 稳定性问题更容易被用户感知；它不是根因，但 WeChat 历史 session 并存会放大这个 bug。

## 本期范围

### 做什么

1. **把 Agent heartbeat 的目标从 channel 升级为 private session target**

   新目标语义：

   ```rust
   HeartbeatTarget {
       channel_id: String,
       session_key: String,
   }
   ```

   这个 `session_key` 必须指向当前 Agent 绑定 channel 中仍有效的 `ImSourceType::Private` peer session。

2. **Agent 层一次性完成目标仲裁**

   Agent workspace 绑定多个 channel 时，只在 Agent heartbeat loop 里选一次目标。选出来的是完整 `HeartbeatTarget`，不是 channel hint。

3. **per-bot heartbeat runner 不再猜 Agent 主动投递目标**

   Agent heartbeat 委托 per-bot runner 时，必须携带 `target_session_key`。runner 只负责校验和投递，不再用 `find_any_peer_session()` 替 Agent 猜目标。

4. **HB private-only**

   Heartbeat 只能投 private peer session。当前活跃入口是 group 时，group 不能成为 HB target。

5. **cron completion 复用同一目标语义**

   Cron completion 当前通过 `pending_cron_events` + wake heartbeat 进入同一条主动投递链路。本期必须保证 cron completion 不因为复用 heartbeat runner 而重新掉回“选 channel 后猜 session”的旧行为。

6. **避免 heartbeat 污染用户活跃目标**

   用户消息、private handover 等真实用户行为可以更新 heartbeat target；heartbeat 自己的系统维护流量不能把错误 session 刷成新的“最近活跃用户入口”。

### 不做什么

- 不让 heartbeat 向多个 bot/channel 广播。
- 不让 heartbeat 投 group。
- 不扫描 `sessions.json` 猜“最新微信 session”。
- 不自动合并 WeChat/OpenClaw 历史 session 碎片。
- 不把 session 映射逻辑塞进 Plugin Bridge。
- 不给 `/api/im/heartbeat` 加 retry/cache/guard 来掩盖上游路由错位。
- 不重写 IM Pipeline v2、SessionStore 或 Sidecar Owner 模型。

## 核心设计

### 1. 区分通用最近活跃入口和 HB private target

`LastActiveChannel` 当前会被普通消息和 handover 写入。它是“最近活跃 IM 入口”的通用状态，但它可能指向 group。因为 HB 只投 private，本期不要继续把 `LastActiveChannel` 原样当 heartbeat target。

建议新增一个 private-only 状态，名字可按实现落地调整：

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastActivePrivateTarget {
    pub channel_id: String,
    pub session_key: String,
    pub last_active_at: String,
}
```

落点建议：

- `AgentConfigRust` 增加 `last_active_private_target: Option<LastActivePrivateTarget>`，带 `#[serde(default)]`。
- `AgentInstance` 增加共享 `Arc<RwLock<Option<LastActivePrivateTarget>>>`，和现有 `last_active_channel` 类似。
- private 用户消息处理成功后，同时更新 `LastActiveChannel` 和 `LastActivePrivateTarget`。
- group 消息只更新 `LastActiveChannel`，不更新 `LastActivePrivateTarget`。
- private handover 成功后更新 `LastActivePrivateTarget`；group handover 不更新。

这样不会把 `LastActiveChannel` 的通用语义改坏，也不会让 group 活跃把 heartbeat 推向 group 或历史 private。

### 2. 目标有效性的定义

一个 `HeartbeatTarget` 只有同时满足以下条件才有效：

```text
channel_id 属于当前 Agent 绑定 channels
channel enabled / running
channel health status == Online
router 仍持有 session_key 对应的 peer session
peer session source_type == Private
peer session 没有被 SessionStore stale binding 校验判定为不可用
```

注意：有效不等于 sidecar 当前活着。Sidecar 可以 idle-collected；后续继续走现有 `prepare_ensure_sidecar` / `create_sidecar_blocking` / `commit_ensure_sidecar` 链路唤醒。

### 3. Resolver 输出完整 target

替换或旁路现有 `resolve_target_channel`，引入 private target resolver。名称可调整，但语义必须稳定：

```rust
pub(super) fn resolve_heartbeat_target(
    agent: &AgentInstance,
    channel_snapshots: &[ChannelHeartbeatSnapshot],
) -> Option<HeartbeatTarget>
```

推荐优先级：

1. 如果 `last_active_private_target` 存在，并且通过目标有效性校验，返回它。
2. 如果 explicit private target 存在但已经 stale，不要改投别的 session；清理或忽略该 target，本轮跳过。避免“当前 private target 失效后发到另一个老 session”。
3. 如果没有 private target（老配置 / 首次启动），先看 `LastActiveChannel`：
   - `LastActiveChannel.session_key` 仍存在且是 private：可把它迁移为 private target。
   - `LastActiveChannel.session_key` 仍存在但属于 group：本轮跳过。group 活跃不能触发 HB，也不能 fallback 到历史 private。
   - 没有 `LastActiveChannel` 或它已经完全不可解析：才允许从当前 routers 的 private peer sessions 中选最近活跃的有效 private session，作为兼容 bootstrapping fallback，并写回 `last_active_private_target`。
4. 如果没有任何有效 private session，返回 `None`，本轮 heartbeat 跳过。

实现时优先在 `SessionRouter` 增加 domain helper，而不是让 Agent resolver 解析 status DTO 字符串：

```rust
fn get_private_peer_session_target(&self, session_key: &str) -> Option<HeartbeatPeerTarget>;
fn latest_private_peer_session_target(&self) -> Option<HeartbeatPeerTarget>;
```

`ImActiveSession.last_active` 是 status display DTO 的 RFC3339 字符串；能不用它做核心排序就不要用。Router 内部的 `PeerSession` 才是该领域的状态权威。

### 4. Wake payload 携带 target_session_key

当前 `WakeReason` 是：

```rust
pub enum WakeReason {
    Interval,
    CronComplete { task_id: String, summary: String },
    Manual,
}
```

本期不要把 target 塞进日志字段里。建议新增 wake envelope：

```rust
pub struct HeartbeatWake {
    pub reason: WakeReason,
    pub target_session_key: Option<String>,
}
```

然后把 channel 中的：

```rust
mpsc::Sender<WakeReason>
```

升级为：

```rust
mpsc::Sender<HeartbeatWake>
```

语义：

- Agent heartbeat 委托 per-bot runner：必须带 `Some(target_session_key)`。
- Agent cron completion 委托 per-bot runner：必须带同一个 private target。
- 老的单 bot / 手动 wake / interval 路径如果没有 Agent target，可以传 `None`，保留 legacy private-most-recent fallback。

如果实现者认为改动面过大，也可以让 `WakeReason` variant 携带 `target_session_key`，但不推荐把目标混进 `CronComplete` 的业务 payload。Envelope 更清楚。

### 5. HeartbeatRunner 只消费目标，不反向决定目标

`HeartbeatRunner::run_once` 新语义：

```text
if wake.target_session_key.is_some():
  只查这个 session_key
  必须是 Private
  不存在 / 非 Private / stale -> skip + structured log
  不 fallback 到 find_any_peer_session()

else:
  legacy 路径才允许 latest private fallback
```

也就是说，`find_any_peer_session()` 只能作为没有 explicit target 的 legacy fallback，不能再服务 Agent-level heartbeat。

`touch_session_activity` 也要收紧：

- 可以继续用于防 idle collection，但不能把 heartbeat 的系统流量写回 `LastActivePrivateTarget`。
- 如果本期发现 `touch_session_activity` 会影响 resolver 的 fallback 排序，必须避免 Agent explicit target 路径依赖这个被 heartbeat 改写的时间。private target 的权威更新时间应来自用户 private 消息 / private handover。

### 6. Cron completion 的目标继承

`src-tauri/src/cron_task/delivery.rs::deliver_cron_result_to_bot` 当前把 cron result append 到 `ImBotInstance.pending_cron_events`，然后发送 `WakeReason::CronComplete`。实际发送给哪个 peer session，仍由 per-bot heartbeat runner 决定。

本期需要把 cron 的目标语义改为：

```text
cron result 要通过 Agent 当前有效 private target 投递
不是通过 bot_id 后再猜一个 peer session
```

实现路径可以是：

- 在 Agent-level cron delivery 调用侧先解析 `HeartbeatTarget`，把 `target_session_key` 放进 wake envelope。
- 或者让 `deliver_cron_result_to_bot` 的入参携带已解析的 private target。

无论采用哪种方式，`pending_cron_events` 仍是 payload truth source，不要把 cron body 塞进 wake reason。wake reason 只用于优先级、日志和调度。

如果 cron result 到达时没有有效 private target：

- 不投 group。
- 不改投历史 private。
- pending event 可以保留，等待后续 private target 出现后的下一次 heartbeat/manual wake 再 drain。
- 必须打结构化日志，便于用户排查“为什么 cron 结果没有 IM 推送”。

## 关键设计决策

### D1. 只选一个目标，不广播

Agent workspace 绑定多个 bot/channel 是常态。HB 是主动系统消息，如果每个 bot 都发，会把同一条 AI 信息重复推给用户。保留单目标仲裁，符合原始产品意图。

### D2. HB target 必须是 private session，不是 channel

channel 只说明“用哪个 bot 发”；用户真正收到消息的地方是 peer session。只返回 `channel_id` 会把正确目标丢掉，导致 per-bot runner 重新猜。

### D3. group 不参与 HB 投递

用户明确修正：HB 只向 private 里发送。group 活跃不能让 HB 发到 group，也不能迫使系统改投一个不相关的老 private session。

### D4. 不把 `LastActiveChannel` 改成 private-only

`LastActiveChannel` 可能还有普通“最近活跃入口”用途，直接改成 private-only 会破坏它的通用含义。新增 private-only target 状态更清楚，也避免 group 和 private 的语义互相污染。

### D5. explicit target stale 时跳过，不 fallback

如果 Agent 层已经有明确 private target，但 runner 执行时发现它不存在或非 private，说明状态已经漂移。此时改投其他 private session 就是用户反馈的错误形态。正确行为是跳过并记录日志。

### D6. 不绕过现有 `ensure_sidecar`

目标解析只决定投给哪个 peer session；sidecar 是否存活、metadata 是否 stale、runtime identity 是否 drift，仍走现有 router/session 机制处理。不要复制 SessionStore 校验逻辑。

### D7. heartbeat 不是用户活跃行为

用户消息和 handover 才能改变“用户当前有效 private target”。Heartbeat 是系统维护流量，不能因为自己跑了一次就把某个 session 刷成新的用户活跃入口。

## 技术地基

### 复用的现有机制

- Agent channel 状态：`AgentInstance.channels`、`ChannelInstance.bot_instance`。
- IM router peer session：`src-tauri/src/im/router.rs::SessionRouter`。
- Sidecar 唤醒：`prepare_ensure_sidecar` / `create_sidecar_blocking` / `commit_ensure_sidecar`。
- Runtime drift 校验：`check_and_reset_on_runtime_identity_drift`。
- Cron pending payload：`ImBotInstance.pending_cron_events` / `PendingCronEvent`。
- 统一日志：Rust 必须继续使用 `ulog_*` 宏。

### 需要小心的红线

- Rust 不要裸 `tokio::spawn`；沿用 `tauri::async_runtime::spawn`。
- Rust localhost HTTP client 继续使用 `crate::local_http::builder()`。
- 新增 `CronTask` 或 config 持久字段必须带 `#[serde(default)]`。
- 不要在持锁状态下做阻塞 sidecar create 或 HTTP call；沿用现有 clone-then-drop-lock 模式。
- 不要引入新的跨进程通信模式；Agent heartbeat 仍是 Rust owner 内部调度。

## 详细实现建议

### Phase 1：类型和状态

1. 在 `src-tauri/src/im/types.rs` 新增 `LastActivePrivateTarget` 和 `HeartbeatWake`。
2. `AgentConfigRust` 增加 `last_active_private_target`，带 serde default。
3. `AgentInstance` 增加共享 `last_active_private_target`。
4. Agent auto-start / manual start / config restore 时，把磁盘配置里的 private target 初始化到 shared Arc。
5. persist agent config 时把 private target 写回磁盘，遵守现有 config lock 规则。

### Phase 2：写入 private target

1. 在 Agent Channel 处理普通用户消息的路径里，判断 `source_type == ImSourceType::Private` 时写 `LastActivePrivateTarget`。
2. group 消息仍可写 `LastActiveChannel`，但不能写 private target。
3. handover 成功路径同理：private handover 写 private target；group handover 不写。

### Phase 3：Router helper

在 `SessionRouter` 增加 target 查询 helper：

```rust
pub fn get_private_peer_session_target(&self, session_key: &str) -> Option<HeartbeatPeerTarget>;
pub fn latest_private_peer_session_target(&self) -> Option<HeartbeatPeerTarget>;
```

`HeartbeatPeerTarget` 至少包含：

```rust
session_key
source
source_id
last_active
```

`source` / `source_id` 要与当前 `find_any_peer_session()` 返回值语义一致，因为 `HeartbeatRequest` 仍需要它们。

### Phase 4：Agent resolver

把 Agent heartbeat loop 中的目标解析改为：

```text
clone channel refs + shared private target Arc
drop ManagedAgents lock
读取每个 channel health/router/wake_tx
读取 private target snapshot + last active channel snapshot
resolve HeartbeatTarget
向 target channel 的 wake_tx 发送 HeartbeatWake { reason, target_session_key: Some(...) }
```

避免现在 `resolve_target_channel()` 内部 `try_read(last_active_channel)` 的模式。Agent heartbeat loop 已经是 async，可以 `read().await` 快照；不要因为锁竞争静默丢 target。

### Phase 5：HeartbeatRunner 消费 explicit target

`HeartbeatRunner::run_once` 签名从 `reason: WakeReason` 升级为 `wake: HeartbeatWake` 或等价形式。

目标选择逻辑：

```text
if explicit target_session_key:
  router.get_private_peer_session_target(key)
else:
  router.latest_private_peer_session_target()
```

explicit target 查不到时：

```text
log warn/debug with bot label, agent_id, target_session_key, reason
return true
```

不要 fallback。

### Phase 6：Cron delivery

把 cron completion wake 也改成 target-aware：

- `pending_cron_events` 保持原样。
- `WakeReason::CronComplete` 保持高优先级语义。
- wake envelope 携带 `target_session_key`。
- 没有 private target 时不投递，打日志，不把 result append 到配置里的旧 bot pending queue；结果仍保留在 cron 执行历史中。

## 测试计划

### Unit tests

1. `resolve_heartbeat_target`：Agent 绑定 WeChat + Feishu，WeChat 当前 private target 有效，即使 Feishu 有更老 active session，也返回 WeChat private target。
2. `resolve_heartbeat_target`：`LastActiveChannel` 指向 group，但 `LastActivePrivateTarget` 不存在，返回 `None`，不选 group，不选历史 private。
3. `resolve_heartbeat_target`：explicit private target stale，返回 `None` 或标记 stale skip，不 fallback 到另一个 private。
4. `resolve_heartbeat_target`：老配置没有 private target，但 router 里存在有效 private session，可 lazy fallback 并写回 private target。
5. `HeartbeatRunner::run_once`：wake 带 explicit target 时，只调用该 target；target 不存在时 skip，不调用 `find_any_peer_session()`。
6. `HeartbeatRunner::run_once`：wake 不带 target 时，legacy fallback 仍只选 private。

### Integration / boundary tests

1. Agent 绑定两个 channel，分别有 private peer session；用户最后在 channel B private 发消息，下一次 heartbeat 投 channel B 的 session。
2. 同一 WeChat bot 有历史 private session 和当前 private session；heartbeat 投当前 private，不投历史 private。
3. 当前最新消息来自 group；heartbeat 不投 group，也不因 group 活跃改投老 private。
4. cron completion 先解析同一个 private target，再 append 到目标 Channel 的 pending queue；target missing 时不入旧 bot queue，结果保留在 cron 执行历史并有日志。
5. heartbeat 运行后，不把 `LastActivePrivateTarget` 改写成 heartbeat 自己触碰过的 session。

## 验收标准

1. Agent workspace 绑定多个 bot 时，每次 HB 只产生一次主动投递。
2. HB 只投 private peer session。
3. 当前有效 private session 和历史 private session 并存时，HB 投当前有效 private session。
4. 当前活跃入口是 group 且没有有效 private target 时，HB 跳过，不投 group，不投老 private。
5. Cron completion 通过同一 private target 投递；无 target 时不投旧 bot queue，执行历史保留结果并有日志。
6. 现有单 bot legacy heartbeat 行为不退化：没有 explicit Agent target 的路径仍可用 latest private fallback。
7. 不新增 Plugin Bridge 映射、不扫描 sessions.json、不新增通信通道。

## 开放问题

1. `LastActivePrivateTarget` 的持久化写盘时机需要实现时对齐现有 Agent config 持久化 helper，避免在消息热路径频繁写盘造成额外 IO。可以先内存更新，沿用已有持久化节流/写入点；如果没有合适 helper，再补一个小的 agent state 持久化函数。
2. Cron result 在无 private target 时是否需要 UI 提示，不在本期扩展。本期决策是不要创建会被未来错误投递的 stale pending event；结果以 cron execution history 为准，日志必须清楚。
3. 老配置 lazy fallback 是否写回磁盘可以由实现决定；但 fallback 不能覆盖 explicit stale target 后改投别的 session。

## 附录：相关文件和符号

- `src-tauri/src/im/types.rs::LastActiveChannel`
- `src-tauri/src/im/types.rs::WakeReason`
- `src-tauri/src/im/state.rs::AgentInstance`
- `src-tauri/src/im/config_store.rs::resolve_target_channel`
- `src-tauri/src/im/config_store.rs::schedule_agent_auto_start`
- `src-tauri/src/im/commands.rs` 中 Agent heartbeat loop 的同构路径
- `src-tauri/src/im/heartbeat.rs::HeartbeatRunner`
- `src-tauri/src/im/router.rs::SessionRouter::find_any_peer_session`
- `src-tauri/src/im/router.rs::SessionRouter::touch_session_activity`
- `src-tauri/src/im/agent_channel.rs` 的 Agent Channel 消息处理和 `LastActiveChannel` 写入路径
- `src-tauri/src/im/handover.rs` 的 handover target 写入路径
- `src-tauri/src/cron_task/delivery.rs::deliver_cron_result_to_bot`
- `specs/tech_docs/im_integration_architecture.md`
- `specs/tech_docs/session_architecture.md`
- `specs/tech_docs/task_provider_routing.md`

## 执行台账

### 开发契约（动第一行代码前写完）

- 必赢场景：Agent workspace 绑定多个 IM channel 时，heartbeat/cron 主动投递仍只选一个目标；目标必须是当前有效 private peer session。当前 private 与历史 private 并存时投当前 private；当前活跃入口是 group 且没有 private target 时跳过，不投 group、不投老 private；单 bot legacy 路径仍能用 latest private fallback。
- 复用的既有抽象：`AgentInstance.channels` / `ChannelInstance.bot_instance`、`SessionRouter` peer session 映射、`prepare_ensure_sidecar` / `create_sidecar_blocking` / `commit_ensure_sidecar`、`WakeReason` heartbeat priority、`pending_cron_events` 作为 cron payload truth source、`LastActiveChannel` 作为通用最近活跃入口、`health::persist_router_active_sessions` 作为 router health snapshot 持久化。
- 反向边界：不向多个 bot 广播；不投 group；不扫描 `sessions.json` 猜目标；不自动合并 WeChat/OpenClaw 历史 session；不改 Plugin Bridge 映射；不新增通信模式；不重写 Sidecar Owner / SessionStore / IM Pipeline v2。
- 新概念清单：`LastActivePrivateTarget`（必要：`LastActiveChannel` 可指向 group，HB 需要 private-only 权威目标）、`HeartbeatWake` envelope（必要：保留 `WakeReason` 业务/优先级语义，同时把 target session 作为调度元数据传给 runner）、`HeartbeatTarget` / `HeartbeatPeerTarget` helper（必要：把 channel+session 的完整目标从 Agent resolver 一路传到 runner）。
- 触及的红线：Rust 日志必须用 `ulog_*`；localhost HTTP 继续用 `crate::local_http::builder()`；新增 config 字段带 `#[serde(default)]`；不在持锁状态下做 sidecar create 或 HTTP；spawn 继续用 `tauri::async_runtime::spawn`；IM / Agent Channel runtime identity 和 `ensure_sidecar` 现有流程不能绕过。

### 行动清单

- [x] Phase 1：新增 private target / wake envelope 类型与 Agent runtime state，完成 config restore / in-memory 更新路径。
- [x] Phase 2：在 private 用户消息和 private handover 路径写入 `LastActivePrivateTarget`，group 只更新 `LastActiveChannel`。
- [x] Phase 3：给 `SessionRouter` 增加 private peer target helper，避免 Agent resolver 解析 display DTO 字符串。
- [x] Phase 4：把 Agent heartbeat resolver 从 `channel_id` 升级为完整 private `HeartbeatTarget`，并携带 target wake per-bot runner。
- [x] Phase 5：让 `HeartbeatRunner` 消费 explicit target；explicit target missing / non-private 时 skip，不 fallback。
- [x] Phase 6：cron completion 先解析 Agent private target，再 append 到目标 Channel pending queue；无 target 时不入旧 queue。
- [x] Phase 7：补 Rust 单测覆盖 resolver、group skip、stale explicit skip、legacy fallback、router private helper。
- [x] Phase 8：静态验证、构建/测试、需求符合性检查、cross-review、提交。

### 待用户决策

无。

### 进展日志

- 2026-07-06：已读 PRD、`ARCHITECTURE.md`、`im_integration_architecture.md`、`session_architecture.md`、`task_provider_routing.md`；确认本期 root-fix 是把 Agent 主动投递目标从 channel 提升为 private peer session。
- 2026-07-06：完成实现：`LastActivePrivateTarget` / `HeartbeatWake` / Agent private target resolver / per-bot explicit target runner / cron + manual wake target-aware routing / 架构文档同步。
- 2026-07-06：cross-review 三路完成；修复 cron delivery 仍按 `delivery.bot_id` 入队、manual wake 不带 target、Agent wake send failure 会停 loop、LAC group/offline fallback、wake coalescing 丢 target metadata 等问题。
- 2026-07-06：验证通过：`cargo test --manifest-path src-tauri/Cargo.toml --locked heartbeat_target_ -- --nocapture`、`cargo test --manifest-path src-tauri/Cargo.toml --locked heartbeat_private_target_helper_rejects_group_session -- --nocapture`、`cargo check --manifest-path src-tauri/Cargo.toml --locked`、`cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D clippy::disallowed_methods -D clippy::disallowed_macros`、`cargo build --manifest-path src-tauri/Cargo.toml --locked`、`npm run typecheck`、`npm run lint`、`npm run test:changed`。
