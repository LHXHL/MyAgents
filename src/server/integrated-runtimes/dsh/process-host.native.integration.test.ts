import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PRESET_PROVIDERS, type Provider } from "../../../shared/config-types";
import { compileDshExtensionSnapshot } from "./extension-compiler";
import { createDshInitializeParams } from "./initialize";
import { resolveDshRuntimeInstallation } from "./installation";
import { compileDshModelExecutionProfile } from "./profile-compiler";
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
          bundledNodeRef: "bundled-node",
          bashRef: "bundled-bash",
          ripgrepRef: "bundled-ripgrep",
          bashDialect: "bash",
          allowedCommandRefs: [
            "bundled-bash",
            "bundled-node",
            "bundled-ripgrep",
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
          async (params: Record<string, unknown>) => {
            if (method === "host/credential/resolve") {
              return {
                kind: "availability",
                available: true,
                authoritativeCredentialRevision: String(params.profileRevision),
              };
            }
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
        const extension = compileDshExtensionSnapshot();
        const extensionResult = await host.request(
          "extension/replace",
          extension as unknown as Record<string, unknown>,
        );
        expect(extensionResult).toMatchObject({
          state: "applied",
          effectiveRevision: extension.revision,
        });
        const extensionCatalog = await host.request("extension/catalog", {});
        const provider = PRESET_PROVIDERS.find(({ id }) => id === "deepseek");
        if (!provider) throw new Error("DeepSeek Provider fixture is unavailable");
        const profile = compileDshModelExecutionProfile({
          provider: structuredClone(provider) as Provider,
          modelId: "deepseek-v4-flash",
        });
        const binding = await host.request("session/create", {
          clientOperationId: "native-smoke-session-create",
          persistenceRef: "native-smoke-persistence",
          provider: profile as unknown as Record<string, unknown>,
          configRevision: "native-smoke-config-v1",
          extensionDigest: String(extensionCatalog.digest),
          systemPrompt: "",
          permissionMode: "default",
          interactionScenario: "host-interaction-v1",
        });
        expect(binding).toMatchObject({ state: "ready" });
        const applied = await host.request("config/apply", {
          revision: "native-smoke-config-v2",
          provider: profile as unknown as Record<string, unknown>,
          permissionMode: "acceptEdits",
          interactionScenario: "host-interaction-v1",
          systemPrompt: "",
          executionEnvironmentRevision: executionEnvironment.revision,
          executionEnvironmentDigest: createDshInitializeParams({
            productSessionId: "native-smoke-product-session",
            productVersion: "0.4.11",
            runtimeHome,
            workspace: { path: workspace, identity: "native-smoke-workspace" },
            executionEnvironment,
            interaction: "deterministic-headless",
          }).executionEnvironment.digest,
        });
        expect(applied).toMatchObject({
          state: "applied",
          effectiveRevision: "native-smoke-config-v2",
        });
        const plan = await host.request("plan/apply", {
          clientOperationId: "native-smoke-plan-normal",
          expectedRevision: "native-smoke-plan-probe",
          mode: "normal",
        });
        expect(plan).toMatchObject({ state: "already_effective", mode: "normal" });
        const rules = await host.request("permission/rules/list", {});
        expect(rules).toMatchObject({ permissionMode: "acceptEdits", rules: [] });
        await host.request("session/close", {
          clientOperationId: "native-smoke-session-close",
        });
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
