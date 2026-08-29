import { createHash } from 'node:crypto';

import type { ImagePayload, ResolvedImagePayload } from '../runtimes/types';
import type { PendingDshRootOperation, SessionMessage } from '../types/session';

type DshProductInputSnapshot = Readonly<{
  schemaVersion: 1;
  clientOperationId: string;
  clientUserMessageId: string;
  content: string;
  images: readonly Readonly<{
    id: string;
    name: string;
    mimeType: string;
    relativePath: string;
    sha256: string;
  }>[];
}>;

function userImages(
  message: SessionMessage,
  imageSha256: readonly string[],
): DshProductInputSnapshot['images'] {
  const attachments = message.attachments ?? [];
  if (attachments.length !== imageSha256.length) {
    throw new Error('DSH root user image digests do not match its persisted attachments');
  }
  return Object.freeze(attachments.map((attachment, index) => {
    const sha256 = imageSha256[index];
    if (
      typeof attachment.id !== 'string'
      || attachment.id.length === 0
      || typeof attachment.name !== 'string'
      || attachment.name.length === 0
      || typeof attachment.mimeType !== 'string'
      || attachment.mimeType.length === 0
      || typeof attachment.path !== 'string'
      || attachment.path.length === 0
      || !sha256
      || !/^[a-f0-9]{64}$/u.test(sha256)
    ) {
      throw new Error('DSH root user attachment is not a persisted image reference');
    }
    return Object.freeze({
      id: attachment.id,
      name: attachment.name,
      mimeType: attachment.mimeType,
      relativePath: attachment.path,
      sha256,
    });
  }));
}

function productInputSnapshot(
  message: SessionMessage,
  clientOperationId: string,
  imageSha256: readonly string[],
): DshProductInputSnapshot {
  if (
    message.role !== 'user'
    || typeof message.id !== 'string'
    || message.id.length === 0
    || typeof message.content !== 'string'
    || message.content.trim().length === 0
    || typeof clientOperationId !== 'string'
    || clientOperationId.length === 0
  ) {
    throw new Error('DSH root operation requires one identified non-empty Product user message');
  }
  return Object.freeze({
    schemaVersion: 1,
    clientOperationId,
    clientUserMessageId: message.id,
    content: message.content,
    images: userImages(message, imageSha256),
  });
}

export function fingerprintDshProductInput(
  message: SessionMessage,
  clientOperationId: string,
  imageSha256: readonly string[],
): string {
  return createHash('sha256')
    .update(JSON.stringify(productInputSnapshot(message, clientOperationId, imageSha256)))
    .digest('hex');
}

export function assertDshProductInputMatches(
  operation: PendingDshRootOperation,
  message: SessionMessage,
): void {
  if (
    operation.schemaVersion !== 1
    || operation.clientUserMessageId !== message.id
    || !Array.isArray(operation.productImageSha256)
    || !/^[a-f0-9]{64}$/u.test(operation.productInputFingerprint)
    || fingerprintDshProductInput(
      message,
      operation.clientOperationId,
      operation.productImageSha256,
    )
      !== operation.productInputFingerprint
  ) {
    throw new Error('The persisted DSH root operation differs from its Product user input');
  }
}

export function replayDshProductInput(operation: PendingDshRootOperation, message: SessionMessage): {
  message: string;
  images: ImagePayload[] | undefined;
} {
  assertDshProductInputMatches(operation, message);
  const images = userImages(message, operation.productImageSha256).map((image): ImagePayload => ({
    kind: 'attachment_ref',
    id: image.id,
    name: image.name,
    mimeType: image.mimeType,
    relativePath: image.relativePath,
  }));
  return Object.freeze({
    message: message.content,
    images: images.length > 0 ? images : undefined,
  });
}

export function assertDshResolvedImagesMatch(
  operation: PendingDshRootOperation,
  images: readonly ResolvedImagePayload[] | undefined,
): void {
  const actual = (images ?? []).map(image => createHash('sha256')
    .update(Buffer.from(image.data, 'base64'))
    .digest('hex'));
  if (
    actual.length !== operation.productImageSha256.length
    || actual.some((digest, index) => digest !== operation.productImageSha256[index])
  ) {
    throw new Error('The recovered DSH image bytes differ from Product admission');
  }
}
