import { delimiter, dirname } from "node:path";

import { describe, expect, it } from "vitest";

import { buildDshChildEnvironment } from "./child-environment";

describe("DSH child environment", () => {
  it("constructs a sealed PATH and never spreads inherited secrets", () => {
    const node = "/verified/resources/nodejs/bin/node";
    const environment = buildDshChildEnvironment({
      nodeExecutablePath: node,
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
      },
    });
    expect(environment.env).toEqual({
      PATH: [dirname(node), "/verified/tools"].join(delimiter),
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
  });

  it('seals explicit Product routing independently of stale ambient variables and generation rotation', () => {
    for (const [productSessionId, sidecarPort] of [['product-a', 31417], ['product-b', 31418], ['product-a', 31419]] as const) {
      const environment = buildDshChildEnvironment({
        nodeExecutablePath: '/verified/node',
        inheritedEnvironment: { MYAGENTS_PORT: '1', MYAGENTS_SESSION_ID: 'old-runtime-session', NODE_OPTIONS: 'injected' },
        sessionRoute: { productSessionId, sidecarPort },
      });
      expect(environment.env.MYAGENTS_PORT).toBe(String(sidecarPort));
      expect(environment.env.MYAGENTS_SESSION_ID).toBe(productSessionId);
      expect(environment.allowedKeys).toEqual(['PATH', 'MYAGENTS_PORT', 'MYAGENTS_SESSION_ID']);
      expect(environment.inheritedKeys).toEqual([]);
      expect(environment.env.NODE_OPTIONS).toBeUndefined();
    }
    for (const sidecarPort of [0, -1, 65_536, NaN, 1.5]) {
      expect(() => buildDshChildEnvironment({
        nodeExecutablePath: '/verified/node', sessionRoute: { productSessionId: 'product-a', sidecarPort },
      })).toThrow(/route/);
    }
    for (const productSessionId of ['', 'with\nnewline', 'a/b', 'a'.repeat(100)]) {
      expect(() => buildDshChildEnvironment({
        nodeExecutablePath: '/verified/node', sessionRoute: { productSessionId, sidecarPort: 31417 },
      })).toThrow(/route/);
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
      inheritedEnvironment: { HTTPS_PROXY: 'http://stale.proxy:8080', NO_PROXY: '*' },
      proxyEnvironment: {
        ...proxyEnvironment,
        ANTHROPIC_API_KEY: 'credential-canary',
        NODE_OPTIONS: '--require=/tmp/inject.js',
        PATH: '/untrusted',
        MYAGENTS_PROXY_INJECTED: '1',
      },
    });
    expect(environment.env).toEqual({ PATH: '/verified', ...proxyEnvironment });
    expect(environment.allowedKeys).toEqual(['PATH', ...Object.keys(proxyEnvironment)]);
    expect(environment.inheritedKeys).toEqual([]);
    expect(JSON.stringify(environment)).not.toContain('credential-canary');
    expect(Object.isFrozen(environment.env)).toBe(true);
  });

  it('omits invalid proxy values without falling back to ambient proxies', () => {
    const environment = buildDshChildEnvironment({
      nodeExecutablePath: '/verified/node',
      inheritedEnvironment: { HTTPS_PROXY: 'http://stale.proxy:8080' },
      proxyEnvironment: { HTTP_PROXY: '', HTTPS_PROXY: 'http://proxy\0invalid', ALL_PROXY: 'x'.repeat(32_769) },
    });
    expect(environment.env).toEqual({ PATH: '/verified' });
  });

  it("rejects relative executable authorities", () => {
    expect(() =>
      buildDshChildEnvironment({ nodeExecutablePath: "node" }),
    ).toThrow(/absolute/);
    expect(() =>
      buildDshChildEnvironment({
        nodeExecutablePath: "/verified/node",
        commandDirectories: ["relative-tools"],
      }),
    ).toThrow(/absolute/);
  });
});
