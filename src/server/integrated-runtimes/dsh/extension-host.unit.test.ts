import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/large-value-store', () => ({ maybeSpill: vi.fn() }));
import { maybeSpill } from '../../utils/large-value-store';

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
      mcpLaunchPolicy: { revision: 'mcp-launch-v1', profiles: [] },
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
    authority: {
      componentId: 'remote-tools',
      componentGenerationId: `extensions-v1:${'a'.repeat(64)}`,
    },
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

function toolParams() {
  return {
    authority: {
      componentId: 'mcp__myagents_host__lookup', componentGenerationId: `extensions-v1:${'a'.repeat(64)}`,
      runtimeGeneration: 'generation-one', runtimeSessionId: 'runtime-session', turnId: 'turn-one', callId: 'call-one',
    },
    tool: 'mcp__myagents_host__lookup', input: {},
  };
}

describe('DSH extension Host reverse ports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(maybeSpill).mockImplementation(async value => ({ inline: value }));
  });

  it('keeps successful execution when one attachment cannot be published', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true, contentItems: [
      { type: 'text', text: 'Already completed' }, { type: 'image', dataUrl: 'data:image/png;base64,YQ==' },
      { type: 'text', text: 'Additional useful output' },
    ] });
    const result = await executeDshProductHostTool({
      plane: plane({ descriptors: [], dispatch, dispose: vi.fn() }),
      attachments: { publishDataUrl: vi.fn().mockRejectedValue(new Error('Synthetic archive failure')) },
      runtimeSessionId: 'runtime-session', productSessionId: 'product-session', params: toolParams(), context: context(),
    });
    expect(result).toEqual({ state: 'succeeded', content: [
      { type: 'text', text: 'Already completed' }, { type: 'text', text: '[MyAgents Host tool attachment unavailable]' },
      { type: 'text', text: 'Additional useful output' },
    ] });
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('still reports real dispatcher failures as failed operations', async () => {
    const result = await executeDshProductHostTool({
      plane: plane({ descriptors: [], dispatch: vi.fn().mockRejectedValue(new Error('Synthetic execution failure')), dispose: vi.fn() }),
      attachments: { publishDataUrl: vi.fn() }, runtimeSessionId: 'runtime-session', productSessionId: 'product-session',
      params: toolParams(), context: context(),
    });
    expect(result).toEqual({ state: 'failed', code: 'host_tool_failed' });
  });

  it('spills long successful output at the DSH wire bound instead of reporting execution failure', async () => {
    const text = 'x'.repeat(180_000);
    vi.mocked(maybeSpill).mockResolvedValueOnce({
      kind: 'ref', id: 'a'.repeat(32), preview: 'Output preview', sizeBytes: text.length,
      mimetype: 'text/plain', expiresAt: 1,
    });
    const result = await executeDshProductHostTool({
      plane: plane({ descriptors: [], dispatch: vi.fn().mockResolvedValue({ success: true, contentItems: [{ type: 'text', text }] }), dispose: vi.fn() }),
      attachments: { publishDataUrl: vi.fn() }, runtimeSessionId: 'runtime-session', productSessionId: 'product-session',
      params: toolParams(), context: context(),
    });
    expect(result).toMatchObject({ state: 'succeeded', content: [{ type: 'text', text: expect.stringContaining('Output preview') }] });
    expect(maybeSpill).toHaveBeenCalledWith(text, expect.objectContaining({ inlineMaxBytes: 131_072, sessionId: 'product-session' }));
  });

  it('retains a bounded preview and real success when full output storage fails', async () => {
    vi.mocked(maybeSpill).mockRejectedValueOnce(new Error('Synthetic disk failure'));
    const result = await executeDshProductHostTool({
      plane: plane({ descriptors: [], dispatch: vi.fn().mockResolvedValue({ success: true, contentItems: [{ type: 'text', text: 'x'.repeat(180_000) }] }), dispose: vi.fn() }),
      attachments: { publishDataUrl: vi.fn() }, runtimeSessionId: 'runtime-session', productSessionId: 'product-session',
      params: toolParams(), context: context(),
    });
    expect(result.state).toBe('succeeded');
    const content = result.content as Array<{ text: string }>;
    expect(content[0]?.text).toContain('Full output unavailable');
    expect(content[0]?.text.length).toBeLessThan(131_072);
  });

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
    expect(resolveDshMcpCredential({
      plane: extensionPlane,
      extensionDigest: extensionPlane.snapshot.digest,
      params: mcpParams({
        authority: {
          componentId: 'remote-tools',
          componentGenerationId: `extensions-v2:${'b'.repeat(64)}`,
        },
      }),
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
      productSessionId: 'product-session',
      params: {
        authority: {
          componentId: 'mcp__myagents_host__lookup',
          componentGenerationId: `extensions-v1:${'a'.repeat(64)}`,
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
      productSessionId: 'product-session',
      params: {
        authority: {
          componentId: 'mcp__myagents_host__lookup',
          componentGenerationId: `extensions-v2:${'b'.repeat(64)}`,
          runtimeGeneration: 'generation-one',
          runtimeSessionId: 'runtime-session',
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
