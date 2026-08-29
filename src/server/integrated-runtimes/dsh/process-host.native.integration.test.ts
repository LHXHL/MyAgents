import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createDshInitializeParams } from "./initialize";
import { resolveDshRuntimeInstallation } from "./installation";
import { DshRuntimeProcessHost, redactDshDiagnosticLine } from "./process-host";
import {
  DSH_REVERSE_METHOD_NAMES,
  type DshExecutionEnvironment,
  type DshHostRequestHandlers,
  type DshRuntimeNotificationHandlers,
} from "./protocol-types";

const nativeSmokeEnabled = process.env.MYAGENTS_DSH_NATIVE_SMOKE === "1";

describe.runIf(nativeSmokeEnabled)(
  "DSH RuntimeProcessHost native smoke",
  () => {
    it("handshakes with and shuts down the exact staged Runtime", async () => {
      const temporaryRoot = await realpath(
        await mkdtemp(join(tmpdir(), "myagents-dsh-process-host-")),
      );
      const workspace = join(temporaryRoot, "workspace");
      const runtimeHome = join(temporaryRoot, "runtime-home");
      const attachments = join(temporaryRoot, "attachments");
      await Promise.all([
        mkdir(workspace),
        mkdir(runtimeHome),
        mkdir(attachments),
      ]);
      const resourceRoot = resolve("src-tauri/resources");
      const installation = await resolveDshRuntimeInstallation({
        resourceRoot,
        nodeExecutablePath: join(resourceRoot, "nodejs/bin/node"),
      });
      const executionEnvironment: Omit<DshExecutionEnvironment, "digest"> = {
        revision: "native-smoke-execution-v1",
        workspace: {
          identity: "native-smoke-workspace",
          canonicalRoot: workspace,
          allowedReadRoots: [workspace],
          allowedWriteRoots: [workspace],
        },
        executables: {
          bundledNodeRef: "myagents-bundled-node-v24",
          bashRef: "myagents-bash",
          ripgrepRef: "myagents-ripgrep",
          bashDialect: "bash",
          allowedCommandRefs: [
            "myagents-bundled-node-v24",
            "myagents-bash",
            "myagents-ripgrep",
          ],
          pathPolicy: "sealed",
        },
        environment: {
          allowedKeys: [],
          inheritedKeys: [],
          secretValues: "reverse-port-only",
        },
        network: { mode: "deny" },
        process: {
          backgroundRetention: "deny",
          maxChildren: 8,
          killTreeOnAbort: true,
        },
        checkpoint: {
          mode: "managed-file-tools",
          version: 1,
          policyRevision: "native-smoke-checkpoint-v1",
          trackedTools: ["Write", "Edit"],
          tracksShell: false,
          tracksChildAgents: false,
          tracksExternalChanges: false,
        },
        attachmentStagingRoot: attachments,
      };
      const hostHandlers = Object.fromEntries(
        DSH_REVERSE_METHOD_NAMES.map((method) => [
          method,
          async () => {
            throw new Error("Native smoke does not admit reverse work");
          },
        ]),
      ) as unknown as DshHostRequestHandlers;
      const notificationHandlers: DshRuntimeNotificationHandlers = {
        "runtime/event": async () => undefined,
        "host/interaction/cancel": async () => undefined,
      };
      const stderr: string[] = [];
      const host = new DshRuntimeProcessHost({
        installation,
        initialize: createDshInitializeParams({
          productSessionId: "native-smoke-product-session",
          productVersion: "0.4.11",
          runtimeHome,
          workspace: {
            path: workspace,
            identity: "native-smoke-workspace",
          },
          executionEnvironment,
          interaction: "deterministic-headless",
        }),
        hostHandlers,
        notificationHandlers,
        commandDirectories: ["/bin"],
        handshakeTimeoutMs: 60_000,
        shutdownGraceMs: 10_000,
        onStderrLine: (line) => stderr.push(line),
        redactStderrLine: redactDshDiagnosticLine,
      });
      try {
        const identity = await host.start().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "unknown";
          throw new Error(
            `Native DSH start failed: ${message}; stderr=${stderr.join(" | ")}`,
          );
        });
        expect(identity).toMatchObject({
          runtimeGeneration: "artifact-process-generation",
          protocolVersion: "2.0.0",
          sessionFormat: "dsh-session-events-v1",
        });
        expect(host.state).toBe("protocol-ready");
        expect(JSON.stringify(stderr)).not.toMatch(
          /(api.?key|authorization|credential-canary)/i,
        );
      } finally {
        await host.stop();
        await rm(temporaryRoot, { recursive: true, force: true });
      }
      expect(host.state).toBe("stopped");
    }, 120_000);
  },
);
