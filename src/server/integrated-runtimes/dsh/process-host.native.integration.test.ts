import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PRESET_PROVIDERS, type Provider } from "../../../shared/config-types";
import { compileDshProductExtensionPlane } from "./extension-compiler";
import { createDshInitializeParams } from "./initialize";
import { resolveDshRuntimeInstallation } from "./installation";
import { compileDshModelExecutionProfile } from "./profile-compiler";
import { DSH_CANONICAL_WEB_ADAPTER_ID } from "./canonical-web-provider";
import { DshRuntimeProcessHost, redactDshDiagnosticLine } from "./process-host";
import {
  DSH_REVERSE_METHOD_NAMES,
  type DshExecutionEnvironment,
  type DshHostRequestHandlers,
  type DshRuntimeNotificationHandlers,
} from "./protocol-types";

const nativeSmokeEnabled = process.env.MYAGENTS_DSH_NATIVE_SMOKE === "1";
const nativeSmokeResourceRoot =
  process.env.MYAGENTS_DSH_NATIVE_SMOKE_RESOURCE_ROOT;
const nativeSoakEnabled = process.env.MYAGENTS_DSH_NATIVE_SOAK === "1";

function requestedNativeSoakIterations(): number {
  const raw = process.env.MYAGENTS_DSH_NATIVE_SOAK_ITERATIONS ?? "12";
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      "MYAGENTS_DSH_NATIVE_SOAK_ITERATIONS must be an integer from 1 to 50",
    );
  }
  const iterations = Number(raw);
  if (iterations < 1 || iterations > 50) {
    throw new Error(
      "MYAGENTS_DSH_NATIVE_SOAK_ITERATIONS must be an integer from 1 to 50",
    );
  }
  return iterations;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function currentOpenFileDescriptorCount(): Promise<number | undefined> {
  if (process.platform === "win32") return undefined;
  return (await readdir("/dev/fd")).length;
}

async function createNativeHostFixture(label: string) {
  const temporaryRoot = await realpath(
    await mkdtemp(join(tmpdir(), `myagents-dsh-process-host-${label}-`)),
  );
  const workspace = join(temporaryRoot, "workspace");
  const runtimeHome = join(temporaryRoot, "runtime-home");
  const attachments = join(temporaryRoot, "attachments");
  await Promise.all([mkdir(workspace), mkdir(runtimeHome), mkdir(attachments)]);
  const resourceRoot = resolve(
    nativeSmokeResourceRoot ?? "src-tauri/resources",
  );
  const installation = await resolveDshRuntimeInstallation({
    resourceRoot,
    nodeExecutablePath: join(resourceRoot, "nodejs/bin/node"),
  });
  const executionEnvironment: Omit<DshExecutionEnvironment, "digest"> = {
    revision: "native-smoke-execution-v1",
    workspace: {
      identity: `native-${label}-workspace`,
      canonicalRoot: workspace,
      allowedReadRoots: [workspace],
      allowedWriteRoots: [workspace],
    },
    executables: {
      bundledNodeRef: "bundled-node",
      bashRef: "bundled-bash",
      ripgrepRef: "bundled-ripgrep",
      bashDialect: "bash",
      allowedCommandRefs: ["bundled-bash", "bundled-node", "bundled-ripgrep"],
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
  const createHost = () =>
    new DshRuntimeProcessHost({
      installation,
      initialize: createDshInitializeParams({
        productSessionId: `native-${label}-product-session`,
        productVersion: "0.4.11",
        runtimeHome,
        workspace: {
          path: workspace,
          identity: `native-${label}-workspace`,
        },
        executionEnvironment,
        interaction: "deterministic-headless",
        webSearchAdapters: [DSH_CANONICAL_WEB_ADAPTER_ID],
      }),
      hostHandlers,
      notificationHandlers,
      commandDirectories: ["/bin"],
      handshakeTimeoutMs: 60_000,
      shutdownGraceMs: 10_000,
      onStderrLine: (line) => stderr.push(line),
      redactStderrLine: redactDshDiagnosticLine,
    });
  const host = createHost();
  return {
    createHost,
    executionEnvironment,
    host,
    runtimeHome,
    stderr,
    temporaryRoot,
    workspace,
  };
}

describe.runIf(nativeSmokeEnabled)(
  "DSH RuntimeProcessHost native smoke",
  () => {
    it("handshakes with and shuts down the exact staged Runtime", async () => {
      const fixture = await createNativeHostFixture("smoke");
      const {
        executionEnvironment,
        host,
        runtimeHome,
        stderr,
        temporaryRoot,
        workspace,
      } = fixture;
      try {
        const identity = await host.start().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : "unknown";
          throw new Error(
            `Native DSH start failed: ${message}; stderr=${stderr.join(" | ")}`,
          );
        });
        expect(identity).toMatchObject({
          runtimeGeneration: "artifact-process-generation",
          protocolVersion: "2.3.0",
          sessionFormat: "dsh-session-events-v1",
        });
        expect(host.state).toBe("protocol-ready");
        const skillPath = join(workspace, "SKILL.md");
        const skillContent =
          "---\nname: native-review\ndescription: Review native smoke evidence\n---\n\n# Review\n";
        await writeFile(skillPath, skillContent, "utf8");
        const hostTool = {
          name: "native_fixture",
          description: "Returns native smoke fixture data",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        };
        const extensionPlane = compileDshProductExtensionPlane({
          revision: "native-smoke-product-extensions-v1",
          skills: [
            {
              name: "native-review",
              description: "Review native smoke evidence",
              contentSha256: createHash("sha256")
                .update(skillContent)
                .digest("hex"),
              path: skillPath,
              scope: "project",
              sourceId: "native-smoke",
            },
          ],
          commands: [
            {
              name: "native-verify",
              description: "Verify native smoke evidence",
              body: "Verify the exact native smoke evidence.",
              scope: "project",
              sourceId: "native-smoke",
            },
          ],
          agents: [
            {
              name: "native-reviewer",
              description: "Reviews native smoke evidence",
              prompt: "Review the exact native smoke evidence.",
              skills: [{ name: "native-review", path: skillPath }],
              scope: "project",
              sourceId: "native-smoke",
            },
          ],
          mcpServers: [],
          dynamicTools: [hostTool],
          hostToolDispatcher: {
            descriptors: [hostTool],
            dispatch: async () => ({
              success: true,
              contentItems: [{ type: "text", text: "native fixture" }],
            }),
            dispose: () => undefined,
          },
        });
        const extension = extensionPlane.snapshot;
        const extensionResult = await host.request(
          "extension/replace",
          extension as unknown as Record<string, unknown>,
        );
        if (extensionResult.state !== "applied") {
          throw new Error(
            `Native extension replacement failed: ${JSON.stringify(extensionResult)}; stderr=${stderr.join(" | ")}`,
          );
        }
        expect(extensionResult).toMatchObject({
          state: "applied",
          effectiveRevision: extension.revision,
        });
        const extensionCatalog = await host.request("extension/catalog", {});
        expect(extensionCatalog.skills).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "native-review" }),
          ]),
        );
        expect(extensionCatalog.agents).toContain("native-reviewer");
        expect(extensionCatalog.tools).toContain(
          "mcp__myagents_host__native_fixture",
        );
        const provider = PRESET_PROVIDERS.find(
          ({ id }) => id === "anthropic-api",
        );
        if (!provider)
          throw new Error("Anthropic API Provider fixture is unavailable");
        const profile = compileDshModelExecutionProfile({
          provider: structuredClone(provider) as Provider,
          modelId: "claude-sonnet-4-6",
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
        expect(binding.toolCatalog).toMatchObject({
          effectiveTools: expect.arrayContaining(["WebFetch", "WebSearch"]),
        });
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
        expect(plan).toMatchObject({
          state: "already_effective",
          mode: "normal",
        });
        const rules = await host.request("permission/rules/list", {});
        expect(rules).toMatchObject({
          permissionMode: "acceptEdits",
          rules: [],
        });
        const granted = await host.request("permission/rules/add", {
          expectedRevision: rules.revision,
          tool: "Bash",
          permissionClass: "process.execute",
          target: "echo native-smoke",
        });
        expect(granted).toMatchObject({ state: "applied" });
        expect(granted.rule).toMatchObject({
          tool: "Bash",
          permissionClass: "process.execute",
          target: "echo native-smoke",
          origin: "root",
        });
        const grantedRule = granted.rule as { ruleId: string };
        const grantedRules = await host.request("permission/rules/list", {});
        expect(grantedRules).toMatchObject({
          revision: granted.revision,
          rules: [{ ruleId: grantedRule.ruleId, target: "echo native-smoke" }],
        });
        const revoked = await host.request("permission/rules/revoke", {
          expectedRevision: grantedRules.revision,
          ruleId: grantedRule.ruleId,
        });
        expect(revoked).toMatchObject({ state: "applied" });
        const revokedRules = await host.request("permission/rules/list", {});
        expect(revokedRules).toMatchObject({
          revision: revoked.revision,
          rules: [],
        });
        const liveReplacement = compileDshProductExtensionPlane({
          revision: "native-smoke-product-extensions-v2",
          skills: [],
          commands: [],
          agents: [],
          mcpServers: [],
          dynamicTools: [],
          components: [],
        });
        const replacementResult = await host.request(
          "extension/replace",
          liveReplacement.snapshot as unknown as Record<string, unknown>,
        );
        expect(replacementResult).toMatchObject({
          state: "applied",
          desiredRevision: liveReplacement.snapshot.revision,
          effectiveRevision: liveReplacement.snapshot.revision,
        });
        const replacementCatalog = await host.request("extension/catalog", {});
        expect(replacementCatalog).toMatchObject({
          revision: liveReplacement.snapshot.revision,
        });
        expect(replacementCatalog.digest).not.toBe(extensionCatalog.digest);
        expect(replacementCatalog.skills).not.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "native-review" }),
          ]),
        );
        expect(replacementCatalog.tools).not.toContain(
          "mcp__myagents_host__native_fixture",
        );
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

    it("resumes a configured Session after a Runtime process restart", async () => {
      const fixture = await createNativeHostFixture("resume");
      const provider = PRESET_PROVIDERS.find(
        ({ id }) => id === "anthropic-api",
      );
      if (!provider)
        throw new Error("Anthropic API Provider fixture is unavailable");
      const profile = compileDshModelExecutionProfile({
        provider: structuredClone(provider) as Provider,
        modelId: "claude-sonnet-4-6",
      });
      const extension = compileDshProductExtensionPlane({
        revision: "native-resume-extensions-v1",
        skills: [],
        commands: [],
        agents: [],
        mcpServers: [],
        dynamicTools: [],
        components: [],
      }).snapshot;
      let resumedHost: DshRuntimeProcessHost | undefined;
      try {
        await fixture.host.start();
        const extensionResult = await fixture.host.request(
          "extension/replace",
          extension as unknown as Record<string, unknown>,
        );
        expect(extensionResult).toMatchObject({
          state: "applied",
          effectiveRevision: extension.revision,
        });
        const catalog = await fixture.host.request("extension/catalog", {});
        const created = await fixture.host.request("session/create", {
          clientOperationId: "native-resume-create",
          persistenceRef: "native-resume-persistence",
          provider: profile as unknown as Record<string, unknown>,
          configRevision: "native-resume-config-v1",
          extensionDigest: String(catalog.digest),
          systemPrompt: "",
          permissionMode: "default",
          interactionScenario: "host-interaction-v1",
        });
        expect(created).toMatchObject({ state: "ready" });
        const runtimeSessionId = String(created.runtimeSessionId);
        await fixture.host.request("config/apply", {
          revision: "native-resume-config-v2",
          provider: profile as unknown as Record<string, unknown>,
          permissionMode: "acceptEdits",
          interactionScenario: "host-interaction-v1",
          systemPrompt: "",
          executionEnvironmentRevision: fixture.executionEnvironment.revision,
          executionEnvironmentDigest: createDshInitializeParams({
            productSessionId: "native-resume-product-session",
            productVersion: "0.4.11",
            runtimeHome: fixture.runtimeHome,
            workspace: {
              path: fixture.workspace,
              identity: "native-resume-workspace",
            },
            executionEnvironment: fixture.executionEnvironment,
            interaction: "deterministic-headless",
          }).executionEnvironment.digest,
        });
        await fixture.host.stop();

        resumedHost = fixture.createHost();
        await resumedHost.start();
        await resumedHost.request(
          "extension/replace",
          extension as unknown as Record<string, unknown>,
        );
        const resumed = await resumedHost.request("session/resume", {
          clientOperationId: "native-resume-bind",
          runtimeSessionId,
          persistenceRef: "native-resume-persistence",
          provider: profile as unknown as Record<string, unknown>,
          configRevision: "native-resume-config-v2",
          extensionDigest: String(catalog.digest),
          systemPrompt: "",
          permissionMode: "acceptEdits",
          interactionScenario: "host-interaction-v1",
        });
        expect(resumed).toMatchObject({ state: "ready", runtimeSessionId });
        expect(
          await resumedHost.request("permission/rules/list", {}),
        ).toMatchObject({
          permissionMode: "acceptEdits",
        });
      } finally {
        await fixture.host.stop();
        await resumedHost?.stop();
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    }, 120_000);
  },
);

describe.runIf(nativeSoakEnabled)(
  "DSH RuntimeProcessHost native lifecycle soak",
  () => {
    it("releases every exact packaged Runtime generation within bounded Host resources", async () => {
      const iterations = requestedNativeSoakIterations();
      const rssBefore = process.memoryUsage().rss;
      const descriptorsBefore = await currentOpenFileDescriptorCount();
      const runtimePids: number[] = [];

      for (let index = 0; index < iterations; index += 1) {
        const fixture = await createNativeHostFixture(`soak-${index + 1}`);
        let runtimePid: number | undefined;
        try {
          const identity = await fixture.host.start();
          expect(identity).toMatchObject({
            protocolVersion: "2.3.0",
            sessionFormat: "dsh-session-events-v1",
          });
          runtimePid = fixture.host.pid;
          expect(runtimePid).toBeTypeOf("number");
          const status = await fixture.host.request("runtime/status", {});
          expect(status).toMatchObject({
            runtimeGeneration: identity.runtimeGeneration,
          });
        } finally {
          await fixture.host.stop();
          await rm(fixture.temporaryRoot, { recursive: true, force: true });
        }
        expect(fixture.host.state).toBe("stopped");
        if (runtimePid !== undefined) {
          runtimePids.push(runtimePid);
          expect(processIsAlive(runtimePid)).toBe(false);
        }
      }

      const descriptorsAfter = await currentOpenFileDescriptorCount();
      const rssGrowthBytes = Math.max(0, process.memoryUsage().rss - rssBefore);
      if (descriptorsBefore !== undefined && descriptorsAfter !== undefined) {
        expect(descriptorsAfter).toBeLessThanOrEqual(descriptorsBefore + 8);
      }
      expect(rssGrowthBytes).toBeLessThanOrEqual(192 * 1024 * 1024);
      expect(new Set(runtimePids).size).toBe(iterations);

      process.stdout.write(
        `${JSON.stringify({
          kind: "myagents-dsh-native-lifecycle-soak-v1",
          iterations,
          runtimePids,
          rssGrowthBytes,
          descriptorsBefore,
          descriptorsAfter,
        })}\n`,
      );
    }, 600_000);
  },
);
