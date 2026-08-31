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
  type RuntimeDiagnostics,
  type RuntimeDetection,
  type RuntimeExtensionApplyState,
  type RuntimeExtensionComponentStatus,
  type RuntimeExtensionDiagnostics,
  type RuntimeModelInfo,
  type RuntimePermissionRuleMutationResult,
  type RuntimePermissionRulesSnapshot,
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
import { DshCanonicalWebHost } from './canonical-web';
import { DSH_CANONICAL_WEB_ADAPTER_ID } from './canonical-web-provider';
import { DshRuntimeEventProjector } from './event-projector';
import {
  compileDshExtensionSnapshot,
  compileDshProductExtensionPlane,
  dshExtensionGenerationId,
  type DshCompiledExtensionPlane,
  type DshProductExtensionSource,
} from './extension-compiler';
import { executeDshProductHostTool, resolveDshMcpCredential } from './extension-host';
import { createDshInitializeParams } from './initialize';
import { resolveDshRuntimeInstallation } from './installation';
import { DshMutationController } from './mutations';
import {
  parseDshPermissionRuleMutation,
  parseDshPermissionRulesSnapshot,
  projectDshPermissionDiagnostics,
  validateDshPermissionIdentifier,
  validateDshPermissionTarget,
} from './permission-rules';
import {
  compileDshModelExecutionProfile,
  type DshModelExecutionProfile,
  type DshReasoningEffortSelection,
} from './profile-compiler';
import {
  DshRuntimeProcessHost,
  redactDshDiagnosticLine,
} from './process-host';
import {
  DSH_CANONICAL_WEB_POLICY_REF,
  type DshExecutionEnvironment,
  type DshHostRequestHandlers,
  type DshRpcObject,
  type DshRuntimeNotificationHandlers,
} from './protocol-types';

const OFFICIAL_INITIAL_PERMISSION_MODE = 'default';
const OFFICIAL_INTERACTION_REVISION = 'host-interaction-v1';
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

function extensionApplyState(value: unknown): RuntimeExtensionApplyState {
  if (value === 'applied') return 'applied';
  if (value === 'queued') return 'deferred_until_idle';
  if (value === 'restart_when_idle') return 'pending_next_start';
  return 'failed';
}

type DshExtensionComponentReceipt = Readonly<{
  key: string;
  state: string;
  reason?: string;
}>;

function extensionComponentReceipts(result: DshRpcObject): DshExtensionComponentReceipt[] {
  if (!Array.isArray(result.components)) return [];
  return result.components.map((raw) => {
    const component = object(raw, 'DSH extension component status');
    return {
      key: string(component.key, 'DSH extension component key'),
      state: string(component.state, 'DSH extension component state'),
      ...(typeof component.reason === 'string' ? { reason: component.reason } : {}),
    };
  });
}

function extensionComponentApplyState(value: string): RuntimeExtensionApplyState {
  if (value === 'ready') return 'applied';
  if (value === 'unsupported') return 'unsupported';
  if (value === 'degraded' || value === 'failed') return 'failed';
  return 'not_applicable';
}

function extensionStatus(
  plane: DshCompiledExtensionPlane,
  result: DshRpcObject,
  unchanged = false,
): RuntimeExtensionDiagnostics {
  const desiredRevision = string(result.desiredRevision, 'DSH desired extension revision');
  const effectiveWireRevision = string(result.effectiveRevision, 'DSH effective extension revision');
  const state = extensionApplyState(result.state);
  const components = plane.diagnostics.map((component): RuntimeExtensionComponentStatus => {
    if (state === 'deferred_until_idle' && component.state === 'applied') {
      return {
        ...component,
        state,
        code: 'dsh_extension_generation_queued',
      };
    }
    return { ...component };
  });
  for (const component of extensionComponentReceipts(result)) {
    if (component.state === 'ready' || component.state === 'disabled') continue;
    const key = component.key;
    const separator = key.indexOf(':');
    components.push({
      component: separator < 0 ? 'runtime' : key.slice(0, separator),
      ...(separator < 0 ? {} : { id: key.slice(separator + 1) }),
      state: extensionComponentApplyState(component.state),
      code: component.reason ?? `dsh_extension_component_${component.state}`,
    });
  }
  return {
    desiredRevision,
    effectiveRevision: effectiveWireRevision === 'none' ? null : effectiveWireRevision,
    state: unchanged && state === 'applied' ? 'unchanged' : state,
    components,
  };
}

function extensionDiagnostics(
  workspacePath: string,
  catalog: DshRpcObject,
  extensions: RuntimeExtensionDiagnostics,
  configuration?: DshConfiguration,
  permissionRules?: RuntimePermissionRulesSnapshot,
): RuntimeDiagnostics {
  const mcpServers = Array.isArray(catalog.mcpServers)
    ? catalog.mcpServers.map((entry) => {
        const server = object(entry, 'DSH extension MCP status');
        return {
          name: string(server.id, 'DSH extension MCP identity'),
          toolCount: 0,
          state: string(server.state, 'DSH extension MCP state'),
        };
      })
    : [];
  return {
    runtime: 'dsh',
    runtimeSource: 'integrated',
    effectiveEnv: { cwd: workspacePath },
    mcpServers,
    status: {
      auth: 'unsupported',
      features: 'unsupported',
      mcpServers: 'ok',
      apps: 'unsupported',
    },
    extensions,
    ...(configuration && permissionRules ? {
      permissions: projectDshPermissionDiagnostics(
        configuration.productPermissionMode,
        configuration.dshPermissionMode,
        permissionRules,
      ),
    } : {}),
    timestamp: new Date().toISOString(),
  };
}

type DshExtensionCatalogFacts = Readonly<{
  digest: string;
  loadedSkillNames: readonly string[];
  tools: readonly string[];
}>;

function extensionCatalogFacts(
  plane: DshCompiledExtensionPlane,
  catalog: DshRpcObject,
  result: DshRpcObject,
): DshExtensionCatalogFacts {
  const digest = string(catalog.digest, 'DSH extension catalog digest');
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('DSH effective extension catalog digest is invalid');
  }
  if (catalog.revision !== plane.snapshot.revision) {
    throw new Error('DSH effective extension catalog differs from Product extension intent');
  }
  const loadedSkillNames = Array.isArray(catalog.skills)
    ? catalog.skills.map((entry) => string(
        object(entry, 'DSH extension Skill').name,
        'DSH extension Skill name',
      ))
    : [];
  const omittedSkillNames = new Set(extensionComponentReceipts(result)
    .filter(component => component.state !== 'ready' && component.key.startsWith('skill:'))
    .map(component => component.key.slice('skill:'.length)));
  const expectedLoadedSkillNames = plane.expectedSkillNames
    .filter(name => !omittedSkillNames.has(name));
  if (
    new Set(loadedSkillNames).size !== loadedSkillNames.length
    || loadedSkillNames.length !== expectedLoadedSkillNames.length
    || expectedLoadedSkillNames.some(name => !loadedSkillNames.includes(name))
  ) {
    throw new Error('DSH effective Skill catalog differs from Product extension intent');
  }
  const tools = Array.isArray(catalog.tools)
    ? catalog.tools.filter((tool): tool is string => typeof tool === 'string')
    : [];
  const omittedHostToolNames = new Set(extensionComponentReceipts(result)
    .filter(component => component.state !== 'ready' && component.key.startsWith('host_tool:'))
    .map(component => component.key.slice('host_tool:'.length)));
  if (plane.hostToolBindings.some(binding => (
    !omittedHostToolNames.has(binding.publicToolName)
    && !tools.includes(binding.publicToolName)
  ))) {
    throw new Error('DSH effective Host tool catalog differs from Product extension intent');
  }
  return Object.freeze({
    digest,
    loadedSkillNames: Object.freeze(loadedSkillNames),
    tools: Object.freeze(tools),
  });
}

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
    network: { mode: 'host-policy', policyRef: DSH_CANONICAL_WEB_POLICY_REF },
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
  loadedSkillNames: readonly string[];
  activeOperationId: string | undefined;
  planRevision: string | undefined;
  planMode: 'normal' | 'plan' | undefined;
  configuration: DshConfiguration;
  readonly operationUserMessages = new Map<string, string>();
  readonly pendingInteractions: Map<string, PendingInteraction>;
  extensionDigest: string;
  tools: readonly string[];
  extensionPlane: DshCompiledExtensionPlane;
  extensionCatalog: DshRpcObject;
  extensionDiagnostics: RuntimeExtensionDiagnostics;
  permissionRules: RuntimePermissionRulesSnapshot | undefined;
  desiredExtensionPlane: DshCompiledExtensionPlane | undefined;
  private resourcesClosed = false;
  private extensionSerial: Promise<void> = Promise.resolve();
  private readonly extensionPlanes = new Map<string, DshCompiledExtensionPlane>();

  constructor(
    readonly host: DshRuntimeProcessHost,
    readonly projector: DshRuntimeEventProjector,
    readonly attachments: DshAttachmentRegistry,
    readonly options: SessionStartOptions,
    readonly onEvent: UnifiedEventCallback,
    readonly executionEnvironment: DshExecutionEnvironment,
    configuration: DshConfiguration,
    readonly runtimeSessionId: string,
    extensionDigest: string,
    tools: readonly string[],
    readonly productTranscriptChangedAtStartup: boolean,
    loadedSkillNames: readonly string[],
    extensionPlane: DshCompiledExtensionPlane,
    extensionCatalog: DshRpcObject,
    extensionDiagnostics: RuntimeExtensionDiagnostics,
    activeTurn?: DshUnsettledTurn,
    pendingInteractions?: Map<string, PendingInteraction>,
  ) {
    this.configuration = configuration;
    this.extensionDigest = extensionDigest;
    this.tools = Object.freeze([...tools]);
    this.extensionPlane = extensionPlane;
    this.extensionCatalog = extensionCatalog;
    this.extensionDiagnostics = extensionDiagnostics;
    this.loadedSkillNames = Object.freeze([...loadedSkillNames]);
    this.extensionPlanes.set(dshExtensionGenerationId(extensionPlane), extensionPlane);
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
    this.closeOwnedResources('host_kill');
    void this.host.stop('host_kill');
  }

  waitForExit(): Promise<number> {
    return this.host.waitForExit().finally(() => this.closeOwnedResources('runtime_exit'));
  }

  closeOwnedResources(reason: string): void {
    if (this.resourcesClosed) return;
    this.resourcesClosed = true;
    this.attachments.close();
    const dispatchers = new Set(
      [...this.extensionPlanes.values()]
        .map(plane => plane.hostToolDispatcher)
        .filter((dispatcher): dispatcher is NonNullable<typeof dispatcher> => Boolean(dispatcher)),
    );
    this.extensionPlanes.clear();
    this.desiredExtensionPlane = undefined;
    for (const dispatcher of dispatchers) dispatcher.dispose(reason);
  }

  planeForGeneration(generationId: string | undefined): DshCompiledExtensionPlane | undefined {
    return generationId ? this.extensionPlanes.get(generationId) : undefined;
  }

  registerExtensionPlane(plane: DshCompiledExtensionPlane): boolean {
    if (this.resourcesClosed) throw new Error('DSH extension owner is closed');
    const generationId = dshExtensionGenerationId(plane);
    if (this.extensionPlanes.has(generationId)) return false;
    this.extensionPlanes.set(generationId, plane);
    return true;
  }

  releaseExtensionPlane(plane: DshCompiledExtensionPlane, reason: string): void {
    const generationId = dshExtensionGenerationId(plane);
    if (this.extensionPlanes.get(generationId) !== plane) return;
    this.extensionPlanes.delete(generationId);
    const dispatcher = plane.hostToolDispatcher;
    if (
      dispatcher
      && ![...this.extensionPlanes.values()].some(candidate => candidate.hostToolDispatcher === dispatcher)
    ) {
      dispatcher.dispose(reason);
    }
  }

  serializeExtensionUpdate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.extensionSerial.then(operation);
    this.extensionSerial = result.then(() => undefined, () => undefined);
    return result;
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
    const configuration = compileConfiguration(options);
    const initialize = createDshInitializeParams({
      productSessionId: options.sessionId,
      productVersion: packageJson.version,
      runtimeHome: roots.runtimeHome,
      workspace: { path: workspacePath, identity: workspaceIdentity },
      executionEnvironment: environmentWithoutDigest,
      interaction: scenarioCapability(options),
      webSearchAdapters: [DSH_CANONICAL_WEB_ADAPTER_ID],
    });
    const extensionPlane: DshCompiledExtensionPlane = options.dshExtensions
      ? compileDshProductExtensionPlane(options.dshExtensions)
      : Object.freeze({
          snapshot: compileDshExtensionSnapshot(),
          credentialBindings: Object.freeze([]),
          hostToolBindings: Object.freeze([]),
          expectedSkillNames: Object.freeze([]),
          diagnostics: Object.freeze([]),
        } satisfies DshCompiledExtensionPlane);
    const extension = extensionPlane.snapshot;
    const initialExtensionGenerationId = dshExtensionGenerationId(extensionPlane);
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
    const canonicalWeb = new DshCanonicalWebHost({
      activeConfiguration: () => processValue?.configuration ?? configuration,
      runtimeSessionId: () => processValue?.runtimeSessionId,
    });
    const extensionPlaneForHostRequest = (params: DshRpcObject): DshCompiledExtensionPlane | undefined => {
      const authority = params.authority && typeof params.authority === 'object'
        && !Array.isArray(params.authority)
        ? params.authority as DshRpcObject
        : undefined;
      const generationId = typeof authority?.componentGenerationId === 'string'
        ? authority.componentGenerationId
        : undefined;
      if (processValue) return processValue.planeForGeneration(generationId);
      return generationId === initialExtensionGenerationId ? extensionPlane : undefined;
    };

    const hostHandlers: DshHostRequestHandlers = Object.freeze({
      'host/credential/resolve': (params) => {
        if (params.subject === 'mcp') {
          const plane = extensionPlaneForHostRequest(params);
          if (!plane) {
            return {
              kind: 'availability',
              available: false,
              authoritativeCredentialRevision: typeof params.credentialRevision === 'string'
                ? params.credentialRevision
                : 'invalid-credential-revision',
              reasonCode: 'mcp_credential_authority_mismatch',
            };
          }
          return resolveDshMcpCredential({
            plane,
            extensionDigest: plane.snapshot.digest,
            params,
          });
        }
        if (params.subject !== 'provider') {
          return {
            kind: 'availability',
            available: false,
            authoritativeCredentialRevision: 'unsupported-credential-subject',
            reasonCode: 'credential_subject_unavailable',
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
      'host/tool/execute': (params, context) => canonicalWeb.handles(params)
        ? canonicalWeb.execute(params, context)
        : (() => {
            const plane = extensionPlaneForHostRequest(params);
            return plane
              ? executeDshProductHostTool({
                  plane,
                  attachments,
                  runtimeSessionId: processValue?.runtimeSessionId,
                  params,
                  context,
                })
              : Promise.resolve({ state: 'failed', code: 'host_tool_authority_mismatch' });
          })(),
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
      const componentReceipts = extensionComponentReceipts(extensionResult);
      const componentIssues = componentReceipts.filter(component => (
        component.state !== 'ready' && component.state !== 'disabled'
      ));
      const extensionReceipt = {
        state: extensionResult.state,
        desiredRevision: extensionResult.desiredRevision,
        effectiveRevision: extensionResult.effectiveRevision,
        componentCount: componentReceipts.length,
        issues: componentIssues,
      };
      console.log(`[dsh-extension] initial replace receipt=${JSON.stringify(extensionReceipt)}`);
      for (const issue of componentIssues) {
        console.warn(
          `[dsh-extension] component isolated key=${issue.key} state=${issue.state} reason=${issue.reason ?? 'none'}`,
        );
      }
      if (extensionResult.state !== 'applied'
        || extensionResult.effectiveRevision !== extension.revision) {
        throw new Error(
          `DSH extension snapshot did not become effective before Session binding: ${JSON.stringify(extensionReceipt)}`,
        );
      }
      const extensionCatalog = await host.request('extension/catalog', {});
      const extensionFacts = extensionCatalogFacts(extensionPlane, extensionCatalog, extensionResult);
      const extensionDigest = extensionFacts.digest;
      const loadedSkillNames = extensionFacts.loadedSkillNames;
      const admittedExtensionStatus = extensionStatus(extensionPlane, extensionResult);
      for (const issue of admittedExtensionStatus.components) {
        if (issue.state !== 'failed' && issue.state !== 'unsupported') continue;
        console.warn(
          `[dsh-extension] product diagnostic component=${issue.component} id=${issue.id ?? 'none'} state=${issue.state} code=${issue.code}`,
        );
      }

      const bindingPermissionMode = options.resumeSessionId
        ? configuration.dshPermissionMode
        : OFFICIAL_INITIAL_PERMISSION_MODE;
      const bindingConfigRevision = options.resumeSessionId
        ? configuration.revision
        : `myagents-dsh-binding-v1:${hash(
            configuration.profile.revision,
            bindingPermissionMode,
            OFFICIAL_INTERACTION_REVISION,
            options.systemPromptAppend ?? '',
          )}`;
      const bindingParams: DshRpcObject = {
        clientOperationId: `session-bind-${randomUUID()}`,
        persistenceRef: `product-session-${hash(options.sessionId)}`,
        provider: configuration.profile as unknown as DshRpcObject,
        configRevision: bindingConfigRevision,
        extensionDigest,
        systemPrompt: options.systemPromptAppend ?? '',
        permissionMode: bindingPermissionMode,
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
        loadedSkillNames,
        extensionPlane,
        extensionCatalog,
        admittedExtensionStatus,
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
        kind: 'runtime_diagnostics',
        diagnostics: extensionDiagnostics(
          workspacePath,
          extensionCatalog,
          admittedExtensionStatus,
          processValue.configuration,
          processValue.permissionRules,
        ),
      });
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
          options.initialTurn.clientOperationId,
        );
      }
      return processValue;
    } catch (error) {
      attachments.close();
      extensionPlane.hostToolDispatcher?.dispose('session_admission_failed');
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
    requestedClientOperationId?: string,
  ): Promise<void> {
    if (process.activeOperationId) throw new Error('DSH already owns an active root turn');
    if (process.desiredExtensionPlane) {
      const reconciled = await this.reconcileDshExtensions(process);
      if (reconciled?.state !== 'applied' && reconciled?.state !== 'unchanged') {
        throw new Error('DSH extension generation is not effective at the root-turn boundary');
      }
    }
    const clientOperationId = requestedClientOperationId ?? `turn-${randomUUID()}`;
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
    options?: { clientUserMessageId?: string; clientOperationId?: string },
  ): Promise<void> {
    await this.startTurn(
      dshProcess(runtimeProcess),
      message,
      images,
      options?.clientUserMessageId ?? `user-${randomUUID()}`,
      options?.clientOperationId,
    );
  }

  private emitExtensionDiagnostics(process: DshProcess): void {
    process.onEvent({
      kind: 'runtime_diagnostics',
      diagnostics: extensionDiagnostics(
        process.executionEnvironment.workspace.canonicalRoot,
        process.extensionCatalog,
        process.extensionDiagnostics,
        process.configuration,
        process.permissionRules,
      ),
    });
  }

  private async refreshPermissionRules(
    process: DshProcess,
    emitDiagnostics = true,
  ): Promise<RuntimePermissionRulesSnapshot> {
    const snapshot = parseDshPermissionRulesSnapshot(
      await process.host.request('permission/rules/list', {}),
    );
    process.permissionRules = snapshot;
    if (emitDiagnostics) this.emitExtensionDiagnostics(process);
    return snapshot;
  }

  async listPermissionRules(
    runtimeProcess: RuntimeProcess,
  ): Promise<RuntimePermissionRulesSnapshot> {
    return this.refreshPermissionRules(dshProcess(runtimeProcess));
  }

  async addPermissionRule(
    runtimeProcess: RuntimeProcess,
    input: Readonly<{
      expectedRevision: string;
      tool: string;
      permissionClass: string;
      target: string;
    }>,
  ): Promise<RuntimePermissionRuleMutationResult> {
    const process = dshProcess(runtimeProcess);
    if (process.activeOperationId) {
      throw new Error('DSH permission rules can change only while the root turn is idle');
    }
    const result = parseDshPermissionRuleMutation(await process.host.request(
      'permission/rules/add',
      {
        expectedRevision: validateDshPermissionIdentifier(
          input.expectedRevision,
          'DSH expected permission revision',
        ),
        tool: validateDshPermissionIdentifier(input.tool, 'DSH permission rule tool'),
        permissionClass: validateDshPermissionIdentifier(
          input.permissionClass,
          'DSH permission rule class',
        ),
        target: validateDshPermissionTarget(input.target),
      },
    ));
    const snapshot = await this.refreshPermissionRules(process);
    if (snapshot.revision !== result.revision) {
      throw new Error('DSH permission mutation read-back revision differs from the result');
    }
    return result;
  }

  async revokePermissionRule(
    runtimeProcess: RuntimeProcess,
    input: Readonly<{ expectedRevision: string; ruleId: string }>,
  ): Promise<RuntimePermissionRuleMutationResult> {
    const process = dshProcess(runtimeProcess);
    if (process.activeOperationId) {
      throw new Error('DSH permission rules can change only while the root turn is idle');
    }
    const result = parseDshPermissionRuleMutation(await process.host.request(
      'permission/rules/revoke',
      {
        expectedRevision: validateDshPermissionIdentifier(
          input.expectedRevision,
          'DSH expected permission revision',
        ),
        ruleId: validateDshPermissionIdentifier(input.ruleId, 'DSH permission rule id'),
      },
    ));
    const snapshot = await this.refreshPermissionRules(process);
    if (snapshot.revision !== result.revision) {
      throw new Error('DSH permission mutation read-back revision differs from the result');
    }
    return result;
  }

  private async commitEffectiveExtension(
    process: DshProcess,
    plane: DshCompiledExtensionPlane,
    status: RuntimeExtensionDiagnostics,
    result: DshRpcObject,
  ): Promise<RuntimeExtensionDiagnostics> {
    const catalog = await process.host.request('extension/catalog', {});
    const facts = extensionCatalogFacts(plane, catalog, result);
    process.extensionPlane = plane;
    process.extensionCatalog = catalog;
    process.extensionDigest = facts.digest;
    process.loadedSkillNames = facts.loadedSkillNames;
    process.tools = facts.tools;
    process.extensionDiagnostics = status;
    process.desiredExtensionPlane = undefined;
    // DSH may retain an old component generation for background children
    // after the root operation reaches the replacement boundary. Protocol
    // 2.0.0 carries that generation on reverse requests but exposes no Host
    // retirement acknowledgement, so every once-effective Host plane remains
    // routable until this process generation closes.
    process.onEvent({ kind: 'runtime_tool_catalog', tools: [...facts.tools] });
    this.emitExtensionDiagnostics(process);
    return status;
  }

  private async settleExtensionApply(
    process: DshProcess,
    plane: DshCompiledExtensionPlane,
    result: DshRpcObject,
    unchanged = false,
  ): Promise<RuntimeExtensionDiagnostics> {
    if (result.desiredRevision !== plane.snapshot.revision) {
      throw new Error('DSH desired extension revision differs from Product intent');
    }
    const status = extensionStatus(plane, result, unchanged);
    for (const issue of extensionComponentReceipts(result)) {
      if (issue.state === 'ready' || issue.state === 'disabled') continue;
      console.warn(
        `[dsh-extension] component isolated key=${issue.key} state=${issue.state} reason=${issue.reason ?? 'none'}`,
      );
    }
    if (status.state === 'applied' || status.state === 'unchanged') {
      if (result.effectiveRevision !== plane.snapshot.revision) {
        throw new Error('DSH applied a different extension revision');
      }
      return this.commitEffectiveExtension(process, plane, status, result);
    }
    process.extensionDiagnostics = status;
    if (status.state === 'failed') {
      process.desiredExtensionPlane = undefined;
      if (plane !== process.extensionPlane) {
        process.releaseExtensionPlane(plane, 'dsh_extension_generation_failed');
      }
    } else {
      process.desiredExtensionPlane = plane;
    }
    this.emitExtensionDiagnostics(process);
    return status;
  }

  async replaceDshExtensions(
    runtimeProcess: RuntimeProcess,
    source: DshProductExtensionSource,
  ): Promise<RuntimeExtensionDiagnostics> {
    const process = dshProcess(runtimeProcess);
    return process.serializeExtensionUpdate(async () => {
      let plane: DshCompiledExtensionPlane;
      try {
        plane = compileDshProductExtensionPlane(source);
      } catch (error) {
        source.hostToolDispatcher?.dispose('dsh_extension_compilation_failed');
        throw error;
      }
      const existing = process.planeForGeneration(dshExtensionGenerationId(plane));
      if (existing === process.desiredExtensionPlane) {
        plane.hostToolDispatcher?.dispose('dsh_extension_generation_unchanged');
        return process.extensionDiagnostics;
      }
      if (existing === process.extensionPlane && !process.desiredExtensionPlane) {
        plane.hostToolDispatcher?.dispose('dsh_extension_generation_unchanged');
        const unchanged = {
          ...process.extensionDiagnostics,
          desiredRevision: process.extensionPlane.snapshot.revision,
          effectiveRevision: process.extensionPlane.snapshot.revision,
          state: 'unchanged' as const,
        };
        process.extensionDiagnostics = unchanged;
        this.emitExtensionDiagnostics(process);
        return unchanged;
      }
      if (existing) {
        plane.hostToolDispatcher?.dispose('dsh_extension_generation_reused');
        plane = existing;
      } else {
        process.registerExtensionPlane(plane);
      }
      const previousDesired = process.desiredExtensionPlane;
      process.desiredExtensionPlane = plane;
      // On an ambiguous transport failure the Runtime may already own this
      // candidate and can still issue generation-fenced credential requests;
      // therefore the registered plane remains owned until reconciliation or
      // process teardown.
      const result = await process.host.request(
        'extension/replace',
        plane.snapshot as unknown as DshRpcObject,
      );
      if (previousDesired && previousDesired !== plane && previousDesired !== process.extensionPlane) {
        process.releaseExtensionPlane(previousDesired, 'dsh_extension_candidate_replaced');
      }
      return this.settleExtensionApply(process, plane, result);
    });
  }

  async reconcileDshExtensions(
    runtimeProcess: RuntimeProcess,
  ): Promise<RuntimeExtensionDiagnostics | null> {
    const process = dshProcess(runtimeProcess);
    return process.serializeExtensionUpdate(async () => {
      const plane = process.desiredExtensionPlane;
      if (!plane) return null;
      const result = await process.host.request('extension/status', {});
      return this.settleExtensionApply(process, plane, result);
    });
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
    if (result.state === 'expired') {
      throw new Error('DSH interaction expired before the response was applied');
    }
    if (result.state !== 'applied' && result.state !== 'already_settled') {
      throw new Error('DSH interaction response returned an invalid state');
    }
    if (!question && decision === 'always_allow') {
      const snapshot = await this.refreshPermissionRules(process);
      if (
        result.state === 'applied'
        && snapshot.revision !== string(
          result.effectivePolicyRevision,
          'DSH applied permission policy revision',
        )
      ) {
        throw new Error('DSH always-allow read-back revision differs from the response');
      }
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
      process.closeOwnedResources('host_shutdown');
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
    const permissionRules = await this.refreshPermissionRules(process, false);
    if (permissionRules.permissionMode !== configuration.dshPermissionMode) {
      throw new Error('DSH effective permission mode differs from Product configuration');
    }
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
    this.emitExtensionDiagnostics(process);
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
