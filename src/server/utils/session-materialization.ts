import type { AgentConfig } from '../../shared/types/agent';
import type { RuntimeSource, RuntimeType } from '../../shared/types/runtime';
import { createSessionMetadata, type SessionMetadata } from '../types/session';
import { snapshotForImSession, snapshotForOwnedSession } from './session-snapshot';

export type SessionMaterializationScenario = 'desktop' | 'cron' | 'im' | 'agent-channel' | 'registeredAgent';

export function isLiveFollowScenario(scenario: SessionMaterializationScenario): boolean {
  return scenario === 'im' || scenario === 'agent-channel' || scenario === 'registeredAgent';
}

export function snapshotForMaterializedSession(
  agent: AgentConfig,
  scenario: SessionMaterializationScenario,
  options?: { runtimeOverride?: RuntimeType; runtimeSourceOverride?: RuntimeSource; managedCodexProviderReady?: boolean },
): Partial<SessionMetadata> {
  return isLiveFollowScenario(scenario)
    ? snapshotForImSession(agent, options)
    : snapshotForOwnedSession(agent, options);
}

export function createMaterializedSessionMetadata(params: {
  agentDir: string;
  sessionId: string;
  scenario: SessionMaterializationScenario;
  agent?: AgentConfig;
  runtimeOverride?: RuntimeType;
  runtimeSourceOverride?: RuntimeSource;
  managedCodexProviderReady?: boolean;
  fallbackRuntime?: RuntimeType;
  title?: string;
}): SessionMetadata {
  const snapshot = params.agent
    ? snapshotForMaterializedSession(params.agent, params.scenario, {
        runtimeOverride: params.runtimeOverride,
        runtimeSourceOverride: params.runtimeSourceOverride,
        managedCodexProviderReady: params.managedCodexProviderReady,
      })
    : undefined;
  const meta = createSessionMetadata(params.agentDir, snapshot);
  const fallbackRuntime = params.runtimeOverride ?? params.fallbackRuntime;
  if (!params.agent && fallbackRuntime) {
    meta.runtime = fallbackRuntime;
    meta.runtimeSource = fallbackRuntime !== 'builtin'
      ? (params.runtimeSourceOverride ?? 'system-cli')
      : undefined;
  }
  meta.id = params.sessionId;
  meta.title = params.title ?? 'New Chat';
  return meta;
}
