import {
  createClaudeSdkBinding,
  createDshBinding,
  createManagedCodexBinding,
  resolveAgentRuntimePreference,
  type AgentRuntimePreference,
  type EffectiveRuntimeBinding,
  type ExternalRuntimeId,
  type IntegratedRuntimeId,
} from "./identity";
import {
  isRuntimeSelectorAvailable,
  resolveDefaultIntegratedRuntime,
  type AgentRuntimeDistributionPolicy,
} from "./distribution-policy";
import type { ProviderExecutionConstraint } from "./provider-constraints";

export type {
  ApiFamily,
  DshApiFamily,
  ProviderExecutionConstraint,
} from "./provider-constraints";

export type RuntimeReadiness =
  | { state: "ready"; implementationVersion?: string }
  | { state: "unverified-dev-runtime"; implementationVersion?: string }
  | {
      state: "unavailable";
      reason:
        | "not-distributed"
        | "artifact-missing"
        | "platform-unverified"
        | "protocol-mismatch"
        | "provider-incompatible";
    };

export interface RuntimeReadinessCatalog {
  integrated: Record<IntegratedRuntimeId, RuntimeReadiness>;
  external: Record<ExternalRuntimeId, RuntimeReadiness>;
  managedCodex: RuntimeReadiness;
  platformTarget: string;
}

export type RuntimeResolutionFailureCode =
  | "runtime-not-allowed"
  | "runtime-not-ready"
  | "provider-runtime-not-ready"
  | "runtime-preference-invalid";

export type RuntimeResolutionResult =
  | {
      status: "resolved";
      binding: EffectiveRuntimeBinding;
      decision:
        | "existing-session"
        | "explicit-external"
        | "provider-required-integrated"
        | "provider-required-managed"
        | "selected-integrated"
        | "distribution-default";
      readiness: RuntimeReadiness["state"];
    }
  | {
      status: "failed";
      code: RuntimeResolutionFailureCode;
      runtimeKey: string;
      message: string;
    };

export interface RuntimeResolutionInput {
  policy: AgentRuntimeDistributionPolicy;
  labsEnabled: boolean;
  configuredDefaultIntegratedRuntime?: unknown;
  agentPreference?: AgentRuntimePreference | unknown;
  legacyAgentRuntime?: string | null;
  legacyAgentRuntimeSource?: string | null;
  legacyAgentProviderId?: string | null;
  providerConstraint: ProviderExecutionConstraint;
  readiness: RuntimeReadinessCatalog;
  existingBinding?: EffectiveRuntimeBinding;
  allowUnverifiedDevRuntime?: boolean;
}

function readinessAdmits(
  readiness: RuntimeReadiness,
  allowUnverifiedDevRuntime: boolean,
): boolean {
  return (
    readiness.state === "ready" ||
    (readiness.state === "unverified-dev-runtime" && allowUnverifiedDevRuntime)
  );
}

function failedReadiness(
  code: RuntimeResolutionFailureCode,
  runtimeKey: string,
  readiness: RuntimeReadiness,
): RuntimeResolutionResult {
  const reason = readiness.state === "unavailable" ? readiness.reason : readiness.state;
  return {
    status: "failed",
    code,
    runtimeKey,
    message: `${runtimeKey} is not ready: ${reason}`,
  };
}

function resolveIntegrated(
  id: IntegratedRuntimeId,
  input: RuntimeResolutionInput,
  decision: Extract<RuntimeResolutionResult, { status: "resolved" }>["decision"],
): RuntimeResolutionResult {
  if (!input.policy.allowedIntegratedRuntimes.includes(id)) {
    return {
      status: "failed",
      code: "runtime-not-allowed",
      runtimeKey: `integrated:${id}`,
      message: `Integrated Runtime ${id} is not included in this distribution.`,
    };
  }
  const readiness = input.readiness.integrated[id];
  if (!readinessAdmits(readiness, input.allowUnverifiedDevRuntime === true)) {
    return failedReadiness("runtime-not-ready", `integrated:${id}`, readiness);
  }
  return {
    status: "resolved",
    binding:
      id === "dsh"
        ? createDshBinding(input.readiness.platformTarget)
        : createClaudeSdkBinding(),
    decision,
    readiness: readiness.state,
  };
}

function resolveExternal(
  id: ExternalRuntimeId,
  input: RuntimeResolutionInput,
  decision: "explicit-external" | "existing-session",
  existingBinding?: Extract<EffectiveRuntimeBinding, { family: "external" }>,
): RuntimeResolutionResult {
  if (!input.policy.allowedExternalRuntimes.includes(id)) {
    return {
      status: "failed",
      code: "runtime-not-allowed",
      runtimeKey: `external:${id}`,
      message: `External Runtime ${id} is not included in this distribution.`,
    };
  }
  const readiness = input.readiness.external[id];
  if (!readinessAdmits(readiness, input.allowUnverifiedDevRuntime === true)) {
    return failedReadiness("runtime-not-ready", `external:${id}`, readiness);
  }
  return {
    status: "resolved",
    binding: existingBinding ?? {
      family: "external",
      id,
      ...("implementationVersion" in readiness && readiness.implementationVersion
        ? { implementationVersion: readiness.implementationVersion }
        : {}),
    },
    decision,
    readiness: readiness.state,
  };
}

function resolveExisting(
  binding: EffectiveRuntimeBinding,
  input: RuntimeResolutionInput,
): RuntimeResolutionResult {
  if (binding.family === "integrated") {
    const result = resolveIntegrated(binding.id, input, "existing-session");
    return result.status === "resolved" ? { ...result, binding } : result;
  }
  if (binding.family === "external") {
    return resolveExternal(binding.id, input, "existing-session", binding);
  }
  const readiness = input.readiness.managedCodex;
  if (!readinessAdmits(readiness, input.allowUnverifiedDevRuntime === true)) {
    return failedReadiness(
      "provider-runtime-not-ready",
      "managed-provider:managed-codex",
      readiness,
    );
  }
  return {
    status: "resolved",
    binding,
    decision: "existing-session",
    readiness: readiness.state,
  };
}

export function resolveEffectiveRuntimeBinding(
  input: RuntimeResolutionInput,
): RuntimeResolutionResult {
  if (input.existingBinding) return resolveExisting(input.existingBinding, input);

  const selectorAvailable = isRuntimeSelectorAvailable(
    input.policy,
    input.labsEnabled,
  );
  let preference: AgentRuntimePreference;
  if (selectorAvailable) {
    const storedPreference = resolveAgentRuntimePreference({
      runtimePreference: input.agentPreference,
      runtime: input.legacyAgentRuntime,
      runtimeSource: input.legacyAgentRuntimeSource,
      providerId: input.legacyAgentProviderId,
    });
    if (!storedPreference) {
      return {
        status: "failed",
        code: "runtime-preference-invalid",
        runtimeKey: "agent-preference",
        message:
          "Agent Runtime preference is invalid or has an illegal legacy projection.",
      };
    }
    preference = storedPreference;
  } else {
    preference = {
      family: "integrated",
      id: resolveDefaultIntegratedRuntime(
        input.policy,
        input.configuredDefaultIntegratedRuntime,
      ),
    };
  }

  if (preference.family === "external") {
    return resolveExternal(preference.id, input, "explicit-external");
  }

  if (input.providerConstraint.kind === "requires-integrated-runtime") {
    return resolveIntegrated(
      input.providerConstraint.runtimeId,
      input,
      "provider-required-integrated",
    );
  }
  if (input.providerConstraint.kind === "requires-managed-runtime") {
    const readiness = input.readiness.managedCodex;
    if (!readinessAdmits(readiness, input.allowUnverifiedDevRuntime === true)) {
      return failedReadiness(
        "provider-runtime-not-ready",
        "managed-provider:managed-codex",
        readiness,
      );
    }
    return {
      status: "resolved",
      binding: createManagedCodexBinding(),
      decision: "provider-required-managed",
      readiness: readiness.state,
    };
  }

  return resolveIntegrated(
    preference.id,
    input,
    selectorAvailable ? "selected-integrated" : "distribution-default",
  );
}
