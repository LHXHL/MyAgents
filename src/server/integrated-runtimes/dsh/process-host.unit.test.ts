import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { LoadedDshProtocolRuntime } from "./generated-client";
import { createDshInitializeParams } from "./initialize";
import type { DshRuntimeInstallation } from "./installation";
import { DshRuntimeProcessHost, redactDshDiagnosticLine } from "./process-host";
import {
  DSH_CLIENT_METHOD_BY_PROTOCOL,
  DSH_HOST_METHOD_NAMES,
  DSH_REVERSE_METHOD_NAMES,
  type DshExecutionEnvironment,
  type DshGeneratedHostClient,
  type DshHostRequestHandlers,
  type DshInitializeResult,
  type DshJsonRpcPeer,
  type DshRuntimeNotificationHandlers,
} from "./protocol-types";

class TestProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killedSignals: Array<NodeJS.Signals | number | undefined> = [];
  private exited = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedSignals.push(signal);
    this.exit(0, typeof signal === "string" ? signal : null);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
  }
}

const installation: DshRuntimeInstallation = {
  resourceRoot: "/verified/resources",
  dshResourceRoot: "/verified/resources/integrated-runtimes/dsh",
  handoffVerifierPath: "/verified/resources/integrated-runtimes/dsh/verify.mjs",
  runtimeArtifactRoot:
    "/verified/resources/integrated-runtimes/dsh/runtime-artifact",
  runtimeEntrypointPath:
    "/verified/resources/integrated-runtimes/dsh/runtime-artifact/runtime-server-process.artifact.mjs",
  nodeExecutablePath: "/verified/resources/nodejs/bin/node",
};

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
      bashRef: "bash",
      ripgrepRef: "rg",
      bashDialect: "bash",
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

function initialize() {
  return createDshInitializeParams({
    productSessionId: "product-session-1",
    productVersion: "0.4.11",
    runtimeHome: "/fixture/runtime-home",
    workspace: { path: "/fixture/workspace", identity: "workspace-1" },
    executionEnvironment: executionEnvironment(),
    interaction: "interactive",
    platform: "fixture",
    arch: "fixture",
  });
}

function initializeResult(
  overrides: Partial<DshInitializeResult> = {},
): DshInitializeResult {
  return {
    protocolVersion: "2.1.0",
    schemaSha256:
      "968dd0c0fb90965ad8881fe6599dcb71e1085dadc5809bf0716aaf3289f79eb7",
    runtimeVersion: "0.0.0",
    runtimeGeneration: "artifact-process-generation",
    sessionFormat: "dsh-session-events-v1",
    profileDigest:
      "fc52e0a31215853cafca925174d76f0f93c10296ec79351a204667baa1630905",
    limits: {
      maxFrameBytes: 1_048_576,
      maxPendingRequests: 128,
      maxConcurrentReverseRequests: 32,
      maxAttachmentLeases: 128,
      eventQueueHighWatermark: 2_048,
    },
    runtimeEngine: {
      name: "deepseek-harness",
      version: "0.1.1-rc.2.myagents.b150a551b8d4.8ac244cc6367",
      distribution: "myagents-dsh",
      distributionVersion: "0.0.0",
    },
    runtimeCapabilities: {
      profile: "myagents-dsh-batch-1-candidate-v1",
      hostPorts: {
        credentials: "request-connection-scoped",
        interaction: "registration-ack-plus-explicit-response",
        tools: "reverse-request-v1",
        hooks: "reverse-request-v1",
        attachments: "generation-leases-v1",
      },
      security: {
        execution: "trusted-local-user-process",
        osSandbox: false,
        secrets: "reverse-port-only",
        checkpoint: "root-write-edit-only-v1",
      },
      tools: {
        pipeline: "dsh-ctx-tools-only",
        hostTools: "reverse-request",
        hooks: "governed-pre-post",
      },
      interaction: { settlement: "register-then-respond" },
      sessions: { resume: "dsh-native" },
    },
    ...overrides,
  };
}

function hostHandlers(): DshHostRequestHandlers {
  return Object.fromEntries(
    DSH_REVERSE_METHOD_NAMES.map((method) => [
      method,
      async () => ({ ok: true }),
    ]),
  ) as unknown as DshHostRequestHandlers;
}

const notificationHandlers: DshRuntimeNotificationHandlers = {
  "runtime/event": vi.fn(),
  "host/interaction/cancel": vi.fn(),
};

function harness(result = initializeResult()) {
  const order: string[] = [];
  const child = new FakeChild();
  let registeredHostHandlers: DshHostRequestHandlers | undefined;
  let registeredNotifications: DshRuntimeNotificationHandlers | undefined;
  const peer: DshJsonRpcPeer = {
    role: "host",
    updateLimits: () => order.push("update-limits"),
    flush: async () => {
      order.push("flush");
    },
    close: () => {
      order.push("peer-close");
    },
  };
  const clientRecord: Record<string, unknown> = { peer };
  for (const method of DSH_HOST_METHOD_NAMES) {
    const clientMethod = DSH_CLIENT_METHOD_BY_PROTOCOL[method];
    clientRecord[clientMethod] = async () => {
      order.push(clientMethod);
      return {};
    };
  }
  clientRecord.initialize = async () => {
    order.push("initialize");
    return result;
  };
  clientRecord.registerHostHandlers = (handlers: DshHostRequestHandlers) => {
    order.push("register-host-handlers");
    registeredHostHandlers = handlers;
    return () => order.push("dispose-host-handlers");
  };
  clientRecord.registerRuntimeNotificationHandlers = (
    handlers: DshRuntimeNotificationHandlers,
  ) => {
    order.push("register-notifications");
    registeredNotifications = handlers;
    return () => order.push("dispose-notifications");
  };
  clientRecord.initialized = async () => {
    order.push("initialized");
  };
  clientRecord.runtimeStatus = async () => {
    order.push("runtimeStatus");
    return {
      runtimeGeneration: result.runtimeGeneration,
      initialized: true,
      primarySessionState: "unbound",
    };
  };
  clientRecord.runtimeShutdown = async () => {
    order.push("runtimeShutdown");
    queueMicrotask(() => child.exit(0, null));
    return { ok: true };
  };
  const client = clientRecord as DshGeneratedHostClient;
  const protocolRuntime: LoadedDshProtocolRuntime = {
    protocolEntryPath: "/verified/protocol.js",
    generatedClientEntryPath: "/verified/host-client.js",
    ProtocolError: TestProtocolError,
    createHostClient: () => client,
  };
  const diagnostics: string[] = [];
  const failures: Error[] = [];
  const host = new DshRuntimeProcessHost({
    installation,
    initialize: initialize(),
    hostHandlers: hostHandlers(),
    notificationHandlers,
    inheritedEnvironment: {
      LANG: "en_US.UTF-8",
      ANTHROPIC_API_KEY: "credential-canary",
      NODE_OPTIONS: "--require=/tmp/inject.js",
    },
    assertNodeVersion: async () => {
      order.push("assert-node");
    },
    assertRuntimeSelfCheck: async () => {
      order.push("assert-runtime");
    },
    assertHandoffVerification: async () => {
      order.push("assert-handoff");
    },
    loadProtocolRuntime: async () => {
      order.push("load-protocol");
      return protocolRuntime;
    },
    spawnRuntime: () => {
      order.push("spawn-runtime");
      return child as never;
    },
    onStderrLine: (line) => diagnostics.push(line),
    redactStderrLine: redactDshDiagnosticLine,
    onFailure: (error) => failures.push(error),
    handshakeTimeoutMs: 1_000,
    shutdownGraceMs: 1_000,
  });
  return {
    host,
    child,
    order,
    diagnostics,
    failures,
    get registeredHostHandlers() {
      return registeredHostHandlers;
    },
    get registeredNotifications() {
      return registeredNotifications;
    },
  };
}

describe("DSH RuntimeProcessHost", () => {
  it("performs the exact handshake before becoming protocol-ready", async () => {
    const test = harness();
    const identity = await test.host.start();
    expect(identity).toMatchObject({
      productSessionId: "product-session-1",
      runtimeGeneration: "artifact-process-generation",
      protocolVersion: "2.1.0",
      sessionFormat: "dsh-session-events-v1",
    });
    expect(test.host.state).toBe("protocol-ready");
    expect(test.order).toEqual([
      "assert-node",
      "assert-handoff",
      "assert-runtime",
      "load-protocol",
      "spawn-runtime",
      "initialize",
      "update-limits",
      "register-host-handlers",
      "register-notifications",
      "initialized",
      "runtimeStatus",
    ]);
    expect(Object.keys(test.registeredHostHandlers ?? {})).toEqual([
      ...DSH_REVERSE_METHOD_NAMES,
    ]);
    expect(Object.keys(test.registeredNotifications ?? {})).toEqual([
      "runtime/event",
      "host/interaction/cancel",
    ]);
    expect(JSON.stringify(test.host.childEnvironment)).not.toContain(
      "credential-canary",
    );

    await expect(test.host.request("session/read", {})).resolves.toEqual({});
    expect(test.order).toContain("sessionRead");

    test.child.stderr.write("authorization=secret-value\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect(test.diagnostics).toEqual(["authorization=[REDACTED]"]);

    await test.host.stop();
    expect(test.host.state).toBe("stopped");
    expect(test.order).toContain("runtimeShutdown");
  });

  it("fails closed on initialize identity drift", async () => {
    const test = harness(
      initializeResult({
        profileDigest: "0".repeat(64),
      }),
    );
    await expect(test.host.start()).rejects.toThrow(/identity/);
    expect(test.host.state).toBe("failed");
    expect(test.child.killedSignals).toContain("SIGTERM");
  });

  it("cancels startup without spawning after Host shutdown", async () => {
    const test = harness();
    const starting = test.host.start();
    const stopping = test.host.stop();
    await expect(starting).rejects.toThrow(/cancelled/);
    await stopping;
    expect(test.host.state).toBe("stopped");
    expect(test.order).toEqual(["assert-node"]);
  });
});
