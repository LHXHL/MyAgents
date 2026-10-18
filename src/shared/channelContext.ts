import { z } from "zod";
import { escapeSystemReminderText } from "./systemReminder";
import * as prompt from "./channelPrompt";

export const CHANNEL_CONTEXT_TAG = "CHANNEL_CONTEXT";
export const CHANNEL_CONTEXT_MAX_BYTES = 32 * 1024;
const encoder = new TextEncoder();
const identity = z
  .string()
  .min(1)
  .refine((value) => encoder.encode(value).length <= 1024);
const time = z.iso.datetime({ offset: true });
export const channelDeliveryModeSchema = z.enum(["auto", "tool_only"]);
export type ChannelDeliveryMode = z.infer<typeof channelDeliveryModeSchema>;
export type ChannelSendIntent = "automatic" | "explicit" | "control";

/** Mode never grants permissions or replaces the turn's delivery owner. */
export function channelAllowsSend(
  mode: ChannelDeliveryMode,
  intent: ChannelSendIntent,
): boolean {
  return mode === "auto" || intent !== "automatic";
}

export const channelActorSchema = z
  .object({
    id: identity.nullable(),
    idType: identity.nullable(),
    name: z.string().nullable(),
    username: z.string().nullable(),
    kind: z.enum(["human", "bot", "system", "unknown"]),
  })
  .strict();
export type ChannelActor = z.infer<typeof channelActorSchema>;

export const channelTargetSchema = z
  .object({
    channelId: identity,
    type: z.enum(["user", "chat"]),
    id: identity,
    idType: identity,
  })
  .strict();
export type ChannelTarget = z.infer<typeof channelTargetSchema>;

export const channelFactsSchema = z
  .object({
    connection: z
      .object({
        channelId: identity,
        platform: identity,
        accountId: identity.nullable(),
        name: z.string().nullable(),
      })
      .strict()
      .nullable(),
    self: channelActorSchema.nullable(),
    conversation: z
      .object({
        id: identity,
        idType: identity,
        kind: z.enum(["direct", "group", "channel", "unknown"]),
        name: z.string().nullable(),
        visibility: z.enum(["private", "restricted", "public", "unknown"]),
        parentId: identity.nullable(),
        threadId: identity.nullable(),
        groupActivation: z.enum(["always", "mention", "unknown"]).nullable(),
      })
      .strict()
      .nullable(),
    sender: channelActorSchema.nullable(),
    message: z
      .object({
        eventId: identity,
        platformMessageId: identity.nullable(),
        sentAt: time.nullable(),
        receivedAt: time,
        aggregation: z.enum(["single", "batch"]),
        addressedToBot: z.boolean().nullable(),
        mentionsSelf: z.boolean().nullable(),
        replyToSelf: z.boolean().nullable(),
      })
      .strict()
      .nullable(),
    execution: z
      .object({
        source: z.enum([
          "im",
          "desktop",
          "task",
          "heartbeat",
          "goal",
          "session_event",
          "other",
        ]),
        startedAt: time,
        timezone: identity,
      })
      .strict(),
    delivery: z
      .object({
        mode: channelDeliveryModeSchema.nullable(),
        ordinaryOutput: z.enum([
          "forwarded",
          "not_forwarded",
          "caller_managed",
          "suppressed",
        ]),
        defaultTarget: channelTargetSchema.nullable(),
        cliCommand: z.literal("myagents im send-message"),
        targetTypes: z
          .array(
            z
              .object({
                type: z.enum(["user", "chat"]),
                idTypes: z.array(identity),
              })
              .strict(),
          )
          .nullable(),
        mediaTypes: z.array(z.enum(["image", "file"])).nullable(),
        askUserQuestion: z.enum(["native-card", "none"]),
      })
      .strict(),
    projection: z
      .object({
        truncatedFields: z.array(z.string()),
        omitted: z
          .object({
            history: z.number().int().nonnegative(),
            mentions: z.number().int().nonnegative(),
            attachments: z.number().int().nonnegative(),
            parts: z.number().int().nonnegative(),
            platformContext: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((facts, ctx) => {
    const invalid = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    if (facts.execution.source === "im") {
      if (
        !facts.connection ||
        !facts.conversation ||
        !facts.sender ||
        !facts.message ||
        !facts.delivery.defaultTarget
      )
        invalid(
          "IM input requires connection, conversation, sender, message and binding",
        );
    } else if (facts.sender !== null || facts.message !== null)
      invalid("Non-IM input must not borrow an IM sender or message");
    if ((facts.delivery.mode === null) !== (facts.connection === null))
      invalid("Mode and connection must have the same binding scope");
    if (
      !facts.connection &&
      (facts.self ||
        facts.conversation ||
        facts.delivery.defaultTarget ||
        facts.delivery.ordinaryOutput !== "not_forwarded")
    )
      invalid("Unbound input cannot claim a default destination");
    if (
      facts.delivery.mode === "tool_only" &&
      facts.delivery.ordinaryOutput !== "not_forwarded" &&
      facts.delivery.ordinaryOutput !== "suppressed"
    )
      invalid("Tool-only output cannot be forwarded automatically");
    if (
      facts.delivery.defaultTarget &&
      facts.delivery.defaultTarget.channelId !== facts.connection?.channelId
    )
      invalid("Default target belongs to another connection");
  });
export type ChannelFacts = z.infer<typeof channelFactsSchema>;

const messageRefSchema = z
  .object({
    messageId: identity.nullable(),
    sender: channelActorSchema.nullable(),
    sentAt: time.nullable(),
    text: z.string().nullable(),
  })
  .strict();
export const channelContextDataSchema = z
  .object({
    reply: messageRefSchema.nullable(),
    history: z.array(messageRefSchema),
    mentions: z.array(channelActorSchema).nullable(),
    attachments: z.array(
      z
        .object({
          kind: z.enum(["image", "file", "unknown"]),
          name: z.string().nullable(),
          localPath: z.string().nullable(),
          caption: z.string().nullable(),
        })
        .strict(),
    ),
    parts: z.array(
      z
        .object({
          eventId: identity,
          platformMessageId: identity.nullable(),
          sender: channelActorSchema.nullable(),
          sentAt: time.nullable(),
        })
        .strict(),
    ),
    platformContext: z.array(
      z.object({ source: z.string(), text: z.string() }).strict(),
    ),
  })
  .strict();
export type ChannelContextData = z.infer<typeof channelContextDataSchema>;
export type ChannelContext = {
  facts: ChannelFacts;
  data?: ChannelContextData;
  configuredInstructions?: string;
};

export function emptyChannelProjection(): ChannelFacts["projection"] {
  return {
    truncatedFields: [],
    omitted: {
      history: 0,
      mentions: 0,
      attachments: 0,
      parts: 0,
      platformContext: 0,
    },
  };
}

export function emptyChannelContextData(): ChannelContextData {
  return {
    reply: null,
    history: [],
    mentions: null,
    attachments: [],
    parts: [],
    platformContext: [],
  };
}

/** Prompt-only projection: keep the validated internal snapshot complete, but
 * omit unknown fields instead of serializing implementation placeholders. */
function omitUnknownFields(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.length ? value.map(omitUnknownFields) : undefined;
  if (typeof value !== "object") return value;
  const entries = Object.entries(value)
    .map(([key, item]) => [key, omitUnknownFields(item)] as const)
    .filter(([, item]) => item !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Render an instant in the computer timezone captured at turn admission.
 * Keep the underlying timestamps canonical; only model-facing text is localized. */
function localChannelTime(instant: string, timezone: string): string {
  const date = new Date(instant);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
  const offset = part("timeZoneName").replace("GMT", "") || "+00:00";
  // Preserve source fractional precision (platform timestamps may use microseconds).
  const fraction = /\.([0-9]+)(?:Z|[+-]\d{2}:\d{2})$/.exec(instant)?.[1];
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}${fraction ? `.${fraction}` : ""}${offset}`;
}

// JSON is XML element text, not an attribute: quotes need no entity expansion.
function channelJsonText(value: unknown): string {
  return JSON.stringify(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function promptFacts(facts: ChannelFacts): unknown {
  // Execution, delivery and projection remain internal. The model only needs
  // the conversation facts, two compact execution hints and a delivery sentence.
  return omitUnknownFields({
    connection: facts.connection
      ? {
          ...facts.connection,
          source: facts.execution.source,
          time: `${localChannelTime(facts.execution.startedAt, facts.execution.timezone)} (${facts.execution.timezone})`,
        }
      : null,
    self: facts.self,
    conversation: facts.conversation,
    sender: facts.sender,
    message: facts.message ? {
      ...facts.message,
      sentAt: facts.message.sentAt && localChannelTime(facts.message.sentAt, facts.execution.timezone),
      receivedAt: localChannelTime(facts.message.receivedAt, facts.execution.timezone),
    } : null,
  });
}

/** Only the effective delivery status varies per turn. Stable semantics live in
 * CHANNEL_PROMPT so a mode change cannot churn the system prefix. */
export function channelInstruction(facts: ChannelFacts): string {
  const { delivery } = facts;
  if (!delivery.defaultTarget || delivery.mode === null) return "";
  if (delivery.ordinaryOutput === "suppressed") return prompt.CHANNEL_DELIVERY_SUPPRESSED;
  if (delivery.mode === "tool_only") return prompt.CHANNEL_DELIVERY_TOOL_ONLY;
  if (delivery.ordinaryOutput === "caller_managed") return prompt.CHANNEL_DELIVERY_CALLER_MANAGED;
  return delivery.ordinaryOutput === "forwarded"
    ? prompt.CHANNEL_DELIVERY_AUTO
    : prompt.CHANNEL_DELIVERY_SUPPRESSED;
}

/** Caller passes typed product context, never raw user XML. Returns an inner
 * fragment so Goal/Task/mentions can share the existing leading envelope. */
export function buildChannelContext(input: ChannelContext, options?: { factsOnly?: boolean }): string {
  const parsed = channelFactsSchema.safeParse(input.facts);
  const dataResult =
    input.data === undefined
      ? undefined
      : channelContextDataSchema.safeParse(input.data);
  if (!parsed.success || (dataResult && !dataResult.success))
    throw new Error("channel_context_invalid");
  const facts = parsed.data;
  // Capability-only scopes have no conversation context to project.
  if (!facts.delivery.defaultTarget) return "";
  facts.projection = emptyChannelProjection();
  const data = dataResult?.success ? dataResult.data : undefined;
  // Zod parsed copies keep historical input immutable; dates in quoted/history
  // records use the same display timezone as the current message.
  for (const record of [data?.reply, ...(data?.history ?? []), ...(data?.parts ?? [])]) {
    if (record?.sentAt) record.sentAt = localChannelTime(record.sentAt, facts.execution.timezone);
  }
  let configured = input.configuredInstructions ?? "";
  const truncated = new Set(facts.projection.truncatedFields);
  const cut = (
    value: string | null,
    maximum: number,
    path: string,
  ): string | null => {
    if (value === null) return null;
    const points = Array.from(value);
    if (points.length <= maximum) return value;
    truncated.add(path);
    return points.slice(0, maximum).join("");
  };
  const actor = (value: ChannelActor | null, path: string) => {
    if (!value) return;
    value.name = cut(value.name, 256, `${path}.name`);
    value.username = cut(value.username, 256, `${path}.username`);
  };
  actor(facts.self, "self");
  actor(facts.sender, "sender");
  if (facts.connection)
    facts.connection.name = cut(facts.connection.name, 256, "connection.name");
  if (facts.conversation)
    facts.conversation.name = cut(
      facts.conversation.name,
      256,
      "conversation.name",
    );
  configured = cut(configured, 8192, "configuredInstructions") ?? "";
  type ListName = keyof ChannelFacts["projection"]["omitted"];
  const drop = (
    name: ListName,
    maximum: number,
    fromStart = false,
  ): boolean => {
    const list = data?.[name];
    if (!list || list.length <= maximum) return false;
    const removed = list.length - maximum;
    list.splice(fromStart ? 0 : maximum, removed);
    facts.projection.omitted[name] += removed;
    truncated.add(`contextData.${name}`);
    return true;
  };
  if (data) {
    drop("history", 20, true);
    drop("mentions", 64);
    drop("attachments", 32);
    drop("parts", 32);
    drop("platformContext", 4);
    if (data.reply) {
      actor(data.reply.sender, "contextData.reply.sender");
      data.reply.text = cut(data.reply.text, 2048, "contextData.reply.text");
    }
    data.history.forEach((item) => {
      actor(item.sender, "contextData.history.sender");
      item.text = cut(item.text, 1024, "contextData.history.text");
    });
    data.mentions?.forEach((item) => actor(item, "contextData.mentions"));
    data.parts.forEach((item) =>
      actor(item.sender, "contextData.parts.sender"),
    );
    data.attachments.forEach((item) => {
      item.name = cut(item.name, 256, "contextData.attachments.name");
      item.caption = cut(item.caption, 2048, "contextData.attachments.caption");
    });
    data.platformContext.forEach((item) => {
      item.source = cut(
        item.source,
        256,
        "contextData.platformContext.source",
      )!;
      item.text = cut(item.text, 2048, "contextData.platformContext.text")!;
    });
  }
  const render = () => {
    facts.projection.truncatedFields = [...truncated].sort((a, b) => {
      const aa = Array.from(a, (c) => c.codePointAt(0)!);
      const bb = Array.from(b, (c) => c.codePointAt(0)!);
      for (let i = 0; i < Math.min(aa.length, bb.length); i++)
        if (aa[i] !== bb[i]) return aa[i] - bb[i];
      return aa.length - bb.length;
    });
    const lines = [`<${CHANNEL_CONTEXT_TAG} version="1">`];
    const modelFacts = promptFacts(facts);
    if (modelFacts)
      lines.push(
        `<facts>${channelJsonText(modelFacts)}</facts>`,
      );
    const modelData = options?.factsOnly ? undefined : omitUnknownFields(data);
    if (modelData)
      lines.push(
        `<context-data trust="untrusted">${channelJsonText(modelData)}</context-data>`,
      );
    if (!options?.factsOnly && configured)
      lines.push(
        `<configured-instructions source="channel-config">${escapeSystemReminderText(configured)}</configured-instructions>`,
      );
    if (!options?.factsOnly) lines.push(
      "<instruction>", escapeSystemReminderText(channelInstruction(facts)), "</instruction>",
    );
    lines.push(`</${CHANNEL_CONTEXT_TAG}>`);
    return lines.join("\n");
  };
  let result = render();
  const overBudget = () =>
    encoder.encode(result).length > CHANNEL_CONTEXT_MAX_BYTES;
  for (const name of [
    "history",
    "platformContext",
    "reply",
    "attachments",
    "mentions",
    "parts",
  ] as const) {
    while (overBudget()) {
      if (name === "reply") {
        if (!data?.reply?.text) break;
        data.reply.text = null;
        truncated.add("contextData.reply.text");
      } else {
        const list = data?.[name];
        if (!list?.length) break;
        drop(name, list.length - 1, name === "history");
      }
      result = render();
    }
  }
  if (overBudget() && configured) {
    truncated.add("configuredInstructions");
    const points = Array.from(configured);
    let low = 0,
      high = points.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      configured = points.slice(0, middle).join("");
      result = render();
      if (overBudget()) high = middle - 1;
      else low = middle;
    }
    configured = points.slice(0, low).join("");
    result = render();
  }
  if (overBudget()) throw new Error("channel_context_too_large");
  return result;
}

/** Only trusted product builders may set hasProductEnvelope. A raw user tail
 * is never reparsed, so XML in user content cannot become primary context. */
export function decorateChannelQuery(
  text: string,
  context: ChannelContext,
  hasProductEnvelope: boolean,
): string {
  const channel = buildChannelContext(context);
  if (!channel) return text;
  if (hasProductEnvelope && text.startsWith("<system-reminder>")) {
    const end = text.indexOf("</system-reminder>");
    if (end < 0) throw new Error("Invalid product reminder envelope");
    const body = text.slice("<system-reminder>".length, end).trim();
    const tail = text
      .slice(end + "</system-reminder>".length)
      .replace(/^\n/, "");
    // This is projection of a product-owned envelope, not a source/permission
    // decision. Ordinary Session payloads neutralize these structural tags.
    if (body.startsWith('<myagents-session-event ') && body.includes('<channel-handoff>')) {
      if ((body.match(/<instruction>/g) ?? []).length !== 1 || body.includes('<CHANNEL_CONTEXT')) {
        throw new Error('Invalid Channel handoff instruction structure');
      }
      const instructionEnd = body.indexOf('</instruction>');
      if (instructionEnd < 0) throw new Error('Missing Channel handoff instruction');
      const rendered = body.slice(0, instructionEnd).trimEnd()
        + '\n' + escapeSystemReminderText(channelInstruction(context.facts))
        + '\n</instruction>\n' + buildChannelContext(context, { factsOnly: true })
        + body.slice(instructionEnd + '</instruction>'.length);
      return `<system-reminder>\n${rendered}\n</system-reminder>${tail ? `\n${tail}` : ''}`;
    }
    const mentions = body.indexOf("<AGENT_MENTIONS>");
    const prefix = mentions < 0 ? body : body.slice(0, mentions).trimEnd();
    const suffix = mentions < 0 ? "" : body.slice(mentions);
    return `<system-reminder>\n${[prefix, channel, suffix].filter(Boolean).join("\n")}\n</system-reminder>${tail ? `\n${tail}` : ""}`;
  }
  return `<system-reminder>\n${channel}\n</system-reminder>${text ? `\n${text}` : ""}`;
}
