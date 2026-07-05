---
type: prd
status: implemented
created: 2026-07-05
updated: 2026-07-05
scope: "修复 OpenAI Bridge 在 Responses API 上没有传递缓存路由信息导致 Codex GPT 中转站前缀缓存命中率低的问题：P0 为 Responses upstream 自动注入稳定且不泄露隐私的 prompt_cache_key，并保留 usage.cached_tokens 统计；P1 只在 provider 明确支持时探索 previous_response_id / conversation state。本期不改 external Codex Runtime，不把所有 Responses 中转站强制切到 store:true。"
issue: "用户反馈：fox 这类 Codex GPT Responses 中转站在 MyAgents OpenAI 协议接入时缓存命中率很低；同一中转站在 Codex 软件直连时缓存命中率很高。用户怀疑 MyAgents OpenAI bridge 面向 API 侧丢信息。"
research: "本 PRD 内含 2026-07-05 本地代码调查、官方 OpenAI 文档核对、fox 中转站真实请求 smoke test；没有单独 research 文件。"
review: "complete：targeted unit/integration/typecheck/lint/build 通过；三视角 cross-review 已完成并修复错误脱敏、降级匹配过宽与 prompt_cache_retention 类型问题；fox smoke 显示第二次成功请求 cache_read_input_tokens=16128。"
---

# 0.2.49 OpenAI Responses 前缀缓存 Bridge PRD

## 执行须知（给空 session 的你）

本 PRD 是一次问题调查后的开发交接物，不需要回翻原始聊天。落地前必须主动读：

1. `specs/ARCHITECTURE.md`
2. `specs/tech_docs/third_party_providers.md`
3. `specs/tech_docs/multi_agent_runtime.md`
4. `specs/tech_docs/session_architecture.md`
5. OpenAI 官方文档：
   - `https://developers.openai.com/api/docs/guides/prompt-caching`
   - `https://developers.openai.com/api/docs/guides/conversation-state`
   - `https://developers.openai.com/api/docs/guides/migrate-to-responses`
6. 当前代码重点：
   - `src/server/openai-bridge/handler.ts`
   - `src/server/openai-bridge/types/openai-responses.ts`
   - `src/server/openai-bridge/translate/request-responses.ts`
   - `src/server/openai-bridge/translate/response-responses.ts`
   - `src/server/openai-bridge/translate/stream-responses.ts`
   - `src/server/openai-bridge/bridge-registry.ts`
   - `src/server/agent-session.ts` 的 `resolveActiveSessionUpstreamConfig` / `ensureActiveSessionBridgeRegistered` / `startOneShotBridge`
   - `src/server/runtimes/codex.ts`
   - `src/server/runtimes/codex-token-usage.ts`

本文引用符号名和文件路径，不依赖行号。涉及 OpenAI API 字段时，以官方文档和当前 OpenAPI schema 为准；本 PRD 写于 2026-07-05，字段可能随 OpenAI API 演进。

## 背景与用户意志

用户反馈的是一个很具体的对照：

- 他有一个叫 fox 的 Codex GPT 中转站，MyAgents 里配置为 OpenAI 协议 + Responses API。
- 在 MyAgents 里用这个 provider，看统计发现缓存命中率很低。
- 同一个协议、同一个中转站，直接在 Codex 软件里接入，缓存命中率很高。
- 用户怀疑 MyAgents 的 OpenAI bridge 面向 API 这一侧丢了信息。

这不是单纯“统计 UI 不显示 cached_tokens”的问题。真正要回答的是：MyAgents 发给中转站的 Responses request shape，和 Codex 直连时的 request shape 相比，是否少了会影响前缀缓存的字段或状态。

## 调查结论

结论分两层：

1. **统计没有明显丢。** MyAgents bridge 已经把 OpenAI usage 里的 `cached_tokens` 映射到 Anthropic 形态的 `cache_read_input_tokens`。如果上游返回了缓存命中 token，当前代码有路径把它传回 SDK / usage 统计。
2. **请求侧确实少了缓存路由信息。** 当前 Responses translator 只发 `model`、`input`、`instructions`、`tools`、`tool_choice`、`stream`、`reasoning` 和可选 `max_output_tokens`，没有发 `prompt_cache_key`，也没有 Responses state 字段。fox 实测证明：同一长前缀请求加稳定 `prompt_cache_key` 后，第二次 cached tokens 从 3840 跳到 11008，说明这个字段对该中转站有效。

所以用户的怀疑需要精确改写为：

> MyAgents 不是丢了 `cached_tokens` 统计，而是 OpenAI Bridge 在 Responses 请求侧没有传递或生成缓存路由相关字段，导致上游较难把同一会话 / 同一前缀路由到热缓存机器。

## 已验证事实

### MyAgents 当前 bridge 形状

`src/server/openai-bridge/translate/request-responses.ts::translateRequestToResponses` 当前行为：

- 从 Anthropic request 翻译出 `ResponsesRequest`。
- 每次把完整 `req.messages` 翻译成 `input`。
- assistant 文本翻译成 `{ role: 'assistant', content: [{ type: 'output_text', text }] }`。
- tool_use 翻译成 `function_call`，tool_result 翻译成 `function_call_output`。
- thinking blocks 不作为 Responses 原始 item replay。

`src/server/openai-bridge/types/openai-responses.ts::ResponsesRequest` 当前没有这些字段：

- `prompt_cache_key`
- `prompt_cache_retention`
- `previous_response_id`
- `conversation`
- `store`

`src/server/openai-bridge/translate/response-responses.ts` 和 `stream-responses.ts` 已经读取：

- `resp.usage.input_tokens_details?.cached_tokens`
- 并映射为 `cacheReadInputTokens`

`src/server/openai-bridge/bridge-registry.ts::UpstreamBridgeConfig` 当前没有每 session 的 cache affinity key，也没有 previous response state。`src/server/agent-session.ts::resolveActiveSessionUpstreamConfig` 只把 provider/model/token limit/upstreamFormat/reasoningEffort 透给 bridge。

### OpenAI 官方文档事实

OpenAI prompt caching 文档说明：

- 缓存命中要求 prompt 前缀 exact match。
- 缓存路由会基于 prompt 初始前缀 hash；提供 `prompt_cache_key` 时，该 key 会和前缀 hash 组合，用于影响路由并提升命中率。
- 最佳实践是对共享公共前缀的请求一致使用 `prompt_cache_key`。
- 1024 tokens 以下的请求也会有 cached_tokens 字段，但值为 0。
- `prompt_cache_retention` 可按请求配置；对 `gpt-5.5` 只支持 `24h`。

OpenAI conversation state / migration 文档说明：

- Responses API 可用 `previous_response_id` 链接前一轮 response。
- 使用 `previous_response_id` 时，仍要在每次请求重发稳定的 `instructions`，因为它不会继承上一轮顶层 `instructions`。
- `previous_response_id` 需要 provider 能解析上一轮 response id；HTTP 示例通常配合 `store:true`。

### fox 真实 smoke test

本机 provider：`fox`

- provider id：`custom-1782281756163-17p1l6b`
- base URL：`https://dm-fox.rjj.cc/codex/v1`
- upstream endpoint：`https://dm-fox.rjj.cc/codex/v1/responses`
- model：`gpt-5.5`
- key 已存在于本机配置，但本 PRD 不记录、不引用、不打印。

2026-07-05 真实请求结果：

| 测试 | 请求形状 | 结果 |
| --- | --- | --- |
| stateless-1-no-cache-key | 约 11K input tokens 长稳定前缀，无 `prompt_cache_key` | 200，`cached_tokens=3840` |
| stateless-2-no-cache-key | 同上重复 | 200，`cached_tokens=3840` |
| stateless-3-with-prompt-cache-key | 同前缀，使用固定测试 `prompt_cache_key` | 200，`cached_tokens=3840` |
| stateless-4-with-same-prompt-cache-key | 同 key 再重复 | 200，`cached_tokens=11008` |
| stateful-previous-response-id | 用未 `store:true` 的第一轮 response id 续接 | 502 |
| stateful-first-store-true | 第一轮直接加 `store:true` | 502 |
| prompt-cache-retention-field | 短请求加 `prompt_cache_retention:"24h"` | 200，短 prompt 所以 cached_tokens=0 |

这说明：

- fox 支持 `prompt_cache_key`，而且这个字段能显著改善同前缀请求的 cached tokens。
- fox 不支持当前测试方式下的 `store:true`，因此不能默认打开 `previous_response_id` stateful continuation。
- `prompt_cache_retention:"24h"` 字段被 fox 接受，但本期不默认启用，因为它涉及数据保留策略，不是修复该 bug 的必要条件。

### Codex direct 路径事实

MyAgents 的 external Codex Runtime 不走 OpenAI bridge。它通过 `codex app-server` JSON-RPC：

- `thread/start`
- `thread/resume`
- `turn/start`
- streaming notifications
- `thread/tokenUsage/updated`

Codex app-server schema 里：

- `ThreadTokenUsage` 包含 `total`、`last`、`modelContextWindow`。
- `TokenUsageBreakdown` 包含 `cachedInputTokens`。
- `ResponseItem` 保留 Responses-native item：`message`、`reasoning`、`function_call`、`function_call_output`、`web_search_call`、`image_generation_call`、`compaction` 等。
- `ResponseItem` 还有 `phase`、`encrypted_content`、`internal_chat_message_metadata_passthrough`。
- `rawResponseItem/completed` notification 会暴露原始 Responses item。

MyAgents 当前 `src/server/runtimes/codex-token-usage.ts` 已能解析 Codex `cachedInputTokens`。所以 Codex direct 缓存高这一侧，不是 OpenAI bridge 的统计路径，而是 Codex app-server 自己的 Responses-native 会话与 usage 路径。

## 根因判断

当前 MyAgents builtin OpenAI bridge 是“Claude Agent SDK Anthropic Messages API ingress -> OpenAI Responses egress”的翻译器。它的上游请求是无状态全文 replay：

```
SDK subprocess
  -> /bridge/<token>/v1/messages  (Anthropic Messages shape)
  -> translateRequestToResponses()
  -> /responses                   (OpenAI Responses shape)
```

这个设计有两个结果：

1. 它保留了功能兼容性，但没有保留 Responses-native cache affinity 字段。
2. 它把 Responses 原始 item 先降到 Anthropic transcript，再翻回 Responses input，无法等价保留 Codex direct 的 raw item identity、phase、encrypted reasoning、compaction 等信息。

对 fox 这个已实测中转站，P0 根因是第一点：没有 `prompt_cache_key`。

`previous_response_id` 不能作为 fox 的 P0 修复，因为 fox 对 `store:true` 返回 502。强行做 stateful continuation 会把当前“可用但缓存差”的路径变成“第二轮直接失败”的路径。

## 本期范围

### P0 做什么

1. 对 `upstreamFormat === 'responses'` 的 OpenAI bridge 请求，注入稳定 `prompt_cache_key`。
2. `prompt_cache_key` 必须由 MyAgents 生成，不让用户手填，不包含 raw sessionId、workspace path、provider key、模型 key 或任何 prompt 内容。
3. key 粒度默认按 session/provider/model 生成，保证同一 MyAgents session 的多轮请求有稳定 cache affinity。
4. 对不支持 `prompt_cache_key` 的上游，支持一次性自动降级或 provider capability 关闭，不能让 turn 因未知字段长期失败。
5. 保持现有 `cached_tokens -> cache_read_input_tokens` 映射不变。
6. 增加 fake upstream 测试和 fox smoke test 记录。

### P0 不做什么

1. 不默认发送 `store:true`。
2. 不默认使用 `previous_response_id`。
3. 不默认发送 `prompt_cache_retention:"24h"`。
4. 不改 external Codex Runtime。
5. 不把 fox 或任意 Codex 中转站改造成 `codex_responses` 私有 backend provider。
6. 不为了缓存命中率把 provider API key、session id、workspace path 或用户 prompt 放进日志 / key / metadata。

### P1 后续探索

只在 provider 能力探测证明支持时，再做：

1. `previous_response_id` stateful continuation。
2. `conversation` object continuation。
3. `prompt_cache_retention` 的显式高级选项。
4. Codex-compatible private backend 的单独 upstream format。

P1 不是 P0 的前置条件。

## 产品策略

用户不应该理解或配置 `prompt_cache_key`。这是协议优化，不是模型能力。

Settings 里维持当前“OpenAI 协议 + Responses API”的配置方式。高级调试可以后续加开关，但 P0 不做 UI 暴露，避免把一个底层 cache affinity 细节推给普通用户。

错误提示也不要说“前缀缓存坏了”。如果上游不支持该字段，bridge 应降级并在统一日志里记录：

```
[bridge] responses prompt_cache_key unsupported for provider=<id> endpoint=<hash>; disabled for this bridge
```

日志不能包含：

- API key
- prompt_cache_key 原文
- session id 原文
- workspace path
- prompt 前缀

## 技术设计

### Cache key 生成

新增一个小的 pure helper，例如 `src/server/openai-bridge/prompt-cache.ts`：

```ts
export function buildPromptCacheKey(input: {
  appNamespace: 'myagents';
  providerId: string;
  model: string | undefined;
  sessionId: string | undefined;
  upstreamFormat: 'responses';
}): string
```

建议输出：

```text
myagents:responses:<sha256(providerId + model + sessionId).slice(0, 32)>
```

理由：

- 同一 session 的多轮请求稳定。
- 不把 raw sessionId 发给上游。
- 不把 workspace path、用户 id、prompt 内容、API key 混入 key。
- 不用 bridge token，因为 `freshToken:true` 重启 subprocess 后 token 会变，缓存 affinity 会丢。

如果未来要跨 session 共享系统 prompt / tools 的缓存，可新增 `provider-model` 粒度，但 P0 不做。OpenAI 文档提醒同一 prefix/key 组合过高并发可能 overflow；session 粒度更保守。

### Config / registry 传递

`UpstreamBridgeConfig` 增加字段：

```ts
cacheAffinity?: {
  sessionId?: string;
  promptCacheKeyMode?: 'off' | 'session';
};
```

`resolveActiveSessionUpstreamConfig()` 设置：

- `sessionId`
- `promptCacheKeyMode: 'session'` when `upstreamFormat === 'responses'`

`startOneShotBridge()` 默认 `promptCacheKeyMode:'off'`。verify、model list、title generator 等 one-shot 不需要缓存 affinity，且不应该污染用户会话的 cache routing。

### ResponsesRequest 类型

`ResponsesRequest` 增加官方字段：

```ts
prompt_cache_key?: string;
prompt_cache_retention?: '24h' | 'in-memory';
previous_response_id?: string;
store?: boolean;
conversation?: string;
```

P0 只使用 `prompt_cache_key`。其它字段先加类型可以降低后续改动成本，但 translator 不应在 P0 自动填它们。

### 注入位置

推荐在 `translateRequestToResponses()` 的 options 里传：

```ts
promptCacheKey?: string;
```

原因：request translator 是 Responses body owner，字段属于 request body，不应散落在 `handler.ts` 里做 ad hoc mutation。`handler.ts` 只负责从 `UpstreamBridgeConfig` 计算 option。

### 兼容性降级

两种可选实现，优先级如下：

1. **自动 retry 降级。** 第一次请求带 `prompt_cache_key`；如果上游返回 400/422 且错误消息匹配 unknown / unsupported parameter / invalid field，bridge 用同一个 Anthropic request 重试一次，去掉 `prompt_cache_key`，并在当前 bridge token 的 capability state 中禁用后续注入。
2. **Provider capability 开关。** 如果不想在 P0 做 retry，可先在 provider 配置里加 hidden capability，并把 fox / OpenAI official 默认设为 on。但这需要更多配置面维护，不如自动降级自洽。

自动 retry 的注意事项：

- 只对明确的 schema/unknown-parameter 错误重试。
- 不对 401/403/429/5xx 重试。
- 不重试 streaming 已经开始的 response。未知字段通常会在 body 前 4xx，因此 P0 可只覆盖 non-stream preflight response；streaming path 如果 fetch 返回非 2xx，同样可 retry 后再进入 stream translator。
- retry 日志不打印请求体。

### State continuation 明确推迟

如果未来做 `previous_response_id`，state owner 应在 `openai-bridge/bridge-registry.ts` 的 per-token entry 或专门的 `responses-state.ts`，不能放在 `index.ts` route handler 的全局变量里。

未来设计约束：

- 只有 provider 探测支持 `store:true` / `previous_response_id` 才启用。
- 上游返回 completed 后才更新 last response id。
- failed / aborted / provider/model/tools/instructions 边界变化必须清 state。
- 对 `previous_response_not_found` 必须回退为 full input replay。
- 使用 `previous_response_id` 时仍要重发 stable `instructions`。

fox 当前 `store:true` 502，因此它必须保持 P0 的 stateless full replay + `prompt_cache_key`。

## 关键设计决策

### D1：先修 cache routing，不先做 previous_response_id

原因：fox 实测支持 `prompt_cache_key` 且收益明显；同时 fox 对 `store:true` 返回 502。把 `previous_response_id` 做成默认修复会破坏该用户当前路径。

躲开的坑：为了追求“Responses-native state”而把不支持 persistent response store 的中转站打坏。

### D2：统计映射不作为修复点

原因：现有 `response-responses.ts`、`stream-responses.ts`、`usage-streaming.unit.test.ts` 已覆盖 `cached_tokens -> cache_read_input_tokens`。低命中率不是统计字段被吞，而是上游真的没有命中足够多缓存。

躲开的坑：在 UI usage 层补显示，掩盖实际请求形状问题。

### D3：prompt_cache_key 不暴露给用户手填

原因：这是协议层 cache affinity，不是模型能力；用户手填容易把敏感信息或不稳定字符串传给上游。

躲开的坑：把底层路由键变成另一个配置债。

### D4：不默认 prompt_cache_retention

原因：`prompt_cache_retention:"24h"` 涉及缓存保留策略。即使 fox 接受该字段，也不是修复命中率低的必要条件。

躲开的坑：为了性能默认扩大数据保留语义。

### D5：Codex Runtime 和 OpenAI Bridge 保持边界

原因：Codex direct 是 app-server JSON-RPC thread/turn 模型，OpenAI bridge 是 Anthropic SDK ingress 的协议翻译层。把 Codex raw Responses item state 塞进 bridge 会形成半个 Codex runtime，复杂度不归位。

躲开的坑：为了一个 provider 的缓存问题重写 runtime 边界。

## 验收标准

1. 单测：`translateRequestToResponses()` 在传入 `promptCacheKey` 时输出 `prompt_cache_key`，不传时 body 与旧行为一致。
2. 单测：`buildPromptCacheKey()` 输出稳定、长度受控、不同 session/model/provider 分离，且不包含 raw sessionId。
3. integration fake upstream：Responses active session 第二次请求 body 仍带同一个 `prompt_cache_key`。
4. integration fake upstream：one-shot bridge 默认不带 `prompt_cache_key`。
5. integration fake upstream：上游 unknown parameter 时，bridge retry 一次去掉 `prompt_cache_key`，后续同 token 不再注入。
6. usage 回归：Responses stream 的 `input_tokens_details.cached_tokens` 仍映射到 `cache_read_input_tokens`。
7. fox smoke：同一长前缀请求，同一 session cache key 重复后，cached_tokens 显著高于无 key 或第一轮。
8. 日志审计：不输出 API key、prompt_cache_key 原文、session id 原文、请求 body。

## 开放问题

1. direct Codex 软件具体是否发送 `prompt_cache_key`、`session_id` 或其它私有 cache routing 字段，本次没有抓包验证。当前结论来自官方文档、Codex app-server schema、MyAgents 代码对比和 fox smoke test。
2. fox 的 `prompt_cache_retention:"24h"` 虽被接受，但是否真实生效、是否影响用户的数据保留预期，未验证。
3. 是否要为 OpenAI official Responses provider 使用 `provider-model` 粒度 key 提升跨 session 共享缓存，留到后续性能 PRD。
4. `previous_response_id` 对官方 OpenAI provider 可行，但对 fox 不可默认；后续需要 provider capability 探测和单独状态 owner。

## 附录：调查命令摘要

本次调查执行过：

- `codex --version`：本机 `codex-cli 0.142.5`
- `codex app-server generate-ts --out /tmp/codex-schema-0.142.5`
- OpenAI 官方 docs 查询：prompt caching / conversation state / migrate to Responses
- fox `/responses` 真实请求 smoke test
- MyAgents OpenAI bridge 代码审计

敏感信息处理约束：

- 不把 fox API key 写入 PRD。
- 后续测试脚本只能输出 endpoint/model/status/usage/id prefix，不能输出 Authorization header、完整 response body、provider config 原文。

## 执行台账

### 开发契约（动第一行代码前写完）

- 必赢场景：builtin OpenAI-protocol + `upstreamFormat:'responses'` 的活跃会话请求会自动带同一 session 稳定、匿名的 `prompt_cache_key`；同一 bridge token 的后续请求 key 保持不变；one-shot bridge 默认不带；遇到上游明确 unknown/unsupported 参数错误时自动去掉 key 重试一次并在该 bridge 上禁用后续注入；usage 里的 `cached_tokens` 仍按现有路径统计。
- 复用的既有抽象：`openai-bridge/translate/request-responses.ts::translateRequestToResponses` 作为 Responses request body owner；`openai-bridge/bridge-registry.ts::UpstreamBridgeConfig` 作为 per-subprocess resolver 配置；`agent-session.ts::resolveActiveSessionUpstreamConfig` / `startOneShotBridge` 作为 active session vs one-shot 边界；`openai-bridge/handler.ts` 作为 upstream fetch / retry owner；现有 `usage-streaming.unit.test.ts` 保留 cached_tokens 回归。
- 反向边界：不默认发送 `store:true`、`previous_response_id`、`conversation`、`prompt_cache_retention`；不改 external Codex Runtime；不改 Settings UI；不把 fox key、raw sessionId、workspace path、prompt 内容写进日志或 cache key。
- 新概念清单：`prompt_cache_key` 生成 helper（必要：把 cache affinity 生成集中到 pure owner，避免 handler ad hoc 拼 key）；per-bridge capability disable 状态（必要：unknown parameter 只降级当前 bridge token，避免 provider 不兼容时每轮重复失败）。
- 触及的红线：第三方供应商 / OpenAI Bridge 必须复用现有 bridge registry 与 translator owner；配置身份继续走 ProviderRoute/ProviderEnv，不把 apiKey/baseUrl 写进 session snapshot；日志不得泄露密钥或请求体；不新增 route 层 runtime 分流。

### 行动清单

- [x] A1 读 PRD 与相关架构文档，补执行台账。
- [x] A2 实现 `prompt_cache_key` 生成、Responses request 注入、active session 配置传递、one-shot 默认 off。
- [x] A3 实现 unknown/unsupported 参数自动降级与当前 bridge token 禁用后续注入。
- [x] A4 补单测 / integration fake upstream / usage 回归覆盖。
- [x] A5 运行静态检查、针对性测试与 fox smoke test。
- [x] A6 cross-review，修复有效问题。
- [x] A7 更新 PRD frontmatter 与台账，提交 git commit。

### 待用户决策

暂无。`previous_response_id`、`prompt_cache_retention`、Codex-compatible private backend 已明确推迟，不阻塞 P0。

### 进展日志

- 2026-07-05：已确认当前 worktree 存在 6 个无关未提交改动（IM/config 类型相关），本次实现避开这些文件；按 PRD 建立 P0 执行契约。
- 2026-07-05：实现 Responses `prompt_cache_key` 注入链路：active session 传入匿名 session/provider/model cache affinity，one-shot 默认无 affinity；handler 对明确 unknown/unsupported `prompt_cache_key` 错误做一次去 key 重试，并在当前 bridge token 禁用后续注入。
- 2026-07-05：新增 helper、translator、fake upstream、registry 回归测试；同步版本号到 0.2.49（package / lockfile / Tauri / Cargo）。
- 2026-07-05：自验证通过：`npm run test:unit -- src/server/openai-bridge/translate/usage-streaming.unit.test.ts src/server/openai-bridge/translate/request-reasoning-effort.unit.test.ts src/server/openai-bridge/translate/request-model-suffix.unit.test.ts src/server/openai-bridge/prompt-cache.unit.test.ts src/server/openai-bridge/translate/request-prompt-cache.unit.test.ts`；`npm run test:integration -- src/server/openai-bridge/handler-prompt-cache.integration.test.ts src/server/__tests__/bridge-registry.integration.test.ts`；`npm run test:classification`；`npm run typecheck`；`npm run lint`；`npm run build:server`。
- 2026-07-05：真实 fox smoke 通过：同一 prefix / 同一匿名 cache key 的两次成功请求中，第二次 `cache_read_input_tokens=16128`（第一轮 0），确认 bridge 注入 key 对 fox 有效；脚本只输出 providerId/model/host/status/usage 摘要，不输出 key、API key 或请求体。
- 2026-07-05：三视角 cross-review 完成；采纳并修复有效问题：上游错误体统一脱敏后再日志/返回 SDK，避免 provider echo 泄露 raw cache key / prompt；unknown 参数降级匹配收紧，不再因普通 invalid echo 错误禁用 cache key；`prompt_cache_retention` future type 按 Responses API reference 改为 `in-memory`；补充第三方供应商技术文档。
- 2026-07-05：提交完成：`fix(openai-bridge): add responses prompt cache affinity`。
