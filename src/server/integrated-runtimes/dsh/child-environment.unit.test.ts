import { spawnSync } from "node:child_process";
import { delimiter, dirname, normalize } from "node:path";

import { describe, expect, it } from "vitest";

import { buildDshChildEnvironment } from "./child-environment";

describe("DSH child environment", () => {
  it("constructs a sealed PATH and never spreads inherited secrets", () => {
    const node = "/verified/resources/nodejs/bin/node";
    const environment = buildDshChildEnvironment({
      nodeExecutablePath: node,
      sessionCli: null,
      commandDirectories: ["/verified/tools"],
      inheritedEnvironment: {
        LANG: "en_US.UTF-8",
        HOME: "/Users/example",
        USER: "example",
        SHELL: "/bin/zsh",
        NODE_OPTIONS: "--require=/tmp/inject.js",
        ANTHROPIC_API_KEY: "credential-canary",
        HTTPS_PROXY: "http://user:password@example.invalid",
        MYAGENTS_PORT: "1",
        MYAGENTS_SESSION_ID: "stale-session",
        MYAGENTS_INTERNAL_CLI_TOKEN: "ambient-capability",
        MYAGENTS_API_TOKEN: "external-capability",
      },
    });
    expect(environment.env).toEqual({
      PATH: [dirname(normalize(node)), normalize("/verified/tools")].join(delimiter),
      HOME: "/Users/example",
      USER: "example",
      SHELL: "/bin/zsh",
      LANG: "en_US.UTF-8",
    });
    expect(environment.inheritedKeys).toEqual(["HOME", "USER", "SHELL", "LANG"]);
    expect(JSON.stringify(environment)).not.toContain("credential-canary");
    expect(environment.env).not.toHaveProperty("NODE_OPTIONS");
    expect(environment.env).not.toHaveProperty("HTTPS_PROXY");
    expect(environment.env).not.toHaveProperty("MYAGENTS_PORT");
    expect(environment.env).not.toHaveProperty("MYAGENTS_SESSION_ID");
    expect(environment.env).not.toHaveProperty("MYAGENTS_INTERNAL_CLI_TOKEN");
    expect(environment.env).not.toHaveProperty("MYAGENTS_API_TOKEN");
  });

  it('seals explicit Product routing independently of stale ambient variables and generation rotation', () => {
    for (const [productSessionId, sidecarPort] of [['product-a', 31417], ['product-b', 31418], ['product-a', 31419]] as const) {
      const environment = buildDshChildEnvironment({
        nodeExecutablePath: '/verified/node',
        inheritedEnvironment: { MYAGENTS_PORT: '1', MYAGENTS_SESSION_ID: 'old-runtime-session', MYAGENTS_INTERNAL_CLI_TOKEN: 'stale-capability', NODE_OPTIONS: 'injected' },
        sessionCli: { productSessionId, sidecarPort, internalCliToken: 'app-capability' },
      });
      expect(environment.env.MYAGENTS_PORT).toBe(String(sidecarPort));
      expect(environment.env.MYAGENTS_SESSION_ID).toBe(productSessionId);
      expect(environment.env.MYAGENTS_INTERNAL_CLI_TOKEN).toBe('app-capability');
      expect(environment.env.MYAGENTS_API_TOKEN).toBeUndefined();
      expect(environment.allowedKeys).toEqual(['PATH', 'MYAGENTS_PORT', 'MYAGENTS_SESSION_ID', 'MYAGENTS_INTERNAL_CLI_TOKEN']);
      expect(environment.inheritedKeys).toEqual([]);
      expect(environment.env.NODE_OPTIONS).toBeUndefined();
    }
    for (const sidecarPort of [0, -1, 65_536, NaN, 1.5]) {
      expect(() => buildDshChildEnvironment({
        nodeExecutablePath: '/verified/node', sessionCli: { productSessionId: 'product-a', sidecarPort, internalCliToken: 'app-capability' },
      })).toThrow(/route/);
    }
    for (const productSessionId of ['', 'with\nnewline', 'a/b', 'a'.repeat(100)]) {
      expect(() => buildDshChildEnvironment({
        nodeExecutablePath: '/verified/node', sessionCli: { productSessionId, sidecarPort: 31417, internalCliToken: 'app-capability' },
      })).toThrow(/route/);
    }
    for (const internalCliToken of ['', ' app-capability', 'app-capability\n', 'app\0capability']) {
      expect(() => buildDshChildEnvironment({
        nodeExecutablePath: '/verified/node',
        sessionCli: { productSessionId: 'product-a', sidecarPort: 31417, internalCliToken },
      })).toThrow(/internal CLI capability/);
    }
  });

  it('admits only the explicit general proxy projection, independently of ambient variables', () => {
    const proxyEnvironment = {
      HTTP_PROXY: 'http://general.proxy:7890',
      HTTPS_PROXY: 'http://general.proxy:7890',
      http_proxy: 'http://general.proxy:7890',
      https_proxy: 'http://general.proxy:7890',
      ALL_PROXY: 'socks5://inherited.proxy:1080',
      all_proxy: 'socks5://inherited.proxy:1080',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
    };
    const environment = buildDshChildEnvironment({
      nodeExecutablePath: '/verified/node',
      sessionCli: null,
      inheritedEnvironment: { HTTPS_PROXY: 'http://stale.proxy:8080', NO_PROXY: '*' },
      proxyEnvironment: {
        ...proxyEnvironment,
        ANTHROPIC_API_KEY: 'credential-canary',
        NODE_OPTIONS: '--require=/tmp/inject.js',
        PATH: '/untrusted',
        MYAGENTS_PROXY_INJECTED: '1',
      },
    });
    const selectedProxyEnvironment = process.platform === 'win32'
      ? Object.fromEntries(Object.entries(proxyEnvironment).filter(([key]) => key === key.toUpperCase()))
      : proxyEnvironment;
    expect(environment.env).toEqual({ PATH: normalize('/verified'), ...selectedProxyEnvironment });
    expect(environment.allowedKeys).toEqual(['PATH', ...Object.keys(selectedProxyEnvironment)]);
    expect(environment.inheritedKeys).toEqual([]);
    expect(JSON.stringify(environment)).not.toContain('credential-canary');
    expect(Object.isFrozen(environment.env)).toBe(true);
  });

  it('omits invalid proxy values without falling back to ambient proxies', () => {
    const environment = buildDshChildEnvironment({
      nodeExecutablePath: '/verified/node',
      sessionCli: null,
      inheritedEnvironment: { HTTPS_PROXY: 'http://stale.proxy:8080' },
      proxyEnvironment: { HTTP_PROXY: '', HTTPS_PROXY: 'http://proxy\0invalid', ALL_PROXY: 'x'.repeat(32_769) },
    });
    expect(environment.env).toEqual({ PATH: normalize('/verified') });
  });

  it('declares only environment names that survive Windows process creation', () => {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const environment = buildDshChildEnvironment({
      nodeExecutablePath: process.execPath,
      platform: 'win32',
      sessionCli: null,
      inheritedEnvironment: { SYSTEMROOT: systemRoot, SystemRoot: systemRoot },
      proxyEnvironment: {
        HTTP_PROXY: 'http://selected.proxy',
        http_proxy: 'http://duplicate.proxy',
        NO_PROXY: 'localhost',
        no_proxy: 'localhost',
      },
    });
    expect(environment.allowedKeys).toContain('SYSTEMROOT');
    expect(environment.allowedKeys).toContain('HTTP_PROXY');
    expect(environment.allowedKeys).toContain('NO_PROXY');
    expect(environment.allowedKeys).not.toContain('SystemRoot');
    expect(environment.allowedKeys).not.toContain('http_proxy');
    expect(environment.allowedKeys).not.toContain('no_proxy');
    expect(environment.inheritedKeys).toEqual(['SYSTEMROOT']);
    expect(environment.env.HTTP_PROXY).toBe('http://selected.proxy');

    if (process.platform === 'win32') {
      const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], {
        env: environment.env,
        encoding: 'utf8',
      });
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual(expect.arrayContaining([...environment.allowedKeys]));
    }
  });

  it("rejects relative executable authorities", () => {
    expect(() =>
      buildDshChildEnvironment({ nodeExecutablePath: "node", sessionCli: null }),
    ).toThrow(/absolute/);
    expect(() =>
      buildDshChildEnvironment({
        nodeExecutablePath: "/verified/node",
        sessionCli: null,
        commandDirectories: ["relative-tools"],
      }),
    ).toThrow(/absolute/);
  });
});
