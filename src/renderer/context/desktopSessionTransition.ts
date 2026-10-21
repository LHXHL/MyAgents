import type { NewDesktopSessionResult } from '@/api/sessionHandoverClient';
import { i18n } from '@/i18n';

interface DesktopSessionTransitionOptions {
  sessionId: string;
  tabId: string;
  newDesktopSession: (args: { oldSessionId: string; tabId: string }) => Promise<NewDesktopSessionResult>;
  onNewSidecar?: (sourceSessionId: string) => Promise<boolean>;
  adoptMigratedSession: (newSessionId: string, options: { sidecarAlreadyMigrated: true; newConversation: true }) => Promise<boolean>;
  releaseMigratedTabOwner: (sessionId: string, tabId: string) => Promise<unknown>;
  reportError: (message: string) => void;
}

function desktopTransitionError(): string {
  return String(i18n.t('chat:shell.toasts.newConversationFailed'));
}

/** Adopt only the identity committed by Rust; status polling never authorizes a reset. */
export async function transitionDesktopSession(
  options: DesktopSessionTransitionOptions,
): Promise<boolean> {
  const {
    sessionId,
    tabId,
    newDesktopSession,
    onNewSidecar,
    adoptMigratedSession,
    releaseMigratedTabOwner,
    reportError,
  } = options;
  let migratedSessionId: string | null = null;

  try {
    const result = await newDesktopSession({ oldSessionId: sessionId, tabId });
    if (result.createNewSidecar) return await onNewSidecar?.(sessionId) ?? false;
    migratedSessionId = result.newSessionId;

    if (!migratedSessionId) {
      console.warn('[Chat] newDesktopSession returned no target');
      reportError(desktopTransitionError());
      return false;
    }

    console.log(`[Chat] New conversation: ${sessionId.slice(0, 8)} -> ${migratedSessionId.slice(0, 8)}`);
    const adopted = await adoptMigratedSession(migratedSessionId, { sidecarAlreadyMigrated: true, newConversation: true });
    if (!adopted) {
      throw new Error(`Failed to adopt new session ${migratedSessionId}.`);
    }
    return true;
  } catch (err) {
    console.error('[Chat] Desktop session transition failed:', err);
    if (migratedSessionId) {
      await releaseMigratedTabOwner(migratedSessionId, tabId).catch((releaseError) => {
        console.error('[Chat] Failed to release migrated Tab owner after adoption failure:', releaseError);
      });
    }
    reportError(desktopTransitionError());
    return false;
  }
}
