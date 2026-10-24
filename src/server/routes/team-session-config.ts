import { getSessionEngine } from '../session-engine';
import { getSessionMetadata, updateSessionMetadata } from '../SessionStore';
import { peerProfileFromSession, resolvePeerProfileBirth, type PeerProfile } from '../utils/peer-profile';
import { agentContext, birthForSelection, modelContext, imSnapshotObservation, sameSelection, sessionEffortChoices, type ImModelSelection } from './im-model-selection';
import { getAllMcpServers, getEnabledMcpServerIds, resolveWorkspaceConfig } from '../utils/admin-config';
import { buildSessionSnapshotPatchUpdates } from '../utils/session-snapshot-patch';
import { snapshotForImRuntimeSwitch, snapshotForImSession } from '../utils/session-snapshot';
import { isManagedCodexProviderReady } from '../utils/managed-codex-readiness';
import { coerceReasoningEffortSettingForRuntime, reasoningEffortAfterModelChange } from '../../shared/reasoningEffort';
import type { SessionMetadata } from '../types/session';
import { OFFICIAL_TOOLS, normalizeOfficialToolIds } from '../../shared/official-tools';
import { listInstalledPlugins } from '../plugins/store';
import { broadcast } from '../sse';
import { canManageSessionExtensions } from '../../shared/teamAi';
import { VALID_RUNTIMES, type RuntimeType } from '../../shared/types/runtime';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Context = Pick<Awaited<ReturnType<typeof modelContext>>, 'config' | 'agent' | 'workspacePath'>;
type ToolsChange = { mcpEnabledServers?: string[]; enabledPluginIds?: string[]; enabledOfficialToolIds?: string[] };
type PeerConfigChange = { runtime?: string; selection?: ImModelSelection; effort?: string; tools?: ToolsChange };
type PeerConfigBody = { agentId?: unknown; profile?: unknown; sessionId?: unknown; change?: PeerConfigChange };

/** The complete config a peer's new Sessions use: its valid profile, else the Agent template. */
function peerConfigBase(owner: Context, profile: unknown): { config: PeerProfile; custom: boolean } {
  if (profile) {
    const resolved = resolvePeerProfileBirth(profile, owner.config, listInstalledPlugins().map(p => p.id));
    if (resolved.kind === 'applied') return { config: resolved.fields, custom: true };
  }
  return {
    config: peerProfileFromSession(snapshotForImSession(owner.agent, {
      managedCodexProviderReady: isManagedCodexProviderReady(owner.config),
      runtimePolicy: { defaultIntegratedRuntime: owner.config.defaultIntegratedRuntime },
    })),
    custom: false,
  };
}

const sameExecution = (session: SessionMetadata | null | undefined, config: PeerProfile) =>
  !!session && (session.runtime ?? 'builtin') === config.runtime && (session.runtimeSource ?? undefined) === (config.runtimeSource ?? undefined);

/** MCP servers a peer config may choose: globally enabled ones plus any it already uses. */
const mcpCatalog = (context: Context, config: PeerProfile) =>
  getAllMcpServers(context.config).filter(s => getEnabledMcpServerIds(context.config).includes(s.id) || config.mcpEnabledServers?.includes(s.id));

/** Read-only catalog and composition for the Team AI peer config. Rust owns the stored
 *  profile and passes it in; nothing here writes Session or Agent state. */
async function handlePeerConfig(path: string, body: PeerConfigBody): Promise<Response> {
  if (typeof body.agentId !== 'string') return json({ success: false, error: 'Agent is required' }, 400);
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;
  // A valid profile stands on its own; the Agent template is compiled only when it is needed.
  const owner = agentContext(body.agentId);
  const { config, custom } = peerConfigBase(owner, body.profile);
  const configContext = await modelContext(body.agentId, undefined, config);
  // The peer config does not depend on its current Session: a deleted, foreign or legacy
  // Session just means no change can be applied to it now.
  const sessionContext = sessionId ? await modelContext(body.agentId, sessionId).catch(() => undefined) : undefined;
  const session = sessionContext?.metadata;
  const appliesNow = (selection: ImModelSelection) => sameExecution(session, config)
    && !!sessionContext?.options.some(option => sameSelection(option.selection, selection) && !option.requiresNewSession);
  if (path === '/api/im/peer-config') {
    return json({
      success: true, config, custom,
      models: configContext.options.map(option => ({ ...option, appliesNow: appliesNow(option.selection) })),
      effortChoices: sessionEffortChoices(configContext),
      tools: {
        canManageExtensions: canManageSessionExtensions(config.runtime, config.runtimeSource),
        mcp: mcpCatalog(owner, config).map(s => ({ id: s.id, name: s.name })),
        plugins: listInstalledPlugins().map(p => ({ id: p.id, name: p.name })),
        official: OFFICIAL_TOOLS.map(t => ({ id: t.id, name: t.name })),
      },
    });
  }
  // Compose: the whole next config plus, when compatible, the Session-only request that
  // applies the same change to the peer's current Session.
  const change = body.change ?? {};
  let next: PeerProfile = { ...config };
  let apply: { path: string; body: Record<string, unknown> } | null = null;
  const observed = session ? { agentId: body.agentId, sessionId: session.id, snapshotObservation: imSnapshotObservation(session) } : undefined;
  if (change.runtime !== undefined) {
    if (!(VALID_RUNTIMES as readonly string[]).includes(change.runtime)) return json({ success: false, error: 'Invalid Runtime' }, 400);
    // Runtime is a birth choice: carry portable choices, never touch the current Session.
    const switched = snapshotForImRuntimeSwitch(config, change.runtime as RuntimeType);
    next = peerProfileFromSession(switched);
  } else if (change.selection) {
    const option = configContext.options.find(o => sameSelection(o.selection, change.selection!));
    if (!option) return json({ success: false, error: 'Model is unavailable' }, 409);
    const birth = birthForSelection(configContext, option.selection);
    next = {
      ...config,
      runtime: birth.runtime as RuntimeType,
      runtimeSource: birth.runtimeSource,
      providerExecutionIdentity: birth.providerExecutionIdentity,
      providerId: birth.providerExecutionIdentity ? undefined : birth.providerId,
      model: birth.model,
      reasoningEffort: coerceReasoningEffortSettingForRuntime(reasoningEffortAfterModelChange(config.reasoningEffort, option.capabilities), birth.runtime ?? 'builtin') ?? 'default',
    };
    if (observed && appliesNow(option.selection)) apply = { path: '/api/im/session-model-selection', body: { ...observed, selection: option.selection, allowNewSession: false } };
  } else if (change.effort !== undefined) {
    const choices = sessionEffortChoices(configContext);
    if (change.effort !== 'default' && !choices?.includes(change.effort)) return json({ success: false, error: 'Reasoning effort is unavailable for this model' }, 409);
    next.reasoningEffort = change.effort;
    const sessionChoices = sessionContext ? sessionEffortChoices(sessionContext) : null;
    if (observed && sameExecution(session, config) && (change.effort === 'default' || sessionChoices?.includes(change.effort))) {
      apply = { path: '/api/im/session-effort', body: { ...observed, effort: change.effort } };
    }
  } else if (change.tools) {
    const manage = canManageSessionExtensions(config.runtime, config.runtimeSource);
    const allowed = {
      mcpEnabledServers: mcpCatalog(owner, config).map(s => s.id),
      enabledPluginIds: listInstalledPlugins().map(p => p.id),
      enabledOfficialToolIds: OFFICIAL_TOOLS.map(t => t.id) as string[],
    };
    const patch: ToolsChange = {};
    for (const key of ['mcpEnabledServers', 'enabledPluginIds', 'enabledOfficialToolIds'] as const) {
      const value = change.tools[key];
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !allowed[key].includes(id))) return json({ success: false, error: 'Selected tool is unavailable' }, 409);
      if (key !== 'enabledOfficialToolIds' && !manage) return json({ success: false, error: 'This Runtime manages MCP and plugins in its CLI configuration' }, 409);
      patch[key] = [...new Set(value)];
    }
    next = { ...next, ...patch, enabledOfficialToolIds: normalizeOfficialToolIds(patch.enabledOfficialToolIds ?? config.enabledOfficialToolIds) };
    if (observed && sameExecution(session, config)) {
      apply = { path: '/api/im/session-tools', body: { ...observed, ...(manage ? { mcpEnabledServers: next.mcpEnabledServers, enabledPluginIds: next.enabledPluginIds } : {}), enabledOfficialToolIds: next.enabledOfficialToolIds } };
    }
  } else {
    return json({ success: false, error: 'No change provided' }, 400);
  }
  // Drop undefined keys so the stored profile is a plain, complete value.
  return json({ success: true, profile: JSON.parse(JSON.stringify(next)), apply });
}

/** Team AI surfaces edit Product Session state or the peer profile. Agent defaults have no writer here. */
export async function handleTeamSessionConfigRoute(path: string, request: Request): Promise<Response | null> {
  if (path === '/api/im/peer-profile' && request.method === 'GET') {
    // Read-only projection for the Rust peer-profile owner; Rust decides whether to store it.
    const metadata = getSessionMetadata(new URL(request.url).searchParams.get('sessionId') ?? '');
    if (!metadata?.configSnapshotAt) return json({ success: false, error: 'Session configuration is not owned yet' }, 409);
    return json({ success: true, profile: peerProfileFromSession(metadata) });
  }
  if ((path === '/api/im/peer-config' || path === '/api/im/peer-config/compose') && request.method === 'POST') {
    try {
      return await handlePeerConfig(path, await request.json() as PeerConfigBody);
    } catch (error) {
      return json({ success: false, error: error instanceof Error ? error.message : 'Peer configuration unavailable' }, 409);
    }
  }
  if (path !== '/api/im/session-tools' && path !== '/api/im/session-effort') return null;
  try {
    if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.agentId !== 'string' || typeof body.sessionId !== 'string') return json({ success: false, error: 'Agent and Session are required' }, 400);
    const context = await modelContext(body.agentId, body.sessionId);
    const metadata = context.metadata!;
    if (imSnapshotObservation(metadata) !== body.snapshotObservation) return json({ success: false, error: 'Session configuration changed; refresh before saving' }, 409);
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
