import { afterEach, describe, expect, it } from 'vitest';
import {
  appendExternalPendingText,
  flushExternalPendingTextBlock,
  applyExternalSubagentToolResult,
  applyExternalProviderToolResult,
  applyExternalSubagentAttachmentUpdate,
  applyExternalToolAttachmentUpdate,
  applyExternalToolResultToContent,
  appendExternalToolResultDeltaToContent,
  buildCurrentExternalAssistantSnapshotContent,
  finalizeExternalToolUseInput,
  finalizeExternalProviderToolsForTurn,
  replaceExternalToolUseInput,
  resetExternalContentState,
  getExternalSubagentAttachmentParent,
  startExternalSubagentToolUse,
  startExternalProviderToolUse,
  startExternalToolUseInput,
} from './content-blocks';

afterEach(() => resetExternalContentState());

describe('external live assistant content', () => {
  it('persists Provider images with their original server tool and rejects a different route', () => {
    const attachment = { kind: 'image' as const, mimeType: 'image/png', refPath: '/api/attachment/tool/session/turn/image.png' };
    startExternalProviderToolUse({ toolUseId: 'provider-call', toolName: 'image_generation',
      providerRouteId: 'provider', providerBlockType: 'server_tool_use', toolInput: {} });
    const result = { toolUseId: 'provider-call', providerRouteId: 'provider',
      providerBlockType: 'image_generation_result', content: 'Generated image', isError: false, attachments: [attachment] };
    expect(applyExternalProviderToolResult({ ...result, providerRouteId: 'other' })).toBe(false);
    expect(applyExternalProviderToolResult(result)).toBe(true);
    const blocks = JSON.parse(buildCurrentExternalAssistantSnapshotContent()!);
    expect(blocks[0].tool).toMatchObject({ result: 'Generated image', isLoading: false, attachments: [attachment] });
  });

  it('persists Provider-owned activity as a distinct server tool block', () => {
    startExternalProviderToolUse({
      toolUseId: 'provider-call-1',
      toolName: 'web_search',
      providerRouteId: 'fixture-provider',
      providerBlockType: 'server_tool_use',
      toolInput: { query: 'public reference' },
    });

    expect(applyExternalProviderToolResult({
      toolUseId: 'provider-call-1',
      providerRouteId: 'fixture-provider',
      providerBlockType: 'web_search_tool_result',
      content: '[{"title":"Reference"}]',
      isError: false,
    })).toBe(true);

    const blocks = JSON.parse(buildCurrentExternalAssistantSnapshotContent() ?? '[]');
    expect(blocks).toEqual([{
      type: 'server_tool_use',
      providerRouteId: 'fixture-provider',
      providerBlockType: 'server_tool_use',
      resultProviderBlockType: 'web_search_tool_result',
      tool: {
        id: 'provider-call-1',
        name: 'web_search',
        input: { query: 'public reference' },
        inputJson: '{\n  "query": "public reference"\n}',
        streamIndex: 0,
        isLoading: false,
        result: '[{"title":"Reference"}]',
        isError: false,
      },
    }]);
  });

  it('settles a Provider-owned block at the root turn boundary without inventing a result', () => {
    startExternalProviderToolUse({
      toolUseId: 'provider-call-without-result',
      toolName: 'web_search',
      providerRouteId: 'fixture-provider',
      providerBlockType: 'server_tool_use',
      toolInput: { query: 'public reference' },
    });

    finalizeExternalProviderToolsForTurn();

    const blocks = JSON.parse(buildCurrentExternalAssistantSnapshotContent() ?? '[]');
    expect(blocks[0].tool).toMatchObject({
      id: 'provider-call-without-result',
      isLoading: false,
    });
    expect(blocks[0].tool).not.toHaveProperty('result');
  });

  it('keeps top-level tool result deltas in the owner snapshot', () => {
    startExternalToolUseInput({ toolUseId: 'tool-1', toolName: 'Read' });
    finalizeExternalToolUseInput('tool-1');

    expect(appendExternalToolResultDeltaToContent('tool-1', 'partial')).toBe(true);

    const blocks = JSON.parse(buildCurrentExternalAssistantSnapshotContent() ?? '[]');
    expect(blocks[0].tool.result).toBe('partial');
  });

  it('keeps nested subagent result deltas in the owner snapshot', () => {
    startExternalToolUseInput({ toolUseId: 'parent', toolName: 'Task' });
    finalizeExternalToolUseInput('parent');
    startExternalSubagentToolUse({
      parentToolUseId: 'parent',
      toolUseId: 'child',
      toolName: 'AgentMessage',
    });

    expect(appendExternalToolResultDeltaToContent('child', 'working')).toBe(true);

    const blocks = JSON.parse(buildCurrentExternalAssistantSnapshotContent() ?? '[]');
    expect(blocks[0].tool.subagentCalls[0].result).toBe('working');
  });

  it('keeps a nested large-result ref in the owner snapshot', () => {
    startExternalToolUseInput({ toolUseId: 'parent', toolName: 'Task' });
    finalizeExternalToolUseInput('parent');
    startExternalSubagentToolUse({
      parentToolUseId: 'parent',
      toolUseId: 'child',
      toolName: 'Edit',
    });
    applyExternalSubagentToolResult({
      parentToolUseId: 'parent',
      toolUseId: 'child',
      content: 'preview',
      metadata: {
        largeValueRef: {
          kind: 'ref',
          id: 'a1b2c3d4',
          sizeBytes: 300_000,
          mimetype: 'text/plain',
          preview: 'preview',
          expiresAt: Date.now() + 60_000,
        },
      },
    });

    const blocks = JSON.parse(buildCurrentExternalAssistantSnapshotContent() ?? '[]');
    expect(blocks[0].tool.subagentCalls[0].resultMeta.largeValueRef).toMatchObject({
      id: 'a1b2c3d4',
      sizeBytes: 300_000,
    });
  });

  it('holds an early child attachment update until its placeholder result establishes ownership', () => {
    startExternalToolUseInput({ toolUseId: 'parent', toolName: 'Task' });
    finalizeExternalToolUseInput('parent');
    startExternalSubagentToolUse({
      parentToolUseId: 'parent',
      toolUseId: 'child-image',
      toolName: 'ImageTool',
    });
    expect(getExternalSubagentAttachmentParent('child-image')).toBe('parent');

    expect(applyExternalSubagentAttachmentUpdate({
      parentToolUseId: 'parent',
      toolUseId: 'child-image',
      pendingId: 'pending-image',
      attachment: {
        kind: 'image',
        mimeType: 'image/png',
        refPath: '/api/attachment/tool/session/turn/final.png',
      },
    })).toBe('deferred');

    applyExternalSubagentToolResult({
      parentToolUseId: 'parent',
      toolUseId: 'child-image',
      content: 'Image generated',
      attachments: [{
        kind: 'image',
        mimeType: 'image/png',
        refPath: '',
        pendingId: 'pending-image',
      }],
    });

    const blocks = JSON.parse(buildCurrentExternalAssistantSnapshotContent() ?? '[]');
    expect(blocks[0].tool.subagentCalls[0].attachments).toEqual([{
      kind: 'image',
      mimeType: 'image/png',
      refPath: '/api/attachment/tool/session/turn/final.png',
    }]);
    expect(getExternalSubagentAttachmentParent('child-image')).toBe('parent');
  });

  it('holds an early top-level attachment update until its placeholder result establishes ownership', () => {
    startExternalToolUseInput({ toolUseId: 'top-image', toolName: 'ImageTool' });
    finalizeExternalToolUseInput('top-image');

    expect(applyExternalToolAttachmentUpdate({
      toolUseId: 'top-image',
      pendingId: 'pending-top-image',
      attachment: {
        kind: 'image',
        mimeType: 'image/png',
        refPath: '/api/attachment/tool/session/turn/final-top.png',
      },
    })).toBe('deferred');

    applyExternalToolResultToContent({
      toolUseId: 'top-image',
      content: 'Image generated',
      attachments: [{
        kind: 'image',
        mimeType: 'image/png',
        refPath: '',
        pendingId: 'pending-top-image',
      }],
    });

    const blocks = JSON.parse(buildCurrentExternalAssistantSnapshotContent() ?? '[]');
    expect(blocks[0].tool.attachments).toEqual([{
      kind: 'image',
      mimeType: 'image/png',
      refPath: '/api/attachment/tool/session/turn/final-top.png',
    }]);
  });

  it('replaces a started tool snapshot with completion-owned input before persistence', () => {
    startExternalToolUseInput({
      toolUseId: 'edit-1',
      toolName: 'Edit',
      toolInput: { file_path: '/workspace/a.ts' },
    });

    expect(replaceExternalToolUseInput('edit-1', {
      file_path: '/workspace/a.ts',
      changes: [{
        path: '/workspace/a.ts',
        kind: { type: 'update' },
        diff: 'applied',
      }],
    })).toBe('Edit');
    expect(finalizeExternalToolUseInput('edit-1')).toBe(true);

    const blocks = JSON.parse(buildCurrentExternalAssistantSnapshotContent() ?? '[]');
    expect(blocks[0].tool.input).toEqual({
      file_path: '/workspace/a.ts',
      changes: [
        { path: '/workspace/a.ts', kind: { type: 'update' }, diff: 'applied' },
      ],
    });
  });
});

it('persists question-only items as explicit text boundaries in live snapshots', () => {
  appendExternalPendingText('Before');
  flushExternalPendingTextBlock();
  const asyncQuestions = { id: 'q', questions: [{ title: 'Where?', options: null }] };
  flushExternalPendingTextBlock(asyncQuestions);
  appendExternalPendingText('After');
  const blocks = JSON.parse(buildCurrentExternalAssistantSnapshotContent()!);
  expect(blocks).toMatchObject([
    { type: 'text', text: 'Before', isComplete: true },
    { type: 'text', text: '', isComplete: true, asyncQuestions },
    { type: 'text', text: 'After' },
  ]);
});
