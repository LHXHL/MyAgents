import { describe, expect, it, vi } from 'vitest';
import { PRESET_PROVIDERS } from '../../shared/config-types';
import { verifyProviderViaSdk } from '../provider-verify';
import { findEffectiveProvider } from '../utils/admin-config';

const sdk = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  close: vi.fn(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => ({
    async *[Symbol.asyncIterator]() { for (const event of sdk.events) yield event; },
    close: sdk.close,
  })),
}));
vi.mock('../agent-session', () => ({
  resolveClaudeCodeCli: () => '/fixture/claude',
  buildClaudeSessionEnv: () => ({}),
  startOneShotBridge: vi.fn(),
  getSidecarPort: () => 0,
}));
vi.mock('../utils/admin-config', () => ({
  loadConfig: () => ({}),
  findEffectiveProvider: vi.fn(),
}));
vi.mock('../utils/sdk-child-launch-guard', () => ({
  createGuardedSdkQuery: async (_cli: string, launch: () => unknown) => launch(),
}));
vi.mock('../utils/fs-utils', () => ({ ensureDirSync: vi.fn() }));
vi.mock('../provider-probe', async importOriginal => ({
  ...(await importOriginal<typeof import('../provider-probe')>()),
  probeAnthropicProviderDirect: vi.fn(async () => undefined),
}));

describe('OpenCode Go connection verification', () => {
  it('reports a terminal failure after the stream has started', async () => {
    vi.mocked(findEffectiveProvider).mockReturnValue(PRESET_PROVIDERS.find(p => p.id === 'opencode-go') as never);
    sdk.events = [
      { type: 'stream_event', event: { type: 'message_start' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
      { type: 'result', subtype: 'error_during_execution', errors: ['upstream failed'] },
    ];
    const result = await verifyProviderViaSdk('opencode-go', '', 'fixture', 'api_key', 'minimax-m3');
    expect(result.success).toBe(false);
    expect(result.error).toContain('upstream failed');
    expect(sdk.close).toHaveBeenCalled();
  });
});
