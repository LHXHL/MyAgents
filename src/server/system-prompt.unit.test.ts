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


describe('Channel Prompt Contract v1 stable system sections', () => {
  it('requires an exact binding for fixed Channel prompts across runtimes and entry surfaces', () => {
    const scenarios = [
      { type: 'desktop' },
      { type: 'im', platform: 'feishu', sourceType: 'private' },
      { type: 'agent-channel', platform: 'wecom', sourceType: 'private', botName: 'Agent' },
    ] as const;
    for (const scenario of scenarios) {
      for (const runtime of ['builtin', 'dsh', 'codex', 'claude-code'] as const) {
        for (const channelBound of [false, true]) {
          const options = { runtime, channelBound };
          const prompt = buildSystemPromptAppend(scenario, options);
          const dsh = buildDshSystemContext(scenario, options).sections.map(section => section.text).join('\n');
          expect(prompt.includes('<myagents-channel>')).toBe(channelBound);
          expect(dsh.includes('<myagents-channel>')).toBe(channelBound);
        }
        expect(buildSystemPromptAppend(scenario, { runtime })).not.toContain('<myagents-channel>');
      }
    }
  });
  it('keeps variable identity and delivery facts out of long-lived instructions', async () => {
    const { CHANNEL_PROMPT } = await import('../shared/channelPrompt');
    const scenario = {type: 'agent-channel', platform: 'openclaw-weixin', sourceType: 'private', botName: 'not a verified identity'} as const;
    const text = buildSystemPromptAppend(scenario, {cliToolsEnabled: true, channelBound: true});
    expect(text).toContain(CHANNEL_PROMPT);
    expect(text.match(/<myagents-channel>/g)).toHaveLength(1);
    expect(text).toContain('## 对话环境');
    expect(text).toContain('## 消息发送');
    expect(text).not.toContain('not a verified identity');
    expect(text).not.toContain('myagents-cli-im-media');
    expect(text).not.toContain('im send-media');
    expect(buildDshSystemContext(scenario, {channelBound: true}).sections.find(section => section.id === 'myagents:session')?.text).toContain(CHANNEL_PROMPT);
    const desktop = buildSystemPromptAppend({type:'desktop'}, {channelBound:true});
    expect(desktop).toContain(CHANNEL_PROMPT);
    expect(desktop).toContain('仅在 CHANNEL_CONTEXT 给出会话绑定时');
    expect(desktop).not.toContain('你通过外部聊天渠道参与对话');
    expect(buildSystemPromptAppend({type:'desktop'})).not.toContain(CHANNEL_PROMPT);
  });
});


describe('Session environment and desktop presentation', () => {
  it('does not claim that desktop restoration makes the current input a desktop conversation', () => {
    for (const runtime of ['builtin', 'dsh', 'codex', 'claude-code'] as const) {
      const options = { runtime, channelBound: true };
      const text = buildSystemPromptAppend({ type: 'desktop' }, options);
      expect(text).not.toContain('用户正通过 MyAgents 桌面客户端与你对话');
      expect(text).not.toContain('<myagents-generative-ui>');
      expect(text).toContain('<myagents-channel>');
      expect(text).toContain('桌面');
      expect(buildDshSystemContext({ type: 'desktop' }, options).sections[2]?.text).not.toContain('<myagents-generative-ui>');
    }
    expect(buildSystemPromptAppend({ type: 'desktop' }, { channelBound: false })).toContain('<myagents-generative-ui>');
  });
});
