import { PROXY_ENV_KEYS } from '../../../shared/proxyScope';
import { isDeepStrictEqual } from 'node:util';
import { RUNTIME_CAPABILITIES } from '../../../../contracts/myagents-dsh/public-contract.generated';
import {
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

import dshLock from "../../../shared/integrated-runtimes/effective-dsh-lock";
import type { DshChildEnvironment } from "./child-environment";
import {
  loadDshProtocolRuntime,
  type LoadedDshProtocolRuntime,
} from "./generated-client";
import {
  createFencedDshHostHandlers,
  createFencedDshNotificationHandlers,
} from "./host-ports";
import {
  assertDshHandoffVerification,
  type DshRuntimeInstallation,
} from "./installation";
import {
  DSH_CLIENT_METHOD_BY_PROTOCOL,
  type DshGeneratedHostClient,
  type DshHostMethodName,
  type DshHostRequestHandlers,
  type DshInitializeParams,
  type DshInitializeResult,
  type DshRuntimeNotificationHandlers,
  type DshRuntimeStatus,
  type MethodParams, type MethodResult,
} from "./protocol-types";

export type DshRuntimeProcessHostState =
  | "idle"
  | "starting"
  | "protocol-ready"
  | "stopping"
  | "stopped"
  | "failed";

type DshSpawnRuntime = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { stdio: "pipe" },
) => ChildProcessWithoutNullStreams;

type RuntimeExit = Readonly<{
  code: number | null;
  signal: NodeJS.Signals | null;
}>;

export type DshRuntimeProcessIdentity = Readonly<{
  productSessionId: string;
  runtimeGeneration: string;
  protocolVersion: string;
  schemaSha256: string;
  profileDigest: string;
  sessionFormat: string;
  runtimeVersion: string;
  dshVersion: string;
}>;

export type DshRuntimeProcessHostOptions = Readonly<{
  installation: DshRuntimeInstallation;
  initialize: DshInitializeParams;
  hostHandlers: DshHostRequestHandlers;
  notificationHandlers: DshRuntimeNotificationHandlers;
  childEnvironment: DshChildEnvironment;
  handshakeTimeoutMs?: number;
  shutdownGraceMs?: number;
  onStderrLine?: (redactedLine: string) => void;
  redactStderrLine?: (line: string) => string;
  onFailure?: (error: Error) => void;
  loadProtocolRuntime?: (
    runtimeArtifactRoot: string,
  ) => Promise<LoadedDshProtocolRuntime>;
  assertHandoffVerification?: (
    installation: DshRuntimeInstallation,
    childEnvironment: DshChildEnvironment,
  ) => Promise<void>;
  spawnRuntime?: DshSpawnRuntime;
}>;

function assertInitializeResult(result: DshInitializeResult): void {
  if (
    result.protocolVersion !== dshLock.protocol.version ||
    result.schemaSha256 !== dshLock.protocol.schemaSha256 ||
    result.profileDigest !== dshLock.profile.digest ||
    result.sessionFormat !== dshLock.runtime.sessionFormat ||
    result.runtimeVersion !== dshLock.runtime.version ||
    !result.runtimeGeneration ||
    result.runtimeEngine.name !== "deepseek-harness" ||
    result.runtimeEngine.distribution !== "myagents-dsh" ||
    result.runtimeEngine.distributionVersion !== dshLock.runtime.version ||
    result.runtimeEngine.version !== dshLock.dsh.version
  ) {
    throw new Error("DSH Runtime initialize identity differs from the lock");
  }
  if (!isDeepStrictEqual(result.runtimeCapabilities, RUNTIME_CAPABILITIES)) {
    throw new Error('DSH Runtime capabilities differ from the installed contract');
  }
}

function assertHostProtocolSelection(params: DshInitializeParams): void {
  if (params.protocol.minVersion !== dshLock.protocol.version || params.protocol.maxVersion !== dshLock.protocol.version) {
    throw new Error('DSH Host protocol selection differs from the installed contract');
  }
}

function assertRuntimeStatus(
  status: DshRuntimeStatus,
  runtimeGeneration: string,
): void {
  if (
    status.runtimeGeneration !== runtimeGeneration ||
    status.initialized !== true ||
    status.primarySessionState !== "unbound"
  ) {
    throw new Error("DSH Runtime was not quiescent after initialization");
  }
}

export function redactDshDiagnosticLine(line: string): string {
  return line
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:api.?key|authorization|credential|password|secret|token|cookie)\s*[=:]\s*)[^\s,;}]+/gi,
      "$1[REDACTED]",
    )
    .slice(0, 4_096);
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 100 || value > 600_000) {
    throw new Error("DSH lifecycle timeout is out of bounds");
  }
  return value;
}

async function withTimeout<T>(
  durationMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("DSH Runtime lifecycle operation timed out"));
    }, durationMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function waitForExit(
  exitPromise: Promise<RuntimeExit>,
  timeoutMs: number,
): Promise<RuntimeExit | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
    void exitPromise.then((exit) => {
      clearTimeout(timer);
      resolve(exit);
    });
  });
}

export class DshRuntimeProcessHost {
  readonly childEnvironment: DshChildEnvironment;

  private stateValue: DshRuntimeProcessHostState = "idle";
  private child: ChildProcessWithoutNullStreams | undefined;
  private exitPromise: Promise<RuntimeExit> | undefined;
  private client: DshGeneratedHostClient | undefined;
  private identityValue: DshRuntimeProcessIdentity | undefined;
  private handlerDisposers: Array<() => void> = [];
  private startPromise: Promise<DshRuntimeProcessIdentity> | undefined;
  private stopPromise: Promise<void> | undefined;
  private failureReported = false;
  private stderrBuffer = "";

  constructor(private readonly options: DshRuntimeProcessHostOptions) {
    assertHostProtocolSelection(options.initialize);
    if (
      (options.onStderrLine === undefined) !==
      (options.redactStderrLine === undefined)
    ) {
      throw new Error(
        "DSH stderr forwarding requires an explicit redactor and sink",
      );
    }
    this.childEnvironment = options.childEnvironment;
  }

  /** Project only names and credential-free proxy endpoints from the sealed environment. */
  get diagnosticSnapshot() {
    const endpoints: Record<string, string> = {};
    for (const key of PROXY_ENV_KEYS) {
      const value = this.childEnvironment.env[key];
      if (!value || key.toUpperCase() === 'NO_PROXY') continue;
      try {
        const url = new URL(value);
        endpoints[key] = `${url.protocol}//${url.host}`;
      } catch { endpoints[key] = '[invalid proxy URL]'; }
    }
    return {
      process: { state: this.state, pid: this.pid, identity: this.identity ?? null,
        artifact: this.identity ? { sourceCommit: dshLock.handoff.sourceCommit,
          handoffSha256: dshLock.handoff.manifestSha256, runtimeManifestSha256: dshLock.handoff.runtimeManifestSha256 } : null },
      environment: { policy: 'allowlist', allowedKeys: [...this.childEnvironment.allowedKeys] },
      proxy: { scope: 'general', capturedAt: 'process_start', endpoints, keys: PROXY_ENV_KEYS.filter(key => Boolean(this.childEnvironment.env[key])) },
    };
  }

  get state(): DshRuntimeProcessHostState {
    return this.stateValue;
  }

  get identity(): DshRuntimeProcessIdentity | undefined {
    return this.identityValue;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get runtimeHome(): string {
    return this.options.initialize.runtimeHome;
  }

  async waitForExit(): Promise<number> {
    const exit = await this.exitPromise;
    return exit?.code ?? (exit?.signal ? 1 : 0);
  }

  start(): Promise<DshRuntimeProcessIdentity> {
    if (this.startPromise) return this.startPromise;
    if (this.stateValue !== "idle") {
      return Promise.reject(
        new Error(`DSH Runtime cannot start from state ${this.stateValue}`),
      );
    }
    this.stateValue = "starting";
    this.startPromise = this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<DshRuntimeProcessIdentity> {
    const handshakeTimeoutMs = boundedTimeout(
      this.options.handshakeTimeoutMs,
      30_000,
    );
    try {
      const loadProtocol =
        this.options.loadProtocolRuntime ?? loadDshProtocolRuntime;
      const assertHandoff =
        this.options.assertHandoffVerification ?? assertDshHandoffVerification;
      await assertHandoff(this.options.installation, this.childEnvironment);
      this.assertStartStillAdmitted();
      const protocolRuntime = await loadProtocol(
        this.options.installation.runtimeArtifactRoot,
      );
      this.assertStartStillAdmitted();
      const child = this.spawnRuntime();
      this.child = child;
      this.exitPromise = new Promise((resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      this.attachChildDiagnostics(child);
      child.once("error", (error) => this.fail(error));

      const client = protocolRuntime.createHostClient({
        input: child.stdout,
        output: child.stdin,
        limits: this.options.initialize.limits,
        onFatalError: (error) => this.fail(error),
      });
      this.client = client;

      const handshake = this.performHandshake(
        client,
        protocolRuntime,
        handshakeTimeoutMs,
      );
      const exited = this.exitPromise.then((details) => {
        throw new Error(
          `DSH Runtime exited during handshake (code=${details.code ?? "null"}, signal=${details.signal ?? "none"})`,
        );
      });
      const identity = await Promise.race([handshake, exited]);
      this.assertStartStillAdmitted();
      this.identityValue = identity;
      this.stateValue = "protocol-ready";
      void this.exitPromise.then((details) => {
        if (this.stateValue === "stopping") {
          this.stateValue = "stopped";
          return;
        }
        if (this.stateValue === "protocol-ready") {
          this.fail(
            new Error(
              `DSH Runtime exited unexpectedly (code=${details.code ?? "null"}, signal=${details.signal ?? "none"})`,
            ),
          );
        }
      });
      return identity;
    } catch (error) {
      if (this.stateValue !== "stopping") this.stateValue = "failed";
      await this.forceStopChild();
      this.disposeProtocolHandlers();
      this.client?.peer.close(
        error instanceof Error ? error : new Error("DSH Runtime start failed"),
      );
      throw error;
    }
  }

  private assertStartStillAdmitted(): void {
    if (this.stateValue !== "starting") {
      throw new Error("DSH Runtime start was cancelled by Host shutdown");
    }
  }

  private spawnRuntime(): ChildProcessWithoutNullStreams {
    const spawnRuntime: DshSpawnRuntime =
      this.options.spawnRuntime ??
      ((command, args, options) =>
        spawnChild(
          command,
          [...args],
          options,
        ) as ChildProcessWithoutNullStreams);
    return spawnRuntime(
      this.options.installation.nodeExecutablePath,
      [this.options.installation.runtimeEntrypointPath],
      {
        cwd: this.options.installation.runtimeArtifactRoot,
        env: this.childEnvironment.env,
        stdio: "pipe",
        windowsHide: true,
      },
    );
  }

  private async performHandshake(
    client: DshGeneratedHostClient,
    protocolRuntime: LoadedDshProtocolRuntime,
    timeoutMs: number,
  ): Promise<DshRuntimeProcessIdentity> {
    const result = await withTimeout(timeoutMs, async (signal) =>
      client.initialize(this.options.initialize, { signal }),
    );
    assertInitializeResult(result);
    client.peer.updateLimits(result.limits);
    const fence = {
      productSessionId: this.options.initialize.productSessionId,
      runtimeGeneration: result.runtimeGeneration,
      ProtocolError: protocolRuntime.ProtocolError,
    } as const;
    const disposeHostHandlers = client.registerHostHandlers(
      createFencedDshHostHandlers(this.options.hostHandlers, fence),
    );
    try {
      const disposeNotifications = client.registerRuntimeNotificationHandlers(
        createFencedDshNotificationHandlers(
          this.options.notificationHandlers,
          fence,
        ),
      );
      this.handlerDisposers.push(disposeHostHandlers, disposeNotifications);
    } catch (error) {
      disposeHostHandlers();
      throw error;
    }
    await withTimeout(timeoutMs, async () => client.initialized({}));
    const status = (await withTimeout(timeoutMs, async (signal) =>
      client.runtimeStatus({}, { signal }),
    )) as DshRuntimeStatus;
    assertRuntimeStatus(status, result.runtimeGeneration);
    return Object.freeze({
      productSessionId: this.options.initialize.productSessionId,
      runtimeGeneration: result.runtimeGeneration,
      protocolVersion: result.protocolVersion,
      schemaSha256: result.schemaSha256,
      profileDigest: result.profileDigest,
      sessionFormat: result.sessionFormat,
      runtimeVersion: result.runtimeVersion,
      dshVersion: result.runtimeEngine.version,
    });
  }

  async request<Name extends Exclude<DshHostMethodName, "initialize" | "runtime/shutdown">>(
    method: Name,
    params: MethodParams<Name>,
    options?: { signal?: AbortSignal },
  ): Promise<MethodResult<Name>> {
    if (this.stateValue !== "protocol-ready" || !this.client) {
      throw new Error("DSH Runtime protocol is not ready");
    }
    const clientMethod = DSH_CLIENT_METHOD_BY_PROTOCOL[method];
    // TypeScript cannot retain the mapped key relation through a generic indexed access.
    const call = this.client[clientMethod] as (input: MethodParams<Name>, options?: { signal?: AbortSignal }) => Promise<MethodResult<Name>>;
    return await call.call(this.client, params, options);
  }

  stop(reason = "host_shutdown"): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal(reason);
    return this.stopPromise;
  }

  private async stopInternal(reason: string): Promise<void> {
    if (this.stateValue === "stopped") return;
    if (this.stateValue === "starting") {
      this.stateValue = "stopping";
      this.child?.kill("SIGTERM");
      await this.startPromise?.catch(() => undefined);
      this.disposeProtocolHandlers();
      this.client?.peer.close();
      this.stateValue = "stopped";
      return;
    }
    const wasReady = this.stateValue === "protocol-ready";
    this.stateValue = "stopping";
    const graceMs = boundedTimeout(this.options.shutdownGraceMs, 5_000);
    const client = this.client;
    if (wasReady && client) {
      try {
        await withTimeout(graceMs, async (signal) =>
          client.runtimeShutdown({ reason }, { signal }),
        );
        await client.peer.flush();
      } catch {
        // A failed shutdown request falls through to bounded process teardown.
      }
    }
    if (this.exitPromise && !(await waitForExit(this.exitPromise, graceMs))) {
      this.child?.kill("SIGTERM");
      if (!(await waitForExit(this.exitPromise, Math.min(graceMs, 2_000)))) {
        this.child?.kill("SIGKILL");
        await waitForExit(this.exitPromise, 1_000);
      }
    }
    this.disposeProtocolHandlers();
    this.client?.peer.close();
    this.stateValue = "stopped";
  }

  private async forceStopChild(): Promise<void> {
    if (!this.child || !this.exitPromise) return;
    this.child.kill("SIGTERM");
    if (!(await waitForExit(this.exitPromise, 500))) {
      this.child.kill("SIGKILL");
      await waitForExit(this.exitPromise, 500);
    }
  }

  private disposeProtocolHandlers(): void {
    for (const dispose of this.handlerDisposers.splice(0).reverse()) dispose();
  }

  private attachChildDiagnostics(child: ChildProcessWithoutNullStreams): void {
    const sink = this.options.onStderrLine;
    const redactor = this.options.redactStderrLine;
    if (!sink || !redactor) return;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
      while (true) {
        const newline = this.stderrBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.stderrBuffer.slice(0, newline);
        this.stderrBuffer = this.stderrBuffer.slice(newline + 1);
        sink(redactor(line));
      }
      if (this.stderrBuffer.length > 16_384) {
        this.stderrBuffer = this.stderrBuffer.slice(-4_096);
      }
    });
  }

  private fail(error: Error): void {
    if (this.stateValue === "stopping" || this.stateValue === "stopped") return;
    this.stateValue = "failed";
    this.disposeProtocolHandlers();
    this.client?.peer.close(error);
    this.child?.kill("SIGTERM");
    if (!this.failureReported) {
      this.failureReported = true;
      this.options.onFailure?.(error);
    }
  }
}
