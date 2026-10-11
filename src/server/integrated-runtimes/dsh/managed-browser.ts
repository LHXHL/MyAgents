import { createHash } from 'node:crypto';
import { MANAGED_BROWSER_MCP_ID } from '../../../shared/browserTools';
import { acquireBrowserCapability, adoptBrowserProductSession } from '../../browser-host/capability-client';
import type { DshProductExtensionSource } from './extension-compiler';

export function usesManagedBrowser(source: DshProductExtensionSource | undefined): boolean {
  return source?.mcpServers.some(server => server.id === MANAGED_BROWSER_MCP_ID && server.command === '__browser_host__') === true;
}

/** Adapter projection only: never persist the endpoint or credential into Product intent. */
export async function projectDshManagedBrowser(
  source: DshProductExtensionSource,
  productSessionId: string,
): Promise<DshProductExtensionSource> {
  if (!usesManagedBrowser(source)) return source;
  const components = source.components?.filter(component => !(component.component === 'mcp' && component.id === MANAGED_BROWSER_MCP_ID)) ?? [];
  try {
    // The native DSH session id is not a Product Session identity. Adopt the
    // canonical future Product id even while its Sidecar is still pending-*.
    await adoptBrowserProductSession(productSessionId);
    const capability = await acquireBrowserCapability();
    const credentialRevision = `browser-${createHash('sha256')
      .update(JSON.stringify([capability.hostGeneration, capability.url, capability.token])).digest('hex')}`;
    return {
      ...source,
      components,
      mcpServers: source.mcpServers.map(server => server.id === MANAGED_BROWSER_MCP_ID && server.command === '__browser_host__'
        ? { ...server, type: 'http', command: undefined, args: undefined, env: undefined,
            url: capability.url, headers: { Authorization: `Bearer ${capability.token}` }, runtimeConfigRevision: credentialRevision }
        : server),
    };
  } catch {
    // The Browser is optional. Preserve the desired source in the existing
    // extension owner so a later boundary can retry through the same path.
    return {
      ...source,
      components: [...components, { component: 'mcp', id: MANAGED_BROWSER_MCP_ID, state: 'failed',
        code: 'dsh_browser_host_unavailable', message: 'The managed Browser Host is unavailable.' }],
      mcpServers: source.mcpServers.filter(server => !(server.id === MANAGED_BROWSER_MCP_ID && server.command === '__browser_host__')),
    };
  }
}
