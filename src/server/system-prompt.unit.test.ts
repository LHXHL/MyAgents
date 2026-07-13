import { describe, expect, it } from 'vitest';

import { buildSystemPromptAppend } from './system-prompt';

describe('buildSystemPromptAppend floating-ball surface', () => {
  it('adds floating-ball instructions only for the floating desktop surface', () => {
    expect(buildSystemPromptAppend({ type: 'desktop' })).not.toContain('<myagents-floating-ball-instructions>');

    const prompt = buildSystemPromptAppend({ type: 'desktop', surface: 'floating-ball' });
    expect(prompt).toContain('<myagents-floating-ball-instructions>');
    expect(prompt).toContain('MyAgents desktop floating window');
    expect(prompt).toContain('Keep responses concise');
  });
});

describe('buildSystemPromptAppend registered Agent events', () => {
  it('defers event business intent to the delivery-specific cloud instruction', () => {
    const prompt = buildSystemPromptAppend({ type: 'registeredAgent', platform: 'space' });
    expect(prompt).toContain('<cloud-issue-instruction>');
    expect(prompt).toContain('<local-execution-instruction>');
    expect(prompt).not.toContain('再决定 ignore、claim 或继续工作');
  });
});
