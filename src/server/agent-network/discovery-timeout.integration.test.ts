import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('returns local discovery before the CLI deadline when the live management connection stalls', async () => {
  const server=createServer((_request,_response)=>{ /* Accepted connection, no response. */ });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const address=server.address();
    if (!address || typeof address==='string') throw new Error('Missing loopback address');
    vi.stubEnv('MYAGENTS_MANAGEMENT_PORT',String(address.port));
    vi.stubEnv('MYAGENTS_SIDECAR_ID','global');
    vi.resetModules();
    const {discoverAgents}=await import('./discovery');
    const started=performance.now();
    const result=await discoverAgents([{agentId:'local',name:'Local'}]);
    expect(performance.now()-started).toBeLessThan(9500);
    expect(result).toMatchObject({items:[{selector:'local',isLocal:true}],complete:false,networkStatus:'error'});
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  }
},15000);
