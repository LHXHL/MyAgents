import { z } from 'zod';

/** Product-owned identities. A sending model supplies only target/text/context. */
export const channelWorldRefSchema = z.strictObject({
  connection: z.strictObject({
    channelId: z.string().min(1),
    platform: z.string().min(1),
    name: z.string().optional(),
  }),
  conversation: z.strictObject({
    id: z.string().min(1),
    idType: z.string().min(1),
    kind: z.enum(['direct', 'group', 'channel']),
    name: z.string().optional(),
    visibility: z.enum(['private', 'restricted', 'public']).optional(),
    parentId: z.string().optional(),
    threadId: z.string().optional(),
  }),
});

export const channelHandoffSchema = z.strictObject({
  source: channelWorldRefSchema.optional(),
  target: channelWorldRefSchema,
  context: z.string().trim().min(1),
  attachments: z.array(z.strictObject({
    path: z.string().min(1), name: z.string().min(1), mimeType: z.string().min(1),
    image: z.boolean(), caption: z.string().optional(),
  })).max(32).optional(),
});
export type ChannelWorldRef = z.infer<typeof channelWorldRefSchema>;
export type ChannelHandoff = z.infer<typeof channelHandoffSchema>;

export const CHANNEL_HANDOFF_INPUT_INCOMPLETE = 'CHANNEL_HANDOFF_INPUT_INCOMPLETE';
export function channelHandoffInputError(missingFields: readonly string[]): string {
  return `无法提交跨会话消息：缺少 ${missingFields.join('、')}。\n` +
    '发送给其他私聊、群聊或频道时，需要 target.id、text、context：\n' +
    '目标 Session 会先接收发送内容和事情背景，再替你告知该会话用户并承接后续对话。\n' +
    '请补齐目标 ID、待告知内容和事情上下文；本次未投递、未发送。\n' +
    '完整用法与示例：myagents im send-message --help（向其他会话发送）。';
}
