import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESET_PROVIDERS } from '../../../shared/config-types';
import { RuntimeSteerUnavailableError } from '../../runtimes/types';
import { DshRuntime } from './runtime';
import type { DshRpcObject } from './protocol-types';

const fixture = vi.hoisted(() => ({ home: '', extensionRevision: '', request: vi.fn() }));
vi.mock('../../utils/platform', async original => ({ ...await original<typeof import('../../utils/platform')>(), getHomeDir: () => fixture.home }));
vi.mock('../../utils/runtime', () => ({ getBundledNodePath: () => join(fixture.home, 'node') }));
vi.mock('../../utils/shell', () => ({ ensureShellPath: async () => '' }));
vi.mock('../../session-core/sidecar-port', () => ({ getSidecarPort: () => 12345 }));
vi.mock('../../SessionStore', () => ({ getSessionMetadata: () => ({ providerRoute: { kind: 'provider', providerId: 'deepseek', model: 'deepseek-flash' } }) }));
vi.mock('../../session-engine/dsh-mutation-recovery', () => ({ recoverPendingDshMutation: async () => ({ recovered: false }) }));
vi.mock('../../utils/admin-config', () => ({
  loadConfig: () => ({}), findProjectAgentByWorkspacePath: () => undefined,
  findEffectiveProvider: () => PRESET_PROVIDERS.find(provider => provider.id === 'deepseek'),
  resolveProviderEnv: () => ({ providerId: 'deepseek', apiProtocol: 'anthropic', authType: 'api_key', apiKey: 'synthetic', baseUrl: 'http://127.0.0.1:1' }),
}));
vi.mock('./installation', () => ({ resolveDshRuntimeInstallation: async (options: unknown) => options }));
vi.mock('./process-host', async original => ({
  ...await original<typeof import('./process-host')>(),
  DshRuntimeProcessHost: class {
    identity = { runtimeGeneration: 'generation-1' };
    state = 'running';
    pid = 1;
    start = async () => this.identity;
    request = (method: string, params: DshRpcObject) => fixture.request(method, params);
    stop = async () => { this.state = 'stopped'; };
  },
}));

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (fixture.home) await rm(fixture.home, { recursive: true, force: true });
});

describe('DSH native realtime rejection classification', () => {
  it('reports definite turn_not_active after pre-dispatch persistence through the actual adapter', async () => {
    fixture.home = await mkdtemp(join(tmpdir(), 'myagents-dsh-steer-'));
    await writeFile(join(fixture.home, 'node'), 'synthetic fixture');
    await mkdir(join(fixture.home, 'integrated-runtimes/dsh/runtime-artifact'), { recursive: true });
    const workspacePath = join(fixture.home, 'workspace'); await mkdir(workspacePath);
    vi.stubEnv('MYAGENTS_INTERNAL_CLI_TOKEN', 'synthetic');
    fixture.request.mockImplementation(async (method: string, params: DshRpcObject) => {
      switch (method) {
        case 'extension/replace':
          fixture.extensionRevision = String(params.revision);
          return { state: 'applied', desiredRevision: params.revision, effectiveRevision: params.revision };
        case 'extension/catalog': return { digest: 'a'.repeat(64), revision: fixture.extensionRevision, skills: [], tools: [] };
        case 'session/create': return { runtimeSessionId: 'runtime-1', state: 'ready', toolCatalog: { effectiveTools: [] }, extensionCatalog: { digest: 'a'.repeat(64) } };
        case 'config/apply': return { state: 'applied', effectiveRevision: params.revision };
        case 'permission/rules/list': return { permissionMode: 'full-autonomous', revision: 'policy-1', autoAllowTools: [], rules: [] };
        case 'turn/start': return { state: 'accepted' };
        case 'turn/followUp': throw Object.assign(new Error('native root just ended'), { code: 'turn_not_active' });
        case 'turn/interrupt':
        case 'session/close': return {};
        default: throw new Error(`Unexpected fixture request: ${method}`);
      }
    });
    const runtime = new DshRuntime();
    const process = await runtime.startSession({ sessionId: 'session-steer-reject', workspacePath,
      permissionMode: 'full-autonomous', scenario: { type: 'desktop' } }, () => {});
    try {
      await runtime.sendMessage(process, 'A', [], { clientUserMessageId: 'user-A', clientOperationId: 'root-A', allowRealtimeSteer: true });
      const beforeDispatch = vi.fn(async () => {});
      await expect(runtime.steerMessage(process, 'C', [], { clientUserMessageId: 'user-C', clientOperationId: 'root-A', beforeDispatch }))
        .rejects.toBeInstanceOf(RuntimeSteerUnavailableError);
      expect(beforeDispatch).toHaveBeenCalledWith({ clientOperationId: 'root-A', inputFingerprint: expect.any(String) });
      expect(fixture.request.mock.calls.filter(call => call[0] === 'turn/followUp')).toHaveLength(1);
      expect(fixture.request.mock.calls.some(call => call[0] === 'session/history')).toBe(false);
    } finally { await runtime.stopSession(process); }
  });
});
