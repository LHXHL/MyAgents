import {
  isNetworkReference,
  parseAgentReference,
  parseSessionReference,
  type SourceRequest,
} from "@myagents/agent-network-protocol";

export const AGENT_NETWORK_TARGET_FIELDS = {
  "agent/show": "agentId",
  "session/list": "agentId",
  "session/start": "agentId",
  "session/get": "sessionId",
  "session/state": "sessionId",
  "session/send": "toSessionId",
  "session/watch": "targetSessionId",
} as const;

/** Shared CLI/Admin addressing policy; it performs no discovery or IO. */
export function networkAddress(
  route: string,
  payload: Record<string, unknown>,
) {
  if (!(route in AGENT_NETWORK_TARGET_FIELDS)) return null;
  const key =
    AGENT_NETWORK_TARGET_FIELDS[
      route as keyof typeof AGENT_NETWORK_TARGET_FIELDS
    ];
  const value =
    route === "agent/show" ? (payload.agentId ?? payload.id) : payload[key];
  if (typeof value !== "string" || !isNetworkReference(value.trim()))
    return null;
  const selector = value.trim();
  const method = route.replace(
    "/",
    ".",
  ) as SourceRequest["operation"]["method"];
  const reference =
    method === "agent.show" ||
    method === "session.list" ||
    method === "session.start"
      ? parseAgentReference(selector)
      : parseSessionReference(selector);
  return { key, selector, method, reference };
}
