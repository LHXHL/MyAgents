import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESET_PROVIDERS, PRESET_MCP_SERVERS } from '../../../shared/config-types';
import { type UnifiedEvent } from '../../runtimes/types';
import { DshRuntime } from './runtime';
import { DshAttachmentRegistry } from './attachments';
import { dshSessionOwnedPaths } from './owned-paths';
import type { DshRpcObject } from './protocol-types';

const fixture = vi.hoisted(() => ({ home: '', extensionRevision: '', snapshot: {} as DshRpcObject, adopt: vi.fn(), acquire: vi.fn(), request: vi.fn(), notify: (_params: DshRpcObject): unknown => undefined }));
vi.mock('../../utils/platform', async original => ({ ...await original<typeof import('../../utils/platform')>(), getHomeDir: () => fixture.home }));
vi.mock('../../utils/runtime', () => ({ getBundledNodePath: () => join(fixture.home, 'node') }));
vi.mock('../../utils/shell', () => ({ ensureShellPath: async () => '' }));
vi.mock('../../session-core/sidecar-port', () => ({ getSidecarPort: () => 12345 }));
vi.mock('../../SessionStore', () => ({ getSessionMetadata: () => ({ providerRoute: { kind: 'provider', providerId: 'deepseek', model: 'deepseek-flash' } }) }));
vi.mock('../../session-engine/dsh-turn-reconciliation', async original => ({ ...await original<typeof import('../../session-engine/dsh-turn-reconciliation')>(), reconcileDshTurnsAtStartup: async () => ({ transcriptChanged: false, reconciledOperations: 0, settledTurnIds: [] }) }));
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
    constructor(options: { notificationHandlers: Record<string, (params: DshRpcObject) => unknown> }) {
      fixture.notify = options.notificationHandlers['runtime/event'];
    }
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


vi.mock('../../browser-host/capability-client', () => ({ adoptBrowserProductSession: fixture.adopt, acquireBrowserCapability: fixture.acquire }));

describe('DSH product Browser capability lifecycle', () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])('projects the owner and refreshes at a boundary (resume=%s, rejected replacement=%s)', async (resume, rejectReplacement) => {
    fixture.home = await mkdtemp(join(tmpdir(), 'dsh-browser-'));
    await writeFile(join(fixture.home, 'node'), 'synthetic fixture');
    await mkdir(join(fixture.home, 'integrated-runtimes/dsh/runtime-artifact'), { recursive: true });
    const workspacePath = join(fixture.home, 'workspace'); await mkdir(workspacePath);
    vi.stubEnv('MYAGENTS_INTERNAL_CLI_TOKEN', 'synthetic');
    fixture.adopt.mockReset().mockResolvedValue(undefined);
    fixture.acquire.mockReset().mockResolvedValue({ url: 'http://127.0.0.1:31337/mcp/playwright', token: 'a'.repeat(32), hostGeneration: 1 });
    let rejectNextReplacement = false;
    const revisions = new Map<string, unknown>();
    fixture.request.mockReset().mockImplementation(async (method: string, params: DshRpcObject) => {
      switch (method) {
        case 'extension/replace': {
          const registry = new DshAttachmentRegistry(dshSessionOwnedPaths(join(fixture.home, '.myagents'), 'product-browser').attachmentRoot);
          await registry.initialize();
          const candidate = await registry.readJson(params.snapshotAttachment as { attachmentId: string; mimeType: string; sizeBytes: number; sha256: string }) as DshRpcObject;
          const revision = String(candidate.revision);
          if (revisions.has(revision) && revisions.get(revision) !== candidate.digest) throw new Error('extension_revision_conflict');
          revisions.set(revision, candidate.digest);
          if (rejectNextReplacement) {
            rejectNextReplacement = false;
            return { state: 'failed', desiredRevision: revision, effectiveRevision: fixture.extensionRevision };
          }
          fixture.snapshot = candidate;
          fixture.extensionRevision = revision;
          return { state: 'applied', desiredRevision: fixture.extensionRevision, effectiveRevision: fixture.extensionRevision };
        }
        case 'extension/catalog': return { digest: 'a'.repeat(64), revision: fixture.extensionRevision, skills: [{ name: 'fixture' }], tools: [] };
        case 'session/resume':
        case 'session/create': return { runtimeSessionId: 'native-browser', state: 'ready', toolCatalog: { effectiveTools: [] }, extensionCatalog: { digest: 'a'.repeat(64) } };
        case 'config/apply': return { state: 'applied', effectiveRevision: params.revision };
        case 'permission/rules/list': return { permissionMode: 'full-autonomous', revision: 'policy-1', autoAllowTools: [], rules: [] };
        case 'turn/start': return { state: 'accepted' };
        case 'turn/interrupt':
        case 'session/close': return {};
        default: throw new Error(`Unexpected fixture request: ${method}`);
      }
    });
    const runtime = new DshRuntime();
    const events: UnifiedEvent[] = [];
    const dispatcher = { descriptors: [], dispatch: vi.fn(), dispose: vi.fn() };
    const rejectedDispatcher = { descriptors: [], dispatch: vi.fn(), dispose: vi.fn() };
    const redundantDispatcher = { descriptors: [], dispatch: vi.fn(), dispose: vi.fn() };
    const skillPath = join(workspacePath, 'SKILL.md');
    const skillContent = '---\nname: fixture\ndescription: Browser fixture\n---\nFrozen instructions.';
    await writeFile(skillPath, skillContent);
    const source = { revision: 'browser-config', workspacePath,
      skills: [{ name: 'fixture', description: 'Browser fixture', path: skillPath, scope: 'project' as const,
        sourceId: 'workspace', contentSha256: createHash('sha256').update(skillContent).digest('hex') }], commands: [], agents: [],
      mcpServers: PRESET_MCP_SERVERS.filter(server => server.id === 'myagents-browser'), dynamicTools: [], hostToolDispatcher: dispatcher };
    const process = await runtime.startSession({ sessionId: 'product-browser', workspacePath,
      resumeSessionId: resume ? 'native-browser' : undefined, permissionMode: 'full-autonomous', scenario: { type: 'desktop' }, dshExtensions: source }, event => events.push(event));
    try {
      expect(fixture.adopt).toHaveBeenCalledWith('product-browser');
      expect(fixture.adopt.mock.invocationCallOrder[0]).toBeLessThan(fixture.acquire.mock.invocationCallOrder[0]);
      expect(fixture.snapshot.components).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'myagents-browser',
        descriptor: expect.objectContaining({ transport: 'http', url: 'http://127.0.0.1:31337/mcp/playwright', credential: expect.objectContaining({ materialSlot: 'header' }) }) })]));
      expect(JSON.stringify(fixture.snapshot)).not.toContain('a'.repeat(32));
      const initialRevision = fixture.extensionRevision;
      // Reusing the desired source must not dispose its still-owned dispatcher.
      await runtime.replaceDshExtensions(process, source);
      expect(fixture.request.mock.calls.filter(([method]) => method === 'extension/replace')).toHaveLength(1);
      expect(dispatcher.dispose).not.toHaveBeenCalled();
      // Live disable/enable and unavailable Host preserve optional-component behavior.
      await runtime.replaceDshExtensions(process, { ...source, revision: 'browser-off', mcpServers: [] });
      expect(fixture.snapshot.components).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'mcp', id: 'myagents-browser' })]));
      fixture.acquire.mockRejectedValueOnce(new Error('Host unavailable'));
      const unavailable = await runtime.replaceDshExtensions(process, source);
      expect(unavailable.components).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'myagents-browser', state: 'failed' })]));
      // A repeated desired generation can arrive with a fresh dispatcher.
      // Keep its retained generation's dispatcher for the next capability refresh.
      fixture.acquire.mockRejectedValueOnce(new Error('Host still unavailable'));
      await runtime.replaceDshExtensions(process, { ...source, hostToolDispatcher: redundantDispatcher });
      expect(redundantDispatcher.dispose).toHaveBeenCalledOnce();
      if (rejectReplacement) {
        rejectNextReplacement = true;
        const rejected = await runtime.replaceDshExtensions(process, { ...source, revision: 'rejected-source', hostToolDispatcher: rejectedDispatcher,
          commands: [{ name: 'candidate', description: 'Rejected command', body: 'Candidate body', scope: 'project', sourceId: 'workspace' }] });
        expect(rejected.state).toBe('failed');
        expect(rejectedDispatcher.dispose).toHaveBeenCalledOnce();
      }
      await rm(skillPath); // Browser refresh must retain the admitted Skill snapshot.
      if (!rejectReplacement) fixture.acquire.mockResolvedValue({ url: 'http://127.0.0.1:31338/mcp/playwright', token: 'b'.repeat(32), hostGeneration: 2 });
      await runtime.sendMessage(process, 'continue', [], { clientUserMessageId: 'browser-user', clientOperationId: 'browser-turn' });
      if (rejectReplacement) expect(fixture.extensionRevision).toBe(initialRevision);
      else expect(fixture.extensionRevision).not.toBe(initialRevision);
      expect(fixture.snapshot.components).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'skill', id: 'fixture' })]));
      expect(fixture.snapshot.components).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'myagents-browser',
        descriptor: expect.objectContaining({ url: `http://127.0.0.1:${rejectReplacement ? 31337 : 31338}/mcp/playwright` }) })]));
      expect(JSON.stringify(fixture.snapshot)).not.toContain('b'.repeat(32));
      expect(source.mcpServers[0].command).toBe('__browser_host__');
      expect(redundantDispatcher.dispose).toHaveBeenCalledOnce();
      expect(dispatcher.dispose).not.toHaveBeenCalled();
    } finally { await runtime.stopSession(process); }
    expect(dispatcher.dispose).toHaveBeenCalledOnce();
    expect(redundantDispatcher.dispose).toHaveBeenCalledOnce();
    expect(rejectedDispatcher.dispose).toHaveBeenCalledTimes(rejectReplacement ? 1 : 0);
  });
});
