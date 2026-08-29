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
        NODE_OPTIONS: "--require=/tmp/inject.js",
        ANTHROPIC_API_KEY: "credential-canary",
        HTTPS_PROXY: "http://user:password@example.invalid",
      },
    });
    expect(environment.env).toEqual({
      PATH: [dirname(node), "/verified/tools"].join(delimiter),
      LANG: "en_US.UTF-8",
    });
    expect(environment.inheritedKeys).toEqual(["LANG"]);
    expect(JSON.stringify(environment)).not.toContain("credential-canary");
    expect(environment.env).not.toHaveProperty("HOME");
    expect(environment.env).not.toHaveProperty("NODE_OPTIONS");
    expect(environment.env).not.toHaveProperty("HTTPS_PROXY");
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
