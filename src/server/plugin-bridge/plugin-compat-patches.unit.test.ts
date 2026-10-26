import { describe, expect, it } from 'vitest';
import { patchChannelLifecycleSource, patchWecomCliSource } from './plugin-compat-patches';

describe('plugin compatibility without source fingerprints', () => {
  it('keeps Lark source metadata after unrelated edits and formatting changes', () => {
    const source = `// Updated upstream build
function context(dc) {
  return { Timestamp: dc.ctx.createTime ?? Date.now(), };
}
`.replaceAll(' ', '\t').replaceAll('\n', '\r\n');
    const patched = patchChannelLifecycleSource(source, 'lark');
    expect(patched).not.toBeNull();
    const context = new Function(`${patched}; return context;`)();
    expect(context({ ctx: { createTime: 42, mentions: [{ isBot: true }] } })).toMatchObject({
      Timestamp: 42, MyAgentsSourceSentAt: 42,
      MyAgentsMentions: [{ isBot: true }], MyAgentsMentionsSelf: true,
    });
    expect(context({ ctx: {} })).toMatchObject({
      MyAgentsSourceSentAt: null, MyAgentsMentions: [], MyAgentsMentionsSelf: false,
    });
  });

  it('preserves Lark configured instructions without inventing historical timestamps', () => {
    const source = `function context(groupSystemPrompt, configuredGroupPrompt, entry) {
      return {
        ...(groupSystemPrompt ? { GroupSystemPrompt: groupSystemPrompt } : {}),
        timestamp: entry.timestamp ?? Date.now(),
      };
    }
    // unrelated upstream addition
    const version = 'next';`;
    const patched = patchChannelLifecycleSource(source, 'larkDispatch');
    expect(patched).not.toBeNull();
    const context = new Function(`${patched}; return context;`)();
    expect(context('group', 'configured', {})).toEqual({
      GroupSystemPrompt: 'group', MyAgentsConfiguredInstructions: 'configured', timestamp: null,
    });
    // Related edits remain a single operation if a required target disappears.
    expect(patchChannelLifecycleSource(source.replace('entry.timestamp', 'entry.sentAt'), 'larkDispatch')).toBeNull();
  });

  it('keeps standalone WeCom help and tool error status across source changes', () => {
    const source = `// Changed plugin build
function validate(argv) {
  const /* added upstream comment */ head = argv[0];
  if (head.startsWith('-')) throw new Error('unsupported flag');
}
const textResult = details => ({ details });
const errorResult = (message, extra) => textResult({ error: message, ...extra });
`;
    const argvPatched = patchWecomCliSource(source, 'argv');
    expect(argvPatched).not.toBeNull();
    const patched = patchWecomCliSource(argvPatched!, 'tool');
    expect(patched).not.toBeNull();
    const { validate, errorResult } = new Function(`${patched}; return { validate, errorResult };`)();
    expect(() => validate(['--help'])).not.toThrow();
    expect(() => validate(['-h'])).not.toThrow();
    expect(() => validate(['--help', '--config-dir=/other'])).toThrow('unsupported flag');
    expect(errorResult('failed', { code: 1 })).toEqual({ isError: true, details: { error: 'failed', code: 1 } });
  });
});
