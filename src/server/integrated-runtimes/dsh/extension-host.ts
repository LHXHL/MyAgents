import {
  dshExtensionGenerationId,
  findDshHostToolBinding,
  findDshMcpCredentialBinding,
  type DshCompiledExtensionPlane,
} from './extension-compiler';
import type { DshRequestContext, DshRpcObject } from './protocol-types';

type HostAttachmentPublisher = Readonly<{
  publishDataUrl(dataUrl: string): Promise<DshRpcObject>;
}>;

function record(value: unknown): DshRpcObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as DshRpcObject
    : undefined;
}

export function resolveDshMcpCredential(input: {
  plane: DshCompiledExtensionPlane;
  extensionDigest: string;
  params: DshRpcObject;
}): DshRpcObject {
  const authority = record(input.params.authority);
  const requestedRevision = typeof input.params.credentialRevision === 'string'
    ? input.params.credentialRevision
    : 'invalid-credential-revision';
  const candidate = input.plane.credentialBindings.find(binding => (
    binding.componentId === input.params.serverId
    && binding.credentialRef === input.params.credentialRef
    && binding.materialSlot === input.params.materialSlot
  ));
  const exact = candidate && findDshMcpCredentialBinding(input.plane, {
    componentId: candidate.componentId,
    credentialRef: candidate.credentialRef,
    credentialRevision: requestedRevision,
    materialSlot: String(input.params.materialSlot ?? ''),
  });
  if (
    !exact
    || authority?.componentId !== exact.componentId
    || authority.componentGenerationId !== dshExtensionGenerationId(input.plane)
    || input.params.extensionDigest !== input.extensionDigest
  ) {
    return {
      kind: 'availability',
      available: false,
      authoritativeCredentialRevision: candidate?.credentialRevision ?? requestedRevision,
      reasonCode: 'mcp_credential_authority_mismatch',
    };
  }
  if (input.params.purpose === 'availability') {
    return {
      kind: 'availability',
      available: true,
      authoritativeCredentialRevision: exact.credentialRevision,
    };
  }
  if (input.params.purpose !== 'connection') {
    return {
      kind: 'availability',
      available: false,
      authoritativeCredentialRevision: exact.credentialRevision,
      reasonCode: 'mcp_credential_purpose_invalid',
    };
  }
  return {
    kind: 'material',
    authoritativeCredentialRevision: exact.credentialRevision,
    material: { ...exact.material },
  };
}

export async function executeDshProductHostTool(input: {
  plane: DshCompiledExtensionPlane;
  attachments: HostAttachmentPublisher;
  runtimeSessionId: string | undefined;
  params: DshRpcObject;
  context: DshRequestContext;
}): Promise<DshRpcObject> {
  const publicToolName = typeof input.params.tool === 'string' ? input.params.tool : '';
  const binding = findDshHostToolBinding(input.plane, publicToolName);
  const dispatcher = input.plane.hostToolDispatcher;
  if (!binding || !dispatcher) {
    return {
      state: 'failed',
      code: 'host_tool_unavailable',
      content: [{ type: 'text', text: 'The requested MyAgents Host tool is unavailable.' }],
    };
  }
  const authority = record(input.params.authority);
  if (
    !authority
    || authority.componentId !== binding.publicToolName
    || authority.componentGenerationId !== dshExtensionGenerationId(input.plane)
    || typeof authority.runtimeGeneration !== 'string'
    || typeof authority.runtimeSessionId !== 'string'
    || typeof authority.turnId !== 'string'
    || typeof authority.callId !== 'string'
    || input.runtimeSessionId !== authority.runtimeSessionId
  ) {
    return { state: 'failed', code: 'host_tool_authority_mismatch' };
  }
  try {
    const result = await dispatcher.dispatch({
      processGeneration: authority.runtimeGeneration,
      threadId: authority.runtimeSessionId,
      turnId: authority.turnId,
      callId: authority.callId,
      tool: binding.dispatcherToolName,
      arguments: input.params.input,
      signal: input.context.signal,
    });
    const content: DshRpcObject[] = [];
    for (const item of result.contentItems) {
      if (item.type === 'text') {
        if (item.text.length > 131_072) throw new Error('Host tool text exceeds the DSH protocol bound');
        content.push({ type: 'text', text: item.text });
      } else {
        content.push({
          type: 'attachment_ref',
          attachment: await input.attachments.publishDataUrl(item.dataUrl),
        });
      }
    }
    return {
      state: result.success ? 'succeeded' : 'failed',
      ...(result.success ? {} : { code: 'host_tool_failed' }),
      ...(content.length > 0 ? { content } : {}),
    };
  } catch {
    return input.context.signal.aborted
      ? { state: 'aborted', code: 'host_tool_aborted' }
      : { state: 'failed', code: 'host_tool_failed' };
  }
}
