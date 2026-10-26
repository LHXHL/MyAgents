/** Explicit installed-protocol smoke. No real transport is invoked. Run only
 * with MYAGENTS_CHANNEL_PLUGIN_ROOT pointing at an approved plugin install. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { patchChannelLifecycleSource, patchWecomCliSource } from "./plugin-compat-patches";
import { normalizePluginMessage } from "./channel-context";
import { normalizeImInbound } from "../session-core/channel-context";

const root = process.env.MYAGENTS_CHANNEL_PLUGIN_ROOT;
function installed(kind: "weixin" | "wecom", path: string): string {
  const original = readFileSync(join(root!, path), "utf8");
  const patched = patchChannelLifecycleSource(original, kind);
  if (!patched)
    throw new Error(`Installed ${kind} lifecycle patch target not found`);
  return patched;
}
function functions(
  source: string,
  names: string[],
  globals: Record<string, unknown>,
) {
  const ast = ts.createSourceFile(
    "plugin.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const declarations = ast.statements.filter(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      names.includes(statement.name?.text ?? ""),
  );
  expect(declarations).toHaveLength(names.length);
  const code =
    declarations.map((node) => node.getText(ast)).join("\n") +
    `\nexport { ${names.join(",")} };`;
  const exports: Record<string, (...args: unknown[]) => unknown> = {};
  runInNewContext(
    ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText,
    { ...globals, exports },
  );
  return exports;
}

describe.skipIf(!root)("installed plugin lifecycle exits", () => {
  it('WeCom CLI accepts standalone help while preserving credential guards and MCP error status', () => {
    const directory = "wecom-openclaw-plugin/node_modules/@wecom/wecom-openclaw-plugin/dist/src/cli/";
    const argvSource = readFileSync(join(root!, directory, "argv.js"), "utf8");
    const patched = patchWecomCliSource(argvSource, "argv");
    expect(patched).not.toBeNull();
    const constants = readFileSync(join(root!, directory, "const.js"), "utf8");
    const load = (body: string) => {
      const exports: Record<string, unknown> = {};
      runInNewContext(ts.transpileModule(constants + "\n" + body.replace(/^import .*;$/mg, ""), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText, { exports });
      return exports.normalizeArgs as (args: unknown) => string[];
    };
    expect(() => load(argvSource)(["--help"])).toThrow();
    const normalize = load(patched!);
    for (const args of [["--help"], ["-h"], ["help"], ["contact", "--help"], ["message", "--help"]]) {
      expect(normalize(args)).toEqual(args);
    }
    for (const args of [["--help", "--config-dir=/tmp/other"], ["-h", "auth", "init"], ["auth", "init"], ["contact", "--home", "/tmp/other"]]) {
      expect(() => normalize(args)).toThrow();
    }
    const toolSource = patchWecomCliSource(readFileSync(join(root!, directory, "tool.js"), "utf8"), "tool");
    expect(toolSource).not.toBeNull();
    const result = runInNewContext(toolSource!.slice(toolSource!.indexOf("const textResult ="), toolSource!.indexOf("/**", toolSource!.indexOf("const textResult ="))) + '\nerrorResult("synthetic failure");');
    expect(result).toMatchObject({ isError: true, details: { error: "synthetic failure" } });
    expect(patchWecomCliSource(argvSource + "\n// New package build\n", "argv")).not.toBeNull();
  });

  it.each(["single", "group"] as const)(
    "WeCom installed %s context preserves every supplied identity, media and quote fact",
    (chattype) => {
      const source = installed("wecom", "wecom-openclaw-plugin/node_modules/@wecom/wecom-openclaw-plugin/dist/src/monitor.js");
      const core = { channel: {
        routing: { resolveAgentRoute: () => ({ agentId: "agent", accountId: "account", sessionKey: "session" }) },
        session: { resolveStorePath: () => "/fixture/store" },
        reply: { finalizeInboundContext: (value: unknown) => value },
      } };
      const entry = functions(source, ["buildMessageContext"], {
        getWeComRuntime: () => core, CHANNEL_ID: "wecom",
        processDynamicRouting: () => ({ routeModified: false }),
        MEDIA_IMAGE_PLACEHOLDER: "[image]", MEDIA_DOCUMENT_PLACEHOLDER: "[file]",
      });
      const result = entry.buildMessageContext({
        headers: { req_id: "private_request" },
        body: { msgid: "source-message", aibotid: "bot", chattype,
          ...(chattype === "group" ? { chatid: "group-id" } : {}),
          from: { userid: "person" }, response_url: "private_response_url" },
      }, { accountId: "account" }, {}, "hello", [
        { path: "/fixture/photo.jpg", contentType: "image/jpeg" },
        { path: "/fixture/report.pdf", contentType: "application/pdf" },
      ], "quoted text", {}) as { ctxPayload: Record<string, unknown>; chatId: string; chatType: string };
      const normalized = normalizePluginMessage("wecom", result.ctxPayload);
      const inbound = normalizeImInbound({
        botId: "connection", requestId: "request", senderId: normalized.senderId,
        senderName: normalized.senderName ?? undefined,
        groupName: normalized.groupName ?? undefined,
        accountId: String(result.ctxPayload.AccountId),
        replyToBody: String(result.ctxPayload.ReplyToBody),
        receivedAt: "2026-10-17T00:00:00Z", sourceMetadata: normalized.sourceMetadata,
      });
      expect(result.chatId).toBe(chattype === "group" ? "group-id" : "person");
      expect(result.chatType).toBe(chattype === "group" ? "group" : "direct");
      expect(inbound).toMatchObject({
        accountId: "account", platformMessageId: "source-message", sentAt: null,
        self: { id: "bot", idType: "aibotid", name: null, username: null },
        sender: { id: "person", idType: "userid", name: null, username: null },
        conversationName: null, threadId: null, parentId: null,
        mentionsSelf: null, replyToSelf: null,
        data: { attachments: [
          { kind: "image", localPath: "/fixture/photo.jpg" },
          { kind: "file", localPath: "/fixture/report.pdf" },
        ], reply: { text: "quoted text", messageId: null, sender: null, sentAt: null } },
      });
      expect(JSON.stringify(inbound)).not.toMatch(/private_request|private_response_url/);
    },
  );

  it.each(["auto", "tool_only"] as const)(
    "Weixin debug/progress/error/typing settles in %s",
    async (mode) => {
      const source = installed(
        "weixin",
        "openclaw-weixin/node_modules/@tencent-weixin/openclaw-weixin/src/messaging/process-message.ts",
      );
      for (const failure of [false, true]) {
        const send = vi.fn(async () => undefined);
        const cleanup = vi.fn();
        const progress = vi.fn(async () => undefined);
        let typing: { start: () => Promise<void>; stop: () => Promise<void> };
        let dispatcher: {
          onError: (error: Error, info: { kind: string }) => void;
        };
        const noop = () => undefined;
        const globals = {
          MessageItemType: { TEXT: 1, IMAGE: 2, VIDEO: 3, FILE: 4, VOICE: 5 },
          TypingStatus: { TYPING: 1, CANCEL: 2 },
          isDebugMode: () => true,
          logger: { debug: noop, info: noop, warn: noop, error: noop },
          weixinMessageToMsgContext: () => ({
            Body: "hello",
            From: "person",
            To: "person",
          }),
          readFrameworkAllowFromList: () => [],
          loadWeixinAccount: () => ({ userId: "person" }),
          resolveWeixinInboundAuthorization: async () => ({
            senderAllowed: true,
            commandAuthorized: true,
          }),
          resolveStoredQuoteContext: noop,
          getWeixinMessageId: () => null,
          getContextTokenFromMsgContext: () => "synthetic-context",
          setContextToken: noop,
          randomUUID: () => "run",
          resolveReplyProgressMessagesEnabled: () => true,
          WeixinReplyProgressSender: class {
            replyOptions = {};
            finalize = progress;
          },
          loadTypingCallbacksFactory: async () => (options: typeof typing) => {
            typing = options;
            return options;
          },
          sendTyping: send,
          sendMessageWeixin: send,
          sendWeixinErrorNotice: send,
          redactBody: (text: string) => text,
          redactToken: () => "[redacted]",
          withPublishedModelRuntime: (value: unknown) => value,
        };
        const entry = functions(
          source,
          ["extractTextBody", "processOneMessage"],
          globals,
        );
        const execution = entry.processOneMessage(
          { from_user_id: "person", to_user_id: "bot@im.bot", item_list: [] },
          {
            accountId: "account",
            config: {},
            typingTicket: "synthetic-ticket",
            log: noop,
            errLog: noop,
            channelRuntime: {
              routing: {
                resolveAgentRoute: () => ({
                  agentId: "agent",
                  sessionKey: "session",
                }),
              },
              session: {
                resolveStorePath: () => "/test/store",
                recordInboundSession: async () => undefined,
              },
              reply: {
                finalizeInboundContext: (ctx: object) => {
                  expect(ctx).toMatchObject({ MyAgentsSelfId: "bot@im.bot" });
                  return { ...ctx, MyAgentsDeliveryMode: mode };
                },
                resolveHumanDelayConfig: noop,
                createReplyDispatcherWithTyping: (
                  options: typeof dispatcher,
                ) => {
                  dispatcher = options;
                  return {
                    dispatcher: options,
                    replyOptions: {},
                    markDispatchIdle: cleanup,
                  };
                },
                withReplyDispatcher: ({ run }: { run: () => Promise<void> }) =>
                  run(),
                dispatchReplyFromConfig: async () => {
                  await typing.start();
                  await typing.stop();
                  if (failure) {
                    dispatcher.onError(new Error("synthetic failure"), {
                      kind: "final",
                    });
                    throw new Error("synthetic failure");
                  }
                },
              },
            },
          },
        );
        if (failure)
          await expect(execution).rejects.toThrow("synthetic failure");
        else await execution;
        expect(cleanup).toHaveBeenCalledOnce();
        if (mode === "tool_only") {
          expect(send).not.toHaveBeenCalled();
          expect(progress).not.toHaveBeenCalled();
        } else {
          expect(send).toHaveBeenCalled();
          expect(progress).toHaveBeenCalledOnce();
        }
      }
    },
  );

  it.each(["auto", "tool_only"] as const)(
    "Wecom empty/error completion preserves cleanup in %s",
    async (mode) => {
      const source = installed(
        "wecom",
        "wecom-openclaw-plugin/node_modules/@wecom/wecom-openclaw-plugin/dist/src/monitor.js",
      );
      for (const failure of [false, true]) {
        const send = vi.fn(async () => undefined);
        const card = vi.fn(async () => undefined);
        const cleanup = vi.fn();
        const entry = functions(
          source,
          ["routeAndDispatchMessage", "finishThinkingStream"],
          {
            CHANNEL_ID: "wecom",
            getWeComRuntime: () => ({
              channel: {
                session: { recordInboundSession: async () => undefined },
                reply: {
                  dispatchReplyWithBufferedBlockDispatcher: async () => {
                    if (failure) throw new Error("synthetic failure");
                  },
                },
              },
            }),
            sendWeComReply: send,
            processTemplateCardsIfNeeded: card,
          },
        );
        await entry.routeAndDispatchMessage({
          ctxPayload: { MyAgentsDeliveryMode: mode },
          route: {},
          chatId: "chat",
          chatType: "direct",
          config: {},
          account: {},
          wsClient: { sendMessage: send },
          frame: { body: { from: { userid: "person" } } },
          state: { streamId: "stream", accumulatedText: "" },
          runtime: {},
          onCleanup: cleanup,
        });
        expect(cleanup).toHaveBeenCalledOnce();
        if (mode === "tool_only") {
          expect(send).not.toHaveBeenCalled();
          expect(card).not.toHaveBeenCalled();
        } else {
          expect(send).toHaveBeenCalledOnce();
          expect(card).toHaveBeenCalledOnce();
        }
      }
    },
  );
});
