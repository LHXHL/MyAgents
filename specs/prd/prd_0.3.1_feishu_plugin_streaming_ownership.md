---
type: prd
status: implemented
created: 2026-07-16
updated: 2026-07-16
scope: "修复 OpenClaw 官方飞书插件流式回复退化，并把 Plugin Bridge 的回复所有权收口到终局架构：插件配置保持真实 JSON 类型；Sidecar / turn producer 拥有 canonical ReplyPayload；OpenClaw 插件 dispatcher / replyOptions 成为渠道渲染、CardKit 生命周期与节奏的唯一 owner；Bridge 只做 requestId 关联、事件转运与有界相邻 partial 合并，不从 block 历史重建 final；Rust 不再根据凭据或 channel capability 猜单次请求的 reply protocol；删除 Bridge 内自建的飞书流式卡片实现。覆盖 streaming=true/false、同群并发、长回复、多文本块、失败/取消与升级迁移，不改变模型生成语义、Sidecar Session、原生飞书适配器或其它 IM 渠道的渲染语义。"
issue: "用户反馈飞书 Bot 最近呈现 0.1 倍速式打字：每次只跳少量字符并停顿，模型早已结束后卡片仍需约 25 秒才收尾。外部 AI 曾归因于 OpenClaw v2026.7.1 回归，但本机实际运行 @larksuite/openclaw-lark@2026.6.10 + openclaw@2026.6.28-shim；本 PRD 以本地代码、配置、插件源码和 31 份 unified log 重建真实根因。"
research: "specs/research/0315_feishu_bot_doc.md；飞书 CardKit 流式更新官方文档 https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview；本 PRD §2 为 2026-07-16 本地代码/运行日志/已安装插件源码 RCA；另以同级 openclaw/ main@7c4ab782（@openclaw/feishu@2026.6.9）做 fresh-context 官方源码对照。"
review: "根因由主会话、同级 openclaw 官方源码审计与已安装 Lark 插件源码交叉核验。实现后 requirements / adversarial / architecture 三镜全部 PASS。所有有效 finding 已在根 owner 上修复，不采用关闭流式、后缀 payload、Bridge 限速/重试、功能开关或版本特判。真实飞书凭据 5K smoke 保留为 release acceptance，未伪装成 CI 证据。"
---

# PRD 0.3.1：飞书 OpenClaw 插件流式回复所有权归位

## 0. 执行须知（给空 session 的你）

本 PRD 自带产品意志、根因证据与技术终态，可以独立驱动实现。动手前必须完成以下读取与核验：

1. 读 `CLAUDE.md`、`specs/ARCHITECTURE.md`。
2. 读：
   - `specs/tech_docs/im_integration_architecture.md`
   - `specs/tech_docs/plugin_bridge_architecture.md`
   - `specs/DESIGN.md`（只涉及 OpenClaw 配置表单的布尔开关与字段样式）
3. 先读真实外部实现，禁止凭印象补 OpenClaw ABI：
   - 当前安装目录中 `@larksuite/openclaw-lark` 的 `src/card/reply-dispatcher.js`、`src/card/streaming-card-controller.js`、`src/messaging/inbound/dispatch.js`；
   - 同级 `../openclaw` 已核验基线中的 `src/auto-reply/reply/reply-dispatcher.ts`、`src/auto-reply/dispatch-dispatcher.ts`、`src/auto-reply/reply/dispatch-from-config.ts`；
   - 同级 `../openclaw/extensions/feishu/src/reply-dispatcher.ts` 与 `streaming-card.ts`；
   - 飞书 CardKit 流式更新官方文档，确认 payload、sequence、频率与收尾语义。
4. 从以下现有符号追链路，不要按文件名猜行为：
   - `createCompatRuntime`
   - `createReplyDispatcherWithTyping`
   - `dispatchReplyFromConfig`
   - `registerPendingDispatch`
   - `getPendingDispatch`
   - `/capabilities`、`/start-stream`、`/stream-chunk`、`/finalize-stream`、`/abort-stream`
   - `BridgeAdapter::sync_capabilities`
   - `ImStreamAdapter::start_stream`
   - `ReplyRouter::dispatch_streaming`
   - `handle_bridge_message`
   - `persist_agent_config_read_heal`
   - `ChannelWizard::buildOpenclawConfig`
   - `OpenClawConfigEditor`
5. 当前 App 版本是 `0.3.0`，目标开发线是 `0.3.1`。修改 SDK shim 时必须同步 bump：
   - `src/server/plugin-bridge/sdk-shim/package.json`
   - `src/server/plugin-bridge/compat-runtime.ts` 中兼容版本常量
   - `src-tauri/src/im/bridge.rs::SHIM_COMPAT_VERSION`
6. `src/server/plugin-bridge/sdk-shim/plugin-sdk/reply-runtime.js` 已列入 `_handwritten.json`。若新增其它手写 shim 文件，也必须同步登记；不得直接修改 auto-generated 区块。
7. 本需求不授权顺手重构 Sidecar、Session、原生 `feishu.rs`、Telegram、DingTalk AI Card 或整个 JSON Schema 表单系统。

实现时以符号名为准，行号会漂移。不得把本 PRD 中的示意伪代码机械复制进生产。

---

## 1. 一句话结论

这不是“飞书接口天生慢”，也不是当前机器升级到了 OpenClaw `v2026.7.1`。

真实问题是：**官方飞书插件原本应该拥有回复渲染，MyAgents 却因为配置类型错误与 dispatcher stub 绕过了插件，再由 Plugin Bridge 自建一套飞书 CardKit 流式；同时 Rust 每个 delta 都同步等待这套远端更新。渲染 owner 分裂后，完整累积文本被重复串行发送，远端延迟反向堵住模型事件消费。**

终局修复只有一条主线：

> 把渠道展示、CardKit 生命周期、全量文本合并与更新节奏完整归还给 OpenClaw 插件；Bridge 退回协议适配器，只负责类型正确的配置、按 requestId 关联，以及不阻塞上游的有序事件交付。

用户最终获得：

- `streaming: true` 时，由官方飞书插件正常流式；
- `streaming: false` 时，由同一插件一次性静态发送；
- 长回复不会在模型完成后继续慢吞吞补 20–30 秒；
- 同一群聊的并发请求不会互相覆盖或串内容；
- 后续插件升级只需适配 OpenClaw ABI，不再维护 MyAgents 私有飞书渲染器。

---

## 2. 已核验的真实根因

### 2.1 运行版本与外部 issue 不吻合

本机实际安装的是：

| 组件 | 实际版本 |
|---|---|
| 官方飞书/Lark Channel Plugin | `@larksuite/openclaw-lark@2026.6.10` |
| MyAgents 注入的 OpenClaw shim | `openclaw@2026.6.28-shim` |
| 用户配置中的渠道类型 | `openclaw:openclaw-lark` |

因此：

- `openclaw/openclaw#108265` 描述的 `v2026.7.1` 症状相似，但不是本机的直接版本根因；
- `openclaw/openclaw#91941` 对“全量累积 payload 会放大长回复成本”的描述可作为机制佐证，但不能代替本项目的本地 RCA；
- 方案不得以升级/降级某个猜测版本作为主修复。

### 2.2 配置在进入插件前已经丢失类型

当前持久化值是：

```json
{
  "openclawPluginConfig": {
    "streaming": "true"
  }
}
```

而官方插件使用严格判断：

```ts
feishuCfg.streaming === true
```

所以字符串 `"true"` 不会开启流式。代码根因不是用户填错，而是 MyAgents 自己把插件配置定义和编辑为 `Record<string, string>`：

- `ChannelConfig.openclawPluginConfig`
- `Agent` 侧同名类型
- `PromotedPlugin.defaultConfig`
- `ChannelWizard` 的 schema state 与 `buildOpenclawConfig`
- `OpenClawConfigEditor` 的所有输入写回

项目架构文档已写成 `Record<string, unknown>`，说明文档意图和生产代码发生了漂移。

### 2.3 官方插件 dispatcher 被 stub 掉

官方插件的正常路径是：

1. `createFeishuReplyDispatcher()` 调 OpenClaw runtime 的 `createReplyDispatcherWithTyping()`；
2. 得到真实 `dispatcher` 与 `replyOptions`；
3. 流式模式时，`replyOptions.onPartialReply` 交给 `StreamingCardController`；
4. `dispatcher.sendFinalReply()` 进入插件自己的 deliver queue；
5. 插件 `waitForIdle()`、`markFullyComplete()`、`markDispatchIdle()` 后关闭 CardKit 流式并写终态。

MyAgents 当前两处实现都不是这个契约：

- `compat-runtime.ts::createReplyDispatcherWithTyping` 返回 `_isStub`；
- `sdk-shim/plugin-sdk/reply-runtime.js::createReplyDispatcherWithTyping` 甚至没有返回上游要求的 `{ dispatcher, replyOptions, markDispatchIdle, ... }` 结构。

于是 `dispatchReplyFromConfig` 判定协议回调不可用，退到 bypass 路径。31 份日志中：

| 观测 | 次数 |
|---|---:|
| 官方插件判定 `effectiveReplyMode=static/useStreamingCards=false` | 300 |
| 官方插件真正进入 streaming | 0 |
| `dispatchReplyFromConfig PROTOCOL path` | 0 |
| compat fallback exit | 153 |
| MyAgents 本地 `[streaming] Started streaming` | 731 |

这组数据证明：用户看到的流式卡片不是官方插件创建的，而是 Bridge 私有 fallback 创建的。

### 2.4 `/capabilities` 把“有凭据”误报成“支持 CardKit 流式”

当前 `/capabilities` 只要看到 `appId + appSecret` 就返回：

```text
streaming=true
streamingCardKit=true
```

它没有检查：

- 该 inbound 是否已经拿到标准 dispatcher/replyOptions 并注册 request-scoped pending；
- `streaming` 配置到底是布尔 true 还是 false；
- `replyOptions.onPartialReply` 是否存在。

即使补查 `capabilities.blockStreaming` 也仍然错误：官方飞书插件没有声明该 capability，却完整支持标准 final/dispatcher；`blockStreaming` 只控制 logical block 投影，不代表整个 reply protocol。

Rust `BridgeAdapter::sync_capabilities` 信任这两个值，于是 `ReplyRouter` 选择 `dispatch_streaming`。这一步把“传输协议能力”和“渠道 UI 呈现能力”混成了一个概念。

### 2.5 Bridge 越权创建了第二套飞书 renderer

当 `/start-stream` 找不到 pending dispatcher，`index.ts` 会创建 `FeishuStreamingSession`。它是官方插件流式控制器的一份“简化本地复制”：

- Bridge 自己拿飞书 token；
- 自己创建 CardKit card；
- 自己更新完整累积文本；
- 自己决定 throttle、sequence、close；
- 官方插件则同时仍负责收消息、配置、静态发送与其它生命周期。

这就是根本的 owner split。它导致两套实现必然漂移：官方插件升级 pacing、终态、线程回复、fallback 或错误处理时，Bridge 私有复制不会自动获得这些修复。

### 2.6 远端 ACK 反向阻塞 Rust 的模型事件消费

当前链路是同步串行的：

```text
Sidecar delta
  → ImEventConsumer 持 ReplyRouter mutex
  → ReplyRouter 累加完整 block_text
  → BridgeAdapter::stream_chunk（loopback HTTP，await）
  → Plugin Bridge fallback session.update（飞书 CardKit PUT，await）
  → HTTP response
  → 才能消费下一个 Sidecar event
```

每个 delta 都发送完整累积文本。payload 越来越大，且每次必须等远端返回后才继续。模型产生事件的速度高于飞书更新完成速度时，事件在上游排队；`complete` 已经产生，也只能等前面所有更新跑完。

一条 2026-06-29 的 5086 字真实回复：

| 时刻 | 事件 |
|---|---|
| 16:11:47.528 | 首个 delta |
| 16:11:48.692 | Bridge 私有卡片开始 |
| 16:12:41.003 | 模型 `text_stop`，正文已完整 |
| 16:12:46.732 | turn final |
| 16:13:11.684 | Bridge 私有卡片才 close |

模型结束到卡片关闭仍约 25 秒，这正是用户看到的“0.1 倍速打字机”。

### 2.7 “只发新增后缀”不是通用正确修复

飞书 CardKit 的文本更新 API 接收的是当前完整 content，客户端自行按流式配置展示新增部分。官方插件也围绕完整快照、sequence 与终态卡片工作。

因此本项目不得在 Bridge 擅自把 full snapshot 改成 suffix-only：

- 会破坏 Markdown 上下文、表格、代码块与插件的合并逻辑；
- 把飞书协议知识继续留在错误 owner；
- 对其它 OpenClaw channel 不成立；
- 只是把一个私有 renderer 改成另一个私有 renderer。

### 2.8 同级 OpenClaw 官方源码对照

2026-07-16 由 fresh-context 只读子 Agent 审查同级官方仓库：

| 项 | 基线 |
|---|---|
| 仓库 | `../openclaw` |
| 分支 / commit | `main@7c4ab782cb83d7fbab567443feeb7ed179a4e8c3` |
| 根包 / 官方飞书包 | `2026.6.9` / `@openclaw/feishu@2026.6.9` |
| 工作区 | clean |

这个官方包不是当前 MyAgents 安装的 `@larksuite/openclaw-lark@2026.6.10`，因此必须同时保留 installed-plugin contract test，不能用任一侧的私有生命周期 API 替代另一侧。

官方对照得到四个可执行结论：

1. `createReplyDispatcher`、`createReplyDispatcherWithTyping`、`settleReplyDispatcher`、`withReplyDispatcher` 的完整实现和 contract 已存在；MyAgents 应按 MIT 许可适配这份真相源，而不是凭描述重写近似版。
2. 官方 `dispatchReplyFromConfig` 把 partial、logical block 和 final 当作三种不同语义；final 是 reply resolver 产出的原始 `ReplyPayload`，不是在 complete 时从历史 block 拼接出来。
3. MyAgents 的 `block-end` 是 SDK raw `content_block_stop`；官方 `sendBlockReply` 是经 block-streaming policy / chunker / coalescing 后真正决定外发的 logical block。两者不能直接等价。
4. 官方飞书插件已拥有 full snapshot 合并、pending latest text、timer throttle、串行远程 queue、final close、duplicate final、start backoff 与静态 fallback；Bridge 内任何对应逻辑都是重复 owner。

这次对照也纠正了本 PRD 早期草案的两个残留错位：

- 删除 Bridge 中的 `completedBlocks.join("\n\n")`；
- 删除“`capabilities.blockStreaming === true` 才支持 reply protocol”的推导。

---

## 3. 产品目标、成功标准与非目标

### 3.1 核心目标

1. 恢复用户配置的真实含义：布尔值必须以 JSON boolean 到达插件。
2. 恢复插件渲染所有权：MyAgents 不再直接实现飞书 CardKit 流式。
3. 模型事件消费与渠道网络延迟解耦：partial 被 Bridge 接受后立即释放 Rust；最终交付仍有明确 barrier。
4. 以现有 `requestId` 做唯一关联，支持同一 chat 的并发请求。
5. 保持 OpenClaw ABI 可维护：compat runtime 与 direct shim 共用一个 dispatcher 真相源。
6. 不引入第二套节流参数、fallback renderer、重试层或发布开关。

### 3.2 用户成功标准

- 开启流式后，首段内容能及时出现并持续平滑更新；
- 约 5K 字回复在模型完成后不再额外拖 20–30 秒；
- 关闭流式后，回复由官方插件一次性发送，不创建 MyAgents 私有流式卡片；
- 多轮、工具调用后多文本块、同群并发均不串内容、不提前结束、不重复最终消息；
- 飞书 API 短时变慢只影响该插件 dispatch 的交付，不阻塞其它 request 的 Sidecar 事件消费。

### 3.3 非目标

本期不做：

- 用 `channels.feishu.streaming=false` 作为正式修复；它只能是用户临时止痛手段；
- 修改模型 token 生成速度、Claude Agent SDK 或 Sidecar SSE 协议；
- 重写原生 `src-tauri/src/im/feishu.rs`；
- 给 CardKit 再加 MyAgents 私有 throttle、timer、token cache、retry/backoff；
- suffix-only payload；
- 为这个 bug 增加“旧/新流式实现”功能开关或长期双轨；
- 构建完整通用 JSON Schema form engine；本期只让当前插件配置表单正确处理已声明的顶层 scalar；
- 升级所有 OpenClaw 插件版本；版本升级可另做，但不能替代本修复；
- 改变 Telegram、DingTalk、原生飞书 adapter 的用户可见流式策略。

---

## 4. 终局 Owner 模型

### 4.1 唯一正确的数据流

```text
Renderer / config store
  typed openclawPluginConfig (boolean / number / string)
              │
              ▼
Plugin Bridge loads plugin + real OpenClaw reply dispatcher
              │ inbound message + requestId
              ▼
Rust IM pipeline / Sidecar
  owns request identity + canonical model event order + producer-owned ReplyPayload
              │ run start / cumulative partial snapshot / raw block barrier / canonical final / complete
              ▼
Plugin Bridge PendingDispatch
  owns correlation + ordered non-blocking handoff only
              │ plugin callbacks
              ▼
OpenClaw channel plugin
  owns render mode + CardKit + pacing + sequence + static fallback + finalization
              │
              ▼
Feishu / Lark
```

### 4.2 职责表

| Owner | 应拥有 | 明确不拥有 |
|---|---|---|
| Renderer + config store | 插件配置的真实 JSON 类型、编辑体验、历史坏值迁移 | 飞书 CardKit 规则 |
| Sidecar / turn producer | canonical final `ReplyPayload`、原始 payload 顺序与 terminal outcome；未来若有 logical block，也只有 producer 能显式决定 | 渠道渲染、Bridge 关联 |
| Rust IM pipeline | `requestId`、Sidecar event 顺序、当前 raw text block 累加、何时 turn complete | 从 block 历史重建 final、插件 UI 模式、远端 pacing |
| Plugin Bridge | OpenClaw ABI 适配、request/stream 关联、有序交付、partial 相邻合并、生命周期清理 | final 正文拼接、飞书 token/card/sequence/Markdown 渲染 |
| OpenClaw plugin dispatcher | reply queue、deliver、typing、partial/final callbacks、静态/流式选择 | MyAgents Session 与模型执行 |
| 飞书插件 controller | CardKit 创建、完整快照合并、更新节奏、终态、平台 fallback | request 路由 |

任何一份生产代码如果同时做“Bridge pending dispatch”和“飞书 CardKit 更新”，即说明 owner 又被拆开，应在 review 阶段直接拒绝。

---

## 5. 关键决策

### D1：删除 Bridge 私有 `FeishuStreamingSession`

删除 `src/server/plugin-bridge/streaming-adapter.ts` 及 `index.ts` 中所有本地 session map、凭据检查、token/card 创建、update/close fallback 分支。

`/start-stream` 找不到匹配的 plugin dispatch 时必须返回结构化协议错误并记录 `requestId/pluginId`，不能悄悄换 renderer。Fail loud 才能阻止未来 ABI 漂移被再次掩盖。

### D2：`openclawPluginConfig` 恢复为真实 JSON object

所有共享类型统一为：

```ts
openclawPluginConfig?: Record<string, unknown>
```

约束：

- 已是 boolean/number/string 的值原样保存；
- manifest schema 声明为 boolean/number 的顶层 scalar，表单以相应控件编辑并按相应类型写盘；
- promoted plugin 的 typed default 可作为 manifest 缺省时的显式类型证据；
- 未声明类型的自定义字段仍按字符串处理；
- object/array 不在本期自动猜测或字符串化；
- Bridge 不做 `"true" → true` 的兜底转换，错误必须在持久化入口被修掉。

### D3：历史坏值在 Rust 权威读盘路径一次性迁移

不能只在 renderer load 时修，因为 enabled channel 会在 UI 挂载前由 Rust 自动启动。

在 `src-tauri/src/im/config_store.rs` 的 raw `serde_json::Value` read-heal 管道中新增幂等迁移，并接入 `persist_agent_config_read_heal`：

- 精确匹配当前产品注册与官方 package manifest 共同使用的 `openclawPluginId === "openclaw-lark"`；
- 仅把 `openclawPluginConfig.streaming` 的精确字符串 `"true"` / `"false"` 转成 boolean；
- 同时覆盖 `agents[].channels[]` 与仍可能存在的 legacy `imBotConfigs[]`；
- 不猜其它 key，不把任意 `"1"`、`"yes"`、数字字符串转型；
- under config lock 持久化一次，日志只记录 channel id 与迁移数量，不记录配置值或 secret；
- 增加 idempotency 测试，第二次执行零 diff。

这是对已知历史错误形态的一次性数据修复，不是长期 Bridge coercion。

### D4：compat runtime 与 direct shim 共用真实 dispatcher 实现

`sdk-shim/plugin-sdk/reply-runtime.js` 从 stub 升级为 OpenClaw ABI 兼容实现；`compat-runtime.ts` 的 `runtime.channel.reply.createReplyDispatcherWithTyping` 必须委托给同一实现，禁止再复制一份。实现以 `../openclaw/src/auto-reply/reply/reply-dispatcher.ts` 与 `dispatch-dispatcher.ts` 为 MIT 真相源适配，在文件中保留来源/commit 说明；不凭本 PRD 的摘要自行重写算法。

最低契约必须与当前插件实际依赖一致：

- `createReplyDispatcher()` 返回 `sendToolResult`、`sendBlockReply`、`sendFinalReply`、`appendBeforeDeliver`、`markComplete`、`waitForIdle`、queued/failed/cancelled counts；
- deliver 串行、顺序稳定；
- `send*` 同步返回是否入队；
- deliver error 进入 `onError` 并记入 failed count，不会制造 unhandled rejection，也不中断后续 payload；
- `markComplete` 与 reservation 语义保证 `onIdle` 恰好在真正 drain 后触发；
- `createReplyDispatcherWithTyping()` 当前正式 ABI 返回 `{ dispatcher, replyOptions, markDispatchIdle, markRunComplete }`，`markRunComplete` 不是 optional；
- `replyOptions` 至少正确携带 `onReplyStart`、`onTypingController`、`onTypingCleanup`；
- deliver metadata 的 `kind` 正确为 `tool | block | final`。
- `settleReplyDispatcher` / `withReplyDispatcher` 严格按 `markComplete → waitForIdle → onSettled` 收口，不以 best-effort catch 吞掉 `run` 或 `onSettled` 异常。
- `sendFinalReply() === false` 表示 payload 在规范化阶段被过滤，不是远端 delivery failure。

OpenClaw core 没有 `markFullyComplete`；它是当前外部 `@larksuite/openclaw-lark` 的插件私有收尾 API。兼容层不得把它伪装成 core ABI，但 installed-plugin integration fixture 必须验证该插件的成功路径仍按 `waitForIdle → markFullyComplete → markDispatchIdle` 收尾。

不要求把 OpenClaw 整个 gateway registry 搬进 MyAgents；只实现插件 ABI 使用到的 dispatcher 语义，并用契约测试锁住。若对当前 ABI 有疑问，以当前安装插件和对应 OpenClaw 类型源码为准。

### D5：所有关联使用现有 `requestId`，禁止按 `chatId` 猜

当前 `pendingDispatches: Map<chatId, ...>` 会导致同一 chat 新请求把旧请求 reject 为 superseded。群聊、thread 和快速连续提问都可能触发。

新协议：

1. Plugin Bridge 在 POST 入站消息前生成 `requestId`；
2. `registerPendingDispatch(requestId, ...)` 先于 POST；
3. 只有当次实际拿到非 stub dispatcher 并完成 pending 注册时，POST `/api/im-bridge/message` 才携带自解释字面量 `deliveryProtocol: "openclaw-reply"`；
4. `/api/im-bridge/message` 接收并原样写入 `ImMessage.request_id` 与当次 delivery protocol；
5. Rust 只在 requestId 为空的 native/legacy 入站时生成新值，不覆盖 Bridge 已提供的值；
6. `ReplySlot` 继续以 requestId 为 key，并保存该 request 的 delivery protocol；路由依据是这个事实，不是 adapter 全局猜测；
7. 若保留现有 stream transport 形状，`start_stream` 带 requestId，Bridge 创建 `streamId → requestId` 绑定；chunk/block barrier 按 streamId，turn complete/abort 按 requestId；
8. chatId 只作为渠道发送地址，不再作为生命周期 identity。

不得新增第二个“dispatch id”。现有 requestId 已经是全链路 trace 与并发身份的唯一真相。

`deliveryProtocol` 是 per-request 的已发生事实，不是 channel capability。它不需要另一个 feature flag，也不能由 `appId/appSecret`、`streaming`、`blockStreaming` 或插件 id 推导。

### D6：Bridge 只保留单消费者、有序、相邻 partial 合并的交付队列

每个 pending request 维护一个小型有序 operation queue：

- `runStart`：在 Rust 接受并真正开始该 turn 时只执行一次 `onReplyStart`；它属于 model/typing lifecycle，不绑定首个句子边界或 `/start-stream`；
- `partial(streamId, fullSnapshot)`：如果队尾已经是同一 streamId 的 partial，则用最新完整快照替换队尾；
- `blockBoundary(streamId)`：不可合并、不可丢弃的排序 barrier；保证该 raw SDK text block 的最新 partial 先交给插件，并防止 partial 合并跨越 block；它不自动调用 `sendBlockReply`；
- `final(payload)`：不可合并的 barrier；逐个交付 producer-supplied canonical `ReplyPayload`，允许零个、一个或多个，不局限于 text；
- `complete(requestId)`：只是 turn terminal barrier；等待全部前序 callback 进入 dispatcher 后 resolve `dispatchReplyFromConfig`，不生成 payload、不猜换行、不拼历史 block；
- `abort(requestId, terminalPayload)`：封口、丢弃尚未执行的 replaceable partial，把 producer 提供的 user-safe cancel/error payload 作为 final 交付后走正常 complete/settle；不得用 reject completion 代替插件收尾。

队列只有一个 drain consumer，所以同一 request 的插件 progress callback 并发数恒为 1。相邻 partial 的替换只消除已经过期的累积快照；block barrier、canonical final 与 complete 永远不丢。

错误语义必须分层：

- 模型 error/cancelled：这是 producer terminal outcome，不是 transport exception；交付 canonical terminal final 后正常 settle；
- `onPartialReply` 等 progress callback 抛错：封口并尝试通过同一 dispatcher 交付 producer-safe error final，再正常 settle；setup/identity 尚未建立时才 fail fast；
- `send*() === false`：payload 被 dispatcher 规范化过滤，正常记录结果，不 reject；
- dispatcher `deliver` 远端失败：由官方 dispatcher 记 failed count、调 `onError` 并继续 drain，Bridge 不二次 reject；
- pending 自身的协议失败：统一 fail settle，不自动 retry，不切本地 renderer。

这不是第二套平台 throttle：

- Bridge 不设飞书毫秒间隔、不懂 CardKit QPS；
- 插件仍决定真正何时发远端请求；
- Bridge 只在跨进程边界实施 backpressure collapse，避免模型事件生产者等待远端 ACK。

### D7：HTTP 端点是“接受事件”边界，不是“远端已渲染”边界

`/stream-chunk`、block finish、turn complete 接到合法 operation 并入队后立即响应。Rust 等待的只是 loopback 接受，不等待飞书网络。

真正的远端交付完成仍由插件自己的生命周期保证：

1. producer-supplied canonical final payload（零个、一个或多个）按原顺序进入 `sendFinalReply`；
2. complete barrier 在前序 callback 已交给 dispatcher 后 resolve `dispatchReplyFromConfig`；
3. OpenClaw core `withReplyDispatcher` 负责 `markComplete() → waitForIdle() → onSettled()`；
4. 目标插件的已验证收尾链负责 typing 与 controller 终态：官方 `@openclaw/feishu` 依赖 core settle，当前外部 Lark 还有 `waitForIdle → markFullyComplete → markDispatchIdle`；
5. 插件 controller 最终 flush、关闭 streaming mode、写终态。

因此不会把“快 ACK”误当成“消息已送达”，也不会让 Rust 持锁等待平台网络。

### D8：reply protocol 是当次请求事实，不是 channel capability

删除凭据推导的 `streaming` / `streamingCardKit` 语义和 `BridgeAdapter.supports_cardkit`。也不得用 `capturedPlugin.raw.capabilities.blockStreaming` gate reply protocol：

- 当前官方 `@openclaw/feishu@2026.6.9` 并未在 channel capability 声明 `blockStreaming`，但完整支持 dispatcher final/static 协议；
- `blockStreaming` 是每次 dispatch 的内容投影策略，由 `replyOptions.disableBlockStreaming` 控制；
- partial/final dispatcher contract 与用户是否开启 block streaming 无关。

唯一权威判据是：**该 inbound 已经实际进入标准 `dispatchReplyFromConfig`，拿到真 dispatcher/replyOptions，并以 requestId 成功注册 pending dispatch。** 只有这时才在该次 POST 中写 `deliveryProtocol: "openclaw-reply"`。

`/capabilities` 若保留全局字段，最多可声明 `replyProtocolTransport: true`（当前 Bridge/shim 实现了该 transport），它不能用于选择某个 request 的 ReplyRouter 路径，也不表示插件已经对该次请求注册。

本期不新增 logical-block transport：当前 Sidecar 只有 raw `block-end`，所以它只形成 barrier。dispatcher 仍完整实现 `sendBlockReply` ABI；未来若 producer 真正产生 canonical logical block，应作为独立需求定义 event，而不是复用 `block-end`。

`streamMode: "cardkit"` 不再由 Rust 传给 Bridge，因为它属于插件 owner。插件收到 partial/final 后自行决定 streaming/static/card/text。

### D9：原子替换，不保留长期双轨

实现完成后：

- 删除本地飞书 renderer 与所有 fallback 分支；
- 删除 `_isStub` 判定与“如果协议不可用就 bypass 到本地 CardKit”的逻辑；
- 未实际进入标准 dispatch 的 legacy plugin 继续走既有 `sendText/editMessage` adapter 能力，不冒充 reply protocol；
- 没有新 feature flag；
- 没有旧实现隐藏开关；
- 回滚依靠版本回滚，不依靠生产双轨。

---

## 6. 详细技术方案

### 6.1 Typed plugin config

#### 6.1.1 类型单一真相

统一修改：

- `src/shared/types/im.ts::ChannelConfig`
- `src/shared/types/agent.ts::ChannelConfig`
- renderer 内所有相关 props/state/build function
- `PromotedPlugin.defaultConfig`

为 `Record<string, unknown>`。如两个 shared 类型存在重复声明，实施时优先消除重复或让它们引用同一导出，不能继续各写一份不同类型。

#### 6.1.2 表单行为

`ChannelWizard` 和 `OpenClawConfigEditor` 使用同一个纯函数做 scalar 读写：

| 显式类型证据 | UI | 写盘类型 |
|---|---|---|
| schema/default = boolean | 复用设计系统 Switch | boolean |
| schema/default = number/integer | number input；保存时校验 finite/integer | number |
| schema/default = string 或未知 | text/password input | string |
| enum | `CustomSelect`，禁止原生 `<select>` | enum 原始 scalar 类型 |

优先级：manifest schema > promoted typed default > 当前已是 scalar 的类型 > string fallback。

不要把 React input 的临时字符串 state 直接当 persisted config。parse/validation 发生在 save boundary，错误显示在字段旁，不启动带坏配置的 channel。

保存边界发送显式单字段 `set/delete` mutation，在 disk-first config transaction 内合并最新 Channel；不得由组件写回全量 plugin config 或旧 `channels[]` snapshot。这一 contract 必须跨 editor unmount/remount 成立，且同一视图内的 group activation、tool groups、allowlist 等其他 Channel 写入也必须基于 disk-latest per-channel patch。

#### 6.1.3 官方 Lark 默认值

promoted plugin 默认值必须是：

```ts
{ streaming: true }
```

而不是 `{ streaming: "true" }`。detail view 对历史已迁移值显示 Switch；用户关闭后落盘 `false`。

#### 6.1.4 Bridge ingress

`buildOpenClawConfig` 只做现有 canonical channel nesting，不做 scalar 猜测。它必须把已持久化的 JSON 值原样传给插件。

禁止日志打印整个 `openclawPluginConfig`，其中可能包含 secret。

### 6.2 Dispatcher compatibility primitive

采用 handwritten `reply-runtime.js` 作为纯 JS 真相源，原因是：

- 插件 direct import `openclaw/plugin-sdk/reply-runtime` 时可直接使用；
- Bridge TypeScript runtime 也可导入同一模块；
- 安装 shim 时不需要访问 MyAgents bundle 内部路径；
- `generate:sdk-shims` 不会覆盖 `_handwritten.json` 中已登记文件。

必须增加针对当前上游行为的 contract fixtures，而不是只断言“函数存在”。至少覆盖：

1. 三种 kind 的 deliver 顺序；
2. slow deliver 下 `waitForIdle` 真正等待；
3. deliver reject 后 `onError`、failed count、后续队列行为；
4. `markComplete` before/after enqueue；
5. 零 payload 时 idle；
6. typing controller 注入与 idle/cleanup；
7. `appendBeforeDeliver` 组合顺序与 cancelled count；
8. `withReplyDispatcher` 的 `markComplete → waitForIdle → onSettled` 顺序与异常传播；
9. installed Lark `createFeishuReplyDispatcher` 能拿到非 stub dispatcher 和 `onPartialReply`；
10. `markRunComplete` 与当前 core ABI 一致。

### 6.3 PendingDispatch 数据模型

状态语义固定如下；实现命名可服从现有代码风格：

```ts
type PendingDispatch = {
  requestId: string;
  chatId: string;             // destination metadata only
  dispatcher: ReplyDispatcher;
  replyOptions: PluginReplyOptions;
  streams: Set<string>;
  operations: DispatchOperation[];
  draining: boolean;
  sealed: boolean;
  settled: boolean;
  resolve(...): void;
  reject(error): void;
};
```

全局索引：

```text
pendingByRequestId: Map<requestId, PendingDispatch>
requestIdByStreamId: Map<streamId, requestId>
```

不再存在 `pendingByChatId`。

#### 6.3.1 operation 合并规则

只允许这一条合并：

```text
queue tail = partial(same streamId)
new op     = partial(same streamId)
=> replace tail payload with newest full snapshot
```

其它任何 pair 都不得合并。尤其：

- 不跨 stream/block 合并；
- 不丢 blockBoundary 或 final；
- 不丢 complete；
- 不用 timer 猜“最后一次”；
- 不按字符数、标点或平台 QPS 决定 flush。

#### 6.3.2 多 block 终态

Rust 的 `block-end` 不是 turn complete。Bridge 不能在第一个 block-end 就 resolve plugin dispatch。

协议必须明确区分：

- raw block boundary：封住当前 partial 合并区间，但不表示应发一条 block reply；
- final delivery：只传递 producer 提供的 canonical final `ReplyPayload[]`；
- turn terminal：等前序 operation 进入 dispatcher 后 settle，本身不产生正文。

本期没有 logical-block wire operation；`sendBlockReply` 只作为 OpenClaw dispatcher ABI 的完整能力接受 unit/contract test，不由 raw `block-end` 触发。

现有 `snapshotCurrentTurnTerminalOutcome()` 已在 Sidecar turn owner 内持有 canonical turn text。实现应将 IM terminal event 从空字符串升级为 typed producer payload（首期至少为 `{ finalPayloads: ReplyPayload[] }`），不应把拼接责任下沉到 Rust 或 Bridge。没有 final payload 时合法：complete 只 settle，插件可用已累积 preview 在 idle 收尾。

可以复用并扩展 `post_stream_cleanup` 为 request-scoped turn completion hook，也可以新增语义清楚的 adapter terminal method；不得继续用 chatId-only cleanup，也不得把第一个 `/finalize-stream` 当成整个 turn final。

### 6.4 Bridge ↔ Rust 协议

Bridge reply protocol 固定为：

```text
Plugin Bridge → POST /api/im-bridge/message
  { requestId, deliveryProtocol: "openclaw-reply", botId, pluginId, chatId, ... }

Rust → POST /start-dispatch
  { requestId }

Rust → POST /start-stream
  { requestId, chatId, initialContent }
  ← { streamId }

Rust → POST /stream-chunk
  { streamId, content: fullBlockSnapshot, sequence, isThinking }

Rust → POST /finish-stream-block
  { streamId }

Rust → POST /complete-dispatch
  { requestId, finalPayloads: canonicalProducerReplyPayloads }

Rust → POST /abort-dispatch
  { requestId, reason, terminalPayload: canonicalProducerCancelOrErrorPayload }
```

保留 `/start-stream`、`/stream-chunk`；用 `/finish-stream-block` 取代旧 `/finalize-stream` 的歧义语义，但它只是 raw block barrier，不再携带用于拼 final 的 `finalContent`；新增 `/start-dispatch`、`/complete-dispatch`、`/abort-dispatch`，并在所有调用方迁移后删除旧 `/finalize-stream`、`/abort-stream` route。`chatId` 可留作日志/防错 metadata，不能参与 lookup。

`finalPayloads` 是 Sidecar / turn producer 的 typed terminal output；Bridge 只逐个调用 `sendFinalReply`。它可为空数组，并为未来的 media-only、multiple final、independent error final 保留原始结构。首期如当前 IM bus 只投影 text，也必须由 Sidecar 从 canonical turn outcome 生成 `{ text }`，不能在下游 join block。

所有 loopback `fetch` 继续使用项目规定的 `cancellableFetch` / Rust `local_http` client；不新增裸 fetch。请求在 operation 被合法入队后即 ACK；progress/transport 错误由 pending terminal 回传，不通过同步 HTTP 把飞书延迟传回 Rust。dispatcher 内部 delivery 错误则由它自己的 failed count/onError 表达。

### 6.5 ReplyRouter 接线

对 Bridge reply protocol：

- 以 `ReplySlot.deliveryProtocol === "openclaw-reply"` 选择当次请求路径，不再用 `adapter.supports_streaming()` / `supports_cardkit` 推测；
- turn 开始时先发 request-scoped `runStart`，保证 `onReplyStart` 不依赖文本、标点或是否有 partial；
- `start_stream` 增加 requestId 上下文；
- delta 继续传当前 block 的完整累积文本，这是模型/块语义，不是 CardKit 规则；
- raw block-end 只调 block boundary barrier，不调 `sendBlockReply`、不终结 pending request；
- complete 将 typed canonical `finalPayloads` 原样转发后调 request-scoped terminal；error/cancelled 按已验证插件 contract 发 user-safe terminal payload/终止信号后 settle；
- terminal hook 参数必须包含 requestId，不能只含 chatId；
- Bridge loopback 接受完成后即可释放 `ReplyRouter` mutex；远端插件 drain 在 Node owner 内继续。

对原生 DingTalk/Telegram/Feishu 的既有行为保持不变。实现应用一个语义清楚的 per-slot delivery protocol 替代当前“streaming 布尔值同时代表 DingTalk AI Card 和 OpenClaw reply protocol”的混合；不得用 channel-specific `if Bridge` 散落在 `ReplyRouter` 状态机里。如 trait 签名需加入 requestId，其它 adapter 可以通过已有 delivery mode 走原路径。

### 6.6 能力与 fail-fast

全局 `/capabilities` 不再决定 reply protocol 路由。可选的 `replyProtocolTransport` 只能在 Bridge 当前 compat runtime 确实具备真 dispatcher/transport 时为 true，且仅用于 doctor/health；它与 `appId/appSecret`、`streaming`、`blockStreaming` 和平台 UI 无关。

当次路由只认 POST 中的 `deliveryProtocol: "openclaw-reply"`，而该字段只能在 pending dispatch 已以同一 requestId 成功注册后写入。

若某 request 标记为 `openclaw-reply` 但 Bridge 找不到同 requestId pending dispatch：

- 首个 `/start-dispatch` / `/start-stream` 返回明确的 `protocol_dispatch_missing`；
- 日志含 pluginId/requestId，不含正文/secret；
- 不创建本地卡片；
- channel health 显示 actionable error；
- contract/integration test 必须失败，促使维护者更新 shim。

### 6.7 生命周期与清理

每个 dispatch 只有以下终态：

```text
completed | aborted | failed | bridge_shutdown
```

终态动作统一由 PendingDispatch 的一个 settle chokepoint 完成：

- 标记 sealed/settled；
- 删除 request 与全部 stream index；
- 停止接受新 operation；
- completion exactly once：已注册 dispatch 的正常、error、cancelled 都 resolve；只有 setup/identity 无法建立时 reject/fail fast；
- 晚到 callback 只记录一次 debug，不复活状态。

不得把“调用 callback”与“远端投递完成”混为一个 pending 结果。dispatcher 自己的 `waitForIdle` / counts 是 delivery 真相；PendingDispatch 只表示跨进程 producer event 已按序交给 dispatcher。

取消与失败必须分别对两个目标 contract 做 executable fixture：

- `@openclaw/feishu@2026.6.9`：异常路径仍经 `withReplyDispatcher` settle；
- `@larksuite/openclaw-lark@2026.6.10`：成功路径有插件私有 `waitForIdle → markFullyComplete → markDispatchIdle`，`abortCard` 是独立能力；单纯 reject `dispatchReplyFromConfig` 不足以证明 CardKit 会正确 close。

因此 MyAgents 的统一终态固定为：模型 error/cancelled 由 Sidecar 产生 user-safe canonical final（error 可带 `isError: true`），Bridge 入队后正常 resolve `dispatchReplyFromConfig`，让两类插件都执行自己的 idle/close 链。当前外部 Lark 的 `abortCard` 保持插件内部 fast-path，Bridge 不穿透调用私有 controller；Bridge shutdown 则依赖插件既有 shutdown hook 与进程生命周期。不得用无依据的 reject 当作卡片收尾。

不加 retry、fallback、额外 timeout 或 watchdog。网络取消与超时继续复用现有 `cancellableFetch` / process shutdown 语义，插件 callback 与 dispatcher drain 由插件 owner 负责。

### 6.8 可观测性

新增结构化阶段日志，统一带 `pluginId`、`requestId`，stream 阶段再带 `streamId`：

```text
dispatch_registered
run_started
stream_started
partial_coalesced   // 聚合计数，不逐 delta 刷日志
raw_block_barrier_accepted
canonical_final_enqueued
complete_barrier_accepted
plugin_dispatch_resolved
dispatcher_delivery_idle
plugin_delivery_settled
dispatch_failed / dispatch_aborted
```

每个 request 终态输出一行汇总：

- partial received / delivered / coalesced 数；
- raw block barrier / final payload 数；
- first partial accepted latency；
- producer terminal → complete barrier accepted；
- canonical final enqueue latency（有 final 时）；
- dispatcher delivery idle latency；
- plugin-owned async `onIdle` settlement latency（对飞书插件即 CardKit 终态更新返回）；
- queued / failed / cancelled delivery counts 与 outcome。

禁止记录正文、token、appSecret 或完整 plugin config。不要为本修复新增产品 analytics；unified log 足以定位协议与性能。

---

## 7. 用户配置与交互要求

### 7.1 创建渠道

- promoted Lark 默认开启 streaming，配置对象中是 boolean true；
- schema/default 能确定 boolean 时显示设计系统 Switch；
- 用户完成创建后无需理解 JSON 类型；
- 保存失败时在字段附近显示明确错误，不把坏值写盘再等启动失败。

### 7.2 编辑已有渠道

- 历史 `"true"` 经启动迁移后显示开启；
- 切换关闭落盘 false，重启后仍关闭；
- 切换开启落盘 true，重启后仍开启；
- 不新增“兼容模式”“快速流式”“Bridge 流式”等暴露内部架构的选项。

### 7.3 用户可见行为

| 配置 | 期望 |
|---|---|
| `streaming: true`，私聊 | 官方插件决定并呈现 streaming card |
| `streaming: false` | 官方插件静态回复，不出现 MyAgents 私有卡片 |
| 插件按 chat type 选择 static | 尊重插件选择 |
| CardKit 创建失败 | 使用插件自己的 fallback/error 语义 |
| MyAgents turn 取消 | 插件生命周期被终结，pending 无泄漏 |

MyAgents 不再承诺“配置 true 必然是 CardKit”；它承诺“配置和值正确交给插件，并忠实执行插件 reply protocol”。

---

## 8. 代码范围与反向边界

### 8.1 预计修改

| 模块 | 目标 |
|---|---|
| `src/shared/types/im.ts` / `agent.ts` | plugin config 改为 typed JSON object；尽量单一导出 |
| `src/server/builtin-session/turn.ts` / `turn-lifecycle.ts` | 从现有 turn terminal outcome 产生 typed canonical final payload；不再发空 complete data |
| `promotedPlugins.ts` | Lark typed default |
| `ChannelWizard.tsx` | schema/default 驱动 scalar 控件与 save-boundary parse |
| `ChannelDetailView.tsx` | boolean Switch、typed save |
| `src-tauri/src/im/config_store.rs` | 权威 raw-value 历史迁移 + locked read-heal |
| `sdk-shim/plugin-sdk/reply-runtime.js` | 真实 dispatcher primitive |
| `compat-runtime.ts` | 委托同一 primitive；requestId 入站；协议 lifecycle |
| `pending-dispatch.ts` | requestId map + stream map + ordered coalescing queue |
| `plugin-bridge/index.ts` | 协议端点、能力语义、删除本地 fallback |
| `plugin-bridge/streaming-adapter.ts` | 删除 |
| `management_api.rs` | 接收/保留 Bridge requestId 与 per-request `deliveryProtocol` |
| `im/adapter.rs` / `state.rs` | request-scoped run/progress/terminal surface；ReplySlot 保存协议事实 |
| `im/bridge.rs` | 新协议 body、transport health、删除 presentation/capability 猜测 |
| `im/reply_router.rs` | block boundary 与 turn complete 分离 |
| 相关 unit/integration/Rust tests | 回归契约 |
| 两份 tech docs | 对齐终态 owner 与协议 |

### 8.2 明确不改

- Claude Agent SDK delta 的产生与 Sidecar Session 语义；仅在既有 turn owner 的 terminal projection 增加 typed payload；
- Sidecar owner / pre-warm / persistent generator；
- Rust HTTP/SSE proxy；
- 原生飞书 adapter 的 CardKit 实现；
- Telegram / DingTalk 用户可见策略；
- Task / Cron / Goal；
- OpenClaw plugin install/update 机制；
- 整个 AppConfig schema versioning 体系。

---

## 9. 实施顺序

### Phase 0：把现有事故固化成测试

先写失败测试，覆盖：

- `"true"` 导致插件 static；
- dispatcher `_isStub` 导致 protocol path 为 0；
- chatId pending supersede；
- slow partial callback 让 finalize 排在大量旧快照后；
- 第一个 block-end 提前 resolve turn；
- complete 从历史 block 拼接 final；
- 无 pending 时进入本地 `FeishuStreamingSession`。

没有这些 guard 不进入重构。

### Phase 1：先修配置类型与磁盘数据

1. shared types 与 promoted default；
2. Rust read-heal migration；
3. wizard/detail typed control；
4. config tests；
5. 验证自动启动前读到 boolean。

### Phase 2：恢复 OpenClaw dispatcher ABI

1. 在 handwritten reply-runtime 实现 dispatcher；
2. compat runtime 委托；
3. bump 三处 shim version；
4. contract tests 对齐 installed Lark 与上游核心语义；
5. 确认日志首次出现 `dispatchReplyFromConfig PROTOCOL path`。

### Phase 3：requestId 协议与 non-blocking queue

1. Bridge 生成/注册 requestId，再 POST Rust；
2. Rust 保留该 requestId；
3. streamId 绑定 requestId；
4. pending operation queue；
5. block boundary / turn complete 分离；
6. Sidecar terminal outcome 产生 canonical `finalPayloads`，Rust/Bridge 只透传；
7. loopback endpoint 入队即 ACK；
8. 同 chat 并发与 slow callback 测试。

### Phase 4：删除错误 owner

1. `/capabilities` 退出请求路由；如保留，仅报告 `replyProtocolTransport` doctor/health；
2. Rust 删除 `supports_cardkit`、`streamMode` 与基于全局 capability 的 protocol 选择；
3. 删除 `streaming-adapter.ts`、session map 与 fallback branches；
4. fail-fast health/error；
5. `rg` 确认不再有 Bridge-owned CardKit token/card/update 实现。

### Phase 5：全量验证与文档对齐

1. unit/dom/integration/Rust tests；
2. lint/typecheck/clippy/fmt；
3. fake slow plugin 压测；
4. 真实 Lark streaming true/false smoke；
5. 5K 长回复与工具调用多 block；
6. macOS / Windows / Linux 配置表单与启动路径检查；
7. 更新 tech docs 与 root-cause dev experience（若实现过程发现新通用陷阱）。

---

## 10. 测试矩阵

### 10.1 TypeScript unit

#### Typed config

- Lark default 是 boolean true；
- schema boolean/number/string 分别写出正确类型；
- unknown custom key 保持 string；
- false 不被 `|| default` 吞掉；
- secret 不进入日志。

#### Dispatcher

- final/block/tool 严格顺序；
- slow deliver 下 waitForIdle；
- markComplete exactly once；
- onIdle only after drain；
- error/count/typing lifecycle；
- direct shim 与 compat runtime 返回相同 contract。

#### Pending dispatch

- 同 chat 两 requestId 并存；
- streamId 只路由到自己的 request；
- 100 个 partial + deferred slow callback：callback concurrency 恒为 1；
- 相邻 partial 被替换为最新 full snapshot；
- raw block barrier 与 complete barrier 不丢，partial 不跨 barrier 合并；
- raw block barrier 不触发 `sendBlockReply`；本期 transport 不伪造 logical block；
- 零个、一个、多个 canonical final 的 payload 结构与顺序原样进入 `sendFinalReply`；
- complete 本身不触发 `sendFinalReply`，只在前序 operation 入 dispatcher 后 settle；
- media-only final 与 answer 后独立 error final 不被文本化或吞掉；
- model error/cancel 交付 user-safe terminal final 后正常 settle；setup fail / shutdown 清空两个 map；
- 晚到 chunk 不复活 dispatch。

### 10.2 Renderer DOM

- migrated boolean 显示正确 Switch state；
- toggle true/false 保存真实 boolean；
- schema number validation；
- CustomSelect enum，不出现原生 `<select>`；
- 中英文文案与 aria label 走 i18n；
- 保存中 unmount/remount 与跨字段 Channel patch 不复活已删除 scalar；
- 不引入硬编码颜色/任意 px 字号。

### 10.3 Rust unit

- `BridgeMessagePayload.requestId` 被原样写入 `ImMessage.request_id`；
- `BridgeMessagePayload.deliveryProtocol` 被原样保存到对应 `ReplySlot`，只影响该 request；
- empty requestId 才 fallback 生成；
- config migration 覆盖 agents + legacy bots、幂等、未知值不改；
- `BridgeAdapter::sync_capabilities` 不再根据凭据或 presentation capability 选择 request protocol；
- start body 带 requestId，不带 streamMode/cardkit；
- block-end 只形成 raw barrier，不等于 logical block 或 turn complete；
- complete 透传 typed canonical `finalPayloads`，不从 `last_block_text` / `block_text` 重建；
- terminal hook 带 requestId 与 producer terminal payload。

### 10.4 CI-safe integration（no egress）

用 fake OpenClaw plugin + controllable deferred callback：

1. 入站注册 pending；
2. Rust enqueue / event replay；
3. runStart/partial/raw barrier/canonical final/complete 全链；
4. HTTP ACK 不等待 deferred remote callback；
5. 最终解除 deferred 后分别观测 dispatcher idle 与 plugin renderer settlement；
6. static plugin 无 `onPartialReply` 时只收到 final；
7. zero-final complete 正常 settle，不合成空文本；
8. protocol missing 时明确失败，绝不创建本地 renderer。

### 10.5 Credentialed / 手工 smoke

至少覆盖：

| 场景 | 验证 |
|---|---|
| Lark 私聊，streaming=true，短答 | 首屏、平滑、终态 |
| Lark 私聊，streaming=true，约 5K 字 | 无 20–30s 尾巴；内容完整 |
| streaming=false | 单次静态回复；无 streaming card |
| 工具调用前后多文本块 | 不在首个 block-end 提前关闭；无重复 |
| 同一 chat 快速发两问 | request 不互相 supersede/串内容 |
| cancel | 卡片/typing/pending 正常清理 |
| 模拟飞书更新变慢 | Sidecar complete 仍及时进入 Bridge；其它 request 不被堵塞 |
| App 重启 | migrated boolean 生效；enabled channel 自动启动正确 |

---

## 11. 验收标准

### AC1：根因链消失

- unified log 中官方插件 `streaming=true` 场景实际选择 streaming；
- `dispatchReplyFromConfig PROTOCOL path` 大于 0；
- `[streaming] Started streaming` 这类 Bridge 私有 renderer 日志为 0；
- 仓库中不存在 `plugin-bridge/streaming-adapter.ts` 或等价私有飞书 CardKit 实现。

### AC2：配置语义正确

- 新建和编辑后磁盘为 `"streaming": true|false`；
- 历史 `"true"/"false"` 在 channel auto-start 前迁移并持久化；
- 第二次迁移零 diff；
- Bridge 无字符串 coercion。

### AC3：并发 identity 正确

- pending map 不以 chatId 为 key；
- 同 chat 两 requestId 可同时存在；
- 任一 stream/chunk/final 只命中一个 request；
- 不再出现“新消息 supersede 同 chat 旧 dispatch”。

### AC4：上游不等待飞书 ACK

在 deterministic deferred test 中：

- `/stream-chunk` 入队 ACK 在 callback deferred 未 resolve 时已经返回；
- callback 最大并发数为 1；
- 过期相邻 partial 被合并；
- raw block / final / complete barrier 顺序不变；
- canonical final 的数量、顺序与 payload 结构 deep-equal producer 输入，文本字节不变；
- Bridge 没有任何 block join；零 final 时 complete 仍可正常 settle。

### AC5：真实体验恢复

- 约 5K 字真实回复从 Sidecar turn complete 到飞书卡片终态，在正常网络下不超过 3 秒；若超过，汇总日志必须能区分 Bridge enqueue 与 plugin delivery 哪一段耗时；
- 不再复现约 25 秒的 post-turn backlog；
- 内容、Markdown、代码块、表格与终态无截断/重复。

### AC6：静态模式真实有效

- `streaming=false` 不触发 partial CardKit；
- final 仍由官方插件 dispatcher 发送；
- 没有“设置关了，但 Rust 因凭据仍强行 CardKit”的行为。

### AC7：无技术债残留

- 无新 feature flag、retry、cache、Bridge vendor throttle；
- compat runtime 与 direct shim 只有一个 dispatcher 真相源；
- request protocol 只来自该次已注册 dispatch，不再由 credential shape、channel capability 或 `blockStreaming` 猜测；
- tech docs 与代码同日更新；
- `npm run typecheck && npm run lint`、相关 Vitest 池、Rust test/fmt/clippy 全通过。

---

## 12. 被否决方案

| 方案 | 否决理由 |
|---|---|
| 默认关闭 streaming | 牺牲产品能力，只掩盖 owner 错位 |
| 升/降级 OpenClaw 版本 | 当前真实版本不匹配外部 issue；无法修本地 split brain |
| Bridge 再调大/调小 throttle | 继续维护第二套飞书 renderer |
| 每次只发新增 suffix | 违背 CardKit/插件完整快照语义，破坏 Markdown 上下文 |
| 给每个 delta 并发 fire-and-forget | 乱序、无界 promise、final race |
| 在 Bridge 把所有 `"true"` 猜成 true | 数据错误继续留盘，未知插件 key 被误判 |
| pending 继续按 chatId | 同 chat 并发必然互相覆盖 |
| 第一个 block-end 就 sendFinal/resolve | 工具调用、多文本块会提前关闭和截断 |
| 保留本地 fallback 作为“保险” | ABI 漂移再次被掩盖；双 owner 永不收敛 |
| 另加一个流式实现开关 | 长期双轨、测试矩阵翻倍、无法形成终态 |

---

## 13. 兼容性、发布与回滚

### 13.1 插件兼容

- 当次实际通过标准 `dispatchReplyFromConfig` 注册成功的请求走 dispatcher transport；
- 没有进入该路径的 legacy plugin 保持已有 direct send/edit surface；是否进入不能由静态 capability 声明猜测；
- 不允许凭 `appId/appSecret` 把任意 plugin 判成 CardKit；
- promoted Lark 必须有真实集成 fixture；其它 promoted OpenClaw plugin 至少跑 load/register smoke。

### 13.2 数据兼容

boolean 是官方插件本来要求的类型。迁移后即使回滚到旧 App，JSON boolean 仍是合法 config；旧 renderer 可能按 string input 展示，但不会损坏凭据。

迁移前写 `.bak` 继续沿用现有 config lock/read-heal 机制，不另建 migration journal。

### 13.3 跨平台

核心修复在 Node Bridge、Rust IM pipeline 与共享 renderer 表单，macOS/Windows/Linux 语义一致。重点检查：

- Windows 路径不参与新 request identity；
- 不新增裸进程/裸 localhost client；
- Node 内置 runtime 与 shim install 三平台一致；
- Switch/number input 在 WKWebView 与 WebView2 都可用。

### 13.4 发布门禁

真实凭据 smoke 未通过前不得宣称修复。至少记录一条 5K streaming=true trace，展示：

```text
model first delta
bridge first partial accepted
model turn complete
plugin final enqueued
plugin delivery settled / card closed
```

并与本 PRD §2.6 的 25 秒基线比较。

### 13.5 回滚

代码回滚按版本整体回滚。已迁移的 boolean 不反向写回字符串。不得为了回滚重新引入 `streaming-adapter.ts`；若新 dispatcher ABI 有问题，修 compat contract 或回滚整个版本。

---

## 14. 文档同步

实现同一提交或同一功能分支内更新：

### `specs/tech_docs/plugin_bridge_architecture.md`

- Bridge = plugin loader + ABI adapter + transport；
- plugin dispatcher 是 outbound render owner；
- requestId/streamId 关联；
- pending operation queue 的唯一合并规则；
- per-request protocol fact 与全局 transport health / presentation config 分离；
- 明确 Bridge 禁止 vendor-specific CardKit renderer。

### `specs/tech_docs/im_integration_architecture.md`

- block boundary 与 turn terminal 的差异；
- Bridge requestId 由入站生成并贯穿 ReplySlot；
- adapter network ACK 不得反压 Sidecar event producer；
- plugin config 为 `Record<string, unknown>`，scalar 类型保存规则。

若实现发现“adapter I/O 在 ReplyRouter mutex 内”对其它原生 channel 也构成可量化问题，应单独立项做通用 reducer/action executor 重构；本 PRD 不借飞书 bug 顺手扩大战线。Bridge 本期通过入队即 ACK 移除已证实的远端阻塞。

---

## 15. 实现前最终核验

产品与架构方向已收口，无需用户再做选择。

编码前只做两项 contract 固化，不构成方案分叉：

1. 以上游 `main@7c4ab782` 锁定 `markRunComplete`、reservation、counts、typing lifecycle 与 `appendBeforeDeliver`；
2. 以当前安装的 `@larksuite/openclaw-lark@2026.6.10` 源码审计锁定 lifecycle，用 hermetic real-Bridge contract mirror 固化 error/cancel 与 `waitForIdle → markFullyComplete → onIdle → markDispatchIdle`；CI 不直接加载用户目录中可变的安装包。

任一 fixture 不通过时，修正同一 ABI adapter 或 terminal projection；不得恢复 stub、本地 renderer、capability 猜测或插件私有 controller 穿透。

---

## 16. 空 session 自检

实现者在开始编码前应能只凭本 PRD 回答：

1. **为什么慢？** 配置 string 让插件选 static，dispatcher stub 让协议路径失效，capability 又让 Rust 进入 streaming，最终 Bridge 私有 CardKit renderer 在每个 delta 同步发送完整累积文本并阻塞事件消费。
2. **为什么不是 OpenClaw 2026.7.1？** 本机实际运行 Lark 2026.6.10 + shim 2026.6.28。
3. **谁应该拥有 CardKit？** 官方 OpenClaw 飞书插件，绝不是 Plugin Bridge。
4. **为什么不能 suffix-only？** 插件/CardKit 使用完整快照和 sequence，suffix 会破坏上下文且继续把平台知识留在错误 owner。
5. **为什么用 requestId？** 它已是 Rust ReplySlot 与日志的 per-request identity；chatId 不是并发 identity。
6. **为什么 operation queue 不算第二套 throttle？** 它没有时间/QPS策略，只合并同 stream 相邻过期快照；真正远端 pacing 仍在插件。
7. **谁产生 final？** Sidecar / turn producer；Bridge 只透传零个、一个或多个 canonical payload，complete 本身不拼正文。
8. **什么时候才算 turn 完成？** `complete/error/cancelled`，不是第一个 `block-end`。
9. **历史 `"true"` 在哪里迁移？** Rust 权威 config read-heal，且在 enabled channel auto-start 前持久化。
10. **协议缺失怎么办？** fail loud、清理 pending、报 actionable error；不切本地 renderer。
11. **交付完成的证据是什么？** typed config、protocol path、无本地 renderer、同 chat 并发测试、slow callback deterministic test、真实 5K Lark trace 和全套质量门禁。

若以上任一题答不清，不应开始实现。

---

## 17. 关联资料

- `specs/research/0315_feishu_bot_doc.md`：官方 Lark 插件接入与 streaming 配置背景。
- `specs/ARCHITECTURE.md`：进程、Owner 与通信总架构。
- `specs/tech_docs/im_integration_architecture.md`：IM request、ReplyRouter、adapter 与事件消费链路。
- `specs/tech_docs/plugin_bridge_architecture.md`：Plugin Bridge 与 OpenClaw shim 既有契约。
- `../openclaw/src/auto-reply/reply/reply-dispatcher.ts`、`reply-dispatcher.types.ts`：官方 dispatcher primitive 与 ABI。
- `../openclaw/src/auto-reply/dispatch-dispatcher.ts`、`reply/dispatch-from-config.ts`：官方 settle、typing 与 final dispatch lifecycle。
- `../openclaw/extensions/feishu/src/reply-dispatcher.ts`、`streaming-card.ts`：官方飞书 renderer owner，审查基线 `main@7c4ab782`。
- 飞书官方 CardKit 流式更新：<https://open.feishu.cn/document/cardkit-v1/streaming-updates-openapi-overview>。
- 症状相似但非本机直接根因：<https://github.com/openclaw/openclaw/issues/108265>。
- full-payload 成本放大的外部机制佐证：<https://github.com/openclaw/openclaw/issues/91941>。

---

## 执行台账

### 开发契约（动第一行代码前写完）

- **必赢场景**：历史配置为 `"streaming": "true"` 的 promoted Lark 渠道在启动前被迁移为 boolean；一条约 5K 字、含工具调用与多个 SDK text block 的回复由已安装 OpenClaw 插件创建并收口卡片，模型 turn complete 后不再积压 20–30 秒；同一 chat 两个并发 request 不串流；`streaming=false` 由同一插件静态发送；error/cancel 正常关闭 typing/card/pending。
- **复用的既有抽象**：Rust `persist_agent_config_read_heal` + config lock；`ImMessage.request_id` / `ReplyRouter::ReplySlot`；`ImStreamAdapter` 的 adapter 边界；Sidecar `snapshotCurrentTurnTerminalOutcome()` / `completeCurrentImRequest()`；Bridge `registerPendingDispatch`；`cancellableFetch` 与 Rust `local_http`；handwritten SDK shim；renderer `Switch` / `CustomSelect` 与现有 promoted-plugin schema/default 数据流；官方 OpenClaw `createReplyDispatcher` / `createReplyDispatcherWithTyping` / `settleReplyDispatcher` / `withReplyDispatcher` 契约。
- **反向边界**：不修改 Claude Agent SDK delta 生成、Sidecar Session/Owner/pre-warm；不重写原生 `feishu.rs`、DingTalk、Telegram；不升级插件版本；不增加 suffix payload、平台 throttle、retry、cache、watchdog、feature flag 或第二套 renderer；raw `block-end` 不冒充 logical block。
- **新概念清单**：无新进程、owner 或平台抽象。仅把已有 pending dispatch 从 chat-scoped 修正为 request-scoped，并在现有 `ReplySlot` 保存 per-request `deliveryProtocol` 事实；现有 IM terminal event 增加 producer-owned `finalPayloads` wire projection；现有 pending map 增加严格有序、只合并相邻 full-snapshot partial 的 transport queue。三者都是修复跨进程 identity/ordering 所必需的已有概念归位。
- **触及的红线**：SDK shim 三处兼容版本同步 bump；新增/改 Bridge fetch 必须带 AbortSignal 并复用 `cancellableFetch`；Rust localhost 请求继续走 `local_http`；配置 read-heal 必须在 config lock 内且早于 enabled channel auto-start；共享类型不得跨 renderer/server 边界 import；不得让 raw `block-end` 终结 turn；不得以凭据/capability 推测 request protocol；日志不得包含正文、凭据或完整 plugin config。

### 开发批次与行动清单

- **Batch 1：恢复 OpenClaw 插件的回复所有权（单批次）**。配置类型、dispatcher ABI、request identity、terminal payload、非阻塞 transport 与删除 Bridge CardKit 是同一根因链和同一必赢场景，任一部分单独提交都会留下双 owner 或假协议，因此不拆批。
  - [x] 把 OpenClaw plugin config 的 shared/renderer 类型与 promoted Lark 默认值改为真实 JSON scalar，补表单单测。
  - [x] 在 Rust 权威 read-heal 中迁移已知 `openclaw-lark.streaming` 字符串布尔并补幂等测试。
  - [x] 按官方 MIT 源码适配唯一 handwritten reply dispatcher primitive，compat runtime 委托它，补 ABI/异常/typing/count contract tests，并同步三处 shim version。
  - [x] 生成并贯穿 Bridge `requestId + deliveryProtocol`，把 pending identity 从 chatId 改为 requestId。
  - [x] 将 Sidecar terminal outcome 投影为 typed canonical `finalPayloads`，Rust/Bridge 只透传；raw block-end 只形成 barrier。
  - [x] 实现 request-scoped ordered transport queue：loopback 入队即 ACK，只替换同 stream 相邻 full-snapshot partial，final/complete 为 barrier。
  - [x] 删除 Bridge 私有 `FeishuStreamingSession`、CardKit capability 猜测、fallback route 与相关 vendor-specific 代码。
  - [x] 更新 IM / Plugin Bridge 架构文档与结构化日志。
  - [x] 完成 unit/dom/integration/Rust、typecheck/lint、全栈 build 与无凭据 fake-plugin smoke。
  - [x] 执行 requirements / adversarial / architecture 三镜 cross-review，根因修复全部有效问题后重跑受影响验证。
  - [x] 提交单一 Conventional Commit，回写 PRD implemented 状态与真机验收指南。

### 当前批次 Review 基线

- **批次**：Batch 1
- **Batch base**：`08eaf110ed4cbaa2e0b5ece5304b90c92e6e3160`
- **预期范围**：`src/shared/types/*`、promoted plugin 配置 UI、Rust config read-heal、`src/server/builtin-session/turn*`、Plugin Bridge compat/shim/pending/routes、Rust IM management/adapter/bridge/reply router/state、相关测试与两份 tech docs；不包含其它会话或用户改动。

### 待用户决策

无。产品与架构决策已在正文收口；真实飞书凭据 smoke 作为交付后的用户真机验收，不阻塞无凭据开发与提交。

### 进展日志

- 2026-07-16：完成本地代码、配置、31 份 unified log 与已安装 `@larksuite/openclaw-lark@2026.6.10` 的 RCA，排除“OpenClaw v2026.7.1 回归”作为本机直接根因。
- 2026-07-16：fresh-context 子 Agent 审查同级官方 `openclaw/main@7c4ab782`；确认可适配 core dispatcher，飞书 renderer/pacing 必须留在插件，并纠正 Bridge 拼 final、raw block 映射 logical block、capability gate 三处草案错位。
- 2026-07-16：按 `prd-writer` 完成 house style、ground truth 与空 session 自检；PRD 可进入实现。
- 2026-07-16：完成 plugin-owned dispatcher/renderer 归位、request-scoped transport、producer-owned canonical final、精确配置迁移与 Bridge 私有 CardKit renderer 删除。
- 2026-07-16：三镜 review 驱动修复 callback failure settlement、early no-turn terminal、nonmention protocol、optional diagnostics、真实 plugin onIdle 观测、编辑器 unmount/cross-writer 竞态与 disk-authoritative runtime sync；未加 retry/cache/flag/第二 renderer。
- 2026-07-16：无凭据验证完成：291 unit files / 2649 passed，100 DOM files / 529 passed，36 integration files / 313 passed，Rust 734 passed，typecheck/lint/classification/fmt/build 通过；仅真实飞书凭据 5K smoke 保留为 release gate。

### 真机发布验收指南

1. 用历史 `"streaming":"true"` 配置启动新版，确认写盘后为 boolean `true`，再分别验证 Switch 保存 `false/true`。
2. `streaming=true` 发送约 5K 字、含工具调用和多 text block 的私聊请求；按同一 `requestId` 记录 model terminal、`dispatcher_delivery_idle`、`plugin_delivery_settled`，验证 terminal 后不再出现 20–30s 尾延迟。
3. 验证 `streaming=false` 静态回复、同 chat 两请求并发、model error 与 cancel；卡片/静态消息都必须仅收尾一次，无串流、无永久 typing。
4. 如 `plugin_delivery_settled` 仍慢，用已安装 Lark 插件的 CardKit/onIdle 日志定位飞书 API；如 dispatcher idle 前慢，用 pending summary 的 received/delivered/coalesced/counts 定位 host transport。
