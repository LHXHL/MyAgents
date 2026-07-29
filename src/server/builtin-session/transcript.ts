import type { SessionMessage } from '../types/session';
import type { MessageWire } from './types';

const messages: MessageWire[] = [];
let messageSequence = 0;
let lastPersistedIndex = 0;
const persistedSessionMessageCache: SessionMessage[] = [];
const persistChainBySession = new Map<string, Promise<void>>();
const authoritativeRewritePendingSessions = new Set<string>();
const currentSessionUuids = new Set<string>();
const liveSessionUuids = new Set<string>();
let pendingReloadAnchor: string | undefined = undefined;

export const transcriptState = {
  messages,
  get messageSequence(): number {
    return messageSequence;
  },
  set messageSequence(value: number) {
    messageSequence = value;
  },
  get lastPersistedIndex(): number {
    return lastPersistedIndex;
  },
  set lastPersistedIndex(value: number) {
    lastPersistedIndex = value;
  },
  persistedSessionMessageCache,
  persistChainBySession,
  currentSessionUuids,
  liveSessionUuids,
  get pendingReloadAnchor(): string | undefined {
    return pendingReloadAnchor;
  },
  set pendingReloadAnchor(anchor: string | undefined) {
    pendingReloadAnchor = anchor;
  },
};

export function nextMessageSequence(): number {
  messageSequence += 1;
  return messageSequence;
}

export function allocateMessageId(): string {
  const id = String(messageSequence);
  messageSequence += 1;
  return id;
}

export function getMessageSequence(): number {
  return messageSequence;
}

export function setMessageSequence(value: number): void {
  messageSequence = value;
}

export function getMessages(): MessageWire[] {
  return messages;
}

export function getLastAssistantMessageId(): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].id;
  }
  return null;
}

export function appendMessage(message: MessageWire): void {
  messages.push(message);
}

export function bindSdkUuidToLatestUnboundUserMessage(sdkUuid: string): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && !messages[i].sdkUuid) {
      messages[i].sdkUuid = sdkUuid;
      return messages[i].id;
    }
  }
  return null;
}

export function bindSdkUuidToMessage(message: MessageWire, sdkUuid: string): string {
  message.sdkUuid = sdkUuid;
  return message.id;
}

export function removeMessageAt(index: number): MessageWire[] {
  return messages.splice(index, 1);
}

export function replaceMessages(nextMessages: MessageWire[]): void {
  messages.length = 0;
  messages.push(...nextMessages);
}

export function clearMessages(): void {
  messages.length = 0;
}

export function truncateMessages(length: number): void {
  messages.length = Math.max(0, length);
}

export function getLastPersistedIndex(): number {
  return lastPersistedIndex;
}

export function setLastPersistedIndex(value: number): void {
  lastPersistedIndex = value;
}

export function getPersistedSessionMessageCache(): SessionMessage[] {
  return persistedSessionMessageCache;
}

export function appendPersistedSessionMessage(message: SessionMessage): void {
  persistedSessionMessageCache.push(message);
}

export function removePersistedSessionMessageAt(index: number): SessionMessage[] {
  return persistedSessionMessageCache.splice(index, 1);
}

export function replacePersistedSessionMessageCache(nextMessages: SessionMessage[]): void {
  persistedSessionMessageCache.length = 0;
  persistedSessionMessageCache.push(...nextMessages);
}

export function clearPersistedSessionMessageCache(): void {
  persistedSessionMessageCache.length = 0;
}

export function truncatePersistedSessionMessageCache(length: number): void {
  persistedSessionMessageCache.length = Math.max(0, length);
}

export function getPersistChain(sessionId: string): Promise<void> | undefined {
  return persistChainBySession.get(sessionId);
}

export function setPersistChain(sessionId: string, chain: Promise<void>): void {
  persistChainBySession.set(sessionId, chain);
}

export function deletePersistChain(sessionId: string): void {
  persistChainBySession.delete(sessionId);
}

export function clearPersistChains(): void {
  persistChainBySession.clear();
}

export function markAuthoritativeRewritePending(sessionId: string): void {
  authoritativeRewritePendingSessions.add(sessionId);
}

export function clearAuthoritativeRewritePending(sessionId: string): void {
  authoritativeRewritePendingSessions.delete(sessionId);
}

export function hasAuthoritativeRewritePending(sessionId: string): boolean {
  return authoritativeRewritePendingSessions.has(sessionId);
}

export function getCurrentSessionUuids(): Set<string> {
  return currentSessionUuids;
}

export function getLiveSessionUuids(): Set<string> {
  return liveSessionUuids;
}

export function clearCurrentSessionUuids(): void {
  currentSessionUuids.clear();
}

export function clearLiveSessionUuids(): void {
  liveSessionUuids.clear();
}

export function addCurrentSessionUuid(uuid: string | undefined): void {
  if (uuid) currentSessionUuids.add(uuid);
}

export function addLiveSessionUuid(uuid: string | undefined): void {
  if (uuid) liveSessionUuids.add(uuid);
}

export function deleteCurrentSessionUuid(uuid: string | undefined): void {
  if (uuid) currentSessionUuids.delete(uuid);
}

export function deleteLiveSessionUuid(uuid: string | undefined): void {
  if (uuid) liveSessionUuids.delete(uuid);
}

export function setPendingReloadAnchor(anchor: string | undefined): void {
  pendingReloadAnchor = anchor;
}

export function getPendingReloadAnchor(): string | undefined {
  return pendingReloadAnchor;
}

export function clearTranscriptState(): void {
  messages.length = 0;
  messageSequence = 0;
  lastPersistedIndex = 0;
  persistedSessionMessageCache.length = 0;
  currentSessionUuids.clear();
  liveSessionUuids.clear();
  pendingReloadAnchor = undefined;
}

export function snapshotTranscript() {
  return {
    messages: [...messages],
    messageSequence,
    lastPersistedIndex,
    persistedSessionMessageCache: [...persistedSessionMessageCache],
    currentSessionUuids: new Set(currentSessionUuids),
    liveSessionUuids: new Set(liveSessionUuids),
    pendingReloadAnchor,
    persistChainSessionIds: [...persistChainBySession.keys()],
    authoritativeRewritePendingSessionIds: [...authoritativeRewritePendingSessions],
  };
}

export function resetTranscriptForTest(): void {
  clearTranscriptState();
  persistChainBySession.clear();
  authoritativeRewritePendingSessions.clear();
}
