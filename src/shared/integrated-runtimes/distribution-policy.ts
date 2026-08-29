import policyJson from "./distribution-policy.json";
import {
  EXTERNAL_RUNTIME_IDS,
  INTEGRATED_RUNTIME_IDS,
  type ExternalRuntimeId,
  type IntegratedRuntimeId,
} from "./identity";

export type RuntimeSelectorAvailability = "always" | "labs" | "hidden";

export interface AgentRuntimeDistributionPolicy {
  schemaVersion: 1;
  allowedIntegratedRuntimes: IntegratedRuntimeId[];
  allowedExternalRuntimes: ExternalRuntimeId[];
  defaultIntegratedRuntime: IntegratedRuntimeId;
  selectorAvailability: RuntimeSelectorAvailability;
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

export function parseAgentRuntimeDistributionPolicy(
  value: unknown,
): AgentRuntimeDistributionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime distribution policy must be an object");
  }
  const row = value as Record<string, unknown>;
  const integrated = row.allowedIntegratedRuntimes;
  const external = row.allowedExternalRuntimes;
  if (row.schemaVersion !== 1) {
    throw new Error("Runtime distribution policy schemaVersion must be 1");
  }
  if (
    !Array.isArray(integrated) ||
    integrated.length === 0 ||
    hasDuplicates(integrated as string[]) ||
    integrated.some(
      (id) => !INTEGRATED_RUNTIME_IDS.includes(id as IntegratedRuntimeId),
    )
  ) {
    throw new Error("Runtime distribution policy has invalid Integrated Runtimes");
  }
  if (
    !Array.isArray(external) ||
    hasDuplicates(external as string[]) ||
    external.some(
      (id) => !EXTERNAL_RUNTIME_IDS.includes(id as ExternalRuntimeId),
    )
  ) {
    throw new Error("Runtime distribution policy has invalid External Runtimes");
  }
  if (
    !INTEGRATED_RUNTIME_IDS.includes(
      row.defaultIntegratedRuntime as IntegratedRuntimeId,
    ) ||
    !integrated.includes(row.defaultIntegratedRuntime)
  ) {
    throw new Error("Default Integrated Runtime must be allowed");
  }
  if (!(["always", "labs", "hidden"] as const).includes(
    row.selectorAvailability as RuntimeSelectorAvailability,
  )) {
    throw new Error("Runtime distribution policy has invalid selectorAvailability");
  }
  return {
    schemaVersion: 1,
    allowedIntegratedRuntimes: [...integrated] as IntegratedRuntimeId[],
    allowedExternalRuntimes: [...external] as ExternalRuntimeId[],
    defaultIntegratedRuntime: row.defaultIntegratedRuntime as IntegratedRuntimeId,
    selectorAvailability:
      row.selectorAvailability as RuntimeSelectorAvailability,
  };
}

export const AGENT_RUNTIME_DISTRIBUTION_POLICY = Object.freeze(
  parseAgentRuntimeDistributionPolicy(policyJson),
);

export function isRuntimeSelectorAvailable(
  policy: AgentRuntimeDistributionPolicy,
  labsEnabled: boolean,
): boolean {
  return (
    policy.selectorAvailability === "always" ||
    (policy.selectorAvailability === "labs" && labsEnabled)
  );
}
