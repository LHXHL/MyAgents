import { createHash, randomUUID } from 'crypto';
import { OPENCODE_GO_PROVIDER_ID } from '../shared/opencode-go';

export const OPENCODE_GO_USER_AGENT = 'MyAgents';
export const OPENCODE_GO_SDK_CLIENT_APP = 'myagents';

/** Never send the local Product Session ID to an external provider. */
export function opencodeGoConversationId(sessionId?: string): string {
  const identity = sessionId || randomUUID();
  return createHash('sha256').update(`myagents:opencode-go:${identity}`).digest('hex');
}

export function opencodeGoHeaders(providerId: string | undefined, conversationId: string | undefined): Record<string, string> {
  return providerId === OPENCODE_GO_PROVIDER_ID && conversationId
    ? { 'User-Agent': OPENCODE_GO_USER_AGENT, 'x-opencode-session': conversationId }
    : {};
}
