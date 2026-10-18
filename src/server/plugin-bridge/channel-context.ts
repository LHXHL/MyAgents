import { emptyChannelContextData } from "../../shared/channelContext";
/** Installed protocol mappings. Do not pass whole plugin contexts: several
 * contain transport tokens, vendor prompts and generated message identifiers. */
export function normalizePluginMessage(
  pluginId: string,
  ctx: Record<string, unknown>,
) {
  const str = (value: unknown): string | null =>
    typeof value === "string" && value ? value : null;
  const wx = pluginId === "openclaw-weixin" || pluginId === "weixin";
  const qq = pluginId === "qqbot";
  const lark = pluginId === "feishu" || pluginId === "openclaw-lark";
  const wecom = pluginId === "wecom" || pluginId === "wecom-openclaw-plugin";
  const senderId =
    str(ctx.SenderId ?? ctx.senderId) ?? (wx ? str(ctx.From) : null) ?? "";
  const senderName = str(ctx.SenderName ?? ctx.senderName);
  const frame = ctx.WeComFrame as { body?: { aibotid?: unknown } } | undefined;
  // To is a reply destination; AccountId can be a configured account key.
  // Only source-protocol actor IDs may populate self.
  const selfId = lark
    ? str(ctx.BotOpenId)
    : wx
      ? str(ctx.MyAgentsSelfId)
      : wecom
        ? str(frame?.body?.aibotid)
        : null;
  // QQ Body carries ASR and attachment summaries that RawBody lacks. The
  // compatibility formatInboundEnvelope already returns its semantic body.
  const text = String(
    (qq
      ? ctx.Body
      : wx || wecom
        ? (ctx.Body ?? ctx.RawBody)
        : lark
          ? (ctx.RawBody ?? ctx.Body)
          : (ctx.BodyForAgent ?? ctx.Body)) ??
      ctx.body ??
      "",
  );
  const timestamp =
    wx || qq ? ctx.Timestamp : lark ? ctx.MyAgentsSourceSentAt : null;
  const date =
    typeof timestamp === "number" && Number.isFinite(timestamp)
      ? new Date(timestamp)
      : null;
  const contextData = emptyChannelContextData();
  if (lark && Array.isArray(ctx.MyAgentsMentions))
    contextData.mentions = ctx.MyAgentsMentions.map((raw) => {
      const item = raw as Record<string, unknown>;
      return {
        id: str(item.openId),
        idType: "open_id",
        name: str(item.name),
        username: null,
        kind: item.isBot === true ? ("bot" as const) : ("unknown" as const),
      };
    });
  if (lark && Array.isArray(ctx.InboundHistory))
    contextData.history = ctx.InboundHistory.map((raw) => {
      const item = raw as Record<string, unknown>;
      const time =
        typeof item.timestamp === "number" ? new Date(item.timestamp) : null;
      return {
        messageId: null,
        sender: {
          id: null,
          idType: null,
          name: str(item.sender),
          username: null,
          kind: "unknown" as const,
        },
        sentAt:
          time && !Number.isNaN(time.getTime()) ? time.toISOString() : null,
        text: str(item.body),
      };
    });
  const mediaPaths = Array.isArray(ctx.MediaPaths)
    ? ctx.MediaPaths
    : ctx.MediaPath
      ? [ctx.MediaPath]
      : [];
  const mediaTypes = Array.isArray(ctx.MediaTypes)
    ? ctx.MediaTypes
    : ctx.MediaType
      ? [ctx.MediaType]
      : [];
  contextData.attachments = mediaPaths.flatMap((path, index) =>
    typeof path === "string"
      ? [
          {
            kind:
              typeof mediaTypes[index] === "string" &&
              (mediaTypes[index] as string).startsWith("image/")
                ? ("image" as const)
                : ("file" as const),
            name: path.split(/[\\/]/).at(-1) || null,
            localPath: path,
            caption: null,
          },
        ]
      : [],
  );
  if (qq) {
    const voicePaths = Array.isArray(ctx.QQVoiceAttachmentPaths)
      ? ctx.QQVoiceAttachmentPaths
      : [];
    for (const path of voicePaths) {
      if (
        typeof path === "string" &&
        path &&
        !contextData.attachments.some((item) => item.localPath === path)
      ) {
        contextData.attachments.push({
          kind: "file",
          name: path.split(/[\\/]/).at(-1) || null,
          localPath: path,
          caption: null,
        });
      }
    }
    const voiceUrls = Array.isArray(ctx.QQVoiceAttachmentUrls)
      ? ctx.QQVoiceAttachmentUrls.filter(
          (value) => typeof value === "string" && value,
        )
      : [];
    if (voiceUrls.length)
      contextData.platformContext.push({
        source: "qq-voice-attachments",
        text: `Remote voice attachments: ${voiceUrls.length} (download URLs omitted).`,
      });
    if (str(ctx.ReplyToId) || str(ctx.ReplyToBody)) {
      contextData.reply = {
        messageId: str(ctx.ReplyToId),
        // The plugin uses senderName ?? senderId, so this field cannot prove an ID.
        sender: str(ctx.ReplyToSender)
          ? {
              id: null,
              idType: null,
              name: str(ctx.ReplyToSender),
              username: null,
              kind: "unknown",
            }
          : null,
        sentAt: null,
        text: str(ctx.ReplyToBody),
      };
    }
  }
  return {
    text,
    senderId,
    // The installed WeCom agent transport copies userid into SenderName.
    senderName: wecom && senderName === senderId ? null : senderName,
    // Lark's GroupSubject is a transport chat ID, not a display name.
    groupName: str(
      lark
        ? (ctx.GroupName ?? ctx.groupName)
        : (ctx.GroupSubject ?? ctx.GroupName ?? ctx.groupName),
    ),
    sourceMetadata: {
      contextData,
      configuredInstructions: lark
        ? str(ctx.MyAgentsConfiguredInstructions)
        : null,
      platformMessageId: str(
        wx
          ? ctx.MessageSidFull
          : (ctx.MessageSid ?? ctx.messageSid ?? ctx.MessageId),
      ),
      sentAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
      senderIdType: wx
        ? "user_id"
        : qq
          ? "openid"
          : lark
            ? "open_id"
            : wecom
              ? "userid"
              : null,
      senderUsername: null,
      senderIsBot:
        typeof ctx.SenderIsBot === "boolean" ? ctx.SenderIsBot : null,
      selfId,
      selfIdType: selfId
        ? lark
          ? "open_id"
          : wx
            ? "user_id"
            : "aibotid"
        : null,
      selfName: null,
      selfUsername: null,
      mentionsSelf:
        typeof ctx.MyAgentsMentionsSelf === "boolean"
          ? ctx.MyAgentsMentionsSelf
          : null,
      replyToSelf:
        typeof ctx.MyAgentsReplyToSelf === "boolean"
          ? ctx.MyAgentsReplyToSelf
          : null,
      threadId: str(ctx.MessageThreadId ?? ctx.threadId),
      parentId: qq ? str(ctx.QQGuildId) : null,
    },
  };
}
