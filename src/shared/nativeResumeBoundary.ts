export const NATIVE_RESUME_BOUNDARY_MESSAGE =
  '会话恢复点已失效。本次消息和原有历史已保留；请从更早的消息回溯重试，或新建会话继续。';

/** The SDK alone decides whether a UUID still belongs to its selected chain. */
export function nativeResumeBoundaryRecoveryMessage(error: string): string | null {
  return /No message found with message\.uuid of:/u.test(error)
    ? NATIVE_RESUME_BOUNDARY_MESSAGE
    : null;
}
