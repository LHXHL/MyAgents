import { describe, expect, it } from "vitest";

import packageJson from "../../../package.json";
import {
  CLAUDE_AGENT_SDK_IMPLEMENTATION_VERSION,
  createDshBinding,
  legacyProjectionForBinding,
  parseAgentRuntimePreference,
  parseEffectiveRuntimeBinding,
  preferenceFromLegacyAgentFacts,
  resolvePersistedRuntimeBinding,
  runtimeBindingKey,
} from "./identity";

describe("Integrated Runtime identity", () => {
  it("keeps the Claude SDK implementation identity aligned with package authority", () => {
    expect(packageJson.dependencies["@anthropic-ai/claude-agent-sdk"]).toBe(
      CLAUDE_AGENT_SDK_IMPLEMENTATION_VERSION,
    );
  });

  it("accepts only public Agent preference families and never accepts Pi", () => {
    expect(
      parseAgentRuntimePreference({ family: "integrated", id: "dsh" }),
    ).toEqual({ family: "integrated", id: "dsh" });
    expect(
      parseAgentRuntimePreference({ family: "external", id: "codex" }),
    ).toEqual({ family: "external", id: "codex" });
    expect(
      parseAgentRuntimePreference({ family: "integrated", id: "pi" }),
    ).toBeUndefined();
    expect(
      parseAgentRuntimePreference({ family: "managed-provider", id: "codex" }),
    ).toBeUndefined();
  });

  it("preserves legal Agent intent and does not reclassify managed Codex as External", () => {
    expect(preferenceFromLegacyAgentFacts({ runtime: "gemini" })).toEqual({
      family: "external",
      id: "gemini",
    });
    expect(
      preferenceFromLegacyAgentFacts({
        runtime: "codex",
        runtimeSource: "managed-provider",
        providerId: "codex-sub",
      }),
    ).toEqual({ family: "integrated", id: "claude-agent-sdk" });
    expect(
      preferenceFromLegacyAgentFacts({
        runtime: "gemini",
        runtimeSource: "managed-provider",
      }),
    ).toEqual({ family: "external", id: "gemini" });
    expect(preferenceFromLegacyAgentFacts({ runtime: "dsh" })).toEqual({
      family: "integrated",
      id: "dsh",
    });
    expect(
      preferenceFromLegacyAgentFacts({ runtime: "dsh", runtimeSource: "integrated" }),
    ).toEqual({ family: "integrated", id: "dsh" });
    expect(
      preferenceFromLegacyAgentFacts({ runtime: "dsh", runtimeSource: "system-cli" }),
    ).toBeUndefined();
    expect(
      preferenceFromLegacyAgentFacts({ runtime: "future-runtime" }),
    ).toBeUndefined();
  });

  it("creates DSH bindings exclusively from the committed lock", () => {
    const binding = createDshBinding("darwin-arm64");
    expect(binding).toMatchObject({
      family: "integrated",
      id: "dsh",
      implementationVersion: "0.0.0",
      protocolVersion: "2.1.0",
      protocolSchemaSha256:
        "968dd0c0fb90965ad8881fe6599dcb71e1085dadc5809bf0716aaf3289f79eb7",
      runtimeArtifactSha256:
        "2c08c37173e5f84e7296fae5ea41ae9054aff247b1656400a25c9b08db8dc270",
      compatibilityManifestSha256:
        "c579ea3ab37616fa2497453a6015651268f8929217fe3fa3b86f257f0264254e",
      sessionFormat: "dsh-session-events-v1",
      platformTarget: "darwin-arm64",
    });
    expect(parseEffectiveRuntimeBinding(binding)).toEqual(binding);
    expect(runtimeBindingKey(binding)).toBe("integrated:dsh:0.0.0");
    expect(legacyProjectionForBinding(binding)).toEqual({
      runtime: "dsh",
      runtimeSource: "integrated",
    });
  });

  it("migrates every legal legacy identity without changing semantics", () => {
    expect(resolvePersistedRuntimeBinding({ runtime: "builtin" })).toMatchObject({
      status: "resolved",
      migratedFromLegacy: true,
      binding: { family: "integrated", id: "claude-agent-sdk" },
    });
    expect(
      resolvePersistedRuntimeBinding({
        runtime: "builtin",
        providerId: "codex-sub",
      }),
    ).toMatchObject({
      status: "resolved",
      binding: { family: "managed-provider", id: "managed-codex" },
    });
    expect(
      resolvePersistedRuntimeBinding({
        runtime: "codex",
        runtimeSource: "managed-provider",
      }),
    ).toMatchObject({
      status: "resolved",
      binding: { family: "managed-provider", id: "managed-codex" },
    });
    for (const runtime of ["claude-code", "codex", "gemini"] as const) {
      expect(resolvePersistedRuntimeBinding({ runtime })).toMatchObject({
        status: "resolved",
        binding: { family: "external", id: runtime },
      });
    }
  });

  it("quarantines unknown and illegal legacy combinations instead of falling back", () => {
    expect(
      resolvePersistedRuntimeBinding({
        runtime: "builtin",
        runtimeSource: "managed-provider",
        providerId: "anthropic-sub",
      }),
    ).toMatchObject({
      status: "incompatible",
      compatibility: {
        code: "legacy-managed-provider-without-codex-proof",
      },
    });
    expect(
      resolvePersistedRuntimeBinding({
        runtime: "gemini",
        runtimeSource: "managed-provider",
      }),
    ).toMatchObject({
      status: "incompatible",
      compatibility: { code: "illegal-legacy-runtime-source" },
    });
    expect(
      resolvePersistedRuntimeBinding({ runtime: "future-runtime" }),
    ).toMatchObject({
      status: "incompatible",
      compatibility: { code: "unknown-legacy-runtime" },
    });
  });

  it("treats an invalid authoritative binding as incompatible without legacy fallback", () => {
    expect(
      resolvePersistedRuntimeBinding({
        runtimeBinding: {
          family: "integrated",
          id: "dsh",
          implementationVersion: "0.0.0",
        },
        runtime: "builtin",
      }),
    ).toMatchObject({
      status: "incompatible",
      compatibility: { code: "invalid-runtime-binding" },
    });
  });
});
