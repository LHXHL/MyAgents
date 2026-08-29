import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type MigrationModule =
  typeof import("../migrations/migrate-runtime-bindings");

let testHome: string;
let previousHome: string | undefined;
let previousUserProfile: string | undefined;
let migration: MigrationModule;
let configPath: string;

beforeAll(async () => {
  testHome = mkdtempSync(join(tmpdir(), "myagents-agent-runtime-migration-"));
  previousHome = process.env.HOME;
  previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  const myAgentsDir = join(testHome, ".myagents");
  mkdirSync(myAgentsDir, { recursive: true });
  configPath = join(myAgentsDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      agents: [
        {
          id: "agent",
          name: "Agent",
          enabled: true,
          runtime: "builtin",
          providerId: "codex-sub",
          channels: [
            {
              id: "external",
              type: "feishu",
              enabled: true,
              overrides: {
                runtime: "gemini",
                runtimeConfig: { source: "managed-provider" },
              },
            },
            {
              id: "managed",
              type: "feishu",
              enabled: true,
              overrides: {
                runtime: "codex",
                runtimeConfig: { source: "managed-provider" },
              },
            },
            {
              id: "invalid",
              type: "feishu",
              enabled: true,
              overrides: {
                runtimePreference: { family: "integrated", id: "pi" },
              },
            },
          ],
        },
        {
          id: "invalid-agent",
          name: "Invalid",
          enabled: true,
          runtime: "builtin",
          runtimePreference: { family: "integrated", id: "pi" },
          channels: [],
        },
      ],
    }),
    "utf8",
  );
  vi.resetModules();
  migration = await import("../migrations/migrate-runtime-bindings");
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  rmSync(testHome, { recursive: true, force: true });
});

describe("Agent Runtime preference migration", () => {
  it("migrates Agent and Channel intent without activating dormant Provider fields", async () => {
    expect(await migration.migrateAgentRuntimePreferences()).toEqual({
      migratedAgents: 1,
      migratedChannels: 2,
      incompatibleAgentIds: ["invalid-agent"],
      incompatibleChannelIds: ["agent/invalid"],
    });
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      agentRuntimePreferenceSchemaVersion: number;
      agents: Array<Record<string, unknown>>;
    };
    expect(config.agentRuntimePreferenceSchemaVersion).toBe(1);
    expect(config.agents[0]).toMatchObject({
      runtime: "builtin",
      runtimePreference: { family: "integrated", id: "claude-agent-sdk" },
    });
    const channels = config.agents[0].channels as Array<Record<string, unknown>>;
    expect(channels[0]).toMatchObject({
      id: "external",
      overrides: {
        runtime: "gemini",
        runtimePreference: { family: "external", id: "gemini" },
      },
    });
    expect(channels[1]).toMatchObject({
      id: "managed",
      overrides: {
        runtime: "codex",
        runtimePreference: {
          family: "integrated",
          id: "claude-agent-sdk",
        },
      },
    });
    expect(channels[2]).toMatchObject({
      id: "invalid",
      overrides: {
        runtimePreference: { family: "integrated", id: "pi" },
      },
    });

    expect(await migration.migrateAgentRuntimePreferences()).toEqual({
      migratedAgents: 0,
      migratedChannels: 0,
      incompatibleAgentIds: ["invalid-agent"],
      incompatibleChannelIds: ["agent/invalid"],
    });
  });
});
