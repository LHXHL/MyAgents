import candidateProfileJson from "../../../../contracts/myagents-dsh/batch-1-candidate-profile-v1.json";
import protocolMetaJson from "../../../../contracts/myagents-dsh/protocol-meta.json";
import dshLock from "../../../shared/integrated-runtimes/dsh-lock.json";

export const DSH_HOST_METHOD_NAMES = [
  "initialize",
  "runtime/status",
  "runtime/shutdown",
  "session/create",
  "session/resume",
  "session/read",
  "session/close",
  "session/compact",
  "session/delete/prepare",
  "session/delete/commit",
  "session/delete/purge",
  "session/delete/rollback",
  "session/delete/status",
  "session/fork/prepare",
  "session/fork/commit",
  "session/fork/abort",
  "session/fork/status",
  "session/rewind/prepare",
  "session/rewind/commit",
  "session/rewind/rollback",
  "session/rewind/status",
  "turn/start",
  "turn/get",
  "turn/steer",
  "turn/followUp",
  "turn/message/cancel",
  "turn/interrupt",
  "command/invoke",
  "config/apply",
  "plan/apply",
  "permission/rules/list",
  "permission/rules/add",
  "permission/rules/revoke",
  "credential/reconcile",
  "extension/replace",
  "extension/status",
  "extension/catalog",
  "extension/reload",
  "interaction/respond",
  "utility/run",
] as const;

export type DshHostMethodName = (typeof DSH_HOST_METHOD_NAMES)[number];

export const DSH_CLIENT_METHOD_BY_PROTOCOL = {
  initialize: "initialize",
  "runtime/status": "runtimeStatus",
  "runtime/shutdown": "runtimeShutdown",
  "session/create": "sessionCreate",
  "session/resume": "sessionResume",
  "session/read": "sessionRead",
  "session/close": "sessionClose",
  "session/compact": "sessionCompact",
  "session/delete/prepare": "sessionDeletePrepare",
  "session/delete/commit": "sessionDeleteCommit",
  "session/delete/purge": "sessionDeletePurge",
  "session/delete/rollback": "sessionDeleteRollback",
  "session/delete/status": "sessionDeleteStatus",
  "session/fork/prepare": "sessionForkPrepare",
  "session/fork/commit": "sessionForkCommit",
  "session/fork/abort": "sessionForkAbort",
  "session/fork/status": "sessionForkStatus",
  "session/rewind/prepare": "sessionRewindPrepare",
  "session/rewind/commit": "sessionRewindCommit",
  "session/rewind/rollback": "sessionRewindRollback",
  "session/rewind/status": "sessionRewindStatus",
  "turn/start": "turnStart",
  "turn/get": "turnGet",
  "turn/steer": "turnSteer",
  "turn/followUp": "turnFollowUp",
  "turn/message/cancel": "turnMessageCancel",
  "turn/interrupt": "turnInterrupt",
  "command/invoke": "commandInvoke",
  "config/apply": "configApply",
  "plan/apply": "planApply",
  "permission/rules/list": "permissionRulesList",
  "permission/rules/add": "permissionRulesAdd",
  "permission/rules/revoke": "permissionRulesRevoke",
  "credential/reconcile": "credentialReconcile",
  "extension/replace": "extensionReplace",
  "extension/status": "extensionStatus",
  "extension/catalog": "extensionCatalog",
  "extension/reload": "extensionReload",
  "interaction/respond": "interactionRespond",
  "utility/run": "utilityRun",
} as const satisfies Record<DshHostMethodName, string>;

export type DshGeneratedClientMethodName =
  (typeof DSH_CLIENT_METHOD_BY_PROTOCOL)[DshHostMethodName];

export const DSH_REVERSE_METHOD_NAMES = [
  "host/credential/resolve",
  "host/interaction/request",
  "host/tool/execute",
  "host/hook/execute",
  "host/attachment/put",
  "host/attachment/acquire",
  "host/attachment/release",
] as const;

export type DshReverseMethodName = (typeof DSH_REVERSE_METHOD_NAMES)[number];

export const DSH_NOTIFICATION_NAMES = [
  "initialized",
  "rpc/cancel",
  "runtime/event",
  "host/interaction/cancel",
] as const;

export const DSH_RUNTIME_NOTIFICATION_NAMES = [
  "runtime/event",
  "host/interaction/cancel",
] as const;

export type DshRuntimeNotificationName =
  (typeof DSH_RUNTIME_NOTIFICATION_NAMES)[number];

export type DshRpcObject = Record<string, unknown>;

export type DshProtocolLimits = Readonly<{
  maxFrameBytes: number;
  maxPendingRequests: number;
  maxConcurrentReverseRequests: number;
  maxAttachmentLeases: number;
  eventQueueHighWatermark: number;
}>;

export type DshExecutionEnvironment = Readonly<{
  revision: string;
  digest: string;
  workspace: Readonly<{
    identity: string;
    canonicalRoot: string;
    allowedReadRoots: readonly string[];
    allowedWriteRoots: readonly string[];
  }>;
  executables: Readonly<{
    bundledNodeRef: string;
    bashRef: string;
    ripgrepRef: string;
    bashDialect: "bash";
    allowedCommandRefs: readonly string[];
    pathPolicy: "sealed";
    windowsPowerShellRef?: string;
    windowsUtf8PreludeRef?: string;
  }>;
  environment: Readonly<{
    allowedKeys: readonly string[];
    inheritedKeys: readonly string[];
    secretValues: "reverse-port-only";
  }>;
  network:
    | Readonly<{ mode: "deny" }>
    | Readonly<{ mode: "host-policy"; policyRef: string }>;
  process: Readonly<{
    backgroundRetention: "allow" | "deny";
    maxChildren: number;
    killTreeOnAbort: true;
  }>;
  checkpoint: Readonly<{
    mode: "managed-file-tools";
    version: 1;
    policyRevision: string;
    trackedTools: readonly ["Write", "Edit"];
    tracksShell: false;
    tracksChildAgents: false;
    tracksExternalChanges: false;
  }>;
  attachmentStagingRoot: string;
  planDirectory?: string;
}>;

export type DshInitializeParams = Readonly<{
  protocol: Readonly<{ minVersion: "2.1.0"; maxVersion: "2.1.0" }>;
  host: Readonly<{
    name: string;
    version: string;
    platform: string;
    arch: string;
    nodeVersion: string;
  }>;
  productSessionId: string;
  runtimeHome: string;
  workspace: Readonly<{ path: string; identity: string }>;
  executionEnvironment: DshExecutionEnvironment;
  hostCapabilities: Readonly<{
    interaction: "interactive" | "deterministic-headless" | "unavailable";
    attachments: "generation-leases-v1";
    productProjection: "transactional-postconditions-v1";
    credentialAuthority: "revisioned-reverse-port-v1";
    webSearchAdapters: readonly string[];
  }>;
  limits: DshProtocolLimits;
}>;

export type DshInitializeResult = Readonly<{
  protocolVersion: "2.1.0";
  schemaSha256: string;
  runtimeVersion: string;
  runtimeGeneration: string;
  sessionFormat: string;
  profileDigest: string;
  limits: DshProtocolLimits;
  runtimeEngine: Readonly<{
    name: string;
    version: string;
    distribution: string;
    distributionVersion: string;
    buildRevision?: string;
  }>;
  runtimeCapabilities: DshRpcObject;
}>;

export type DshRuntimeStatus = DshRpcObject &
  Readonly<{
    runtimeGeneration: string;
    initialized: boolean;
    primarySessionState: string;
  }>;

export type DshRequestContext = Readonly<{
  requestId: string | number;
  signal: AbortSignal;
  commit: () => void;
  afterResponse: (callback: () => void) => void;
}>;

export type DshHostRequestHandler = (
  params: DshRpcObject,
  context: DshRequestContext,
) => Promise<DshRpcObject> | DshRpcObject;

export type DshHostRequestHandlers = Readonly<
  Record<DshReverseMethodName, DshHostRequestHandler>
>;

export type DshRuntimeNotificationHandlers = Readonly<
  Record<
    DshRuntimeNotificationName,
    (params: DshRpcObject) => Promise<void> | void
  >
>;

type DshGeneratedClientCall = (
  params: DshRpcObject,
  options?: { signal?: AbortSignal },
) => Promise<DshRpcObject>;

export type DshJsonRpcPeer = Readonly<{
  role: "host";
  updateLimits: (limits: DshProtocolLimits) => void;
  flush: () => Promise<void>;
  close: (reason?: Error) => void;
}>;

export type DshGeneratedHostClient = Readonly<
  Record<
    Exclude<DshGeneratedClientMethodName, "initialize">,
    DshGeneratedClientCall
  > & {
    peer: DshJsonRpcPeer;
    initialize: (
      params: DshInitializeParams,
      options?: { signal?: AbortSignal },
    ) => Promise<DshInitializeResult>;
    initialized: (params?: DshRpcObject) => Promise<void>;
    registerHostHandlers: (handlers: DshHostRequestHandlers) => () => void;
    registerRuntimeNotificationHandlers: (
      handlers: DshRuntimeNotificationHandlers,
    ) => () => void;
  }
>;

export type DshProtocolErrorConstructor = new (
  code: string,
  message: string,
  retryable?: boolean,
) => Error;

function equalSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === right.length &&
    right.every((entry) => left.includes(entry))
  );
}

export function assertDshProtocolContract(): void {
  if (
    protocolMetaJson.protocolVersion !== dshLock.protocol.version ||
    protocolMetaJson.schemaSha256 !== dshLock.protocol.schemaSha256 ||
    protocolMetaJson.sessionFormat !== dshLock.runtime.sessionFormat ||
    protocolMetaJson.hostMethods.length !== dshLock.protocol.hostMethodCount ||
    protocolMetaJson.reverseMethods.length !==
      dshLock.protocol.reverseMethodCount ||
    protocolMetaJson.notifications.length !== dshLock.protocol.notificationCount
  ) {
    throw new Error("DSH protocol metadata differs from the committed lock");
  }
  if (
    !equalSet(protocolMetaJson.hostMethods, DSH_HOST_METHOD_NAMES) ||
    !equalSet(protocolMetaJson.reverseMethods, DSH_REVERSE_METHOD_NAMES) ||
    !equalSet(protocolMetaJson.notifications, DSH_NOTIFICATION_NAMES) ||
    !equalSet(
      candidateProfileJson.protocol.availableHostMethods,
      DSH_HOST_METHOD_NAMES,
    ) ||
    !equalSet(
      candidateProfileJson.protocol.availableReverseMethods,
      DSH_REVERSE_METHOD_NAMES,
    ) ||
    !equalSet(
      candidateProfileJson.protocol.availableNotifications,
      DSH_NOTIFICATION_NAMES,
    )
  ) {
    throw new Error("DSH generated client surface differs from the candidate");
  }
}

assertDshProtocolContract();

export const DSH_GENERATED_CAPABILITY_PROFILE_DIGEST =
  protocolMetaJson.capabilityProfileDigest;
