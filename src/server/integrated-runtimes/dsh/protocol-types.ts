import candidateProfileJson from "../../../../contracts/myagents-dsh/batch-1-candidate-profile-v1.json";
import protocolMetaJson from "../../../../contracts/myagents-dsh/protocol-meta.json";
import dshLock from "../../../shared/integrated-runtimes/effective-dsh-lock";

export const DSH_CANONICAL_WEB_POLICY_REF = "deepseek-official-web-search-v1" as const;

export {
  HOST_METHOD_NAMES as DSH_HOST_METHOD_NAMES,
  CLIENT_METHOD_BY_PROTOCOL as DSH_CLIENT_METHOD_BY_PROTOCOL,
  REVERSE_METHOD_NAMES as DSH_REVERSE_METHOD_NAMES,
  NOTIFICATION_NAMES as DSH_NOTIFICATION_NAMES,
  RUNTIME_NOTIFICATION_NAMES as DSH_RUNTIME_NOTIFICATION_NAMES,
} from '../../../../contracts/myagents-dsh/public-contract.generated';
import {
  GENERATED_PROTOCOL_VERSION, HOST_METHOD_NAMES, CLIENT_METHOD_BY_PROTOCOL, REVERSE_METHOD_NAMES, RUNTIME_NOTIFICATION_NAMES, NOTIFICATION_NAMES,
  type MethodParams, type MethodResult, type PublicHostClient,
} from '../../../../contracts/myagents-dsh/public-contract.generated';
export type { MethodParams, MethodResult } from '../../../../contracts/myagents-dsh/public-contract.generated';
export type DshHostMethodName = typeof HOST_METHOD_NAMES[number];
export type DshGeneratedClientMethodName = typeof CLIENT_METHOD_BY_PROTOCOL[DshHostMethodName];
export type DshReverseMethodName = typeof REVERSE_METHOD_NAMES[number];
export type DshRuntimeNotificationName = typeof RUNTIME_NOTIFICATION_NAMES[number];

export type DshRpcObject = Record<string, unknown>;

export type DshProtocolLimits = MethodParams<'initialize'>['limits'];
export type DshExecutionEnvironment = MethodParams<'initialize'>['executionEnvironment'];
export type DshInitializeParams = MethodParams<'initialize'>;
export type DshInitializeResult = MethodResult<'initialize'>;
export type DshRuntimeStatus = MethodResult<'runtime/status'>;

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

export type DshJsonRpcPeer = Readonly<{
  role: "host";
  updateLimits: (limits: DshProtocolLimits) => void;
  flush: () => Promise<void>;
  close: (reason?: Error) => void;
}>;

export type DshGeneratedHostClient = Readonly<PublicHostClient & {
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
  const sourceSnapshot = !("release" in dshLock);
  if (
    GENERATED_PROTOCOL_VERSION !== protocolMetaJson.protocolVersion ||
    protocolMetaJson.protocolVersion !== dshLock.protocol.version ||
    (sourceSnapshot && (
      protocolMetaJson.schemaSha256 !== dshLock.protocol.schemaSha256 ||
      protocolMetaJson.sessionFormat !== dshLock.runtime.sessionFormat ||
      protocolMetaJson.hostMethods.length !== dshLock.protocol.hostMethodCount ||
      protocolMetaJson.reverseMethods.length !== dshLock.protocol.reverseMethodCount ||
      protocolMetaJson.notifications.length !== dshLock.protocol.notificationCount
    ))
  ) {
    throw new Error("DSH protocol metadata differs from the selected lock");
  }
  if (
    !equalSet(protocolMetaJson.hostMethods, HOST_METHOD_NAMES) ||
    !equalSet(protocolMetaJson.reverseMethods, REVERSE_METHOD_NAMES) ||
    !equalSet(protocolMetaJson.notifications, NOTIFICATION_NAMES) ||
    !equalSet(
      candidateProfileJson.protocol.availableHostMethods,
      HOST_METHOD_NAMES,
    ) ||
    !equalSet(
      candidateProfileJson.protocol.availableReverseMethods,
      REVERSE_METHOD_NAMES,
    ) ||
    !equalSet(
      candidateProfileJson.protocol.availableNotifications,
      NOTIFICATION_NAMES,
    )
  ) {
    throw new Error("DSH generated client surface differs from the candidate");
  }
}

assertDshProtocolContract();

export const DSH_GENERATED_CAPABILITY_PROFILE_DIGEST =
  protocolMetaJson.capabilityProfileDigest;
