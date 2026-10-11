import { isPendingSessionId } from '@/../shared/constants';
import type { ChatTab } from '@/features/chat/tabContract';
import type { TabPersistenceCodec } from '@/tab-workspace/contracts';

export interface PersistedChatTab {
  view: 'chat';
  id: string;
  agentDir: string;
  sessionId: string;
  title: string;
  discussionId?: string;
}

export const chatTabPersistenceCodec: TabPersistenceCodec<ChatTab, PersistedChatTab> = {
  serialize: (tab) =>
    tab.agentDir.length > 0 && !!tab.sessionId && (!isPendingSessionId(tab.sessionId) || !!tab.discussionId)
      ? {
          view: 'chat',
          id: tab.id,
          agentDir: tab.agentDir,
          sessionId: tab.sessionId,
          title: tab.title,
          ...(tab.discussionId ? { discussionId: tab.discussionId } : {}),
        }
      : null,
  parse: (value) => {
    if (typeof value !== 'object' || value === null) return null;
    const tab = value as Record<string, unknown>;
    if (
      (tab.view === undefined || tab.view === 'chat') &&
      typeof tab.id === 'string' &&
      tab.id.length > 0 &&
      typeof tab.agentDir === 'string' &&
      tab.agentDir.length > 0 &&
      typeof tab.sessionId === 'string' &&
      tab.sessionId.length > 0 &&
      (!isPendingSessionId(tab.sessionId) || (typeof tab.discussionId === 'string' && /^[A-Za-z0-9_-]+$/.test(tab.discussionId))) &&
      typeof tab.title === 'string'
    ) {
      return {
        view: 'chat',
        id: tab.id,
        agentDir: tab.agentDir,
        sessionId: tab.sessionId,
        title: tab.title,
        ...(typeof tab.discussionId === 'string' && /^[A-Za-z0-9_-]+$/.test(tab.discussionId) ? { discussionId: tab.discussionId } : {}),
      };
    }
    return null;
  },
  hydrate: (tab) => ({
    ...tab,
    sidecarConfigDisposition: 'pending',
  }),
  resourceIdentity: (tab) => `chat:${tab.sessionId}`,
};
