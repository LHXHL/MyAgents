import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  channelMessageSchema,
  type ChannelMessageResult,
} from "../../shared/channelMessage";
import { assertSafeFilePath } from "../utils/safe-file-path";
import { managementApi } from "../utils/management-api-client";

export async function readChannelScope(): Promise<Record<
  string,
  unknown
> | null> {
  const sidecarId = process.env.MYAGENTS_SIDECAR_ID;
  if (!sidecarId) return null;
  const response = await managementApi("/api/im/channel-context", "POST", {
    sidecarId,
  });
  if (response.ok !== true)
    throw new Error(String(response.error ?? "Channel context unavailable"));
  return response;
}

/** Channel prompts require the exact Session binding, not Agent-wide capabilities. */
export async function readChannelPromptOptions(): Promise<{ channelBound: boolean }> {
  const scope = await readChannelScope();
  return {
    channelBound: !!scope?.defaultTarget,
  };
}

/** One business entrypoint for every Runtime surface. The Rust process owner
 * resolves the caller Session and binding; neither tool nor CLI supplies them. */
export async function sendChannelMessage(
  input: unknown,
  workspacePath: string,
): Promise<ChannelMessageResult> {
  try {
    const parsed = channelMessageSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues.find(issue => issue.code === 'custom' && ['CHANNEL_HANDOFF_INPUT_INCOMPLETE', 'CHANNEL_TARGET_INVALID'].includes(String(issue.params?.code)));
      const details = issue?.code === 'custom' ? issue.params : undefined;
      return { status: 'failed', connection: null, target: null, items: [],
        ...(details ? { code: String(details.code), missingFields: details.missingFields as string[] } : {}),
        error: issue?.message ?? parsed.error.message };
    }
    const request = parsed.data;
    const sidecarId = process.env.MYAGENTS_SIDECAR_ID;
    if (!sidecarId)
      throw new Error("A live Session is required to send channel messages.");
    for (const attachment of request.attachments ?? []) {
      if (!isAbsolute(attachment.path))
        throw new Error("Attachment paths must be absolute.");
      attachment.path = assertSafeFilePath(attachment.path, { workspacePath });
      if (!statSync(attachment.path).isFile())
        throw new Error("Attachments must be regular files.");
    }
    const response = await managementApi("/api/im/send-message", "POST", {
      sidecarId,
      request,
    });
    if (response.result) return response.result as ChannelMessageResult;
    return {
      status:
        response.code === "transport_outcome_unknown" ? "unknown" : "failed",
      connection: null,
      target: null,
      items: [],
      error: String(
        response.error ??
          "Channel send did not return a result. Inspect delivery before retrying.",
      ),
    };
  } catch (error) {
    return {
      status: "failed",
      connection: null,
      target: null,
      items: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
