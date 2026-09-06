import { GENERATED_PROTOCOL_VERSION } from '../../../../contracts/myagents-dsh/public-contract.generated';
import { describe, expect, it } from "vitest";

import type { DshExecutionEnvironment } from "./protocol-types";
import { createDshInitializeParams } from "./initialize";

function executionEnvironment(): Omit<DshExecutionEnvironment, "digest"> {
  return {
    revision: "execution-v1",
    workspace: {
      identity: "workspace-1",
      canonicalRoot: "/fixture/workspace",
      allowedReadRoots: ["/fixture/workspace"],
      allowedWriteRoots: ["/fixture/workspace"],
    },
    executables: {
      bundledNodeRef: "node-v24",
      shellRef: "bash",
      ripgrepRef: "rg",
      shellDialect: "bash",
      allowedCommandRefs: ["node-v24", "bash", "rg"],
      pathPolicy: "sealed",
    },
    environment: {
      allowedKeys: ["LANG"],
      inheritedKeys: [],
      secretValues: "reverse-port-only",
    },
    network: { mode: "deny" },
    process: {
      backgroundRetention: "allow",
      maxChildren: 8,
      killTreeOnAbort: true,
    },
    checkpoint: {
      mode: "managed-file-tools",
      version: 1,
      policyRevision: "checkpoint-v1",
      trackedTools: ["Write", "Edit"],
      tracksShell: false,
      tracksChildAgents: false,
      tracksExternalChanges: false,
    },
    attachmentStagingRoot: "/fixture/attachments",
  };
}

function create(environment = executionEnvironment()) {
  return createDshInitializeParams({
    productSessionId: "product-session-1",
    productVersion: "0.4.11",
    runtimeHome: "/fixture/runtime-home",
    workspace: { path: "/fixture/workspace", identity: "workspace-1" },
    executionEnvironment: environment,
    interaction: "interactive",
    platform: "fixture",
    arch: "fixture",
  });
}

describe("DSH initialize authority compiler", () => {
  it("produces a stable, deeply frozen secret-free authority", () => {
    const source = executionEnvironment();
    const first = create(source);
    const second = create();
    expect(first.executionEnvironment.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.executionEnvironment.digest).toBe(
      second.executionEnvironment.digest,
    );
    expect(first.protocol).toEqual({
      minVersion: GENERATED_PROTOCOL_VERSION,
      maxVersion: GENERATED_PROTOCOL_VERSION,
    });
    expect(first.host.nodeVersion).toBe("v24.20.0");
    expect(Object.isFrozen(first.executionEnvironment.workspace)).toBe(true);
    expect(Object.isFrozen(source.workspace)).toBe(false);
  });

  it("changes the digest for execution-policy changes", () => {
    const original = executionEnvironment();
    const changed = {
      ...original,
      process: { ...original.process, maxChildren: 9 },
    };
    expect(create(changed).executionEnvironment.digest).not.toBe(
      create().executionEnvironment.digest,
    );
  });

  it("preserves declarations for Runtime admission and rejects Host workspace drift", () => {
    const original = executionEnvironment();
    const secret = {
      ...original,
      environment: {
        ...original.environment,
        allowedKeys: ["ANTHROPIC_API_KEY"],
      },
    };
    expect(create(secret).executionEnvironment.environment.allowedKeys).toEqual(secret.environment.allowedKeys);

    const drifted = {
      ...original,
      workspace: { ...original.workspace, canonicalRoot: "/fixture/other" },
    };
    expect(() => create(drifted)).toThrow(/authority/);

    expect(() => create({ ...original, planDirectory: undefined })).toThrow(
      /undefined/,
    );
  });
});
