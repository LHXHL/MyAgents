import { getSessionEngine } from '../session-engine';
import { getSessionMetadata, updateSessionMetadata } from '../SessionStore';
import { peerProfileFromSession } from '../utils/peer-profile';
import { modelContext, imSnapshotObservation, sessionEffortChoices } from './im-model-selection';
import { getAllMcpServers, getEnabledMcpServerIds, resolveWorkspaceConfig } from '../utils/admin-config';
import { buildSessionSnapshotPatchUpdates } from '../utils/session-snapshot-patch';
import { snapshotForImRuntimeSwitch } from '../utils/session-snapshot';
import { OFFICIAL_TOOLS, normalizeOfficialToolIds } from '../../shared/official-tools';
import { listInstalledPlugins } from '../plugins/store';
import { broadcast } from '../sse';
import { canManageSessionExtensions } from '../../shared/teamAi';
import { VALID_RUNTIMES, type RuntimeType } from '../../shared/types/runtime';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** This surface edits only Product Session state. Agent defaults have no writer here. */
export async function handleTeamSessionConfigRoute(path: string, request: Request): Promise<Response | null> {
  if (path === '/api/im/peer-profile' && request.method === 'GET') {
    // Read-only projection for the Rust peer-profile owner; Rust decides whether to store it.
    const metadata = getSessionMetadata(new URL(request.url).searchParams.get('sessionId') ?? '');
    if (!metadata?.configSnapshotAt) return json({ success: false, error: 'Session configuration is not owned yet' }, 409);
    return json({ success: true, profile: peerProfileFromSession(metadata) });
  }
  if (path !== '/api/im/session-tools' && path !== '/api/im/session-runtime' && path !== '/api/im/session-effort') return null;
  try {
    const url = new URL(request.url);
    const body = request.method === 'GET' ? Object.fromEntries(url.searchParams) : await request.json() as Record<string, unknown>;
    if (typeof body.agentId !== 'string' || typeof body.sessionId !== 'string') return json({ success: false, error: 'Agent and Session are required' }, 400);
    const context = await modelContext(body.agentId, body.sessionId);
    const metadata = context.metadata!;
    if (request.method === 'GET' && path === '/api/im/session-tools') {
      return json({ success: true, canManageExtensions: canManageSessionExtensions(metadata.runtime, metadata.runtimeSource), snapshotObservation: imSnapshotObservation(metadata),
        mcp: getAllMcpServers(context.config).filter(s => getEnabledMcpServerIds(context.config).includes(s.id) || metadata.mcpEnabledServers?.includes(s.id)).map(s => ({ id: s.id, name: s.name })),
        plugins: listInstalledPlugins().map(p => ({ id: p.id, name: p.name })),
        official: OFFICIAL_TOOLS.map(t => ({ id: t.id, name: t.name })),
        mcpEnabledServers: metadata.mcpEnabledServers ?? [], enabledPluginIds: metadata.enabledPluginIds ?? [], enabledOfficialToolIds: metadata.enabledOfficialToolIds ?? [] });
    }
    if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
    if (imSnapshotObservation(metadata) !== body.snapshotObservation) return json({ success: false, error: 'Session configuration changed; refresh before saving' }, 409);
    if (path === '/api/im/session-runtime') {
      if (typeof body.runtime !== 'string' || !(VALID_RUNTIMES as readonly string[]).includes(body.runtime)) return json({ success: false, error: 'Invalid Runtime' }, 400);
      const birth = snapshotForImRuntimeSwitch(metadata, body.runtime as RuntimeType);
      return json({ success: true, requiresNewSession: true, birth: { agentDir: context.workspacePath,
        runtime: birth.runtime, runtimeSource: birth.runtimeSource,
        runtimeSwitchSourceSessionId: metadata.id, runtimeSwitchObservation: body.snapshotObservation,
        origin: { kind: 'agent-channel', surface: 'channel_message' } } });
    }
    const engine = getSessionEngine();
    if (engine.getCurrentSessionContext().sessionId !== metadata.id) return json({ success: false, error: 'Session binding changed' }, 409);
    if (path === '/api/im/session-effort') {
      const choices = sessionEffortChoices(context);
      if (typeof body.effort !== 'string' || !choices?.length || (body.effort !== 'default' && !choices.includes(body.effort))) return json({ success: false, error: 'Reasoning effort is unavailable for this model' }, 409);
      const updated = await updateSessionMetadata(metadata.id,
        buildSessionSnapshotPatchUpdates({ existing: metadata, payload: { reasoningEffort: body.effort }, nowIso: new Date().toISOString() }),
        current => engine.getCurrentSessionContext().sessionId === metadata.id && imSnapshotObservation(current) === body.snapshotObservation);
      if (!updated) return json({ success: false, error: 'Session configuration changed' }, 409);
      broadcast('chat:session-config-changed', { sessionId: updated.id });
      try {
        if (engine.getCurrentSessionContext().sessionId !== metadata.id) throw new Error('Session binding changed after saving');
        const applied = await engine.updateReasoningEffort(body.effort);
        return json({ success: applied.success, sessionConfig: 'saved', runtimeApply: applied.success ? engine.isBusy() ? 'deferred' : 'applied' : 'failed', error: applied.error }, applied.success ? 200 : 500);
      } catch (error) { return json({ success: false, sessionConfig: 'saved', runtimeApply: 'failed', error: error instanceof Error ? error.message : 'Runtime apply failed' }, 500); }
    }
    const keys = ['mcpEnabledServers', 'enabledPluginIds', 'enabledOfficialToolIds'] as const;
    const patch: { mcpEnabledServers?: string[]; enabledPluginIds?: string[]; enabledOfficialToolIds?: ReturnType<typeof normalizeOfficialToolIds> } = {};
    for (const key of keys) {
      const value = body[key];
      if (value !== undefined && key !== 'enabledOfficialToolIds' && !canManageSessionExtensions(metadata.runtime, metadata.runtimeSource)) return json({ success: false, error: 'This Runtime manages MCP and plugins in its CLI configuration' }, 409);
      if (value === undefined) continue;
      if (!Array.isArray(value) || !value.every(id => typeof id === 'string')) return json({ success: false, error: 'Tool selection must be an array of IDs' }, 400);
      const allowed = key === 'mcpEnabledServers' ? getAllMcpServers(context.config).map(s => s.id)
        : key === 'enabledPluginIds' ? listInstalledPlugins().map(p => p.id) : OFFICIAL_TOOLS.map(t => t.id);
      if (value.some(id => !allowed.includes(id) && !(metadata[key] ?? []).includes(id as never))) return json({ success: false, error: 'Selected tool is unavailable' }, 409);
      if (key === 'enabledOfficialToolIds') patch[key] = normalizeOfficialToolIds(value);
      else patch[key] = [...new Set(value)];
    }
    if (Object.keys(patch).length === 0) return json({ success: false, error: 'No tool selection provided' }, 400);
    const updated = await updateSessionMetadata(metadata.id,
      buildSessionSnapshotPatchUpdates({ existing: metadata, payload: patch, nowIso: new Date().toISOString() }),
      current => engine.getCurrentSessionContext().sessionId === metadata.id && imSnapshotObservation(current) === body.snapshotObservation);
    if (!updated) return json({ success: false, error: 'Session configuration changed' }, 409);
    broadcast('chat:session-config-changed', { sessionId: updated.id });
    try {
      if (engine.getCurrentSessionContext().sessionId !== metadata.id) throw new Error('Session binding changed after saving');
      const results = [];
      if (patch.mcpEnabledServers) results.push(await engine.updateMcpServers(resolveWorkspaceConfig(updated.agentDir, updated).mcpServers));
      if (patch.enabledPluginIds) results.push(await engine.updateEnabledPluginIds(patch.enabledPluginIds));
      if (patch.enabledOfficialToolIds) results.push(await engine.updateOfficialToolIds(patch.enabledOfficialToolIds));
      const failed = results.find(result => !result.success);
      return json({ success: !failed, sessionConfig: 'saved', runtimeApply: failed ? 'failed' : engine.isBusy() ? 'deferred' : 'applied', error: failed?.error }, failed ? 500 : 200);
    } catch (error) { return json({ success: false, sessionConfig: 'saved', runtimeApply: 'failed', error: error instanceof Error ? error.message : 'Runtime apply failed' }, 500); }

  } catch (error) {
    return json({ success: false, error: error instanceof Error ? error.message : 'Session configuration unavailable' }, 409);
  }
}
