import { describe, expect, it } from 'vitest';

import {
  MCP_LOCALHOST_NO_PROXY_VAL,
  buildMcpSubprocessEnv,
} from './mcp-env-policy';

describe('mcp-env-policy', () => {
  it('injects localhost NO_PROXY protection when the MCP has no explicit override', () => {
    const env = buildMcpSubprocessEnv({
      HTTPS_PROXY: 'http://proxy.local:7890',
      NO_PROXY: 'dirty-system-value',
      no_proxy: 'dirty-system-value',
    }, undefined);

    expect(env.HTTPS_PROXY).toBe('http://proxy.local:7890');
    expect(env.NO_PROXY).toBe(MCP_LOCALHOST_NO_PROXY_VAL);
    expect(env.no_proxy).toBe(MCP_LOCALHOST_NO_PROXY_VAL);
  });

  it('lets per-server NO_PROXY override the default and mirrors the other casing', () => {
    const env = buildMcpSubprocessEnv({
      NO_PROXY: 'localhost,127.0.0.1,[::1]',
      no_proxy: 'localhost,127.0.0.1,[::1]',
    }, {
      NO_PROXY: 'localhost,127.0.0.1,::1',
    });

    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1');
  });

  it('preserves explicit per-server values for both casings when both are configured', () => {
    const env = buildMcpSubprocessEnv({}, {
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1,.corp.local',
      MINERU_API_TOKEN: 'token',
    });

    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1,.corp.local');
    expect(env.MINERU_API_TOKEN).toBe('token');
  });

  it('mirrors a lowercase-only per-server no_proxy override to uppercase', () => {
    const env = buildMcpSubprocessEnv({}, {
      no_proxy: 'localhost,127.0.0.1,::1',
    });

    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,::1');
    expect(env.no_proxy).toBe('localhost,127.0.0.1,::1');
  });

  it('treats empty per-server NO_PROXY values as absent to keep localhost protection', () => {
    const env = buildMcpSubprocessEnv({}, {
      NO_PROXY: '',
      no_proxy: '   ',
    });

    expect(env.NO_PROXY).toBe(MCP_LOCALHOST_NO_PROXY_VAL);
    expect(env.no_proxy).toBe(MCP_LOCALHOST_NO_PROXY_VAL);
  });
});
