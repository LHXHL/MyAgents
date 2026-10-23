/** Bridge transport for Runtime-owned questions; no second pending-question registry. */
export interface LarkQuestionContext {
  senderId?: string;
  payload: string;
  rawEvent: { action?: { value?: { rid?: string; answers?: Record<string, string> } } };
}

/** Lark resolves API business errors with an empty ID instead of rejecting the send. */
export function larkQuestionDeliveryResponse(result: { messageId?: string }): Response {
  return result.messageId
    ? Response.json({ ok: true, messageId: result.messageId })
    : Response.json({ ok: false }, { status: 502 });
}

export async function forwardLarkQuestion(
  context: LarkQuestionContext,
  forward: (response: { requestId: string; userId: string; answers: Record<string, string> | null }) => Promise<void>,
) {
  const value = context.rawEvent.action?.value;
  if (!value?.rid || !context.senderId || !['answer', 'cancel'].includes(context.payload)) {
    return { toast: { type: 'error', content: '无法识别本次回答，请直接回复文字。' } };
  }
  if (context.payload === 'answer' && (!value.answers || !Object.values(value.answers).every(answer => typeof answer === 'string'))) {
    return { toast: { type: 'error', content: '答案无效，请直接回复文字。' } };
  }
  await forward({ requestId: value.rid, userId: context.senderId, answers: context.payload === 'cancel' ? null : value.answers! });
  // Admission to Rust is not Runtime acceptance. The pending owner updates the card after acceptance.
  return { toast: { type: 'info', content: '回答已收到' } };
}
