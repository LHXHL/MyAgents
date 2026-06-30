import { describe, expect, test } from 'vitest';

import {
  canHotSwapSessionSidecar,
  normalizeRuntime,
  planSessionOpen,
  sessionRuntimeIdentityFromMetadataForOpen,
} from './sessionOpenPlan';

describe('planSessionOpen', () => {
  test('jumps to an already-open session before considering runtime', () => {
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-a',
      multiAgentRuntime: true,
      currentRuntime: 'builtin',
      targetRuntime: 'codex',
      targetActivation: null,
      currentTabCronRunning: false,
    })).toEqual({ type: 'jump-to-tab', tabId: 'tab-a' });
  });

  test('opens a new tab when current and target sessions use different runtimes', () => {
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
      multiAgentRuntime: true,
      currentRuntime: 'claude-code',
      targetRuntime: 'codex',
      targetActivation: null,
      currentTabCronRunning: false,
    })).toEqual({
      type: 'open-new-tab',
      reason: 'runtime-mismatch',
      currentRuntime: 'claude-code',
      targetRuntime: 'codex',
      currentRuntimeSource: 'system-cli',
      targetRuntimeSource: 'system-cli',
    });
  });

  test('opens a new tab when Codex runtime source changes', () => {
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
      multiAgentRuntime: true,
      currentRuntimeIdentity: { runtime: 'codex', runtimeSource: 'system-cli' },
      targetRuntimeIdentity: { runtime: 'codex', runtimeSource: 'managed-provider' },
      targetActivation: null,
      currentTabCronRunning: false,
    })).toEqual({
      type: 'open-new-tab',
      reason: 'runtime-mismatch',
      currentRuntime: 'codex',
      targetRuntime: 'codex',
      currentRuntimeSource: 'system-cli',
      targetRuntimeSource: 'managed-provider',
    });
  });

  test('keeps Managed Codex runtime-source boundary active when Labs runtime mode is disabled', () => {
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
      multiAgentRuntime: false,
      currentRuntimeIdentity: { runtime: 'builtin' },
      targetRuntimeIdentity: { runtime: 'codex', runtimeSource: 'managed-provider' },
      targetActivation: null,
      currentTabCronRunning: false,
    })).toEqual({
      type: 'open-new-tab',
      reason: 'runtime-mismatch',
      currentRuntime: 'builtin',
      targetRuntime: 'codex',
      targetRuntimeSource: 'managed-provider',
    });
  });

  test('allows Managed Codex model/session switches within the same runtime source', () => {
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
      multiAgentRuntime: false,
      currentRuntimeIdentity: { runtime: 'codex', runtimeSource: 'managed-provider' },
      targetRuntimeIdentity: { runtime: 'codex', runtimeSource: 'managed-provider' },
      targetActivation: null,
      currentTabCronRunning: false,
    })).toEqual({ type: 'switch-current-tab' });
  });

  test('attaches to an existing cron sidecar before checking the current tab cron state', () => {
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
      multiAgentRuntime: true,
      currentRuntime: 'codex',
      targetRuntime: 'codex',
      targetActivation: { tab_id: null, task_id: 'task-1' },
      currentTabCronRunning: true,
    })).toEqual({ type: 'attach-existing-sidecar', taskId: 'task-1' });
  });

  test('attaches to an existing cron sidecar even when runtimes differ', () => {
    // Cron-owned sessions must not be routed through the runtime-mismatch
    // new-tab path: that path calls activateSession(..., taskId: null) and
    // overwrites the cron activation record, breaking ownership.
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
      multiAgentRuntime: true,
      currentRuntime: 'builtin',
      targetRuntime: 'codex',
      targetActivation: { tab_id: null, task_id: 'task-1' },
      currentTabCronRunning: false,
    })).toEqual({ type: 'attach-existing-sidecar', taskId: 'task-1' });
  });

  test('does not produce a runtime-mismatch plan when multi-agent runtime is disabled', () => {
    // Single-runtime mode collapses everything to `builtin`; cross-runtime
    // tabs cannot exist for user-managed CLI runtimes, so a hot-swap in current
    // tab is the right path. Managed provider sources are covered separately.
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
      multiAgentRuntime: false,
      currentRuntime: 'builtin',
      targetRuntime: 'codex',
      targetActivation: null,
      currentTabCronRunning: false,
    })).toEqual({ type: 'switch-current-tab' });
  });

  test('opens a new tab when current tab is running its own cron', () => {
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
      multiAgentRuntime: true,
      currentRuntime: 'builtin',
      targetRuntime: 'builtin',
      targetActivation: null,
      currentTabCronRunning: true,
    })).toEqual({ type: 'open-new-tab', reason: 'current-cron-running' });
  });

  test('falls through to switch-current-tab for an idle target with no special owners', () => {
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
      multiAgentRuntime: true,
      currentRuntime: 'builtin',
      targetRuntime: 'builtin',
      targetActivation: null,
      currentTabCronRunning: false,
    })).toEqual({ type: 'switch-current-tab' });
  });
});

describe('normalizeRuntime', () => {
  test('falls back to builtin for missing or unknown runtime values', () => {
    expect(normalizeRuntime(undefined)).toBe('builtin');
    expect(normalizeRuntime('unknown')).toBe('builtin');
    expect(normalizeRuntime('gemini')).toBe('gemini');
  });
});

describe('canHotSwapSessionSidecar', () => {
  test('allows Rust session-id handover only within the same runtime identity', () => {
    expect(canHotSwapSessionSidecar({
      currentRuntimeIdentity: { runtime: 'builtin' },
      targetRuntimeIdentity: { runtime: 'builtin' },
    })).toBe(true);

    expect(canHotSwapSessionSidecar({
      currentRuntimeIdentity: { runtime: 'codex', runtimeSource: 'managed-provider' },
      targetRuntimeIdentity: { runtime: 'codex', runtimeSource: 'managed-provider' },
    })).toBe(true);

    expect(canHotSwapSessionSidecar({
      currentRuntimeIdentity: { runtime: 'codex', runtimeSource: 'system-cli' },
      targetRuntimeIdentity: { runtime: 'codex', runtimeSource: 'managed-provider' },
    })).toBe(false);

    expect(canHotSwapSessionSidecar({
      currentRuntimeIdentity: { runtime: 'builtin' },
      targetRuntimeIdentity: { runtime: 'codex', runtimeSource: 'managed-provider' },
    })).toBe(false);

    expect(canHotSwapSessionSidecar({
      currentRuntimeIdentity: { runtime: 'builtin' },
      targetRuntimeIdentity: { runtime: 'gemini', runtimeSource: 'system-cli' },
    })).toBe(false);

    expect(canHotSwapSessionSidecar({
      currentRuntimeIdentity: { runtime: 'builtin' },
      targetRuntimeIdentity: { runtime: 'builtin', runtimeKnown: false },
    })).toBe(false);
  });
});

describe('sessionRuntimeIdentityFromMetadataForOpen', () => {
  test('treats Managed Codex provider identity as codex even when runtime is missing', () => {
    expect(sessionRuntimeIdentityFromMetadataForOpen({
      providerExecutionIdentity: {
        kind: 'runtime-backed-provider',
        providerId: 'codex-sub',
        runtime: 'codex',
        runtimeSource: 'managed-provider',
        model: 'gpt-5.4-codex',
      },
    }, 'builtin')).toEqual({
      runtime: 'codex',
      runtimeSource: 'managed-provider',
      runtimeKnown: true,
    });
  });

  test('keeps legacy builtin metadata as Agents SDK builtin', () => {
    expect(sessionRuntimeIdentityFromMetadataForOpen({
      runtime: 'builtin',
      runtimeSource: 'managed-provider',
    }, 'codex')).toEqual({
      runtime: 'builtin',
      runtimeSource: undefined,
      runtimeKnown: true,
    });
  });
});
