import { describe, expect, it, vi } from 'vitest';

vi.mock('./utils/cli-tools-registry', () => ({
  getUserToolsPromptSection: () => '<myagents-user-tools>registered</myagents-user-tools>',
}));

const { buildCliToolsAppend, buildSessionInboxSection } = await import('./system-prompt-cli-tools');
const { IMAGE_UNDERSTANDING_TOOL_ID, SPEECH_RECOGNITION_TOOL_ID } = await import('../shared/official-tools');

describe('buildCliToolsAppend', () => {
  it('discovers local capabilities and local/network collaboration without conflating Task or permission scope', () => {
    const text = buildSessionInboxSection({ type: 'desktop' });
    for (const command of [
      'myagents --help', 'myagents agent list', 'myagents agent show <agentId>',
      'myagents session list --agent <agentId>', 'myagents session start --agent <agentId>',
      'myagents session send <sessionId>', 'myagents session get <sessionId>',
      'myagents session state <sessionId>', 'myagents session watch <sessionId>',
      'myagents session watches', 'myagents agent network-diagnose --json',
      'myagents <group> <action> --help',
    ]) expect(text).toContain(command);
    expect(text).toContain('MCP, providers, skills and configuration');
    expect(text).toContain('durable work, scheduling and run tracking');
    expect(text).toContain('other devices');
    expect(text).toContain('description, deviceName and isLocal');
    expect(text).toContain('ma-agent:1');
    expect(text).toContain('ma-session:1');
    expect(text).toContain('visible requests and answers');
    expect(text).toContain('idle/running/waiting_user');
    expect(text).toContain('not an existing Session');
    expect(text).toContain('Never approve remotely');
    expect(text).toContain('tell your user');
    expect(text).not.toContain('complete current contract');
    expect(text).toContain('Treat them as system-delivered');
  });

  it('keeps stable CLI capabilities while user-registered tools are gated off', () => {
    const text = buildCliToolsAppend({ type: 'desktop' }, { includeUserTools: false });

    expect(text).toContain('<myagents-cli-task-automation>');
    expect(text).toContain('myagents-task-automation');
    expect(text).toContain('myagents task readme');
    expect(text).not.toContain('<myagents-cli-cron>');
    expect(text).toContain('<myagents-cli-goal>');
    expect(text).toContain('<myagents-cli-record>');
    expect(text).toContain('myagents record create');
    expect(text).not.toContain('myagents thought create');
    expect(text).toContain('myagents goal --help');
    expect(text).toContain('goal-objective.txt');
    expect(text).toContain('system\ntemp files are both accepted');
    expect(text).not.toContain('<myagents-user-tools>');
    expect(text.toLowerCase()).not.toContain('anydoc');
  });

  it('injects Goal Mode into private user-facing channel prompts', () => {
    const imText = buildCliToolsAppend(
      { type: 'im', platform: 'feishu', sourceType: 'private' },
      { includeUserTools: false },
    );
    const channelText = buildCliToolsAppend(
      { type: 'agent-channel', platform: 'feishu', sourceType: 'private' },
      { includeUserTools: false },
    );

    expect(imText).toContain('<myagents-cli-goal>');
    expect(channelText).toContain('<myagents-cli-goal>');
    expect(imText).toContain('目标模式');
    expect(channelText).toContain('设立目标');
  });

  it('does not inject Goal Mode into headless or semi-open prompts', () => {
    const cronText = buildCliToolsAppend(
      { type: 'cron', taskId: 'task-1', intervalMinutes: 5, aiCanExit: true },
      { includeUserTools: false },
    );
    const registeredAgentText = buildCliToolsAppend(
      { type: 'registeredAgent', platform: 'space', spaceId: 'space-1', registeredAgentId: 'ra-1' },
      { includeUserTools: false },
    );
    const imGroupText = buildCliToolsAppend(
      { type: 'im', platform: 'feishu', sourceType: 'group' },
      { includeUserTools: false },
    );
    const agentChannelGroupText = buildCliToolsAppend(
      { type: 'agent-channel', platform: 'feishu', sourceType: 'group' },
      { includeUserTools: false },
    );

    expect(cronText).not.toContain('<myagents-cli-goal>');
    expect(cronText).not.toContain('myagents goal create');
    expect(cronText).toContain('<myagents-cli-task-exit>');
    expect(cronText).toContain('myagents task exit');
    expect(registeredAgentText).not.toContain('<myagents-cli-goal>');
    expect(registeredAgentText).not.toContain('myagents goal create');
    expect(imGroupText).not.toContain('<myagents-cli-goal>');
    expect(imGroupText).not.toContain('myagents goal create');
    expect(agentChannelGroupText).not.toContain('<myagents-cli-goal>');
    expect(agentChannelGroupText).not.toContain('myagents goal create');
  });

  it('includes user-registered CLI tools only when explicitly enabled', () => {
    const text = buildCliToolsAppend({ type: 'desktop' }, { includeUserTools: true });

    expect(text).toContain('<myagents-user-tools>registered</myagents-user-tools>');
  });

  it('does not inject official image understanding by default', () => {
    const text = buildCliToolsAppend({ type: 'desktop' }, { includeUserTools: false });

    expect(text).not.toContain('<myagents-cli-vision>');
  });

  it('injects official image understanding when the session enables it', () => {
    const text = buildCliToolsAppend(
      { type: 'desktop' },
      { includeUserTools: false, enabledOfficialToolIds: [IMAGE_UNDERSTANDING_TOOL_ID] },
    );

    expect(text).toContain('<myagents-cli-vision>');
    expect(text).toContain('myagents vision analyze');
    expect(text).toContain('--prompt-file');
    expect(text).toContain('[Unsupported Image]');
    expect(text).toContain('myagents vision --help');
    expect(text).toContain('shell-sensitive');
    expect(text).toContain('user-provided');
  });

  it('injects only the thin speech discovery hint when the session authorizes it', () => {
    const text = buildCliToolsAppend(
      { type: 'desktop' },
      { includeUserTools: false, enabledOfficialToolIds: [SPEECH_RECOGNITION_TOOL_ID] },
    );

    expect(text).toContain('<myagents-cli-speech>');
    expect(text).toContain('myagents-speech-recognition');
    expect(text).toContain('myagents speech --help');
    expect(text).toContain('automatically binds');
    expect(text).not.toContain('myagents speech transcribe --file');
  });
});
