import { z } from "zod";
import { CHANNEL_HANDOFF_INPUT_INCOMPLETE, channelHandoffInputError, type ChannelWorldRef } from './channelHandoff';

const id = z
  .string()
  .min(1)
  .refine((value) => new TextEncoder().encode(value).length <= 1024);
/** Shared by the CLI and the Session admin endpoint. No caller or
 * delivery-authority fields are accepted from model input. */
export const channelMessageShape = {
  context: z.string().optional().describe('向其他会话交接时必填的事情背景；仅供目标 Session 理解，不作为外发正文。用法见 myagents im send-message --help。'),
  text: z
    .string()
    .optional()
    .describe(
      "要实际发送给收件人的正文。可与附件一起发送；不用于记录仅留在 Session 的分析。",
    ),
  attachments: z
    .array(
      z.strictObject({
        path: z.string().min(1),
        caption: z.string().optional(),
      }),
    )
    .max(32)
    .optional()
    .describe(
      "按顺序发送的本地附件。每项 path 是可读取的绝对路径，caption 仅描述该附件；不是远程下载 URL。",
    ),
  target: z
    .strictObject({ type: z.enum(["user", "chat"]), id, idType: id.optional() })
    .optional()
    .describe(
      "指定本次收件人；当前会话直接发送，其他会话交由目标 Session 转达并须提供 text、context。type/idType 取连接支持值；省略使用当前绑定，不改变后续默认目标。",
    ),
  channelId: id
    .optional()
    .describe(
      "无默认绑定时必填，须属于当前 Agent。已有绑定时只能省略或填写同一连接 ID；不能借此跨连接发送。",
    ),
};
const requestSchema = z
  .strictObject(channelMessageShape)
  .refine(
    (input) => !!input.target || input.context !== undefined || !!input.text?.trim() || !!input.attachments?.length,
    "Provide non-empty text or at least one local attachment.",
  );
export const channelMessageSchema = z.preprocess((input, ctx) => {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;
    const target = value.target as Record<string, unknown> | undefined;
    if ((value.target !== undefined || value.context !== undefined)
      && (!target || typeof target.id !== 'string' || !target.id.trim())) {
      const missing = ['target.id'];
      if (typeof value.text !== 'string' || !value.text.trim()) missing.push('text');
      if (typeof value.context !== 'string' || !value.context.trim()) missing.push('context');
      ctx.addIssue({ code: 'custom', message: channelHandoffInputError(missing), params: { code: CHANNEL_HANDOFF_INPUT_INCOMPLETE, missingFields: missing } });
    } else if (target && !['user', 'chat'].includes(String(target.type))) {
      ctx.addIssue({ code: 'custom', message: 'target.type 必须为 user 或 chat。发送到其他会话时，需要目标 ID、text 和 context；目标 Session 接收背景后转达并承接后续对话。本次未投递、未发送。完整用法：myagents im send-message --help（向其他会话发送）。', params: { code: 'CHANNEL_TARGET_INVALID' } });
    }
  }
  return input;
}, requestSchema);
export type ChannelMessageRequest = z.infer<typeof channelMessageSchema>;
export type ChannelMessageItemResult = {
  kind: "text" | "attachment";
  index: number;
  status: "sent" | "failed" | "unknown" | "not_attempted";
  messageIds?: string[];
  error?: string;
};
export type ChannelDirectMessageResult = {
  status: "sent" | "failed" | "unknown" | "partial";
  connection: { channelId: string; platform: string } | null;
  target: { type: "user" | "chat"; id: string; idType: string } | null;
  items: ChannelMessageItemResult[];
  error?: string;
  code?: string;
  missingFields?: string[];
};
export type ChannelHandoffResult = {
  action: 'handoff';
  status: 'accepted' | 'failed' | 'unknown';
  eventId: string;
  targetSessionId: string;
  connection: ChannelWorldRef['connection'];
  conversation: ChannelWorldRef['conversation'];
  message?: string;
  error?: string;
  code?: string;
};
export type ChannelMessageResult = ChannelDirectMessageResult | ChannelHandoffResult;
