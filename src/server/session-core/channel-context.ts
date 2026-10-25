import type { AskUserQuestionHostCapability } from "../../shared/types/hostInteraction";
import { z } from "zod";
import {
  channelActorSchema,
  channelContextDataSchema,
  channelDeliveryModeSchema,
  channelTargetSchema,
  emptyChannelContextData,
  emptyChannelProjection,
  type ChannelContext,
  type ChannelFacts,
} from "../../shared/channelContext";
import { readChannelScope } from "../tools/channel-messaging";
import type { TurnChannelDelivery } from "./channel-delivery";

const channelSchema = z.object({
  channelId: z.string(),
  platform: z.string(),
  name: z.string().nullable(),
  mode: channelDeliveryModeSchema,
  groupActivation: z.string().nullable(),
  targetTypes: z.array(
    z.object({ type: z.enum(["user", "chat"]), idTypes: z.array(z.string()) }),
  ),
  mediaTypes: z.array(z.enum(["image", "file"])),
});
const scopeSchema = z.object({
  conversationRef: z.object({ channelId: z.string().min(1), sessionKey: z.string().min(1) }).nullable().optional(),
  channels: z.array(channelSchema),
  defaultTarget: channelTargetSchema.nullable(),
  sourceType: z.enum(["private", "group"]).nullable(),
  bindingName: z.string().nullable().optional(),
});

/** Event facts supplied only by the accepted IM protocol, never by tool input. */
export const channelInboundSchema = z
  .object({
    channelId: z.string().min(1),
    accountId: z.string().nullable(),
    self: channelActorSchema.nullable(),
    sender: channelActorSchema,
    eventId: z.string().min(1),
    platformMessageId: z.string().nullable(),
    sentAt: z.string().nullable(),
    receivedAt: z.string(),
    conversationName: z.string().nullable(),
    threadId: z.string().nullable(),
    parentId: z.string().nullable(),
    addressedToBot: z.boolean().nullable(),
    mentionsSelf: z.boolean().nullable(),
    replyToSelf: z.boolean().nullable(),
    data: channelContextDataSchema.optional(),
    configuredInstructions: z.string().optional(),
  })
  .strict();
export type ChannelInbound = z.infer<typeof channelInboundSchema>;

/** Projection from Rust's accepted event, deliberately enumerating fields so
 * transport credentials and arbitrary plugin properties cannot enter prompts. */
export function normalizeImInbound(input: {
  botId?: string;
  requestId: string;
  senderId?: string;
  senderName?: string;
  accountId?: string;
  receivedAt?: string;
  groupName?: string;
  isMention?: boolean;
  sourceMetadata?: Record<string, unknown>;
  replyToBody?: string;
  pendingHistory?: string;
  groupSystemPrompt?: string;
}): ChannelInbound {
  const meta = input.sourceMetadata ?? {};
  const string = (key: string) =>
    typeof meta[key] === "string" && meta[key] ? (meta[key] as string) : null;
  const boolean = (key: string) =>
    typeof meta[key] === "boolean" ? (meta[key] as boolean) : null;
  const data =
    meta.contextData == null
      ? emptyChannelContextData()
      : channelContextDataSchema.parse(meta.contextData);
  if (Array.isArray(meta.parts))
    data.parts = meta.parts.map((part) => {
      const p = z
        .object({
          eventId: z.string(),
          platformMessageId: z.string().nullable(),
          senderId: z.string(),
          senderName: z.string().nullable(),
          senderUsername: z.string().nullable(),
          senderIsBot: z.boolean().nullable(),
          sentAt: z.string().nullable(),
        })
        .parse(part);
      return {
        eventId: p.eventId,
        platformMessageId: p.platformMessageId,
        sentAt: p.sentAt,
        sender: {
          id: p.senderId || null,
          idType: string("senderIdType"),
          name: p.senderName,
          username: p.senderUsername,
          kind:
            p.senderIsBot === true
              ? ("bot" as const)
              : p.senderIsBot === false
                ? ("human" as const)
                : ("unknown" as const),
        },
      };
    });
  if (input.replyToBody)
    data.reply = {
      messageId: data.reply?.messageId ?? null,
      sender: data.reply?.sender ?? null,
      sentAt: data.reply?.sentAt ?? null,
      text: input.replyToBody,
    };
  if (input.pendingHistory)
    data.platformContext.push({
      source: "existing-group-history",
      text: input.pendingHistory,
    });
  // Plugin GroupSystemPrompt may mix vendor instructions and config. It is
  // provenance-bearing data until the config owner provides a typed value.
  if (input.groupSystemPrompt)
    data.platformContext.push({
      source: "plugin-group-context",
      text: input.groupSystemPrompt,
    });
  return channelInboundSchema.parse({
    channelId: input.botId,
    accountId: input.accountId || null,
    self: string("selfId")
      ? {
          id: string("selfId"),
          idType: string("selfIdType"),
          name: string("selfName"),
          username: string("selfUsername"),
          kind: "bot",
        }
      : null,
    sender: {
      id: input.senderId || null,
      idType: string("senderIdType"),
      name: input.senderName || null,
      username: string("senderUsername"),
      kind:
        boolean("senderIsBot") === true
          ? "bot"
          : boolean("senderIsBot") === false
            ? "human"
            : "unknown",
    },
    eventId: input.requestId,
    platformMessageId: string("platformMessageId"),
    sentAt: string("sentAt"),
    receivedAt: input.receivedAt,
    conversationName: input.groupName || null,
    threadId: string("threadId"),
    parentId: string("parentId"),
    addressedToBot: input.isMention ?? null,
    mentionsSelf: boolean("mentionsSelf"),
    replyToSelf: boolean("replyToSelf"),
    data,
    configuredInstructions: string("configuredInstructions") ?? undefined,
  });
}
export type ChannelTurnSnapshot = {
  scope: z.infer<typeof scopeSchema>;
  startedAt: string;
  timezone: string;
  askUserQuestion: AskUserQuestionHostCapability;
};

export function channelInputSource(
  source: string | undefined,
  requestId?: string,
  origin?: { kind: string; surface: string },
  owner?: { kind: string },
  inbox = false,
): ChannelFacts["execution"]["source"] {
  if (requestId) return "im";
  if (inbox || origin?.kind === "session-inbox") return "session_event";
  if (owner?.kind === "goal") return "goal";
  if (origin?.surface === "channel_heartbeat") return "heartbeat";
  if (origin?.kind === "automation") return "task";
  if (origin?.kind === "desktop" || source === "floating_ball")
    return "desktop";
  if (source === "cron" || source === "task" || source === "cron-task")
    return "task";
  if (source === "heartbeat" || source === "goal" || source === "desktop")
    return source;
  if (source === "inbox" || source === "session_event") return "session_event";
  return "other";
}

export async function captureChannelTurn(
  askUserQuestion: AskUserQuestionHostCapability,
): Promise<ChannelTurnSnapshot | null> {
  const scope = await readChannelScope();
  if (!scope) return null;
  const parsed = scopeSchema.parse(scope);
  // Agent-wide send capabilities do not establish this Session's conversation.
  if (!parsed.defaultTarget) return null;
  if (!parsed.channels.some((channel) => channel.channelId === parsed.defaultTarget!.channelId))
    throw new Error("channel_context_invalid: binding has no matching connection");
  return {
    scope: parsed,
    startedAt: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    askUserQuestion,
  };
}

export function effectiveChannelDelivery(
  snapshot: ChannelTurnSnapshot | null,
  owner: TurnChannelDelivery,
): TurnChannelDelivery {
  const channel = snapshot?.scope.channels.find(
    (channel) => channel.channelId === snapshot.scope.defaultTarget?.channelId,
  );
  return { ...owner, mode: channel?.mode ?? "auto" };
}

export function channelContextForInput(
  snapshot: ChannelTurnSnapshot,
  delivery: TurnChannelDelivery,
  source: ChannelFacts["execution"]["source"],
  inbound?: ChannelInbound,
): ChannelContext {
  const { scope } = snapshot;
  const binding = scope.defaultTarget;
  const channel = scope.channels.find(
    (channel) => channel.channelId === binding?.channelId,
  );
  if (source === "im" && (!inbound || inbound.channelId !== binding?.channelId))
    throw new Error(
      "channel_context_invalid: IM event and Session binding disagree",
    );
  const isIm = source === "im";
  const group = scope.sourceType === "group";
  const facts: ChannelFacts = {
    connection: channel
      ? {
          channelId: channel.channelId,
          platform: channel.platform,
          accountId: isIm ? inbound!.accountId : null,
          name: channel.name,
        }
      : null,
    self: isIm ? inbound!.self : null,
    conversation: binding
      ? {
          id: binding.id,
          idType: binding.idType,
          kind:
            binding.idType === "channel_id"
              ? "channel"
              : group
                ? "group"
                : "direct",
          name: isIm ? inbound!.conversationName : scope.bindingName ?? null,
          visibility:
            binding.idType === "channel_id"
              ? "unknown"
              : group
                ? "restricted"
                : "private",
          parentId: isIm ? inbound!.parentId : null,
          threadId: isIm ? inbound!.threadId : null,
          groupActivation: group
            ? channel?.groupActivation === "always"
              ? "always"
              : channel?.groupActivation === "mention"
                ? "mention"
                : "unknown"
            : null,
        }
      : null,
    sender: isIm ? inbound!.sender : null,
    message: isIm
      ? {
          eventId: inbound!.eventId,
          platformMessageId: inbound!.platformMessageId,
          sentAt: inbound!.sentAt,
          receivedAt: inbound!.receivedAt,
          aggregation:
            (inbound!.data?.parts.length ?? 0) > 1 ? "batch" : "single",
          addressedToBot: inbound!.addressedToBot,
          mentionsSelf: inbound!.mentionsSelf,
          replyToSelf: inbound!.replyToSelf,
        }
      : null,
    execution: {
      source,
      startedAt: snapshot.startedAt,
      timezone: snapshot.timezone,
    },
    delivery: {
      mode: channel?.mode ?? null,
      ordinaryOutput:
        !channel ? "not_forwarded"
          : delivery.assistant === "none" ? "suppressed"
          : delivery.mode === "tool_only" ? "not_forwarded"
          : delivery.assistant === "caller-owned" ? "caller_managed"
          : "forwarded",
      defaultTarget: binding,
      cliCommand: "myagents im send-message",
      targetTypes: channel?.targetTypes ?? null,
      mediaTypes: channel?.mediaTypes ?? null,
      askUserQuestion: snapshot.askUserQuestion,
    },
    projection: emptyChannelProjection(),
  };
  return {
    facts,
    data: isIm ? inbound!.data : emptyChannelContextData(),
    configuredInstructions: isIm ? inbound!.configuredInstructions : undefined,
  };
}

export { decorateChannelQuery } from "../../shared/channelContext";
