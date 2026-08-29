import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

import packageJson from '../../../../package.json';
import type { Provider } from '../../../shared/config-types';
import {
  DSH_PROVIDER_CELL_CONTRACT,
  findDshProviderCell,
} from '../../../shared/integrated-runtimes/dsh-provider-cells';
import {
  DSH_PERMISSION_MODES,
  type RuntimeDetection,
  type RuntimeModelInfo,
  type RuntimePermissionMode,
  type RuntimeType,
} from '../../../shared/types/runtime';
import { isConcreteProviderRoute } from '../../../shared/providerRoute';
import { getSessionMetadata } from '../../SessionStore';
import {
  findEffectiveProvider,
  findProjectAgentByWorkspacePath,
  loadConfig,
  resolveProviderEnv,
} from '../../utils/admin-config';
import { getHomeDir } from '../../utils/platform';
import { getBundledNodePath } from '../../utils/runtime';
import type {
  AgentRuntime,
  ResolvedImagePayload,
  RuntimeConfigCapabilities,
  RuntimeProcess,
  SessionStartOptions,
  UnifiedEvent,
  UnifiedEventCallback,
} from '../../runtimes/types';
import { recoverPendingDshMutation } from '../../session-engine/dsh-mutation-recovery';
import {
  reconcileDshTurnsAtStartup,
  type DshUnsettledTurn,
} from '../../session-engine/dsh-turn-reconciliation';
import { DshAttachmentRegistry } from './attachments';
import { DshRuntimeEventProjector } from './event-projector';
import { compileDshExtensionSnapshot } from './extension-compiler';
import { createDshInitializeParams } from './initialize';
import { resolveDshRuntimeInstallation } from './installation';
import { DshMutationController } from './mutations';
import {
  compileDshModelExecutionProfile,
  type DshModelExecutionProfile,
  type DshReasoningEffortSelection,
} from './profile-compiler';
import {
  DshRuntimeProcessHost,
  redactDshDiagnosticLine,
} from './process-host';
import type {
  DshExecutionEnvironment,
  DshHostRequestHandlers,
  DshRpcObject,
  DshRuntimeNotificationHandlers,
} from './protocol-types';

const OFFICIAL_INITIAL_PERMISSION_MODE = 'default';
const OFFICIAL_INTERACTION_REVISION = 'host-interaction-v1';
const DSH_NETWORK_POLICY_REF = 'myagents-network-v1';
const DSH_CHECKPOINT_POLICY_REVISION = 'myagents-root-write-edit-checkpoint-v1';

type ProductPermissionMode = 'auto' | 'plan' | 'fullAgency';
type DshPermissionMode = 'acceptEdits' | 'bypassPermissions';

type PendingInteraction = Readonly<{
  kind: 'permission' | 'ask_user' | 'plan_approval';
  desiredPolicyRevision: string;
  schema: DshRpcObject;
}>;

type DshConfiguration = Readonly<{
  profile: DshModelExecutionProfile;
  apiKey: string;
  productPermissionMode: ProductPermissionMode;
  dshPermissionMode: DshPermissionMode;
  reasoningEffort: DshReasoningEffortSelection;
  revision: string;
}>;

function hash(...parts: readonly string[]): string {
  const digest = createHash('sha256');
  for (const part of parts) digest.update(part).update('\0');
  return digest.digest('hex');
}

function object(value: unknown, description: string): DshRpcObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as DshRpcObject;
}

function string(value: unknown, description: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

function productPermissionMode(value: string | undefined): ProductPermissionMode {
  if (value === undefined || value === '' || value === 'auto') return 'auto';
  if (value === 'plan' || value === 'fullAgency') return value;
  throw new Error(`Unsupported MyAgents DSH permission mode: ${value}`);
}

function dshPermissionMode(value: ProductPermissionMode): DshPermissionMode {
  return value === 'fullAgency' ? 'bypassPermissions' : 'acceptEdits';
}

function reasoningSelection(value: string | undefined): DshReasoningEffortSelection {
  if (value === undefined || value === '' || value === 'default') return 'default';
  if (value === 'off' || value === 'low' || value === 'medium'
    || value === 'high' || value === 'xhigh' || value === 'max') {
    return value;
  }
  throw new Error(`Unsupported DSH reasoning effort: ${value}`);
}

function scenarioCapability(options: SessionStartOptions): 'interactive' | 'deterministic-headless' {
  return options.scenario.type === 'desktop' ? 'interactive' : 'deterministic-headless';
}

function turnOrigin(options: SessionStartOptions): DshRpcObject {
  return options.scenario.type === 'desktop'
    ? { kind: 'desktop' }
    : { kind: 'headless', scenario: options.scenario.type };
}

function platformTarget(): 'darwin-arm64' | 'win32-x64' | 'linux-x64' {
  const target = `${process.platform}-${process.arch}`;
  if (target === 'darwin-arm64' || target === 'win32-x64' || target === 'linux-x64') {
    return target;
  }
  throw new Error(`DSH Runtime has no accepted native target for ${target}`);
}

async function resourceRootForNode(nodeExecutablePath: string): Promise<string> {
  let cursor = dirname(await realpath(nodeExecutablePath));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      await access(join(cursor, 'integrated-runtimes', 'dsh', 'runtime-artifact'));
      return await realpath(cursor);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  throw new Error('Bundled DSH Runtime resources are unavailable beside bundled Node');
}

async function installedRuntime() {
  const nodeExecutablePath = getBundledNodePath();
  if (!nodeExecutablePath) throw new Error('MyAgents bundled Node is unavailable');
  return await resolveDshRuntimeInstallation({
    nodeExecutablePath,
    resourceRoot: await resourceRootForNode(nodeExecutablePath),
  });
}

function providerForSession(options: SessionStartOptions, requestedOverride?: string): {
  provider: Provider;
  modelId: string;
  apiKey: string;
} {
  const config = loadConfig();
  const metadata = getSessionMetadata(options.sessionId);
  const agent = findProjectAgentByWorkspacePath(options.workspacePath) as
    | { providerId?: string; model?: string }
    | undefined;
  const requestedModel = requestedOverride
    || (isConcreteProviderRoute(metadata?.providerRoute) ? metadata.providerRoute.model : undefined)
    || metadata?.model
    || agent?.model
    || options.model;
  const providerId = isConcreteProviderRoute(metadata?.providerRoute)
    ? metadata.providerRoute.providerId
    : metadata?.providerId || agent?.providerId
      || (requestedModel
        ? DSH_PROVIDER_CELL_CONTRACT.cells.find(cell => cell.modelId === requestedModel)?.providerId
        : undefined);
  if (!providerId) {
    throw new Error('DSH Session has no concrete Provider authority');
  }
  const provider = findEffectiveProvider(providerId, config) as Provider | null;
  if (!provider) throw new Error(`DSH Provider ${providerId} is unavailable`);
  const modelId = requestedModel || provider.primaryModel;
  if (!findDshProviderCell(providerId, modelId)) {
    throw new Error(`Provider/model ${providerId}/${modelId} is not accepted by the DSH handoff`);
  }
  const resolved = resolveProviderEnv(providerId, config);
  if (!resolved?.apiKey) {
    throw new Error(`DSH Provider ${providerId} has no Host-owned API credential`);
  }
  return { provider, modelId, apiKey: resolved.apiKey };
}

function compileConfiguration(
  options: SessionStartOptions,
  overrides?: { model?: string; permissionMode?: string; reasoningEffort?: string },
): DshConfiguration {
  const selected = providerForSession(options, overrides?.model);
  const productMode = productPermissionMode(overrides?.permissionMode ?? options.permissionMode);
  const effort = reasoningSelection(overrides?.reasoningEffort ?? options.reasoningEffort);
  const profile = compileDshModelExecutionProfile({
    provider: selected.provider,
    modelId: selected.modelId,
    reasoningEffort: effort,
  });
  const dshMode = dshPermissionMode(productMode);
  return Object.freeze({
    profile,
    apiKey: selected.apiKey,
    productPermissionMode: productMode,
    dshPermissionMode: dshMode,
    reasoningEffort: effort,
    revision: `myagents-dsh-config-v1:${hash(
      profile.revision,
      dshMode,
      OFFICIAL_INTERACTION_REVISION,
      options.systemPromptAppend ?? '',
    )}`,
  });
}

async function createOwnedRoots(productSessionId: string): Promise<Readonly<{
  runtimeHome: string;
  attachmentRoot: string;
}>> {
  const identity = hash('myagents-dsh-product-session-v1', productSessionId);
  const base = join(getHomeDir(), '.myagents');
  const requestedRuntimeHome = join(base, 'dsh-runtime', identity);
  const requestedAttachmentRoot = join(base, 'dsh-attachments', identity);
  await Promise.all([
    mkdir(requestedRuntimeHome, { recursive: true, mode: 0o700 }),
    mkdir(requestedAttachmentRoot, { recursive: true, mode: 0o700 }),
  ]);
  const [runtimeHome, attachmentRoot] = await Promise.all([
    realpath(requestedRuntimeHome),
    realpath(requestedAttachmentRoot),
  ]);
  return Object.freeze({ runtimeHome, attachmentRoot });
}

function executionEnvironment(
  workspacePath: string,
  workspaceIdentity: string,
  attachmentRoot: string,
): Omit<DshExecutionEnvironment, 'digest'> {
  const windows = process.platform === 'win32';
  return {
    revision: `myagents-dsh-execution-v1:${hash(
      platformTarget(),
      workspaceIdentity,
      workspacePath,
      attachmentRoot,
    )}`,
    workspace: {
      identity: workspaceIdentity,
      canonicalRoot: workspacePath,
      allowedReadRoots: [workspacePath],
      allowedWriteRoots: [workspacePath],
    },
    executables: {
      bundledNodeRef: 'bundled-node',
      bashRef: 'bundled-bash',
      ripgrepRef: 'bundled-ripgrep',
      bashDialect: 'bash',
      allowedCommandRefs: windows
        ? ['bundled-bash', 'bundled-node', 'bundled-powershell', 'bundled-ripgrep']
        : ['bundled-bash', 'bundled-node', 'bundled-ripgrep'],
      pathPolicy: 'sealed',
      ...(windows
        ? {
          windowsPowerShellRef: 'bundled-powershell',
          windowsUtf8PreludeRef: 'windows-powershell-utf8-v1',
        }
        : {}),
    },
    environment: {
      allowedKeys: [],
      inheritedKeys: [],
      secretValues: 'reverse-port-only',
    },
    network: { mode: 'host-policy', policyRef: DSH_NETWORK_POLICY_REF },
    process: {
      backgroundRetention: 'allow',
      maxChildren: 16,
      killTreeOnAbort: true,
    },
    checkpoint: {
      mode: 'managed-file-tools',
      version: 1,
      policyRevision: DSH_CHECKPOINT_POLICY_REVISION,
      trackedTools: ['Write', 'Edit'],
      tracksShell: false,
      tracksChildAgents: false,
      tracksExternalChanges: false,
    },
    attachmentStagingRoot: attachmentRoot,
  };
}

function answerValue(schema: DshRpcObject, updatedInput: Record<string, unknown> | undefined): DshRpcObject {
  const answers = updatedInput?.answers;
  const answerMap = answers && typeof answers === 'object' && !Array.isArray(answers)
    ? answers as Record<string, unknown>
    : {};
  const questions = Array.isArray(schema.questions) ? schema.questions : [];
  return {
    answers: questions.flatMap((candidate, index) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const question = candidate as DshRpcObject;
      const id = typeof question.id === 'string' ? question.id : `question-${index}`;
      const label = typeof question.question === 'string' ? question.question : undefined;
      const value = answerMap[id] ?? answerMap[String(index)] ?? (label ? answerMap[label] : undefined);
      if (typeof value !== 'string') return [];
      const selected = value.split(',').map(entry => entry.trim()).filter(Boolean);
      return [{ id, selected: selected.length > 0 ? selected : [value] }];
    }),
  };
}

class DshProcess implements RuntimeProcess {
  readonly runtimeGeneration: string;
  loadedSkillNames: readonly string[] = [];
  activeOperationId: string | undefined;
  planRevision: string | undefined;
  planMode: 'normal' | 'plan' | undefined;
  configuration: DshConfiguration;
  readonly operationUserMessages = new Map<string, string>();
  readonly pendingInteractions: Map<string, PendingInteraction>;

  constructor(
    readonly host: DshRuntimeProcessHost,
    readonly projector: DshRuntimeEventProjector,
    readonly attachments: DshAttachmentRegistry,
    readonly options: SessionStartOptions,
    readonly onEvent: UnifiedEventCallback,
    readonly executionEnvironment: DshExecutionEnvironment,
    configuration: DshConfiguration,
    readonly runtimeSessionId: string,
    readonly extensionDigest: string,
    readonly tools: readonly string[],
    readonly productTranscriptChangedAtStartup: boolean,
    activeTurn?: DshUnsettledTurn,
    pendingInteractions?: Map<string, PendingInteraction>,
  ) {
    this.configuration = configuration;
    this.runtimeGeneration = string(host.identity?.runtimeGeneration, 'DSH Runtime generation');
    this.pendingInteractions = pendingInteractions ?? new Map();
    if (activeTurn) {
      this.activeOperationId = activeTurn.clientOperationId;
      this.operationUserMessages.set(activeTurn.clientOperationId, activeTurn.clientUserMessageId);
    }
  }

  get pid(): number {
    const pid = this.host.pid;
    if (!pid) throw new Error('DSH Runtime process has no pid');
    return pid;
  }

  get exited(): boolean {
    return this.host.state === 'stopped' || this.host.state === 'failed';
  }

  writeLine(): Promise<void> {
    return Promise.reject(new Error('DSH Runtime accepts only generated protocol requests'));
  }

  kill(): void {
    void this.host.stop('host_kill');
  }

  waitForExit(): Promise<number> {
    return this.host.waitForExit();
  }
}

function dshProcess(process: RuntimeProcess): DshProcess {
  if (!(process instanceof DshProcess)) throw new Error('Runtime process is not owned by DSH');
  return process;
}

export type DshConversationMutationContext = Readonly<{
  controller: DshMutationController;
  runtimeSessionId: string;
  runtimeHome: string;
  workspaceIdentity: string;
}>;

export function getDshConversationMutationContext(
  runtimeProcess: RuntimeProcess,
): DshConversationMutationContext {
  const process = dshProcess(runtimeProcess);
  return Object.freeze({
    controller: new DshMutationController(process.host, process.runtimeSessionId),
    runtimeSessionId: process.runtimeSessionId,
    runtimeHome: process.host.runtimeHome,
    workspaceIdentity: process.executionEnvironment.workspace.identity,
  });
}

export async function createDshForkTargetFacts(
  productSessionId: string,
): Promise<Readonly<{
  runtimeHome: string;
  persistenceRef: string;
}>> {
  const roots = await createOwnedRoots(productSessionId);
  return Object.freeze({
    runtimeHome: roots.runtimeHome,
    persistenceRef: `product-session-${hash(productSessionId)}`,
  });
}

export class DshRuntime implements AgentRuntime {
  readonly type: RuntimeType = 'dsh';

  getConfigCapabilities(): RuntimeConfigCapabilities {
    return {
      model: 'live_session_rpc',
      permissionMode: 'live_session_rpc',
      reasoningEffort: 'live_session_rpc',
    };
  }

  async detect(): Promise<RuntimeDetection> {
    try {
      const installation = await installedRuntime();
      return {
        installed: true,
        version: packageJson.version,
        path: installation.runtimeEntrypointPath,
      };
    } catch {
      return { installed: false };
    }
  }

  async queryModels(): Promise<RuntimeModelInfo[]> {
    return DSH_PROVIDER_CELL_CONTRACT.cells.map((cell, index) => ({
      value: cell.modelId,
      displayName: cell.modelId,
      description: `${cell.providerId} · verified MyAgents-dsh cell`,
      isDefault: index === 0,
    }));
  }

  getPermissionModes(): RuntimePermissionMode[] {
    return DSH_PERMISSION_MODES;
  }

  async startSession(
    options: SessionStartOptions,
    onEvent: UnifiedEventCallback,
  ): Promise<RuntimeProcess> {
    if (options.runtimeSource && options.runtimeSource !== 'integrated') {
      throw new Error('DSH Runtime source must be integrated');
    }
    const installation = await installedRuntime();
    const workspacePath = await realpath(options.workspacePath);
    if (normalize(workspacePath) !== workspacePath) {
      throw new Error('DSH workspace path is not canonical');
    }
    const roots = await createOwnedRoots(options.sessionId);
    const attachments = new DshAttachmentRegistry(roots.attachmentRoot);
    await attachments.initialize();
    const workspaceIdentity = `myagents-workspace-v1:${hash(workspacePath)}`;
    const environmentWithoutDigest = executionEnvironment(
      workspacePath,
      workspaceIdentity,
      roots.attachmentRoot,
    );
    const initialize = createDshInitializeParams({
      productSessionId: options.sessionId,
      productVersion: packageJson.version,
      runtimeHome: roots.runtimeHome,
      workspace: { path: workspacePath, identity: workspaceIdentity },
      executionEnvironment: environmentWithoutDigest,
      interaction: scenarioCapability(options),
    });
    const configuration = compileConfiguration(options);
    const extension = compileDshExtensionSnapshot();
    let processValue: DshProcess | undefined;
    let projector: DshRuntimeEventProjector | undefined;
    const pendingInteractions = new Map<string, PendingInteraction>();
    const deferredProductActions: Array<() => void> = [];
    let productEventDeliveryReady = false;
    const emitProductEvent = (event: UnifiedEvent): void => {
      if (productEventDeliveryReady) onEvent(event);
      else deferredProductActions.push(() => onEvent(event));
    };
    const deferProductAction = (action: () => void): void => {
      if (productEventDeliveryReady) action();
      else deferredProductActions.push(action);
    };

    const hostHandlers: DshHostRequestHandlers = Object.freeze({
      'host/credential/resolve': (params) => {
        if (params.subject !== 'provider') {
          return {
            kind: 'availability',
            available: false,
            authoritativeCredentialRevision: string(params.credentialRevision, 'DSH MCP credential revision'),
            reasonCode: 'mcp_credential_unavailable',
          };
        }
        const active = processValue?.configuration ?? configuration;
        if (
          params.credentialRef !== active.profile.credentialRef
          || params.providerRouteId !== active.profile.providerRouteId
          || params.profileRevision !== active.profile.revision
        ) {
          return {
            kind: 'availability',
            available: false,
            authoritativeCredentialRevision: active.profile.revision,
            reasonCode: 'provider_credential_authority_mismatch',
          };
        }
        if (params.purpose === 'availability') {
          return {
            kind: 'availability',
            available: true,
            authoritativeCredentialRevision: active.profile.revision,
          };
        }
        return {
          kind: 'material',
          authoritativeCredentialRevision: active.profile.revision,
          material: { apiKey: active.apiKey },
        };
      },
      'host/interaction/request': (params) => {
        const interactionId = string(params.interactionId, 'DSH interaction id');
        const kind = string(params.kind, 'DSH interaction kind') as PendingInteraction['kind'];
        if (kind !== 'permission' && kind !== 'ask_user' && kind !== 'plan_approval') {
          throw new Error('DSH interaction kind is unsupported');
        }
        const schema = object(params.schema, 'DSH interaction schema');
        pendingInteractions.set(interactionId, {
          kind,
          desiredPolicyRevision: string(params.desiredPolicyRevision, 'DSH interaction revision'),
          schema,
        });
        const authority = object(params.authority, 'DSH interaction authority');
        const toolName = kind === 'permission'
          ? (typeof schema.tool === 'string' ? schema.tool : 'DSHTool')
          : 'AskUserQuestion';
        emitProductEvent({
          kind: 'permission_request',
          requestId: interactionId,
          toolName,
          toolUseId: typeof authority.callId === 'string' ? authority.callId : interactionId,
          input: schema,
        });
        emitProductEvent({ kind: 'status_change', state: 'waiting_permission' });
        return { registered: true };
      },
      'host/tool/execute': () => ({
        state: 'failed',
        code: 'host_tool_unavailable',
        content: [{ type: 'text', text: 'The MyAgents Host tool backend is unavailable.' }],
      }),
      'host/hook/execute': () => ({ state: 'continue' }),
      'host/attachment/put': params => attachments.put(params),
      'host/attachment/acquire': params => attachments.acquire(params),
      'host/attachment/release': params => attachments.release(params),
    });
    const notificationHandlers: DshRuntimeNotificationHandlers = Object.freeze({
      'runtime/event': params => {
        if (!projector) throw new Error('DSH event arrived before projection was bound');
        return projector.accept(params);
      },
      'host/interaction/cancel': params => {
        const interactionId = string(params.interactionId, 'DSH cancelled interaction id');
        pendingInteractions.delete(interactionId);
        emitProductEvent({ kind: 'interactive_request_resolved', requestId: interactionId });
      },
    });
    const host = new DshRuntimeProcessHost({
      installation,
      initialize,
      hostHandlers,
      notificationHandlers,
      commandDirectories: process.platform === 'win32'
        ? [dirname(installation.nodeExecutablePath)]
        : ['/bin', '/usr/bin'],
      onStderrLine: line => emitProductEvent({ kind: 'log', level: 'warn', message: line }),
      redactStderrLine: redactDshDiagnosticLine,
      onFailure: error => {
        emitProductEvent({ kind: 'log', level: 'error', message: redactDshDiagnosticLine(error.message) });
        emitProductEvent({ kind: 'status_change', state: 'error' });
      },
    });

    try {
      const identity = await host.start();
      projector = new DshRuntimeEventProjector({
        productSessionId: options.sessionId,
        runtimeGeneration: identity.runtimeGeneration,
        onEvent: emitProductEvent,
        clientUserMessageIdForOperation: operationId => processValue?.operationUserMessages.get(operationId),
        onTurnTerminal: terminal => {
          deferProductAction(() => {
            if (processValue?.activeOperationId === terminal.clientOperationId) {
              processValue.activeOperationId = undefined;
            }
          });
        },
      });
      const extensionResult = await host.request(
        'extension/replace',
        extension as unknown as DshRpcObject,
      );
      if (extensionResult.state !== 'applied'
        || extensionResult.effectiveRevision !== extension.revision) {
        throw new Error('DSH extension snapshot did not become effective before Session binding');
      }
      const extensionCatalog = await host.request('extension/catalog', {});
      const extensionDigest = string(extensionCatalog.digest, 'DSH extension catalog digest');
      if (!/^[a-f0-9]{64}$/.test(extensionDigest)) {
        throw new Error('DSH effective extension catalog digest is invalid');
      }

      const bindingParams: DshRpcObject = {
        clientOperationId: `session-bind-${randomUUID()}`,
        persistenceRef: `product-session-${hash(options.sessionId)}`,
        provider: configuration.profile as unknown as DshRpcObject,
        configRevision: configuration.revision,
        extensionDigest,
        systemPrompt: options.systemPromptAppend ?? '',
        permissionMode: OFFICIAL_INITIAL_PERMISSION_MODE,
        interactionScenario: OFFICIAL_INTERACTION_REVISION,
        ...(options.resumeSessionId ? { runtimeSessionId: options.resumeSessionId } : {}),
      };
      let binding = await host.request(
        options.resumeSessionId ? 'session/resume' : 'session/create',
        bindingParams,
      );
      const runtimeSessionId = string(binding.runtimeSessionId, 'DSH Runtime Session id');
      const mutationController = new DshMutationController(host, runtimeSessionId);
      const recovery = await recoverPendingDshMutation({
        productSessionId: options.sessionId,
        runtimeSessionId,
        binding,
        controller: mutationController,
      });
      if (recovery.productDeleted) {
        throw new Error('The DSH Product Session was deleted during recovery');
      }
      if (binding.state === 'recovery_required' || recovery.recovered) {
        binding = await host.request('session/resume', {
          ...bindingParams,
          clientOperationId: `session-rebind-${randomUUID()}`,
          runtimeSessionId,
        });
      }
      if (binding.state !== 'ready') {
        throw new Error(`DSH Session requires recovery: ${String(binding.reason ?? 'unknown')}`);
      }
      if (binding.runtimeSessionId !== runtimeSessionId) {
        throw new Error('DSH recovery changed the Runtime Session identity');
      }
      const turnReconciliation = options.resumeSessionId
        ? await reconcileDshTurnsAtStartup({
            productSessionId: options.sessionId,
            runtimeSessionId,
            controller: mutationController,
          })
        : { transcriptChanged: false, reconciledOperations: 0 };
      const toolCatalog = object(binding.toolCatalog, 'DSH tool catalog');
      const boundExtensionCatalog = object(binding.extensionCatalog, 'DSH bound extension catalog');
      if (boundExtensionCatalog.digest !== extensionDigest) {
        throw new Error('DSH Session bound a different extension catalog generation');
      }
      const tools = Array.isArray(toolCatalog.effectiveTools)
        ? toolCatalog.effectiveTools.filter((tool): tool is string => typeof tool === 'string')
        : [];
      processValue = new DshProcess(
        host,
        projector,
        attachments,
        options,
        onEvent,
        initialize.executionEnvironment,
        configuration,
        runtimeSessionId,
        extensionDigest,
        tools,
        recovery.recovered || turnReconciliation.transcriptChanged,
        turnReconciliation.activeTurn,
        pendingInteractions,
      );
      await projector.whenIdle();
      if (turnReconciliation.activeTurn) {
        onEvent({
          kind: 'root_turn_admitted',
          runtimeTurnId: turnReconciliation.activeTurn.productTurnId,
          clientUserMessageId: turnReconciliation.activeTurn.clientUserMessageId,
        });
      } else if (options.resumeSessionId) {
        deferredProductActions.length = 0;
      }
      productEventDeliveryReady = true;
      for (const action of deferredProductActions.splice(0)) action();
      await this.applyConfiguration(processValue, configuration);
      await this.applyPlanMode(
        processValue,
        configuration.productPermissionMode === 'plan' ? 'plan' : 'normal',
      );
      onEvent({
        kind: 'session_init',
        sessionId: runtimeSessionId,
        model: configuration.profile.modelId,
        tools: [...tools],
      });
      onEvent({ kind: 'runtime_tool_catalog', tools: [...tools] });
      onEvent({
        kind: 'status_change',
        state: pendingInteractions.size > 0
          ? 'waiting_permission'
          : processValue.activeOperationId
            ? 'running'
            : 'idle',
      });
      if (options.initialTurn) {
        await this.startTurn(
          processValue,
          options.initialTurn.message,
          options.initialTurn.images,
          options.initialTurn.clientUserMessageId,
        );
      }
      return processValue;
    } catch (error) {
      attachments.close();
      await host.stop('session_admission_failed').catch(() => undefined);
      throw error;
    }
  }

  private async canonicalInput(
    process: DshProcess,
    message: string,
    images: readonly ResolvedImagePayload[] | undefined,
  ): Promise<DshRpcObject> {
    const text = message.trim();
    const imageParts = await process.attachments.registerImages(images);
    const parts: DshRpcObject[] = [
      ...(text ? [{ kind: 'text', text }] : []),
      ...imageParts,
    ];
    if (parts.length === 0) throw new Error('DSH turn input is empty');
    return { parts };
  }

  private async startTurn(
    process: DshProcess,
    message: string,
    images: readonly ResolvedImagePayload[] | undefined,
    clientUserMessageId: string,
  ): Promise<void> {
    if (process.activeOperationId) throw new Error('DSH already owns an active root turn');
    const clientOperationId = `turn-${randomUUID()}`;
    process.activeOperationId = clientOperationId;
    process.operationUserMessages.set(clientOperationId, clientUserMessageId);
    try {
      const result = await process.host.request('turn/start', {
        clientOperationId,
        clientUserMessageId,
        input: await this.canonicalInput(process, message, images),
        configRevision: process.configuration.revision,
        extensionDigest: process.extensionDigest,
        executionEnvironmentRevision: process.executionEnvironment.revision,
        executionEnvironmentDigest: process.executionEnvironment.digest,
        limits: {
          ...(process.options.maxTurns ? { maxTurns: process.options.maxTurns } : {}),
        },
        origin: turnOrigin(process.options),
      });
      if (result.state !== 'accepted' && result.state !== 'already_known') {
        throw new Error('DSH root turn was not admitted');
      }
    } catch (error) {
      if (process.activeOperationId === clientOperationId) process.activeOperationId = undefined;
      throw error;
    }
  }

  async sendMessage(
    runtimeProcess: RuntimeProcess,
    message: string,
    images?: ResolvedImagePayload[],
    options?: { clientUserMessageId?: string },
  ): Promise<void> {
    await this.startTurn(
      dshProcess(runtimeProcess),
      message,
      images,
      options?.clientUserMessageId ?? `user-${randomUUID()}`,
    );
  }

  getActiveRootOperation(runtimeProcess: RuntimeProcess): Readonly<{
    clientOperationId: string;
    clientUserMessageId: string;
  }> | null {
    const process = dshProcess(runtimeProcess);
    const clientOperationId = process.activeOperationId;
    if (!clientOperationId) return null;
    const clientUserMessageId = process.operationUserMessages.get(clientOperationId);
    if (!clientUserMessageId) {
      throw new Error('DSH active root operation lost its Product user owner');
    }
    return Object.freeze({ clientOperationId, clientUserMessageId });
  }

  async steerMessage(
    runtimeProcess: RuntimeProcess,
    message: string,
    images?: ResolvedImagePayload[],
  ): Promise<void> {
    const process = dshProcess(runtimeProcess);
    if (!process.activeOperationId) throw new Error('DSH has no active root turn to steer');
    await process.host.request('turn/steer', {
      clientOperationId: process.activeOperationId,
      input: await this.canonicalInput(process, message, images),
    });
  }

  async compactContext(runtimeProcess: RuntimeProcess): Promise<void> {
    const process = dshProcess(runtimeProcess);
    if (process.activeOperationId) throw new Error('DSH compaction requires a quiescent root turn');
    const result = await process.host.request('session/compact', {
      clientOperationId: `compact-${randomUUID()}`,
    });
    if (result.state !== 'accepted' && result.state !== 'already_known') {
      throw new Error('DSH compaction was not accepted');
    }
  }

  async respondPermission(
    runtimeProcess: RuntimeProcess,
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    _reason?: string,
    _suggestions?: unknown[],
    updatedInput?: Record<string, unknown>,
  ): Promise<void> {
    const process = dshProcess(runtimeProcess);
    const pending = process.pendingInteractions.get(requestId);
    if (!pending) throw new Error('DSH interaction is no longer pending');
    const question = pending.kind !== 'permission';
    const wireDecision = question
      ? (decision === 'deny' ? 'cancelled' : 'answered')
      : decision;
    const result = await process.host.request('interaction/respond', {
      interactionId: requestId,
      expectedRevision: pending.desiredPolicyRevision,
      decision: wireDecision,
      ...(question && wireDecision === 'answered'
        ? { value: answerValue(pending.schema, updatedInput) }
        : {}),
    });
    if (result.state === 'rejected') {
      throw new Error(`DSH interaction response was rejected: ${String(result.code)}`);
    }
    process.pendingInteractions.delete(requestId);
    process.onEvent({ kind: 'interactive_request_resolved', requestId });
    process.onEvent({ kind: 'status_change', state: 'running' });
  }

  async interruptTurn(runtimeProcess: RuntimeProcess): Promise<void> {
    const process = dshProcess(runtimeProcess);
    if (!process.activeOperationId) return;
    await process.host.request('turn/interrupt', {
      clientOperationId: process.activeOperationId,
      cancelQueued: false,
    });
  }

  async stopSession(runtimeProcess: RuntimeProcess): Promise<void> {
    const process = dshProcess(runtimeProcess);
    try {
      if (process.activeOperationId) {
        await process.host.request('turn/interrupt', {
          clientOperationId: process.activeOperationId,
          cancelQueued: true,
        });
      }
      await process.host.request('session/close', {
        clientOperationId: `session-close-${randomUUID()}`,
      }).catch(() => undefined);
    } finally {
      process.attachments.close();
      await process.host.stop('host_shutdown');
    }
  }

  private async applyConfiguration(
    process: DshProcess,
    configuration: DshConfiguration,
  ): Promise<void> {
    const result = await process.host.request('config/apply', {
      revision: configuration.revision,
      provider: configuration.profile as unknown as DshRpcObject,
      permissionMode: configuration.dshPermissionMode,
      interactionScenario: OFFICIAL_INTERACTION_REVISION,
      systemPrompt: process.options.systemPromptAppend ?? '',
      executionEnvironmentRevision: process.executionEnvironment.revision,
      executionEnvironmentDigest: process.executionEnvironment.digest,
    });
    if (result.state !== 'applied' || result.effectiveRevision !== configuration.revision) {
      throw new Error('DSH configuration did not become effective');
    }
    process.configuration = configuration;
  }

  private async applyPlanMode(process: DshProcess, desired: 'normal' | 'plan'): Promise<void> {
    const call = (mode: 'normal' | 'plan', expectedRevision: string) => process.host.request(
      'plan/apply',
      {
        clientOperationId: `plan-${randomUUID()}`,
        expectedRevision,
        mode,
      },
    );
    if (process.planRevision) {
      const result = await call(desired, process.planRevision);
      process.planRevision = string(result.revision, 'DSH Plan revision');
      process.planMode = desired;
      return;
    }

    const placeholder = `myagents-plan-probe:${hash(process.runtimeSessionId)}`;
    try {
      const already = await call(desired, placeholder);
      process.planRevision = string(already.revision, 'DSH Plan revision');
      process.planMode = desired;
      return;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      if (code !== 'plan_revision_stale') throw error;
      const currentMode = desired === 'plan' ? 'normal' : 'plan';
      const current = await call(currentMode, placeholder);
      const currentRevision = string(current.revision, 'DSH Plan revision');
      const applied = await call(desired, currentRevision);
      process.planRevision = string(applied.revision, 'DSH Plan revision');
      process.planMode = desired;
    }
  }

  async setModel(runtimeProcess: RuntimeProcess, model: string | undefined): Promise<void> {
    const process = dshProcess(runtimeProcess);
    await this.applyConfiguration(process, compileConfiguration(process.options, {
      model,
      permissionMode: process.configuration.productPermissionMode,
      reasoningEffort: process.configuration.reasoningEffort,
    }));
  }

  async setPermissionMode(runtimeProcess: RuntimeProcess, mode: string | undefined): Promise<void> {
    const process = dshProcess(runtimeProcess);
    const configuration = compileConfiguration(process.options, {
      model: process.configuration.profile.modelId,
      permissionMode: mode,
      reasoningEffort: process.configuration.reasoningEffort,
    });
    await this.applyConfiguration(process, configuration);
    await this.applyPlanMode(
      process,
      configuration.productPermissionMode === 'plan' ? 'plan' : 'normal',
    );
  }

  async setReasoningEffort(runtimeProcess: RuntimeProcess, effort: string | undefined): Promise<void> {
    const process = dshProcess(runtimeProcess);
    await this.applyConfiguration(process, compileConfiguration(process.options, {
      model: process.configuration.profile.modelId,
      permissionMode: process.configuration.productPermissionMode,
      reasoningEffort: effort,
    }));
  }
}
