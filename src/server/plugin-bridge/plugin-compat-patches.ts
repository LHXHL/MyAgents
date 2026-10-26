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
    const entry = Object.assign(taskPromise, { admission, activeTasks });
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
 * Keep chatQueues values awaitable for other plugin consumers. Only missing
 * target code prevents a transform; the surrounding module may evolve freely.
 */
export function patchLarkChatQueueSource(source: string): string | null {
  return replaceSourceBlocks(source, [
    [LARK_REGISTER_DISPATCHER, LARK_REGISTER_DISPATCHER_PATCH],
    [LARK_UNREGISTER_DISPATCHER, LARK_UNREGISTER_DISPATCHER_PATCH],
    [LARK_GET_DISPATCHER, LARK_GET_DISPATCHER_PATCH],
    [LARK_ENQUEUE, LARK_ENQUEUE_PATCH],
  ]);
}


/** Known upstream lifecycle exits that send outside dispatcher callbacks.
 * Patches read the exact request context; they never consult a global last mode. */
const CHANNEL_PATCHES = {
  "larkDispatch": {"replacements": [["            ...(groupSystemPrompt ? { GroupSystemPrompt: groupSystemPrompt } : {}),", "            ...(groupSystemPrompt ? { GroupSystemPrompt: groupSystemPrompt } : {}),\n            MyAgentsConfiguredInstructions: configuredGroupPrompt ?? null,"], ["timestamp: entry.timestamp ?? Date.now(),", "timestamp: entry.timestamp ?? null,"]]},
  "weixin": {
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
        "const cardResult = await processTemplateCardsIfNeeded({",
        "if (ctxPayload.MyAgentsDeliveryMode === \"tool_only\") { safeCleanup(); return; }\n        const cardResult = await processTemplateCardsIfNeeded({"
      ]
    ]
  },
  "lark": {
    "replacements": [
      [
        "        Timestamp: dc.ctx.createTime ?? Date.now(),",
        "        Timestamp: dc.ctx.createTime ?? Date.now(),\n        MyAgentsSourceSentAt: dc.ctx.createTime ?? null,\n        MyAgentsMentions: dc.ctx.mentions ?? [],\n        MyAgentsMentionsSelf: (dc.ctx.mentions ?? []).some(m => m.isBot),"
      ]
    ]
  }
} as const;

export function patchChannelLifecycleSource(source: string, kind: keyof typeof CHANNEL_PATCHES): string | null {
  return replaceSourceBlocks(source, CHANNEL_PATCHES[kind].replacements);
}

/** Installed WeCom CLI 2026.9.15 compatibility. Allow only standalone global
 * help flags; every ordinary command still passes the upstream credential guards. */
const WECOM_CLI_PATCHES = {
  argv: {"before": "    const head = argv[0];", "after": "    if (argv.length === 1 && (argv[0] === \"--help\" || argv[0] === \"-h\")) return;\n    const head = argv[0];"},
  tool: {"before": "const errorResult = (message, extra) => textResult({ error: message, ...extra });", "after": "const errorResult = (message, extra) => ({ ...textResult({ error: message, ...extra }), isError: true });"},
} as const;

export function patchWecomCliSource(source: string, kind: keyof typeof WECOM_CLI_PATCHES): string | null {
  const patch = WECOM_CLI_PATCHES[kind];
  return replaceSourceBlocks(source, [[patch.before, patch.after]]);
}

/** WeCom 2026.9.15 uses the same admission/completion boundary as Lark.
 * Its renderer state is local to processWeComMessageNow(entry), so overlapping
 * tasks retain their own frame, stream, callbacks and delivery policy. */
export function patchWecomChatQueueSource(source: string): string | null {
  const before = "export function enqueueWeComChatTask(params) {\n    const { accountId, chatId, task } = params;\n    const key = buildQueueKey(accountId, chatId);\n    const prev = chatQueues.get(key) ?? Promise.resolve();\n    const status = chatQueues.has(key) ? \"queued\" : \"immediate\";\n    const next = prev.then(task, task);\n    chatQueues.set(key, next);\n    const cleanup = () => {\n        if (chatQueues.get(key) === next) {\n            chatQueues.delete(key);\n        }\n    };\n    next.then(cleanup, cleanup);\n    return { status, promise: next };\n}";
  const after = LARK_ENQUEUE_PATCH
    .replace('function enqueueFeishuChatTask', 'export function enqueueWeComChatTask')
    .replace('accountId, chatId, threadId, task', 'accountId, chatId, task')
    .replace('buildQueueKey(accountId, chatId, threadId)', 'buildQueueKey(accountId, chatId)');
  return replaceSourceBlocks(source, [[before, after]]);
}

// Retain upstream transport/queue order,
// but release the ingress lane after the existing Rust bounded queue accepts.
const IM_MONITOR_ADMISSION_PATCHES = {
  "weixin": {
    "before": "        await processOneMessage(full, {\n          accountId,\n          config,\n          channelRuntime,\n          baseUrl,\n          cdnBaseUrl,\n          token,\n          typingTicket: cachedConfig.typingTicket,\n          log: opts.runtime?.log ?? (() => {}),\n          errLog,\n        });",
    "after": "        const admit = (globalThis as any).__myagentsAwaitPluginAdmission;\n        const task = () => processOneMessage(full, {\n          accountId,\n          config,\n          channelRuntime,\n          baseUrl,\n          cdnBaseUrl,\n          token,\n          typingTicket: cachedConfig.typingTicket,\n          log: opts.runtime?.log ?? (() => {}),\n          errLog,\n        });\n        if (admit) {\n          await admit(task, () => errLog('[myagents] weixin request delivery failed'));\n        } else {\n          await task();\n        }"
  },
  "qq": {
    "before": "            await handleMessageFnRef(msg);",
    "after": "            const admit = (globalThis as any).__myagentsAwaitPluginAdmission;\n            const handler = handleMessageFnRef;\n            if (admit) {\n              await admit(() => handler(msg), () => log?.error('[myagents] qq request delivery failed'));\n            } else {\n              await handler(msg);\n            }"
  }
} as const;

export function patchImMonitorAdmissionSource(source: string, kind: keyof typeof IM_MONITOR_ADMISSION_PATCHES): string | null {
  const patch = IM_MONITOR_ADMISSION_PATCHES[kind];
  return replaceSourceBlocks(source, [[patch.before, patch.after]]);
}

/** Match only the code being changed, allowing whitespace and comments between
 * its words. Unrelated source edits and package versions do not gate patches.
 * A group is applied together because its edits share a lifecycle contract. */
function replaceSourceBlocks(source: string, replacements: ReadonlyArray<readonly [string, string]>): string | null {
  let result = source;
  for (const [before, after] of replacements) {
    const pattern = new RegExp(before.trim().split(/\s+/)
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\r\\n]*(?:\\r?\\n|$))*'), 'g');
    if (!pattern.test(result)) return null;
    result = result.replace(pattern, () => after.trim());
  }
  return result;
}
