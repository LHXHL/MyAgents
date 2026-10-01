import { describe, expect, it } from 'vitest';

import { createDshBinding } from '../../shared/integrated-runtimes/identity';
import type { AgentConfig } from '../../shared/types/agent';
import type { SessionMetadata } from '../types/session';
import { resolveSessionConfig } from './resolve-session-config';

const agent: AgentConfig = {
  id: 'agent-1',
  name: 'Agent',
  enabled: true,
  channels: [],
  runtime: 'dsh',
  providerId: 'anthropic-api',
  model: 'claude-sonnet-4-6',
  reasoningEffort: 'default',
  permissionMode: 'plan',
};

describe('resolveSessionConfig DSH ownership', () => {
  it('reads the authoritative binding instead of trusting its legacy projection alone', () => {
    const metadata = {
      id: 'session-1',
      agentDir: '/workspace',
      title: 'Session',
      createdAt: '2026-08-30T00:00:00.000Z',
      lastActiveAt: '2026-08-30T00:00:00.000Z',
      runtime: 'dsh',
      runtimeSource: 'integrated',
      runtimeBinding: createDshBinding('darwin-arm64'),
      providerId: 'anthropic-api',
      providerRoute: {
        kind: 'provider',
        providerId: 'anthropic-api',
        model: 'claude-sonnet-4-6',
      },
      model: 'claude-sonnet-4-6',
      reasoningEffort: 'default',
      permissionMode: 'plan',
      configSnapshotAt: '2026-08-30T00:00:00.000Z',
    } satisfies SessionMetadata;

    expect(resolveSessionConfig(metadata, agent, undefined, 'owned')).toMatchObject({
      runtime: 'dsh',
      runtimeSource: 'integrated',
      providerId: 'anthropic-api',
      providerRoute: metadata.providerRoute,
      model: 'claude-sonnet-4-6',
      permissionMode: 'approval-required',
    });
  });

  it('resolves IM birth templates from Agent with maximum Runtime permission', () => {
    expect(resolveSessionConfig(undefined, agent, undefined, 'im')).toMatchObject({
      runtime: 'dsh',
      runtimeSource: 'integrated',
      providerId: 'anthropic-api',
      model: 'claude-sonnet-4-6',
      permissionMode: 'full-autonomous',
    });
  });
});
