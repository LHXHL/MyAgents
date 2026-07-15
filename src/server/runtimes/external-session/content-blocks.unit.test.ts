import { afterEach, describe, expect, it } from 'vitest';
import {
  appendExternalToolResultDeltaToContent,
  buildCurrentExternalAssistantSnapshotContent,
  finalizeExternalToolUseInput,
  resetExternalContentState,
  startExternalSubagentToolUse,
  startExternalToolUseInput,
} from './content-blocks';

afterEach(() => resetExternalContentState());

describe('external live assistant content', () => {
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
});
