import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { materializeProviderRouteEnv, type AdminAppConfig } from '../utils/admin-config';
import { providerEnvEqual } from '../builtin-session/config';

const scratch = vi.hoisted(() => ({ home: `/tmp/myagents-go-route-${process.pid}-${Date.now()}` }));
vi.mock('../utils/platform', async importOriginal => ({
  ...(await importOriginal<typeof import('../utils/platform')>()),
  getHomeDirOrNull: () => scratch.home,
}));
beforeAll(() => mkdirSync(`${scratch.home}/.myagents`, { recursive: true }));
afterAll(() => rmSync(scratch.home, { recursive: true, force: true }));

const config: AdminAppConfig = {
  providerApiKeys: { 'opencode-go': 'fixture-only' },
  presetCustomModels: { 'opencode-go': [{
    model: 'future-go', modelName: 'Future Go', modelSeries: 'other', source: 'manual',
    executionProtocol: 'openai:responses',
  }] },
};

describe('OpenCode Go execution materialization', () => {
  const route = (model: string, c = config) => materializeProviderRouteEnv(
    { kind: 'provider', providerId: 'opencode-go', model }, c,
  )!;

  it('routes all three transports and observes protocol changes on the next Query', () => {
    const messages = route('minimax-m3');
    const responses = route('grok-4.7');
    const chat = route('kimi-k3');
    expect(messages).toMatchObject({ apiProtocol: 'anthropic', baseUrl: 'https://opencode.ai/zen/go', authType: 'api_key' });
    expect(responses).toMatchObject({ apiProtocol: 'openai', upstreamFormat: 'responses', baseUrl: 'https://opencode.ai/zen/go/v1' });
    expect(chat).toMatchObject({ apiProtocol: 'openai', upstreamFormat: 'chat_completions', baseUrl: 'https://opencode.ai/zen/go/v1' });
    expect(route('future-go').upstreamFormat).toBe('responses');
    expect(providerEnvEqual(messages, responses)).toBe(false);
    expect(providerEnvEqual(responses, chat)).toBe(false);
    expect(route('minimax-m3')).toEqual(messages);
  });

  it('rejects an unknown model before execution and does not borrow the default route', () => {
    const withUnknown = { ...config, presetCustomModels: { 'opencode-go': [{
      model: 'unknown', modelName: 'Unknown', modelSeries: 'other', source: 'manual' as const,
    }] } };
    expect(() => route('unknown', withUnknown)).toThrow('Set its protocol in model settings');
    expect(route('minimax-m3', withUnknown).apiProtocol).toBe('anthropic');
  });

});
