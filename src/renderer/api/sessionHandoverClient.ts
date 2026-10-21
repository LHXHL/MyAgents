/**
 * sessionHandoverClient — frontend wrappers for session ↔ channel surface
 * commands (PRD 0.2.14).
 *
 * Two operations:
 *   1. newDesktopSession — when desktop user clicks "+新对话", Rust resolves
 *      the current binding and moves the participating Tab and any Channel
 *      binding together when the source is idle and exclusively migratable.
 *      Retained/busy sources keep their binding while App opens a separate conversation.
 *      IM `/new` only rotates the channel binding.
 *
 *   2. handoverSessionToChannel — when desktop user clicks the 📤 button on
 *      a pure desktop session, the chosen channel's binding is replaced to
 *      route to this session. The channel sends a system notification.
 */

import { isTauriEnvironment } from '@/utils/browserMock';

let cachedInvoke: typeof import('@tauri-apps/api/core').invoke | null = null;

async function getInvoke() {
    if (!cachedInvoke) {
        const { invoke } = await import('@tauri-apps/api/core');
        cachedInvoke = invoke;
    }
    return cachedInvoke;
}

export interface NewDesktopSessionResult {
    newSessionId: string | null;
    createNewSidecar: boolean;
}

/** Rust resolves the binding and admits the exact Tab before any Runtime reset. */
export async function newDesktopSession(args: { oldSessionId: string; tabId: string }): Promise<NewDesktopSessionResult> {
    if (!isTauriEnvironment()) throw new Error('New conversations require the desktop Session lifecycle');
    const invoke = await getInvoke();
    return invoke<NewDesktopSessionResult>('cmd_new_desktop_session', args);
}

export interface HandoverArgs {
    /** Session id currently in the desktop tab — this is the session that will become channel-bound */
    sessionId: string;
    agentId: string;
    channelId: string;
    /** Exact peer chat target, e.g. `agent:{agentId}:feishu:group:{chatId}` */
    sessionKey?: string;
    /** Workspace path of the desktop session — must match the Agent's workspacePath */
    workspacePath: string;
}

export interface HandoverResult {
    ok: boolean;
    /** sessionKey assigned to the new binding (caller can use to display) */
    sessionKey: string;
    /** Whether the IM notification reached the channel */
    notified: boolean;
    /** Whether peer-session binding was durably projected to channel state */
    statePersisted?: boolean;
    /** Optional management warning, e.g. binding changed in memory but state persistence failed */
    warning?: string;
}

/**
 * Bind a desktop session to an IM channel. The channel's previous bound
 * session (if any) is replaced — old session is released from the
 * `Agent` Sidecar owner, target session gains the `Agent` owner.
 *
 * Channel adapter sends a notification message to the chat.
 */
export async function handoverSessionToChannel(args: HandoverArgs): Promise<HandoverResult> {
    if (!isTauriEnvironment()) {
        throw new Error('Handover is only available in Tauri environment');
    }
    const invoke = await getInvoke();
    return invoke<HandoverResult>('cmd_handover_session_to_channel', {
        sessionId: args.sessionId,
        agentId: args.agentId,
        channelId: args.channelId,
        sessionKey: args.sessionKey,
        workspacePath: args.workspacePath,
    });
}
