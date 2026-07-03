import type { Project } from "@/config/types";
import { i18n } from "@/i18n";
import { workspacePathsEqual } from "@/../shared/workspacePath";

export const DEFAULT_SPACE_ID = "official";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`MyAgents Space requires Tauri runtime: ${cmd}`);
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

function spacePath(spaceId = DEFAULT_SPACE_ID): string {
  return encodeURIComponent(spaceId || DEFAULT_SPACE_ID);
}

export interface SpaceUser {
  id: string;
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface SpaceInfo {
  id: string;
  slug: string;
  name: string;
  joinPolicy: string;
  rootGoalId?: string | null;
}

export interface SpaceMembership {
  id: string;
  role: "owner" | "admin" | "member";
}

export interface SpaceSession {
  baseUrl: string;
  expiresAt?: string | null;
  user: SpaceUser;
  space: SpaceInfo;
  membership: SpaceMembership;
  updatedAt: string;
}

export interface SpaceBuildCapability {
  available: boolean;
  baseUrl?: string | null;
  publicClientId?: string | null;
  reason?: string | null;
}

export interface SpaceTag {
  id: string;
  name: string;
  color?: string | null;
  description?: string | null;
}

export type SpaceIssueState = "open" | "todo" | "doing" | "done" | "closed";

export interface SpaceGoal {
  id: string;
  spaceId: string;
  parentGoalId?: string | null;
  path: string;
  depth: number;
  title: string;
  context: string;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  goalPathLabel?: string | null;
}

export interface SpaceGoalSubscription {
  id: string;
  spaceId: string;
  actorType: "user" | "registered_agent";
  actorId: string;
  goalId: string;
  includeSubtree: boolean;
  stateFilter: string[];
  goalPathLabel?: string | null;
  createdAt: string;
}

export interface SpaceIssue {
  id: string;
  spaceId: string;
  goalId?: string | null;
  parentIssueId?: string | null;
  title: string;
  body: string;
  state: SpaceIssueState | string;
  humanOnly?: boolean;
  createdByType?: "user" | "registered_agent";
  createdById?: string;
  createdByUserId?: string;
  creator?: { id: string; name?: string | null };
  notificationVersion?: number;
  goalPathLabel?: string | null;
  status?: string;
  author?: { id: string; name?: string | null };
  tags?: SpaceTag[];
  commentCount?: number;
  attachmentCount?: number;
  claim?: SpaceIssueClaim | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceIssueComment {
  id: string;
  author: { id: string; type: "user" | "registered_agent" | "system" };
  body: string;
  createdAt: string;
}

export interface SpaceAttachment {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType?: string | null;
  createdAt: string;
}

export interface SpaceDownloadAttachmentResult {
  name: string;
  relativePath: string;
  fullPath: string;
  sizeBytes: number;
}

export interface SpaceIssueGoalReference {
  goalId: string;
  goalPath: string;
  goalPathLabel?: string | null;
  goalTitle: string;
  goalContext: string;
}

export interface SpaceIssueClaim {
  id: string;
  spaceId: string;
  issueId: string;
  actorType: "user" | "registered_agent";
  actorId: string;
  actorName?: string | null;
  actor?: {
    id: string;
    name?: string | null;
    type?: "user" | "registered_agent" | string;
  };
  status?: "active" | "completed" | "cancelled" | string;
  localTaskId?: string | null;
  localSessionId?: string | null;
  claimedAt: string;
  updatedAt: string;
}

export interface SpaceIssueDetail {
  issue: SpaceIssue;
  goalReference?: SpaceIssueGoalReference | null;
  comments: {
    items: SpaceIssueComment[];
    hasMore: boolean;
    nextCursor?: string | null;
    limit: number;
  };
  attachments: SpaceAttachment[];
  claim?: SpaceIssueClaim | null;
}

export interface SpaceSkill {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  latestRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceSkillFile {
  id: string;
  path: string;
  name: string;
  parentPath: string;
  isDir: boolean;
  sizeBytes?: number | null;
  mimeType?: string | null;
  createdAt: string;
}

export interface SpaceSkillDetail {
  skill: SpaceSkill;
  revision?: Record<string, unknown> | null;
  files: SpaceSkillFile[];
}

export type SpaceIssueSubscriptionRunMode = "single_session" | "new_session";

export interface SpaceUserDeviceSummary {
  deviceId: string;
  deviceName?: string | null;
  platform?: string | null;
  osVersion?: string | null;
  appVersion?: string | null;
  status?: string | null;
  lastSeenAt?: string | null;
}

export interface LocalRegisteredAgent {
  id: string;
  baseUrl: string;
  spaceId: string;
  isLocal?: boolean;
  ownerUserId?: string | null;
  deviceId?: string | null;
  device?: SpaceUserDeviceSummary | null;
  clientId?: string | null;
  deviceName?: string | null;
  localWorkspaceId?: string | null;
  localAgentId?: string | null;
  workspaceId?: string | null;
  displayName: string;
  workspacePath: string;
  workspaceLabel?: string | null;
  goalId?: string | null;
  goalPathLabel?: string | null;
  stateFilter: string[];
  goalMd?: string | null;
  deliverySessionId?: string | null;
  issueSubscriptionRunMode: SpaceIssueSubscriptionRunMode;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceRegisteredAgent {
  id: string;
  spaceId: string;
  ownerUserId?: string | null;
  deviceId?: string | null;
  device?: SpaceUserDeviceSummary | null;
  clientId?: string | null;
  deviceName?: string | null;
  localWorkspaceId?: string | null;
  localAgentId?: string | null;
  displayName: string;
  workspacePath?: string | null;
  workspaceLabel?: string | null;
  subscriptions?: SpaceGoalSubscription[];
  goalMd?: string | null;
  issueSubscriptionRunMode?: SpaceIssueSubscriptionRunMode | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceDispatchItem {
  dispatch: {
    id: string;
    spaceId: string;
    issueId: string;
    registeredAgentId: string;
    deliveryStatus: string;
    goalSnapshotMd: string;
    createdAt: string;
    updatedAt: string;
  };
  registeredAgent: {
    id: string;
    displayName: string;
    goalMd: string;
  };
  issueMeta: {
    id: string;
    title: string;
    status: string;
    updatedAt: string;
  };
}

export interface SpaceDeliveryItem {
  delivery: {
    id: string;
    spaceId: string;
    issueId: string;
    registeredAgentId: string;
    deliveryKind?: "subscription" | "claim_followup" | string | null;
    subscriptionId?: string | null;
    claimId?: string | null;
    notificationVersion: number;
    updateSummary?: string | null;
    targetSessionId?: string | null;
    status: "pending" | "delivered" | "claimed" | "ignored" | string;
    deliveredToSessionId?: string | null;
    deliveredAt?: string | null;
    createdAt: string;
    updatedAt: string;
  };
  issueMeta: {
    id: string;
    title: string;
    state: SpaceIssueState | string;
    updatedAt: string;
  };
  goalMeta?: {
    id: string;
    path?: string | null;
    title?: string | null;
  } | null;
}

export interface SpaceEvent {
  id: string;
  type: string;
  resourceType?: string | null;
  resourceId?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  targetRegisteredAgentId?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

export interface SpaceApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  requestId?: string;
  recoveryHint?: {
    message: string;
    recoveryCommand?: string;
  };
  hint?: string;
}

export interface SpaceErrorContext {
  method?: string;
  path?: string;
  operation?: string;
}

export interface NormalizedSpaceError {
  userMessage: string;
  debugMessage: string;
}

interface SpaceUserFacingError extends Error {
  readonly __spaceUserFacingError: true;
}

function spaceUserFacingError(message: string): SpaceUserFacingError {
  const error = new Error(message) as SpaceUserFacingError;
  Object.defineProperty(error, "__spaceUserFacingError", { value: true });
  return error;
}

function isSpaceUserFacingError(error: unknown): error is SpaceUserFacingError {
  return (
    error instanceof Error &&
    (error as Partial<SpaceUserFacingError>).__spaceUserFacingError === true
  );
}

function rawErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "error" in error &&
    typeof error.error === "string"
  ) {
    return error.error;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function sanitizeSpaceError(message: string): string {
  return message
    .replace(/\s*\(https?:\/\/[^)]+\)/g, "")
    .replace(/https?:\/\/\S+/g, "[URL]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\/Users\/[^\s)]+/g, "[path]")
    .replace(/\/var\/folders\/[^\s)]+/g, "[path]")
    .replace(/[A-Z]:\\Users\\[^\s)]+/g, "[path]")
    .trim();
}

function spaceText(key: string, options?: Record<string, unknown>): string {
  return String(i18n.t(`app:space.errors.${key}`, options));
}

function operationFromPath(context?: SpaceErrorContext): string {
  if (context?.operation) return context.operation;
  const path = context?.path ?? "";
  const method = (context?.method ?? "").toUpperCase();
  if (method === "POST" && /\/api\/issues\/[^/]+\/comments$/.test(path))
    return spaceText("operations.comment");
  if (method === "POST" && /\/api\/spaces\/[^/]+\/issues$/.test(path))
    return spaceText("operations.createIssue");
  if (method === "PATCH" && /\/api\/issues\/[^/]+$/.test(path))
    return spaceText("operations.updateIssue");
  if (method === "POST" && /\/api\/issues\/[^/]+\/status$/.test(path))
    return spaceText("operations.updateIssueStatus");
  if (method === "POST" && /\/api\/issues\/[^/]+\/close-own$/.test(path))
    return spaceText("operations.closeIssue");
  if (method === "POST" && /\/api\/issues\/[^/]+\/claim$/.test(path))
    return spaceText("operations.claimIssue");
  if (method === "POST" && /\/api\/issues\/[^/]+\/complete$/.test(path))
    return spaceText("operations.completeIssue");
  if (method === "POST" && /\/api\/issues\/[^/]+\/cancel-claim$/.test(path))
    return spaceText("operations.cancelClaim");
  if (path.includes("/goals")) return spaceText("operations.goal");
  if (path.includes("/attachments")) return spaceText("operations.attachment");
  if (path.includes("/skills")) return spaceText("operations.skill");
  return spaceText("operations.request");
}

export function normalizeSpaceError(
  error: unknown,
  context?: SpaceErrorContext,
): NormalizedSpaceError {
  if (isSpaceUserFacingError(error)) {
    return {
      userMessage: error.message,
      debugMessage: error.message,
    };
  }
  const raw = rawErrorMessage(error);
  const sanitized = sanitizeSpaceError(raw);
  const operation = operationFromPath(context);
  const lower = raw.toLowerCase();
  const envelope =
    error && typeof error === "object"
      ? (error as Partial<SpaceApiEnvelope<unknown>>)
      : null;
  const code = typeof envelope?.code === "string" ? envelope.code : "";
  const requestId =
    typeof envelope?.requestId === "string" ? envelope.requestId : "";
  const recoveryMessage =
    typeof envelope?.recoveryHint?.message === "string"
      ? envelope.recoveryHint.message.trim()
      : "";
  const debugSuffix = [code, requestId].filter(Boolean).join(" ");

  if (code === "NOT_AUTHENTICATED" || code === "SESSION_EXPIRED") {
    return {
      userMessage: spaceText("templates.relogin", { operation }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  if (
    code === "FORBIDDEN" ||
    code.includes("PERMISSION") ||
    lower.includes("permission required")
  ) {
    return {
      userMessage: spaceText("templates.permissionDenied", { operation }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  if (code === "INTERNAL_ERROR") {
    return {
      userMessage: spaceText("templates.serviceUnavailable", { operation }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  if (recoveryMessage) {
    return {
      userMessage: spaceText("templates.withDetail", {
        operation,
        detail: recoveryMessage,
      }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  if (
    lower.includes("error sending request") ||
    lower.includes("space api request failed") ||
    lower.includes("load failed") ||
    lower.includes("network") ||
    lower.includes("timed out")
  ) {
    return {
      userMessage: spaceText("templates.network", { operation }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  if (
    lower.includes("invalid space api response") ||
    lower.includes("response missing data")
  ) {
    return {
      userMessage: spaceText("templates.invalidResponse", { operation }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  if (sanitized) {
    return {
      userMessage: spaceText("templates.withDetail", {
        operation,
        detail: sanitized,
      }),
      debugMessage: [debugSuffix, sanitized].filter(Boolean).join(" · "),
    };
  }

  return {
    userMessage: spaceText("templates.failed", { operation }),
    debugMessage: [debugSuffix, raw].filter(Boolean).join(" · "),
  };
}

export function spaceErrorMessage(
  error: unknown,
  context?: SpaceErrorContext,
): string {
  return normalizeSpaceError(error, context).userMessage;
}

async function spaceApi<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let result: SpaceApiEnvelope<T>;
  try {
    result = await inv<SpaceApiEnvelope<T>>("cmd_space_api_request", {
      input: {
        method,
        path,
        body: body ?? null,
      },
    });
  } catch (error) {
    const normalized = normalizeSpaceError(error, { method, path });
    console.warn("[Space] API transport failed", {
      method,
      path,
      error: normalized.debugMessage,
    });
    throw spaceUserFacingError(normalized.userMessage);
  }
  if (!result.success) {
    const normalized = normalizeSpaceError(
      result.error ? result : `Space API failed: ${method} ${path}`,
      { method, path },
    );
    console.warn("[Space] API business error", {
      method,
      path,
      error: normalized.debugMessage,
    });
    throw spaceUserFacingError(normalized.userMessage);
  }
  return result.data as T;
}

export function spaceGetSession(): Promise<SpaceSession | null> {
  return inv("cmd_space_get_session");
}

export function spaceGetCapability(): Promise<SpaceBuildCapability> {
  return inv("cmd_space_get_capability");
}

export function spaceAuthStart(): Promise<{
  loginToken: string;
  authorizationUrl: string;
  expiresInSeconds: number;
}> {
  return inv("cmd_space_auth_start");
}

export function spaceAuthPoll(
  loginToken: string,
): Promise<Record<string, unknown>> {
  return inv("cmd_space_auth_poll", { input: { loginToken } });
}

export function spaceAuthAck(loginToken: string): Promise<void> {
  return inv("cmd_space_auth_ack", { input: { loginToken } });
}

export function spaceLogout(): Promise<void> {
  return inv("cmd_space_logout");
}

export function spaceGetOfficial(
  spaceId = DEFAULT_SPACE_ID,
): Promise<{
  space: SpaceInfo;
  membership: SpaceMembership;
  goals: SpaceGoal[];
  tags?: SpaceTag[];
}> {
  return spaceApi("GET", `/api/spaces/${spacePath(spaceId)}`);
}

export function spaceListGoals(
  input: { includeArchived?: boolean } = {},
  spaceId = DEFAULT_SPACE_ID,
) {
  const search = new URLSearchParams();
  if (input.includeArchived) search.set("includeArchived", "true");
  const suffix = search.toString() ? `?${search.toString()}` : "";
  return spaceApi<{ items: SpaceGoal[] }>(
    "GET",
    `/api/spaces/${spacePath(spaceId)}/goals${suffix}`,
  );
}

export function spaceCreateGoal(
  input: { parentGoalId: string; title: string; context: string },
  spaceId = DEFAULT_SPACE_ID,
) {
  return spaceApi<{ goal: SpaceGoal }>(
    "POST",
    `/api/spaces/${spacePath(spaceId)}/goals`,
    input,
  );
}

export function spaceUpdateGoal(input: {
  goalId: string;
  title?: string;
  context?: string;
}) {
  return spaceApi<{ goal: SpaceGoal }>(
    "PATCH",
    `/api/goals/${encodeURIComponent(input.goalId)}`,
    {
      title: input.title,
      context: input.context,
    },
  );
}

export function spaceArchiveGoal(goalId: string) {
  return spaceApi<{ archived: boolean; archivedAt: string }>(
    "POST",
    `/api/goals/${encodeURIComponent(goalId)}/archive`,
    {},
  );
}

export function spaceListIssues(
  params: {
    q?: string;
    state?: string;
    goalId?: string | null;
    includeSubtree?: boolean;
    humanOnly?: boolean | null;
    cursor?: string;
    limit?: number;
  },
  spaceId = DEFAULT_SPACE_ID,
) {
  const search = new URLSearchParams();
  if (params.q) search.set("q", params.q);
  if (params.state) search.set("state", params.state);
  if (params.goalId) search.set("goalId", params.goalId);
  if (params.includeSubtree !== undefined)
    search.set("includeSubtree", String(params.includeSubtree));
  if (params.humanOnly !== undefined && params.humanOnly !== null)
    search.set("humanOnly", String(params.humanOnly));
  if (params.cursor) search.set("cursor", params.cursor);
  search.set("limit", String(params.limit ?? 30));
  return spaceApi<{
    items: SpaceIssue[];
    hasMore: boolean;
    nextCursor?: string | null;
  }>("GET", `/api/spaces/${spacePath(spaceId)}/issues?${search.toString()}`);
}

export function spaceListEvents(
  params: { cursor?: string | null; limit?: number; tail?: boolean },
  spaceId = DEFAULT_SPACE_ID,
) {
  const search = new URLSearchParams();
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.tail) search.set("tail", "1");
  search.set("limit", String(params.limit ?? 50));
  return spaceApi<{
    items: SpaceEvent[];
    hasMore: boolean;
    nextCursor?: string | null;
  }>("GET", `/api/spaces/${spacePath(spaceId)}/events?${search.toString()}`);
}

export function spaceCreateIssue(
  input: {
    title: string;
    body: string;
    goalId?: string | null;
    parentIssueId?: string | null;
    humanOnly?: boolean;
  },
  spaceId = DEFAULT_SPACE_ID,
) {
  return spaceApi<{ issue: SpaceIssue }>(
    "POST",
    `/api/spaces/${spacePath(spaceId)}/issues`,
    input,
  );
}

export function spaceUpdateIssue(input: {
  issueId: string;
  title?: string;
  body?: string;
}) {
  return spaceApi<{ issue: SpaceIssue }>(
    "PATCH",
    `/api/issues/${encodeURIComponent(input.issueId)}`,
    {
      title: input.title,
      body: input.body,
    },
  );
}

export function spaceGetIssue(id: string, commentsCursor?: string | null) {
  const search = new URLSearchParams({ commentsLimit: "5" });
  if (commentsCursor) search.set("commentsCursor", commentsCursor);
  return spaceApi<SpaceIssueDetail>(
    "GET",
    `/api/issues/${encodeURIComponent(id)}?${search.toString()}`,
  );
}

export function spaceCommentIssue(id: string, body: string) {
  return spaceApi<{ comment: SpaceIssueComment }>(
    "POST",
    `/api/issues/${encodeURIComponent(id)}/comments`,
    { body },
  );
}

export function spaceSetIssueState(id: string, state: string) {
  return spaceApi<{ state: string; updatedAt: string }>(
    "POST",
    `/api/issues/${encodeURIComponent(id)}/status`,
    { state },
  );
}

export function spaceCloseOwnIssue(id: string) {
  return spaceApi<{ state: string; updatedAt: string }>(
    "POST",
    `/api/issues/${encodeURIComponent(id)}/close-own`,
    {},
  );
}

export function spaceCloseIssue(id: string) {
  return spaceApi<{ state: string; updatedAt: string }>(
    "POST",
    `/api/issues/${encodeURIComponent(id)}/close`,
    {},
  );
}

export function spaceCompleteIssue(id: string) {
  return spaceApi<{ state: string; updatedAt: string }>(
    "POST",
    `/api/issues/${encodeURIComponent(id)}/complete`,
    {},
  );
}

export function spaceCancelIssueClaim(id: string) {
  return spaceApi<{ state: string; updatedAt: string }>(
    "POST",
    `/api/issues/${encodeURIComponent(id)}/cancel-claim`,
    {},
  );
}

export function spaceClaimIssue(id: string, deliveryId?: string | null) {
  return spaceApi<{ claim: SpaceIssueClaim }>(
    "POST",
    `/api/issues/${encodeURIComponent(id)}/claim`,
    { deliveryId },
  );
}

export function spaceListSkills(spaceId = DEFAULT_SPACE_ID) {
  return spaceApi<{ items: SpaceSkill[] }>(
    "GET",
    `/api/spaces/${spacePath(spaceId)}/skills`,
  );
}

export function spaceGetSkill(id: string) {
  return spaceApi<SpaceSkillDetail>(
    "GET",
    `/api/skills/${encodeURIComponent(id)}`,
  );
}

export function spaceGetSkillFile(id: string, path: string) {
  const search = new URLSearchParams({ path });
  return spaceApi<{
    text?: string;
    binary?: boolean;
    mimeType?: string;
    sizeBytes?: number;
  }>(
    "GET",
    `/api/skills/${encodeURIComponent(id)}/file-content?${search.toString()}`,
  );
}

export function spaceInstallSkill(input: {
  skillId: string;
  skillName: string;
  target: "global" | "project";
  workspacePath?: string;
}) {
  return inv<{
    installedName: string;
    installedPath: string;
    target: string;
    renamed: boolean;
  }>("cmd_space_install_skill", {
    input,
  });
}

export function spaceUploadSkillZip(input: {
  filePath: string;
  name?: string;
  description?: string;
  skillId?: string;
}) {
  return inv<{ skill: SpaceSkill }>("cmd_space_upload_skill", { input });
}

export function spaceDeleteSkill(skillId: string) {
  return spaceApi<{ deleted: boolean }>(
    "DELETE",
    `/api/skills/${encodeURIComponent(skillId)}`,
  );
}

export function spaceUploadIssueAttachments(input: {
  issueId: string;
  filePaths: string[];
}) {
  return inv<{ attachments: SpaceAttachment[] }>(
    "cmd_space_upload_issue_attachments",
    { input },
  );
}

export function spaceDownloadIssueAttachment(input: {
  attachmentId: string;
  workspacePath: string;
  issueId?: string;
  fileName?: string;
  output?: string;
}) {
  return inv<SpaceDownloadAttachmentResult>("cmd_space_download_attachment", {
    input,
  });
}

export function spaceRegisterAgent(input: {
  displayName: string;
  workspaceId: string;
  workspacePath: string;
  workspaceLabel?: string;
  goalId: string;
  stateFilter?: string[];
  issueSubscriptionRunMode?: SpaceIssueSubscriptionRunMode;
}) {
  return inv<LocalRegisteredAgent>("cmd_space_register_agent", { input });
}

export function spaceUpdateRegisteredAgent(input: {
  id: string;
  displayName?: string;
  workspaceId?: string;
  workspacePath?: string;
  workspaceLabel?: string;
  goalId?: string;
  stateFilter?: string[];
  status?: "active" | "disabled";
  issueSubscriptionRunMode?: SpaceIssueSubscriptionRunMode;
}) {
  return inv<LocalRegisteredAgent>("cmd_space_update_registered_agent", {
    input,
  });
}

export function spaceRevokeRegisteredAgent(id: string) {
  return inv<LocalRegisteredAgent>("cmd_space_revoke_registered_agent", {
    input: { id },
  });
}

export function spaceListRegisteredAgents(spaceId = DEFAULT_SPACE_ID) {
  return spaceApi<{ items: SpaceRegisteredAgent[] }>(
    "GET",
    `/api/spaces/${spacePath(spaceId)}/registered-agents`,
  );
}

export function spaceListLocalAgents() {
  return inv<LocalRegisteredAgent[]>("cmd_space_list_local_agents");
}

export function spacePollDispatches(registeredAgentId: string) {
  return inv<SpaceApiEnvelope<{ items: SpaceDispatchItem[] }>>(
    "cmd_space_poll_dispatches",
    {
      input: { registeredAgentId },
    },
  );
}

export function spaceMarkDispatchDelivered(input: {
  registeredAgentId: string;
  dispatchId: string;
  localTaskId?: string;
  localRunId?: string;
}) {
  return inv<SpaceApiEnvelope<{ delivered: boolean; deliveredAt?: string }>>(
    "cmd_space_mark_dispatch_delivered",
    { input },
  );
}

export function spaceProcessDispatchesOnce() {
  return inv<{ processed: number; delivered: number; errors: string[] }>(
    "cmd_space_process_dispatches_once",
  );
}

export function spacePollDeliveries(registeredAgentId: string) {
  return inv<SpaceApiEnvelope<{ items: SpaceDeliveryItem[] }>>(
    "cmd_space_poll_deliveries",
    {
      input: { registeredAgentId },
    },
  );
}

export function spaceMarkDeliveryDelivered(input: {
  registeredAgentId: string;
  deliveryId: string;
  sessionId?: string;
}) {
  return inv<SpaceApiEnvelope<{ delivered: boolean; deliveredAt?: string }>>(
    "cmd_space_mark_delivery_delivered",
    { input },
  );
}

export function spaceProcessDeliveriesOnce() {
  return inv<{ processed: number; delivered: number; errors: string[] }>(
    "cmd_space_process_deliveries_once",
  );
}

export function findProjectForAgent(
  projects: Project[],
  agent: LocalRegisteredAgent,
): Project | null {
  if (agent.workspaceId) {
    const byId = projects.find((project) => project.id === agent.workspaceId);
    if (byId) return byId;
  }
  return (
    projects.find((project) =>
      workspacePathsEqual(project.path, agent.workspacePath),
    ) ?? null
  );
}
