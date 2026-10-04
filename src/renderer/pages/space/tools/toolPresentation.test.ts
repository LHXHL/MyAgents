import { describe, expect, it } from "vitest";

import type { SpaceToolRevision } from "@/api/spaceCloud";
import type { PortableMcpManifestV1 } from "../../../../shared/spaceToolManifest";
import {
  configKeyUsage,
  describeRevisionChange,
  summarizeToolRun,
  toolMonogram,
} from "./toolPresentation";

function stdio(
  command: string,
  args: string[],
  envTemplates: Record<string, string> = {},
): PortableMcpManifestV1 {
  return {
    schemaVersion: 1,
    serverId: "tool",
    transport: "stdio",
    stdio: { command, args, envTemplates },
    requiredConfigKeys: [],
  };
}

function remote(
  urlTemplate: string,
  headerTemplates: Record<string, string> = {},
  transport: "http" | "sse" = "http",
): PortableMcpManifestV1 {
  return {
    schemaVersion: 1,
    serverId: "tool",
    transport,
    remote: { urlTemplate, headerTemplates },
    requiredConfigKeys: [],
  };
}

function revision(
  number: number,
  patch: Partial<SpaceToolRevision> = {},
): SpaceToolRevision {
  return {
    id: `r${number}`,
    toolId: "tool",
    revision: number,
    name: "Tool",
    description: "desc",
    createdAt: "2026-10-01T00:00:00.000Z",
    ...patch,
  };
}

describe("summarizeToolRun", () => {
  it("shows the host for remote services and the port for local services", () => {
    expect(summarizeToolRun(remote("https://docs.qq.com/openapi/mcp"))).toEqual({
      kind: "remote",
      host: "docs.qq.com",
      transport: "http",
      full: "https://docs.qq.com/openapi/mcp",
    });
    expect(
      summarizeToolRun(remote("https://{{TENANT}}.example.com/mcp")),
    ).toMatchObject({ kind: "remote", host: "{{TENANT}}.example.com" });
    expect(
      summarizeToolRun(remote("http://127.0.0.1:3845/sse", {}, "sse")),
    ).toMatchObject({ kind: "localService", port: "3845", transport: "sse" });
    expect(summarizeToolRun(remote("http://localhost/mcp"))).toMatchObject({
      kind: "localService",
      port: "80",
    });
  });

  it("names the package and the runtime members need for package runners", () => {
    expect(
      summarizeToolRun(stdio("npx", ["-y", "@modelcontextprotocol/server-github"])),
    ).toMatchObject({
      kind: "package",
      runner: "npx",
      packageName: "@modelcontextprotocol/server-github",
      runtime: null,
    });
    expect(summarizeToolRun(stdio("uvx", ["mcp-server-fetch"]))).toMatchObject({
      kind: "package",
      packageName: "mcp-server-fetch",
      runtime: "uv",
    });
    expect(
      summarizeToolRun(stdio("uvx", ["--from", "git+https://x/y", "tool"])),
    ).toMatchObject({ packageName: "git+https://x/y" });
    expect(
      summarizeToolRun(stdio("pnpm", ["dlx", "@scope/mcp"])),
    ).toMatchObject({ packageName: "@scope/mcp", runtime: "pnpm" });
    expect(
      summarizeToolRun(stdio("pipx", ["run", "some-mcp"])),
    ).toMatchObject({ packageName: "some-mcp", runtime: "pipx" });
    expect(
      summarizeToolRun(stdio("npx", ["-p", "@scope/pkg", "bin"])),
    ).toMatchObject({ packageName: "@scope/pkg" });
  });

  it("names the image for docker and skips flag values", () => {
    expect(
      summarizeToolRun(
        stdio("docker", ["run", "-i", "--rm", "-e", "DATABASE_URL", "mcp/postgres"]),
      ),
    ).toMatchObject({ kind: "docker", image: "mcp/postgres" });
    expect(
      summarizeToolRun(stdio("docker", ["run", "--env=A=1", "ghcr.io/x/y:1"])),
    ).toMatchObject({ kind: "docker", image: "ghcr.io/x/y:1" });
  });

  it("falls back to the command name", () => {
    expect(summarizeToolRun(stdio("my-mcp", ["--stdio"]))).toEqual({
      kind: "command",
      command: "my-mcp",
      full: "my-mcp --stdio",
    });
    expect(summarizeToolRun(stdio("pnpm", ["exec", "foo"]))).toMatchObject({
      kind: "command",
      command: "pnpm",
    });
    expect(summarizeToolRun(stdio("pipx", ["some-mcp"]))).toMatchObject({
      kind: "command",
      command: "pipx",
    });
    expect(summarizeToolRun(stdio("my-mcp", ["a b", ""])).full).toBe(
      'my-mcp "a b" ""',
    );
    expect(summarizeToolRun(stdio("npx", ["-y"]))).toMatchObject({
      kind: "command",
      command: "npx",
    });
  });
});

describe("configKeyUsage", () => {
  it("says where each required key is used", () => {
    const http = remote("https://{{HOST}}/mcp", {
      Authorization: "Bearer {{TOKEN}}",
    });
    expect(configKeyUsage(http, "TOKEN")).toEqual({
      kind: "header",
      name: "Authorization",
    });
    expect(configKeyUsage(http, "HOST")).toEqual({ kind: "url" });
    const local = stdio("npx", ["pkg", "--key", "{{ARG_KEY}}"], {
      API_KEY: "{{API_KEY}}",
    });
    expect(configKeyUsage(local, "API_KEY")).toEqual({ kind: "env" });
    expect(configKeyUsage(local, "ARG_KEY")).toEqual({ kind: "argument" });
  });
});

describe("describeRevisionChange", () => {
  it("reports the first publish only for revision 1", () => {
    expect(describeRevisionChange(revision(1), undefined)).toEqual({
      kind: "first",
    });
    expect(describeRevisionChange(revision(7), undefined)).toEqual({
      kind: "unknown",
    });
  });

  it("lists changed fields against the next older revision", () => {
    const older = revision(1, {
      name: "github",
      description: "",
      portableMcpManifest: stdio("npx", ["pkg"], { A: "{{A}}" }),
    });
    const newer = revision(2, {
      name: "GitHub",
      description: "desc",
      portableMcpManifest: {
        ...stdio("npx", ["pkg@2"], { B: "{{B}}" }),
        requiredConfigKeys: ["B"],
      },
    });
    expect(describeRevisionChange(newer, older)).toEqual({
      kind: "changed",
      fields: ["name", "description", "credentials", "run"],
    });
    expect(
      describeRevisionChange(
        revision(3, { customInstallInstruction: "new" }),
        revision(2, { customInstallInstruction: "old" }),
      ),
    ).toEqual({ kind: "changed", fields: ["instruction"] });
  });

  it("never reports a changed manifest as unchanged", () => {
    expect(
      describeRevisionChange(
        revision(2, { portableMcpManifest: remote("https://x/mcp", { "X-Region": "cn" }) }),
        revision(1, { portableMcpManifest: remote("https://x/mcp", { "X-Region": "us" }) }),
      ),
    ).toEqual({ kind: "changed", fields: ["run"] });
    expect(describeRevisionChange(revision(2), revision(1))).toEqual({
      kind: "unchanged",
    });
  });
});

describe("toolMonogram", () => {
  it("uses the first letter or digit and a stable theme tone", () => {
    expect(toolMonogram("tencent-docs").character).toBe("T");
    expect(toolMonogram("  @腾讯文档").character).toBe("腾");
    expect(toolMonogram("---").character).toBe("?");
    expect(toolMonogram("GitHub").color).toBe(toolMonogram("GitHub").color);
    expect(toolMonogram("GitHub").color).toMatch(/^var\(--/);
  });
});
