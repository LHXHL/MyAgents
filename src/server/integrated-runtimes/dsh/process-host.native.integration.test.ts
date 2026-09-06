import { GENERATED_PROTOCOL_VERSION } from '../../../../contracts/myagents-dsh/public-contract.generated';
import { createServer } from "node:http";
import { DshAttachmentRegistry } from "./attachments";
import type { PermissionReview } from "../../../shared/types/runtime";
import { buildDshChildEnvironment } from "./child-environment";
import type { MethodParams } from "./protocol-types";
import { createHash, randomUUID } from "node:crypto";
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

async function createNativeHostFixture(label: string, route?: { productSessionId: string; sidecarPort: number }) {
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
  const childEnvironment = buildDshChildEnvironment({
    nodeExecutablePath: installation.nodeExecutablePath, commandDirectories: ["/bin"],
    ...(route === undefined ? {} : { sessionRoute: route }),
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
      shellRef: "runtime-shell",
      ripgrepRef: "bundled-ripgrep",
      shellDialect: "bash",
      allowedCommandRefs: ["runtime-shell", "bundled-node", "bundled-ripgrep"],
      pathPolicy: "sealed",
    },
    environment: {
      allowedKeys: childEnvironment.allowedKeys,
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
  const createHost = (requests = hostHandlers, notifications = notificationHandlers) =>
    new DshRuntimeProcessHost({
      installation,
      initialize: createDshInitializeParams({
        productSessionId: route?.productSessionId ?? `native-${label}-product-session`,
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
      hostHandlers: requests,
      notificationHandlers: notifications,
      childEnvironment,
      commandDirectories: ["/bin"],
      handshakeTimeoutMs: 60_000,
      shutdownGraceMs: 10_000,
      onStderrLine: (line) => stderr.push(line),
      redactStderrLine: redactDshDiagnosticLine,
    });
  const host = createHost();
  return {
    createHost,
    hostHandlers,
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
    it.runIf(process.platform !== 'win32').each([false, true])('executes the official Shell after approval with production CLI route environment (large review: %s)', async largeReview => {
      const productSessionId = randomUUID();
      const command = 'printf "%s|%s" "$MYAGENTS_PORT" "$MYAGENTS_SESSION_ID"' + (largeReview ? ` # ${"example".repeat(10_000)}` : "");
      let requests = 0;
      const server = createServer(async (request, response) => {
        for await (const _chunk of request) { /* Drain the synthetic model request. */ }
        const tool = requests++ === 0;
        const emit = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        emit('message_start', { type: 'message_start', message: { id: `fixture-message-${requests}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
        emit('content_block_start', { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'fixture-shell-call', name: 'bash', input: {} } : { type: 'text', text: '' } });
        emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ command, workdir: 'child', description: 'Read the current CLI route' }) } : { type: 'text_delta', text: 'Fixture complete.' } });
        emit('content_block_stop', { type: 'content_block_stop', index: 0 });
        emit('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
        emit('message_stop', { type: 'message_stop' });
        response.end();
      });
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fixture server did not bind');
      const fixture = await createNativeHostFixture('shell-review', { productSessionId, sidecarPort: address.port }).catch(async error => {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        throw error;
      });
      const attachments = new DshAttachmentRegistry(fixture.executionEnvironment.attachmentStagingRoot);
      await attachments.initialize();
      const reviews: PermissionReview[] = [];
      const approvals: MethodParams<'host/interaction/request'>[] = [];
      const events: Record<string, unknown>[] = [];
      const host = fixture.createHost({
        ...fixture.hostHandlers,
        'host/credential/resolve': params => params.purpose === 'availability'
          ? { kind: 'availability', available: true, authoritativeCredentialRevision: params.profileRevision }
          : { kind: 'material', authoritativeCredentialRevision: params.profileRevision, material: { apiKey: 'synthetic-native-model-key' } },
        'host/hook/execute': () => ({ state: 'continue' }),
        'host/attachment/put': params => attachments.put(params),
        'host/attachment/acquire': params => attachments.acquire(params),
        'host/attachment/release': params => attachments.release(params),
        'host/interaction/request': async params => {
          const approval = params as MethodParams<'host/interaction/request'>;
          reviews.push(approval.reviewRef ? await attachments.readJson(approval.reviewRef) as PermissionReview : approval.review!);
          approvals.push(approval);
          return { registered: true };
        },
      }, { 'runtime/event': params => { events.push(params); }, 'host/interaction/cancel': () => undefined });
      try {
        await mkdir(join(fixture.workspace, 'child'));
        await host.start();
        const extension = compileDshProductExtensionPlane({ revision: 'native-shell-review-extensions', skills: [], commands: [], agents: [], mcpServers: [], dynamicTools: [] }).snapshot;
        await host.request('extension/replace', extension);
        const catalog = await host.request('extension/catalog', {});
        const provider = structuredClone(PRESET_PROVIDERS.find(({ id }) => id === 'anthropic-api'));
        if (!provider) throw new Error('Fixture Provider is missing');
        provider.config.baseUrl = `http://127.0.0.1:${address.port}`;
        const profile = compileDshModelExecutionProfile({ provider, modelId: 'claude-sonnet-4-6' });
        const binding = await host.request('session/create', { clientOperationId: 'native-shell-review-bind', persistenceRef: 'native-shell-review', provider: profile, configRevision: 'native-shell-review-config', extensionDigest: catalog.digest, systemPrompt: '', permissionMode: 'default', interactionScenario: 'host-interaction-v1' });
        expect(binding.state).toBe('ready');
        await host.request('turn/start', { clientOperationId: 'native-shell-review-turn', clientUserMessageId: 'native-shell-review-message', input: { parts: [{ kind: 'text', text: 'Read the current CLI route from the child directory.' }] }, configRevision: 'native-shell-review-config', extensionDigest: catalog.digest, executionEnvironmentRevision: fixture.executionEnvironment.revision, executionEnvironmentDigest: createDshInitializeParams({ productSessionId, productVersion: '0.4.11', runtimeHome: fixture.runtimeHome, workspace: { path: fixture.workspace, identity: fixture.executionEnvironment.workspace.identity }, executionEnvironment: fixture.executionEnvironment, interaction: 'deterministic-headless' }).executionEnvironment.digest, limits: { maxTurns: 4 }, origin: { kind: 'headless', scenario: 'native-shell-review' } });
        await expect.poll(() => approvals.length, { timeout: 20_000 }).toBe(1);
        const approval = approvals[0]!;
        expect(approval.authority).toMatchObject({ callId: 'fixture-shell-call', rootCallId: 'fixture-shell-call' });
        expect(approval.reviewRef !== undefined).toBe(largeReview);
        expect(reviews[0]?.operation).toEqual({ kind: 'command', dialect: 'bash', command, cwd: join(fixture.workspace, 'child'), description: 'Read the current CLI route' });
        expect(reviews[0]?.actor.origin).toBe('root');
        expect(events.some(value => (value.event as Record<string, unknown>)?.kind === 'tool' && (value.event as Record<string, unknown>).phase === 'end')).toBe(false);
        const receipt = await host.request('interaction/respond', { interactionId: approval.interactionId, expectedRevision: approval.desiredPolicyRevision, decision: 'allow_once' });
        expect(receipt.state).toBe('applied');
        await expect.poll(async () => (await host.request('turn/get', { clientOperationId: 'native-shell-review-turn' })).terminal !== undefined, { timeout: 20_000 }).toBe(true);
        const toolResult = events.find(value => (value.event as Record<string, unknown>)?.kind === 'tool' && (value.event as Record<string, unknown>).phase === 'end');
        expect(toolResult).toBeDefined();
        expect(JSON.stringify(toolResult)).toContain(`${address.port}|${productSessionId}`);
        expect(JSON.stringify(toolResult)).not.toContain('not sealed');
        expect(requests).toBe(2);
      } finally {
        await host.stop();
        attachments.close();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(fixture.temporaryRoot, { recursive: true, force: true });
      }
    }, 60_000);

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
          protocolVersion: GENERATED_PROTOCOL_VERSION,
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
          extension,
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
          provider: profile,
          configRevision: "native-smoke-config-v1",
          extensionDigest: String(extensionCatalog.digest),
          systemPrompt: "",
          permissionMode: "default",
          interactionScenario: "host-interaction-v1",
        });
        expect(binding).toMatchObject({ state: "ready" });
        if (binding.state !== "ready") throw new Error("Native Session was not admitted");
        expect(binding.toolCatalog).toMatchObject({
          effectiveTools: expect.arrayContaining(["WebFetch", "WebSearch"]),
        });
        const applied = await host.request("config/apply", {
          revision: "native-smoke-config-v2",
          provider: profile,
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
          tool: "bash",
          permissionClass: "process.execute",
          target: "echo native-smoke",
        });
        expect(granted).toMatchObject({ state: "applied" });
        if (granted.state !== "applied") throw new Error("Native permission rule was not applied");
        expect(granted.rule).toMatchObject({
          tool: "bash",
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
          liveReplacement.snapshot,
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
          extension,
        );
        expect(extensionResult).toMatchObject({
          state: "applied",
          effectiveRevision: extension.revision,
        });
        const catalog = await fixture.host.request("extension/catalog", {});
        const created = await fixture.host.request("session/create", {
          clientOperationId: "native-resume-create",
          persistenceRef: "native-resume-persistence",
          provider: profile,
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
          provider: profile,
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
          extension,
        );
        const resumed = await resumedHost.request("session/resume", {
          clientOperationId: "native-resume-bind",
          runtimeSessionId,
          persistenceRef: "native-resume-persistence",
          provider: profile,
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
            protocolVersion: GENERATED_PROTOCOL_VERSION,
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
