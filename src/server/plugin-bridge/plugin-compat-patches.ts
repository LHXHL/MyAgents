const LARK_REGISTER_DISPATCHER = `function registerActiveDispatcher(key, entry) {
    activeDispatchers.set(key, entry);
}`;

const LARK_UNREGISTER_DISPATCHER = `function unregisterActiveDispatcher(key) {
    activeDispatchers.delete(key);
}`;

const LARK_GET_DISPATCHER = `function getActiveDispatcher(key) {
    return activeDispatchers.get(key);
}`;

const LARK_REGISTER_DISPATCHER_PATCH = `function registerActiveDispatcher(key, entry) {
    const token = globalThis.__myagentsCurrentLarkAdmissionToken?.();
    const existing = activeDispatchers.get(key);
    const entries = existing instanceof Map ? existing : new Map();
    entries.set(token ?? entry, entry);
    activeDispatchers.set(key, entries);
}`;

const LARK_UNREGISTER_DISPATCHER_PATCH = `function unregisterActiveDispatcher(key) {
    const entries = activeDispatchers.get(key);
    if (!(entries instanceof Map)) {
        activeDispatchers.delete(key);
        return;
    }
    const token = globalThis.__myagentsCurrentLarkAdmissionToken?.();
    if (token === undefined) {
        activeDispatchers.delete(key);
        return;
    }
    entries.delete(token);
    if (entries.size === 0) {
        activeDispatchers.delete(key);
    }
}`;

const LARK_GET_DISPATCHER_PATCH = `function getActiveDispatcher(key) {
    const entries = activeDispatchers.get(key);
    if (!(entries instanceof Map)) {
        return entries;
    }
    let latest;
    for (const entry of entries.values()) {
        latest = entry;
    }
    return latest;
}`;

const LARK_ENQUEUE = `function enqueueFeishuChatTask(params) {
    const { accountId, chatId, threadId, task } = params;
    const key = buildQueueKey(accountId, chatId, threadId);
    const prev = chatQueues.get(key) ?? Promise.resolve();
    const status = chatQueues.has(key) ? 'queued' : 'immediate';
    const taskPromise = prev.then(task, task);
    chatQueues.set(key, taskPromise);
    const cleanup = () => {
        if (chatQueues.get(key) === taskPromise) {
            chatQueues.delete(key);
        }
    };
    taskPromise.then(cleanup, cleanup);
    return { status, promise: taskPromise };
}`;

const LARK_ENQUEUE_PATCH = `function enqueueFeishuChatTask(params) {
    const { accountId, chatId, threadId, task } = params;
    const key = buildQueueKey(accountId, chatId, threadId);
    const previous = chatQueues.get(key);
    const previousAdmission = previous?.admission ?? Promise.resolve();
    const activeTasks = previous?.activeTasks ?? new Set();
    const status = chatQueues.has(key) ? 'queued' : 'immediate';
    const launch = () => {
        const runner = globalThis.__myagentsRunLarkAdmissionScopedTask;
        if (typeof runner === 'function') {
            return runner(task);
        }
        const completion = Promise.resolve().then(task);
        return {
            admission: completion.then(() => undefined, () => undefined),
            completion,
        };
    };
    const launched = previousAdmission.then(launch, launch);
    const admission = launched.then((execution) => execution.admission);
    const taskPromise = launched.then((execution) => execution.completion);
    const entry = { admission, activeTasks };
    activeTasks.add(taskPromise);
    chatQueues.set(key, entry);
    const cleanup = () => {
        activeTasks.delete(taskPromise);
        if (activeTasks.size === 0 && chatQueues.get(key)?.activeTasks === activeTasks) {
            chatQueues.delete(key);
        }
    };
    taskPromise.then(cleanup, cleanup);
    return { status, promise: taskPromise };
}`;

/**
 * Narrow compatibility transform for the official @larksuite/openclaw-lark
 * process-level queue. It keeps task completion request-scoped while moving
 * only same-chat scheduling to the Bridge→Rust admission boundary.
 *
 * Returning null is deliberate fail-closed behavior for an unknown upstream
 * source shape: load the plugin unchanged instead of guessing at its private
 * lifecycle.
 */
export function patchLarkChatQueueSource(source: string): string | null {
  const fingerprint = createHash('sha256').update(source).digest('hex');
  if (fingerprint !== KNOWN_LARK_CHAT_QUEUE_SHA256) return null;

  const knownBlocks = [
    LARK_REGISTER_DISPATCHER,
    LARK_UNREGISTER_DISPATCHER,
    LARK_GET_DISPATCHER,
    LARK_ENQUEUE,
  ];
  if (knownBlocks.some((block) => source.split(block).length !== 2)) {
    return null;
  }

  return source
    .replace(LARK_REGISTER_DISPATCHER, LARK_REGISTER_DISPATCHER_PATCH)
    .replace(LARK_UNREGISTER_DISPATCHER, LARK_UNREGISTER_DISPATCHER_PATCH)
    .replace(LARK_GET_DISPATCHER, LARK_GET_DISPATCHER_PATCH)
    .replace(LARK_ENQUEUE, LARK_ENQUEUE_PATCH);
}
import { createHash } from 'node:crypto';

const KNOWN_LARK_CHAT_QUEUE_SHA256 = '439851fff11b078730e9bab9b0405076e5c73cb29bb37f2d20b0c147ca7c791a';


/** Known upstream lifecycle exits that send outside dispatcher callbacks.
 * Patches read the exact request context; they never consult a global last mode. */
const CHANNEL_PATCHES = {
  "larkDispatch": {"sha256": "39924d577ddbb5822afed77576c21aadaa09d940e57447e6c4345acd45259479", "replacements": [["            ...(groupSystemPrompt ? { GroupSystemPrompt: groupSystemPrompt } : {}),", "            ...(groupSystemPrompt ? { GroupSystemPrompt: groupSystemPrompt } : {}),\n            MyAgentsConfiguredInstructions: configuredGroupPrompt ?? null,"], ["timestamp: entry.timestamp ?? Date.now(),", "timestamp: entry.timestamp ?? null,"]]},
  "weixin": {
    "sha256": "96b7b2fc57758e70c4914138e6ad457edbd0d11a9d778a49a689457946936d64",
    "replacements": [
      [
        "  const ctx = weixinMessageToMsgContext(full, deps.accountId, mediaOpts);",
        "  const ctx = weixinMessageToMsgContext(full, deps.accountId, mediaOpts);\n  ctx.MyAgentsSelfId = full.to_user_id ?? null;"
      ],
      ["        void sendWeixinErrorNotice({", "        if (finalized.MyAgentsDeliveryMode === \"tool_only\") return;\n        void sendWeixinErrorNotice({"],
      [
        "    await replyProgressSender?.finalize();",
        "    if (finalized.MyAgentsDeliveryMode !== \"tool_only\") await replyProgressSender?.finalize();"
      ],
      [
        "    if (debug && contextToken) {",
        "    if (finalized.MyAgentsDeliveryMode !== \"tool_only\" && debug && contextToken) {"
      ],
      [
        "      ? () =>\n          sendTyping({",
        "      ? () => finalized.MyAgentsDeliveryMode === \"tool_only\" ? Promise.resolve() :\n          sendTyping({"
      ]
    ]
  },
  "wecom": {
    "sha256": "dfb905d4172b1104dea4a1356fec9f885259be7db634e0ba42a3be4fd138035f",
    "replacements": [
      [
        "const ctx = { wsClient, frame, state, account, runtime };",
        "const ctx = { wsClient, frame, state, account, runtime, channelContext: ctxPayload };"
      ],
      [
        "async function finishThinkingStream(ctx) {",
        "async function finishThinkingStream(ctx) {\n    if (ctx.channelContext?.MyAgentsDeliveryMode === \"tool_only\") return;"
      ],
      [
        "        // 模板卡片检测与发送（在关闭 thinking 流之前独立处理）",
        "        if (ctxPayload.MyAgentsDeliveryMode === \"tool_only\") { safeCleanup(); return; }\n        // 模板卡片检测与发送（在关闭 thinking 流之前独立处理）"
      ],
      [
        "        // 即使 dispatch 抛异常，也需要处理卡片和关闭 thinking 流",
        "        if (ctxPayload.MyAgentsDeliveryMode === \"tool_only\") { safeCleanup(); return; }\n        // 即使 dispatch 抛异常，也需要处理卡片和关闭 thinking 流"
      ]
    ]
  },
  "lark": {
    "sha256": "ff2b96e3ae665d69ecb403cc63528f591bf90018e4d19e636d713a828c75f7ea",
    "replacements": [
      [
        "        Timestamp: dc.ctx.createTime ?? Date.now(),",
        "        Timestamp: dc.ctx.createTime ?? Date.now(),\n        MyAgentsSourceSentAt: dc.ctx.createTime ?? null,\n        MyAgentsMentions: dc.ctx.mentions ?? [],\n        MyAgentsMentionsSelf: (dc.ctx.mentions ?? []).some(m => m.isBot),"
      ]
    ]
  }
} as const;

export function patchChannelLifecycleSource(source: string, kind: keyof typeof CHANNEL_PATCHES): string | null {
  const patch = CHANNEL_PATCHES[kind];
  if (createHash('sha256').update(source).digest('hex') !== patch.sha256) return null;
  let result = source;
  for (const [before, after] of patch.replacements) {
    if (!result.includes(before)) return null;
    result = result.replaceAll(before, after);
  }
  return result;
}

/** Installed WeCom CLI 2026.9.15 compatibility. Allow only standalone global
 * help flags; every ordinary command still passes the upstream credential guards. */
const WECOM_CLI_PATCHES = {
  argv: {"sha256": "8ce8854434c8c912aee0739bc7467d515132a9b70bdd17406386c3b5a0717bef", "before": "    const head = argv[0];", "after": "    if (argv.length === 1 && (argv[0] === \"--help\" || argv[0] === \"-h\")) return;\n    const head = argv[0];"},
  tool: {"sha256": "85a69c78a96b7d6f12d53cb812127897740a20dffe77bb7514e9cffebb4fd56f", "before": "const errorResult = (message, extra) => textResult({ error: message, ...extra });", "after": "const errorResult = (message, extra) => ({ ...textResult({ error: message, ...extra }), isError: true });"},
} as const;

export function patchWecomCliSource(source: string, kind: keyof typeof WECOM_CLI_PATCHES): string | null {
  const patch = WECOM_CLI_PATCHES[kind];
  if (createHash('sha256').update(source).digest('hex') !== patch.sha256
    || source.split(patch.before).length !== 2) return null;
  return source.replace(patch.before, patch.after);
}
