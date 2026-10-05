import { emit } from '@tauri-apps/api/event';
import { isTauriEnvironment } from '@/utils/browserMock';

/**
 * Window event fired after a renderer-side config write actually lands on
 * disk. ConfigProvider listens to refresh React state so downstream consumers
 * (e.g. Chat's MCP sync, Settings panels) see the new values without a manual
 * reload.
 *
 * Shared with the SSE bridge in TabProvider that forwards admin-CLI changes —
 * both code paths funnel through ConfigProvider's single window listener.
 * Issue #303: env-only edits (mcpServerEnv) used to write to disk silently,
 * leaving the live Chat sidecar with a stale `currentMcpServers` snapshot
 * (no MINERU_API_KEY) until the user happened to switch tabs.
 */
export const CONFIG_CHANGED_EVENT = 'myagents:config-changed';

/**
 * Single sanctioned dispatcher for CONFIG_CHANGED_EVENT. Every renderer code
 * path that wants ConfigProvider to refresh MUST route through here — including
 * the SSE bridge in TabProvider that forwards admin-CLI config edits — so the
 * event contract stays "no AppConfig payload, ever". A window-level CustomEvent
 * is observable by every other listener attached to the renderer (analytics
 * SDKs, browser extensions, dev tooling); leaking providerApiKeys or
 * mcpServerEnv in `detail` would be a real exfiltration risk. ConfigProvider's
 * listener re-reads from disk, so no consumer needs the payload anyway.
 */
export function notifyConfigChanged(reason: string, options: { native?: boolean } = {}): void {
    if (typeof window === 'undefined') return;
    // App-owned consumers (including the network actor) cannot observe DOM events.
    // SSE is already fanned out by the native producer and only refreshes this window.
    if (options.native !== false && isTauriEnvironment()) {
        void emit('app:config-changed').catch(error => {
            console.warn('[configService] App configuration notification failed:', error);
        });
    }
    try {
        window.dispatchEvent(new CustomEvent(CONFIG_CHANGED_EVENT, { detail: { reason } }));
    } catch {
        // Older webview / non-Custom-Event environments — fall back to a bare Event.
        window.dispatchEvent(new Event(CONFIG_CHANGED_EVENT));
    }
}

export type ConfigChangeNotification = 'immediate' | 'deferred';
