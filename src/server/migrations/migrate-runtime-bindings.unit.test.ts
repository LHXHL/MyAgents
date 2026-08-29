import { describe, expect, it } from "vitest";

import { migrateAgentRuntimePreferenceRecord } from "./migrate-runtime-bindings";

describe("Agent Runtime preference migration", () => {
  it("projects legal legacy values while preserving old fields", () => {
    expect(
      migrateAgentRuntimePreferenceRecord({
        id: "builtin",
        runtime: "builtin",
        runtimeConfig: { model: "legacy" },
      }),
    ).toEqual({
      status: "migrated",
      agent: {
        id: "builtin",
        runtime: "builtin",
        runtimeConfig: { model: "legacy" },
        runtimePreference: {
          family: "integrated",
          id: "claude-agent-sdk",
        },
      },
    });
    expect(
      migrateAgentRuntimePreferenceRecord({ id: "external", runtime: "gemini" }),
    ).toMatchObject({
      status: "migrated",
      agent: { runtimePreference: { family: "external", id: "gemini" } },
    });
    expect(
      migrateAgentRuntimePreferenceRecord({
        id: "managed",
        runtime: "codex",
        runtimeConfig: { source: "managed-provider" },
        providerId: "codex-sub",
      }),
    ).toMatchObject({
      status: "migrated",
      agent: {
        runtimePreference: {
          family: "integrated",
          id: "claude-agent-sdk",
        },
      },
    });
  });

  it("is idempotent for a valid authoritative preference", () => {
    const agent = {
      id: "dsh",
      runtime: "builtin",
      runtimePreference: { family: "integrated", id: "dsh" },
    } as const;
    expect(migrateAgentRuntimePreferenceRecord(agent)).toEqual({
      status: "unchanged",
      agent,
    });
  });

  it("preserves and reports invalid authoritative preferences", () => {
    const agent = {
      id: "future",
      runtime: "builtin",
      runtimePreference: { family: "integrated", id: "pi" },
    };
    expect(migrateAgentRuntimePreferenceRecord(agent)).toEqual({
      status: "incompatible",
      agent,
    });
  });

  it("preserves and reports unknown legacy Agent combinations", () => {
    const agent = {
      id: "illegal",
      runtime: "future-runtime",
    };
    expect(migrateAgentRuntimePreferenceRecord(agent)).toEqual({
      status: "incompatible",
      agent,
    });
  });
});
