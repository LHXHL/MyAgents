import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  parseAgentReference,
  parseSessionReference,
  agentReference,
  sessionReference,
  sourceRequestSchema,
  outcomeSchema,
  REMOTE_DEADLINES,
  NetworkProtocolError,
  type AgentReference,
} from "@myagents/agent-network-protocol";
import { managementApi } from "../utils/management-api-client";
import { networkAddress } from "../../shared/agentNetworkRouting";
type SourceKind = "internal-session" | "external-cli";
type Request = z.infer<typeof sourceRequestSchema>;

/** The only selector router. A malformed reserved reference never reaches a
 * local registry; ordinary IDs return null without contacting the network. */
export function networkRequest(
  route: string,
  payload: Record<string, unknown>,
  kind: SourceKind,
): Request | null {
  const address = networkAddress(route, payload);
  if (!address) return null;
  const { key, selector: ref, method } = address;
  const allowed = new Set<string>([
    key,
    ...(route === "agent/show" ? ["id"] : []),
    ...(method === "session.list" ? ["limit"] : []),
    ...(method === "session.get" ? ["limit", "before"] : []),
    ...(method === "session.start" || method === "session.send"
      ? ["prompt", "replyBack"]
      : []),
  ]);
  if (
    Object.keys(payload).some(
      (field) => payload[field] !== undefined && !allowed.has(field),
    )
  ) {
    throw new NetworkProtocolError(
      "NETWORK_ARGUMENT_INVALID",
      "This operation does not accept execution overrides or caller identity.",
    );
  }
  if (kind === "external-cli" && method === "session.watch") {
    throw new NetworkProtocolError(
      "EXTERNAL_CLI_CAPABILITY_NOT_OPEN",
      "External CLI cannot register a Session watch.",
    );
  }
  const params =
    method === "session.start" || method === "session.send"
      ? {
          prompt: payload.prompt,
          messageId: randomUUID(),
          replyBack: kind === "internal-session" && payload.replyBack !== false,
        }
      : method === "session.list" || method === "session.get"
        ? {
            limit: payload.limit === undefined ? 5 : Number(payload.limit),
            ...(method === "session.get" && payload.before !== undefined
              ? { before: payload.before }
              : {}),
          }
        : method === "session.watch"
          ? { watchId: randomUUID() }
          : {};
  return sourceRequestSchema.parse({
    selector: ref,
    requestId: randomUUID(),
    operation: { method, params },
  });
}

function qualifySession(ref: AgentReference, value: unknown): unknown {
  return typeof value === "string"
    ? sessionReference({ ...ref, localSessionId: value })
    : value;
}
export function networkOutcome(
  request: Request,
  input: unknown,
): Record<string, unknown> {
  const outcome = outcomeSchema.parse(input);
  if (outcome.method === "error")
    return {
      success: false,
      code: outcome.error.code,
      error: outcome.error.message,
      requestId: request.requestId,
      selector: request.selector,
    };
  if (outcome.method !== request.operation.method)
    throw new NetworkProtocolError(
      "NETWORK_RECEIPT_INVALID",
      "The reply does not match the requested operation.",
    );
  const agent =
    request.operation.method === "agent.show" ||
    request.operation.method === "session.list" ||
    request.operation.method === "session.start"
      ? parseAgentReference(request.selector)
      : parseSessionReference(request.selector);
  const agentId = agentReference(agent);
  if (outcome.method === "agent.show")
    return {
      success: true,
      data: { ...outcome.result, agentId, source: "network" },
    };
  if (outcome.method === "session.list")
    return {
      success: true,
      data: outcome.result.map((item) => ({
        ...item,
        sessionId: qualifySession(agent, item.sessionId),
      })),
    };
  if (outcome.method === "session.get")
    return {
      success: true,
      session: {
        ...outcome.result,
        id: qualifySession(agent, outcome.result.id),
      },
    };
  const result = outcome.result;
  const error = result.error;
  const unconfirmed = "unconfirmed" in result && result.unconfirmed === true;
  const success =
    !error &&
    (outcome.method === "session.start"
      ? outcome.result.accepted === true
      : outcome.method === "session.send"
        ? outcome.result.delivered === true
        : outcome.result.watched === true);
  return {
    ...result,
    success,
    requestId: request.requestId,
    selector: request.selector,
    ...(outcome.method === "session.start"
      ? {
          agentId,
          ...(outcome.result.sessionId
            ? { sessionId: qualifySession(agent, outcome.result.sessionId) }
            : {}),
        }
      : {}),
    ...(outcome.method === "session.watch" && outcome.result.targetSessionId
      ? {
          targetSessionId: qualifySession(
            agent,
            outcome.result.targetSessionId,
          ),
        }
      : {}),
    ...(!success
      ? {
          code: unconfirmed
            ? "admission_unconfirmed"
            : (error?.code ?? "TARGET_ADMISSION_REJECTED"),
          error:
            error?.message ??
            (unconfirmed
              ? "Admission acknowledgement was not received."
              : "The target did not accept this operation."),
        }
      : {}),
  };
}

export async function routeNetworkRequest(
  route: string,
  payload: Record<string, unknown>,
  kind: SourceKind,
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  let request: Request | null = null;
  try {
    request = networkRequest(route, payload, kind);
    if (!request) return null;
    const sidecarId = process.env.MYAGENTS_SIDECAR_ID?.trim();
    if (!sidecarId)
      return {
        success: false,
        code: "SOURCE_OWNER_UNAVAILABLE",
        error: "Source process identity is unavailable.",
      };
    const result = await managementApi(
      "/api/agent-network/invoke",
      "POST",
      { sidecarId, sourceKind: kind, request },
      {
        timeoutMs: REMOTE_DEADLINES[request.operation.method].admin,
        parentSignal: signal,
      },
    );
    if (result.ok !== true) {
      const networkError =
        result.error && typeof result.error === "object"
          ? (result.error as Record<string, unknown>)
          : null;
      const raw = networkError?.code ?? result.code;
      const code =
        raw === "ADMISSION_UNCONFIRMED" || raw === "transport_outcome_unknown"
          ? "admission_unconfirmed"
          : typeof raw === "string"
            ? raw
            : "NETWORK_UNAVAILABLE";
      return {
        success: false,
        code,
        error: code,
        requestId: request.requestId,
        selector: request.selector,
        ...(code === "admission_unconfirmed"
          ? {
              unconfirmed: true,
              recoveryHint: {
                message:
                  "Inspect the target Session; do not automatically resend.",
              },
            }
          : {}),
      };
    }
    return networkOutcome(request, result.outcome);
  } catch (error) {
    const uncertain = request !== null;
    const code = uncertain
      ? "admission_unconfirmed"
      : error instanceof NetworkProtocolError
        ? error.code
        : "NETWORK_ARGUMENT_INVALID";
    return {
      success: false,
      code,
      error: code,
      ...(request
        ? {
            requestId: request.requestId,
            selector: request.selector,
            ...(uncertain ? { unconfirmed: true } : {}),
          }
        : {}),
    };
  }
}
