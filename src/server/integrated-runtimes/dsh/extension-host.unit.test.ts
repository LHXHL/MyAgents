import { describe, expect, it, vi } from 'vitest';

import type { ProductHostToolDispatcher } from '../../runtimes/product-extensions/contracts';
import type { DshCompiledExtensionPlane } from './extension-compiler';
import type { DshRequestContext } from './protocol-types';
import { executeDshProductHostTool, resolveDshMcpCredential } from './extension-host';

function plane(dispatcher?: ProductHostToolDispatcher): DshCompiledExtensionPlane {
  return {
    snapshot: {
      formatVersion: 1,
      revision: 'extensions-v1',
      digest: 'a'.repeat(64),
      components: [],
      resources: [],
      skillSourcePolicy: { revision: 'skills-v1', roots: [] },
    },
    credentialBindings: [{
      componentId: 'remote-tools',
      credentialRef: 'remote-tools-credential',
      credentialRevision: 'credential-v1',
      materialSlot: 'header',
      material: { authorization: 'Bearer private' },
    }],
    hostToolBindings: [{
      publicToolName: 'mcp__myagents_host__lookup',
      dispatcherToolName: 'lookup',
    }],
    ...(dispatcher ? { hostToolDispatcher: dispatcher } : {}),
    expectedSkillNames: [],
    diagnostics: [],
  };
}

function mcpParams(overrides: Record<string, unknown> = {}) {
  return {
    authority: { componentId: 'remote-tools' },
    serverId: 'remote-tools',
    credentialRef: 'remote-tools-credential',
    credentialRevision: 'credential-v1',
    extensionDigest: 'a'.repeat(64),
    materialSlot: 'header',
    purpose: 'connection',
    ...overrides,
  };
}

function context(signal = new AbortController().signal): DshRequestContext {
  return {
    requestId: 'request-one',
    signal,
    commit: () => undefined,
    afterResponse: () => undefined,
  };
}

describe('DSH extension Host reverse ports', () => {
  it('returns MCP material only for the exact component, digest, and revision', () => {
    const extensionPlane = plane();
    expect(resolveDshMcpCredential({
      plane: extensionPlane,
      extensionDigest: extensionPlane.snapshot.digest,
      params: mcpParams(),
    })).toEqual({
      kind: 'material',
      authoritativeCredentialRevision: 'credential-v1',
      material: { authorization: 'Bearer private' },
    });
    expect(resolveDshMcpCredential({
      plane: extensionPlane,
      extensionDigest: extensionPlane.snapshot.digest,
      params: mcpParams({ extensionDigest: 'b'.repeat(64) }),
    })).toEqual({
      kind: 'availability',
      available: false,
      authoritativeCredentialRevision: 'credential-v1',
      reasonCode: 'mcp_credential_authority_mismatch',
    });
  });

  it('dispatches a fenced Host tool and publishes non-text results as attachment refs', async () => {
    const dispatch = vi.fn(async () => ({
      success: true,
      contentItems: [
        { type: 'text' as const, text: 'found' },
        { type: 'image' as const, dataUrl: 'data:image/png;base64,YQ==' },
      ],
    }));
    const extensionPlane = plane({ descriptors: [], dispatch, dispose: vi.fn() });
    const publishDataUrl = vi.fn(async () => ({
      attachmentId: `sha256:${'c'.repeat(64)}`,
      mimeType: 'image/png',
      sizeBytes: 1,
      sha256: 'c'.repeat(64),
    }));
    const signal = new AbortController().signal;

    await expect(executeDshProductHostTool({
      plane: extensionPlane,
      attachments: { publishDataUrl },
      runtimeSessionId: 'runtime-session',
      params: {
        authority: {
          componentId: 'mcp__myagents_host__lookup',
          runtimeGeneration: 'generation-one',
          runtimeSessionId: 'runtime-session',
          turnId: 'turn-one',
          callId: 'call-one',
        },
        tool: 'mcp__myagents_host__lookup',
        input: { query: 'fixture' },
      },
      context: context(signal),
    })).resolves.toEqual({
      state: 'succeeded',
      content: [
        { type: 'text', text: 'found' },
        {
          type: 'attachment_ref',
          attachment: {
            attachmentId: `sha256:${'c'.repeat(64)}`,
            mimeType: 'image/png',
            sizeBytes: 1,
            sha256: 'c'.repeat(64),
          },
        },
      ],
    });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      processGeneration: 'generation-one',
      threadId: 'runtime-session',
      turnId: 'turn-one',
      callId: 'call-one',
      tool: 'lookup',
      arguments: { query: 'fixture' },
      signal,
    }));
    expect(publishDataUrl).toHaveBeenCalledWith('data:image/png;base64,YQ==');
  });

  it('fails stale authority before invoking the Product dispatcher', async () => {
    const dispatch = vi.fn();
    const extensionPlane = plane({ descriptors: [], dispatch, dispose: vi.fn() });
    await expect(executeDshProductHostTool({
      plane: extensionPlane,
      attachments: { publishDataUrl: vi.fn() },
      runtimeSessionId: 'runtime-session',
      params: {
        authority: {
          componentId: 'mcp__myagents_host__lookup',
          runtimeGeneration: 'generation-one',
          runtimeSessionId: 'other-session',
          turnId: 'turn-one',
          callId: 'call-one',
        },
        tool: 'mcp__myagents_host__lookup',
        input: {},
      },
      context: context(),
    })).resolves.toEqual({ state: 'failed', code: 'host_tool_authority_mismatch' });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
