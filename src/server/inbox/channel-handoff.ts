import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { channelHandoffSchema, type ChannelHandoff } from '../../shared/channelHandoff';
import type { ImagePayload } from '../runtimes/types';
import type { DispatchGuard } from '../session-core/turn-queue';
import { readChannelScope } from '../tools/channel-messaging';

/** This is typed host ingress, never a route inferred from rendered prompt text. */
export function channelHandoffGuard(
  handoff: ChannelHandoff,
  targetSessionId: string,
  currentSessionId: () => string | undefined,
  readScope = readChannelScope,
): DispatchGuard {
  return async () => {
    const changed = (field: string, expected: unknown, actual: unknown) => ({
      accepted: false as const,
      code: 'CHANNEL_HANDOFF_TARGET_CHANGED',
      error: `Channel handoff binding changed (${field}: expected ${JSON.stringify(expected)}, actual ${JSON.stringify(actual ?? null)}). Nothing was forwarded.`,
    });
    const sessionId = currentSessionId();
    if (sessionId !== targetSessionId) return changed('sessionId', targetSessionId, sessionId);
    let scope: Awaited<ReturnType<typeof readScope>>;
    try {
      scope = await readScope();
    } catch {
      return { accepted: false, code: 'CHANNEL_HANDOFF_SCOPE_UNAVAILABLE', error: 'Could not read the target Channel binding. Nothing was forwarded.' };
    }
    if (!scope) return { accepted: false, code: 'CHANNEL_HANDOFF_SCOPE_UNAVAILABLE', error: 'Target Channel scope is unavailable. Nothing was forwarded.' };
    const binding = scope.defaultTarget as { channelId?: string; id?: string; idType?: string } | null;
    const { connection, conversation } = handoff.target;
    // Only exact binding identity matters, never descriptive platform labels.
    for (const [field, expected, actual] of [
      ['channelId', connection.channelId, binding?.channelId],
      ['peerId', conversation.id, binding?.id],
      ['idType', conversation.idType, binding?.idType],
      ['sourceType', conversation.kind === 'direct' ? 'private' : 'group', scope.sourceType],
    ] as const) {
      if (expected !== actual) return changed(field, expected, actual);
    }
    return { accepted: true };
  };
}

/** Files are imported by Rust's workspace owner before admission. Read only
 * that event's owned copies; images then use the normal per-Session input and
 * transcript path, and files remain ordinary persisted workspace references. */
export async function channelHandoffImages(handoff: ChannelHandoff, workspace: string, eventId: string): Promise<ImagePayload[]> {
  channelHandoffSchema.parse(handoff);
  if (!handoff.attachments?.length) return [];
  if (!/^[\da-f-]{36}$/i.test(eventId)) throw new Error('Invalid Channel handoff event ID');
  const root = await realpath(join(workspace, 'myagents_files', 'channel-handoff', eventId));
  const images: ImagePayload[] = [];
  for (const attachment of handoff.attachments) {
    const path = await realpath(attachment.path);
    const child = relative(root, path);
    if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) throw new Error('Channel handoff attachment is outside its event directory');
    const info = await stat(path);
    const limit = (attachment.image ? 10 : 50) * 1024 * 1024;
    if (!info.isFile() || info.size > limit) throw new Error('Invalid Channel handoff attachment');
    if (attachment.image) {
      const bytes = await readFile(path);
      if (bytes.length > limit) throw new Error('Channel handoff image exceeds size limit');
      images.push({ kind: 'inline_base64', name: attachment.name, mimeType: attachment.mimeType, data: bytes.toString('base64') });
    }
  }
  return images;
}
