import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESET_MCP_SERVERS } from '../../../shared/config-types';
import { compileDshProductExtensionPlane, type DshProductExtensionSource } from './extension-compiler';
import { projectDshManagedBrowser } from './managed-browser';
const capability = vi.hoisted(() => ({ adopt: vi.fn(), acquire: vi.fn() }));
vi.mock('../../browser-host/capability-client', () => ({ adoptBrowserProductSession: capability.adopt, acquireBrowserCapability: capability.acquire }));
const source: DshProductExtensionSource = {
  revision: 'config-1', workspacePath: '/synthetic/workspace', skills: [], commands: [], agents: [], dynamicTools: [],
  mcpServers: PRESET_MCP_SERVERS.filter(server => server.id === 'myagents-browser'),
};
beforeEach(() => {
  capability.adopt.mockReset().mockResolvedValue(undefined);
  capability.acquire.mockReset().mockResolvedValue({ url: 'http://127.0.0.1:12345/mcp/playwright', token: 'synthetic-secret-1', hostGeneration: 1 });
});
describe('DSH managed Browser projection', () => {
  it('does not acquire a Browser for ordinary MCPs', async () => {
    const ordinary = { ...source, mcpServers: PRESET_MCP_SERVERS.filter(server => server.id === 'playwright') };
    expect(await projectDshManagedBrowser(ordinary, 'product-1')).toBe(ordinary);
    expect(capability.adopt).not.toHaveBeenCalled();
    expect(capability.acquire).not.toHaveBeenCalled();
  });
  it('degrades only the Browser and retries unchanged product intent after recovery', async () => {
    capability.acquire.mockRejectedValueOnce(new Error('private-error-synthetic-secret-1'));
    const unavailable = await projectDshManagedBrowser(source, 'product-1');
    expect(unavailable.mcpServers).toEqual([]);
    expect(unavailable.components).toEqual([expect.objectContaining({ id: 'myagents-browser', state: 'failed', code: 'dsh_browser_host_unavailable' })]);
    expect(JSON.stringify(unavailable)).not.toContain('private-error');
    const failedPlane = compileDshProductExtensionPlane(unavailable);
    const ready = await projectDshManagedBrowser(source, 'product-1');
    const readyPlane = compileDshProductExtensionPlane(ready);
    expect(readyPlane.snapshot.revision).not.toBe(failedPlane.snapshot.revision);
    expect(readyPlane.snapshot.components).toEqual([expect.objectContaining({ id: 'myagents-browser', descriptor: expect.objectContaining({ transport: 'http' }) })]);
    expect(JSON.stringify(readyPlane.snapshot)).not.toContain('synthetic-secret');
    expect(source.mcpServers[0].command).toBe('__browser_host__');
  });
  it('does not acquire under an unadopted owner', async () => {
    capability.adopt.mockRejectedValueOnce(new Error('owner mismatch'));
    expect((await projectDshManagedBrowser(source, 'product-1')).components).toEqual([expect.objectContaining({ state: 'failed' })]);
    expect(capability.acquire).not.toHaveBeenCalled();
  });
  it('changes the effective revision for credential rotation on the same endpoint', async () => {
    const first = compileDshProductExtensionPlane(await projectDshManagedBrowser(source, 'product-1'));
    capability.acquire.mockResolvedValue({ url: 'http://127.0.0.1:12345/mcp/playwright', token: 'synthetic-secret-2', hostGeneration: 1 });
    const second = compileDshProductExtensionPlane(await projectDshManagedBrowser(source, 'product-1'));
    expect(second.snapshot.revision).not.toBe(first.snapshot.revision);
    expect(JSON.stringify(second.snapshot)).not.toContain('synthetic-secret');
  });
});
