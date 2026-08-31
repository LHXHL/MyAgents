import { describe, expect, it } from 'vitest';

import { buildDshSystemContext, buildSystemPromptAppend } from './system-prompt';

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
  it('keeps action semantics open while binding the exact execution identity', () => {
    const prompt = buildSystemPromptAppend({
      type: 'registeredAgent',
      platform: 'space',
      spaceId: 'space-1',
      registeredAgentId: 'agent-1',
    });
    expect(prompt).toContain('space-id="space-1" registered-agent-id="agent-1"');
    expect(prompt).toContain('<registered-agent-instruction>');
    expect(prompt).toContain('<operating-guidance>');
    expect(prompt).toContain('不再行动、只评论或更新、claim 责任');
    expect(prompt).toContain('不存在由你调用的 ignore、handled 或 acknowledge 动作');
    expect(prompt).not.toContain('<cloud-issue-instruction>');
  });
});

describe('buildDshSystemContext', () => {
  it('separates stable product sections, root session guidance, and companion context', () => {
    const snapshot = buildDshSystemContext(
      { type: 'desktop', surface: 'floating-ball' },
      { cliToolsEnabled: false },
      'Current workspace instructions follow.\n\n## .claude/rules/literal.md\nKeep {{name}} literal.',
    );
    expect(snapshot.sections.map(({ id, order, scope }) => ({ id, order, scope }))).toEqual([
      { id: 'myagents:identity', order: -80, scope: 'global' },
      { id: 'myagents:capability-routing', order: -70, scope: 'global' },
      { id: 'myagents:session', order: 10, scope: 'root' },
    ]);
    expect(snapshot.sections[2]?.text).toContain('MyAgents desktop floating window');
    expect(snapshot.sections[2]?.text).not.toContain('<myagents-identity>');
    expect(snapshot.contexts).toEqual([{
      id: 'workspace-supplement',
      order: 100,
      scope: 'global',
      text: 'Current workspace instructions follow.\n\n## .claude/rules/literal.md\nKeep {{name}} literal.',
    }]);
  });
});
